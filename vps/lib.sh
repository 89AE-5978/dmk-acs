#!/usr/bin/env bash
# DMK ACS - funções comuns do instalador, atualizador e removedor (VPS Linux).
#
# Regra de organização: TUDO do módulo fica em /opt/dmk-acs. Fora dela o módulo só cria:
#   - /etc/systemd/system/dmk-acs-*.service e dmk-acs.target (serviços do sistema);
#   - o usuário de sistema "dmkacs" (sem login), dono dos processos;
#   - regras do firewall (ufw) para as portas públicas, se o ufw estiver ativo;
#   - com --dominio: o site $NGINX/sites-available/dmk-acs.conf (+ link) e o certificado HTTPS dele.
# O removedor desfaz exatamente essa lista. Nada do DMK Prisma, do nginx ou de outros sistemas
# é tocado.

set -Eeuo pipefail

RAIZ="${DMK_ACS_RAIZ:-/opt/dmk-acs}"
SYSTEMD="${DMK_ACS_SYSTEMD:-/etc/systemd/system}"
NGINX="${DMK_ACS_NGINX:-/etc/nginx}"   # só usado com --dominio (painel público)
USUARIO="dmkacs"
SERVICOS=(mongodb cwmp nbi fs ui painel)

CODIGO="$RAIZ/codigo-fonte"     # clone do GitHub (origem das atualizações)
APP="$RAIZ/app"                 # versão em uso do painel (cópia de codigo-fonte)
PROGRAMAS="$RAIZ/programas"     # MongoDB e GenieACS, só desta pasta
DADOS="$RAIZ/dados"             # provedores, segredo de integração, banco do ACS
CONFIG="$RAIZ/config"           # acs.env (portas e segredos)
BACKUPS="$RAIZ/backups"         # UM backup só, regravado a cada atualização
INSTALACAO="$RAIZ/instalacao.json"

# Portas padrão (troque com --porta-cwmp=... etc. na instalação)
PORTA_CWMP=7547; PORTA_FS=7567                  # públicas: roteadores chegam aqui
PORTA_NBI=7557; PORTA_UI=7570; PORTA_PAINEL=7580; PORTA_MONGODB=27117   # só 127.0.0.1

cor() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
titulo() { echo; cor '1;36' "== $1"; }
ok()     { cor '32' "  [ok] $1"; }
info()   { echo "  ...  $1"; }
aviso()  { cor '33' "  [!]  $1"; }
erro()   { cor '31' "  [x]  $1" >&2; }
falhar() { erro "$1"; exit 1; }

exigir_root() { [ "$(id -u)" -eq 0 ] || falhar "Rode como root (sudo)."; }

# Lê o acs.env (portas e segredos) já instalado
carregar_config() {
  [ -f "$CONFIG/acs.env" ] || falhar "Não achei $CONFIG/acs.env. O DMK ACS está instalado?"
  # shellcheck disable=SC1091
  set -a; . "$CONFIG/acs.env"; set +a
  PORTA_CWMP="$GENIEACS_CWMP_PORT"; PORTA_FS="$GENIEACS_FS_PORT"; PORTA_NBI="$GENIEACS_NBI_PORT"
  PORTA_UI="$GENIEACS_UI_PORT"; PORTA_PAINEL="$DMK_ACS_PORTA"; PORTA_MONGODB="$DMK_ACS_PORTA_MONGODB"
}

porta_ocupada() { [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]; }
quem_usa_porta() { ss -Hltnp "sport = :$1" 2>/dev/null | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | head -1; }

# npm do módulo: usa o do sistema se existir; se não (ex.: Node.js do Ubuntu sem o pacote npm), baixa o
# npm para dentro de $PROGRAMAS/npm, sem instalar nada no sistema. Cache em $PROGRAMAS/.npm-cache (apagado
# no fim), para não deixar sobra em /root.
npm_modulo() {
  local cli="$PROGRAMAS/npm/bin/npm-cli.js"
  if ! command -v npm >/dev/null && [ ! -f "$cli" ]; then
    info "npm não está no sistema: baixando o npm para dentro de $PROGRAMAS/npm"
    local tmp v; tmp="$(mktemp -d)"
    for v in 10.9.2 10.8.2; do
      curl -fsSL --retry 2 -o "$tmp/npm.tgz" "https://registry.npmjs.org/npm/-/npm-$v.tgz" && break
    done
    [ -s "$tmp/npm.tgz" ] || { rm -rf "$tmp"; falhar "Não consegui baixar o npm (registry.npmjs.org)."; }
    mkdir -p "$PROGRAMAS/npm"; tar -xzf "$tmp/npm.tgz" -C "$PROGRAMAS/npm" --strip-components=1; rm -rf "$tmp"
  fi
  local r=0
  if command -v npm >/dev/null; then npm --cache "$PROGRAMAS/.npm-cache" "$@" || r=$?
  else node "$cli" --cache "$PROGRAMAS/.npm-cache" "$@" || r=$?; fi
  rm -rf "$PROGRAMAS/.npm-cache"
  return "$r"
}

versao_node_ok() {
  command -v node >/dev/null || return 1
  local v; v="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$v" -ge 18 ]
}

# Espera um serviço responder na porta (segundos)
esperar_porta() {
  local porta="$1" limite="${2:-60}" i
  for ((i = 0; i < limite * 2; i++)); do porta_ocupada "$porta" && return 0; sleep 0.5; done
  return 1
}

saude_painel() { curl -fsS --max-time 5 "http://127.0.0.1:$PORTA_PAINEL/saude" 2>/dev/null; }

# Escreve as unidades do systemd (idempotente: o atualizador chama de novo)
escrever_servicos() {
  local node_bin; node_bin="$(readlink -f "$(command -v node)")"
  # Node instalado dentro de /root ou /home (nvm): o serviço precisa enxergar essa pasta
  local protege_home=true
  case "$node_bin" in /root/*|/home/*) protege_home=read-only ;; esac
  local comum="User=$USUARIO
Group=$USUARIO
EnvironmentFile=$CONFIG/acs.env
WorkingDirectory=$RAIZ
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=$protege_home
PrivateTmp=true
ReadWritePaths=$DADOS"

  cat > "$SYSTEMD/dmk-acs.target" <<EOF
# DMK ACS - liga/desliga todos os serviços do módulo juntos. Instalado por $RAIZ/vps/instalar.sh
[Unit]
Description=DMK ACS (GenieACS + painel DMK)
Wants=$(printf 'dmk-acs-%s.service ' "${SERVICOS[@]}")

[Install]
WantedBy=multi-user.target
EOF

  cat > "$SYSTEMD/dmk-acs-mongodb.service" <<EOF
# DMK ACS - banco próprio do ACS (MongoDB em $PROGRAMAS/mongodb, dados em $DADOS/mongodb)
[Unit]
Description=DMK ACS - banco (MongoDB)
After=network.target
PartOf=dmk-acs.target

[Service]
$comum
ExecStart=$PROGRAMAS/mongodb/bin/mongod --dbpath $DADOS/mongodb --port $PORTA_MONGODB --bind_ip 127.0.0.1 --quiet
LimitNOFILE=64000

[Install]
WantedBy=dmk-acs.target
EOF

  local s
  for s in cwmp nbi fs ui; do
    cat > "$SYSTEMD/dmk-acs-$s.service" <<EOF
# DMK ACS - GenieACS $s
[Unit]
Description=DMK ACS - GenieACS $s
After=dmk-acs-mongodb.service
Requires=dmk-acs-mongodb.service
PartOf=dmk-acs.target

[Service]
$comum
ExecStart=$node_bin $PROGRAMAS/genieacs/node_modules/genieacs/bin/genieacs-$s

[Install]
WantedBy=dmk-acs.target
EOF
  done

  cat > "$SYSTEMD/dmk-acs-painel.service" <<EOF
# DMK ACS - painel (Central DMK + módulo dos provedores), aberto pelo DMK Prisma
[Unit]
Description=DMK ACS - painel
After=dmk-acs-nbi.service
PartOf=dmk-acs.target

[Service]
$comum
ExecStart=$node_bin $APP/servidor/servidor.js

[Install]
WantedBy=dmk-acs.target
EOF
  systemctl daemon-reload
}

# Escreve instalacao.json (versão, portas, data) - lido pelo atualizador e pelo removedor
gravar_instalacao() {
  local versao="$1" ufw="$2" dominio="${3:-}"
  cat > "$INSTALACAO" <<EOF
{
  "modulo": "dmk-acs",
  "versao": "$versao",
  "atualizadoEm": "$(date -Iseconds)",
  "raiz": "$RAIZ",
  "origem": "$(git -C "$CODIGO" remote get-url origin 2>/dev/null || echo local)",
  "portas": { "cwmp": $PORTA_CWMP, "fs": $PORTA_FS, "nbi": $PORTA_NBI, "ui": $PORTA_UI, "painel": $PORTA_PAINEL, "mongodb": $PORTA_MONGODB },
  "ufw": [$ufw],
  "dominio": "$dominio"
}
EOF
}

# Copia o código do painel de codigo-fonte para app (sem .git e sem a pasta vps)
publicar_app() {
  local origem="$1" destino="$2"
  rm -rf "$destino"; mkdir -p "$destino"
  cp -a "$origem/servidor" "$origem/testes" "$origem/VERSION" "$destino/"
}
