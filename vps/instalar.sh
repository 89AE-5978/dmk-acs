#!/usr/bin/env bash
# DMK ACS - INSTALADOR (VPS Ubuntu/Debian x86_64, como root).
#
#   Normalmente pelo comando único (pergunta só o domínio):
#     curl -fsSL https://raw.githubusercontent.com/89AE-5978/dmk-acs/main/dmk-acs.sh | sudo bash
#   Ou à mão: git clone <repositório> /opt/dmk-acs/codigo-fonte && bash .../vps/instalar.sh --dominio=...
#
# Opções: --dominio=acs.dmksolutions.io   painel público com HTTPS (nginx + certbot); também vira o
#                                         endereço do ACS dos clientes avulsos (http://dominio:7547)
#         --email=voce@dominio            opcional: avisos de vencimento do certificado
#         --porta-cwmp=7547 --porta-fs=7567 --porta-nbi=7557 --porta-ui=7570
#         --porta-painel=7580 --porta-mongodb=27117 --sem-firewall --moldura="https://central.dominio"
#
# Instala tudo em /opt/dmk-acs (MongoDB e GenieACS próprios, painel, dados), cria os serviços
# dmk-acs-* e liga. Não mexe no DMK Prisma, no nginx nem em outros sistemas da VPS.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$AQUI/lib.sh"

FIREWALL=1; MOLDURA="'self'"; DOMINIO=""; EMAIL=""
for arg in "$@"; do
  case "$arg" in
    --porta-cwmp=*) PORTA_CWMP="${arg#*=}" ;;   --porta-fs=*) PORTA_FS="${arg#*=}" ;;
    --porta-nbi=*) PORTA_NBI="${arg#*=}" ;;     --porta-ui=*) PORTA_UI="${arg#*=}" ;;
    --porta-painel=*) PORTA_PAINEL="${arg#*=}" ;; --porta-mongodb=*) PORTA_MONGODB="${arg#*=}" ;;
    --sem-firewall) FIREWALL=0 ;;
    --dominio=*) DOMINIO="${arg#*=}" ;;
    --email=*) EMAIL="${arg#*=}" ;;
    --moldura=*) MOLDURA="'self' ${arg#*=}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) falhar "Opção desconhecida: $arg" ;;
  esac
done

exigir_root
titulo "DMK ACS - instalação em $RAIZ"

# ------------------------------------------------------------------ conferências (antes de mexer em nada)
[ -f "$INSTALACAO" ] && falhar "Já instalado ($INSTALACAO). Para atualizar use vps/atualizar.sh; para reinstalar, remova antes com vps/remover.sh."
[ "$(uname -m)" = "x86_64" ] || falhar "Só VPS x86_64 (64 bits)."
# shellcheck disable=SC1091
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04) MONGO_OS=ubuntu2204; MONGO_VERSOES="7.0.14 7.0.12" ;;
  ubuntu:24.04) MONGO_OS=ubuntu2404; MONGO_VERSOES="8.0.16 8.0.12 8.0.4" ;;
  # Ubuntu mais novo que o 24.04 (ex.: 26.04): o MongoDB ainda não publica pacote próprio; o do 24.04
  # roda nele (mesmas bibliotecas, mais novas). O instalador confere as bibliotecas com ldd logo abaixo.
  ubuntu:2[4-9].*) MONGO_OS=ubuntu2404; MONGO_VERSOES="8.0.16 8.0.12 8.0.4"
                   aviso "Ubuntu $VERSION_ID: usando o MongoDB feito para o Ubuntu 24.04 (compatível)." ;;
  ubuntu:20.04) MONGO_OS=ubuntu2004; MONGO_VERSOES="7.0.14 7.0.12" ;;
  debian:12)    MONGO_OS=debian12;   MONGO_VERSOES="7.0.14 7.0.12" ;;
  debian:11)    MONGO_OS=debian11;   MONGO_VERSOES="7.0.14 7.0.12" ;;
  debian:1[3-9]) MONGO_OS=debian12;  MONGO_VERSOES="7.0.14 7.0.12"
                   aviso "Debian $VERSION_ID: usando o MongoDB feito para o Debian 12 (compatível)." ;;
  *) falhar "Sistema $PRETTY_NAME não testado. Suportados: Ubuntu 20.04 ou mais novo, Debian 11 ou mais novo." ;;
esac
ok "$PRETTY_NAME"
versao_node_ok || falhar "Precisa do Node.js 18 ou mais novo (o mesmo do DMK Prisma). node -v: $(node -v 2>/dev/null || echo ausente)"
ok "Node.js $(node -v)"
for c in curl tar git ss; do command -v "$c" >/dev/null || falhar "Falta o comando $c."; done
if [ -n "$DOMINIO" ]; then
  [[ "$DOMINIO" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && "$DOMINIO" == *.* ]] || falhar "Domínio inválido: $DOMINIO"
  command -v nginx >/dev/null || falhar "Para o painel público é preciso o nginx (o mesmo que já serve o DMK Prisma)."
  [ ! -e "$NGINX/sites-available/dmk-acs.conf" ] || falhar "Já existe $NGINX/sites-available/dmk-acs.conf."
  ok "Painel público em https://$DOMINIO"
fi

livre_mb="$(df -Pm "$(dirname "$RAIZ")" | awk 'NR==2{print $4}')"
[ "$livre_mb" -ge 2048 ] || falhar "Pouco disco livre (${livre_mb} MB). Precisa de 2 GB."
ok "Disco livre: ${livre_mb} MB"

ocupadas=0
for par in "CWMP:$PORTA_CWMP" "FS:$PORTA_FS" "NBI:$PORTA_NBI" "UI:$PORTA_UI" "PAINEL:$PORTA_PAINEL" "MONGODB:$PORTA_MONGODB"; do
  nome="${par%%:*}"; porta="${par#*:}"
  if porta_ocupada "$porta"; then erro "Porta $porta ($nome) em uso por $(quem_usa_porta "$porta")"; ocupadas=1; else ok "Porta $porta livre ($nome)"; fi
done
[ "$ocupadas" -eq 0 ] || falhar "Escolha outras portas, ex.: --porta-painel=7680"

# Daqui para frente a instalação cria coisas. Se parar no meio (erro ou falhar), desfaz tudo o que
# criou com o próprio removedor, mantendo só o código clonado (para tentar de novo sem clonar).
INSTALANDO=1
desfazer() {
  local st=$?
  [ "$st" -ne 0 ] && [ "${INSTALANDO:-0}" -eq 1 ] || return 0
  erro "A instalação parou. Desfazendo o que foi criado..."
  DMK_ACS_RAIZ="$RAIZ" DMK_ACS_SYSTEMD="$SYSTEMD" bash "$AQUI/remover.sh" --confirmar --silencioso --manter-codigo || true
  exit "$st"
}
trap desfazer EXIT

# ------------------------------------------------------------------ pastas e usuário
titulo "Pastas e usuário"
mkdir -p "$RAIZ" "$PROGRAMAS" "$DADOS/mongodb" "$CONFIG" "$BACKUPS"
if [ "$(readlink -f "$AQUI/..")" != "$(readlink -f "$CODIGO" 2>/dev/null || true)" ]; then
  # Rodou de fora de /opt/dmk-acs/codigo-fonte: traz o código para dentro da pasta do módulo
  rm -rf "$CODIGO"; cp -a "$AQUI/.." "$CODIGO"
fi
id "$USUARIO" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$RAIZ" --shell /usr/sbin/nologin "$USUARIO"
ok "Usuário de sistema $USUARIO"
su -s /bin/sh "$USUARIO" -c "node -v" >/dev/null 2>&1 \
  || falhar "O usuário $USUARIO não consegue rodar o Node.js ($(readlink -f "$(command -v node)")). Se o Node está em /root (nvm), instale o Node.js do sistema."

# ------------------------------------------------------------------ MongoDB (só o binário, dentro da pasta)
titulo "Banco do ACS (MongoDB)"
tmp="$(mktemp -d)"
baixou=0
for v in $MONGO_VERSOES; do
  url="https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-$MONGO_OS-$v.tgz"
  info "Baixando MongoDB $v ($MONGO_OS)"
  if curl -fsSL --retry 2 -o "$tmp/mongo.tgz" "$url"; then baixou=1; break; fi
  aviso "MongoDB $v indisponível, tentando outra versão"
done
[ "$baixou" -eq 1 ] || falhar "Não consegui baixar o MongoDB."
mkdir -p "$PROGRAMAS/mongodb/bin"
tar -xzf "$tmp/mongo.tgz" -C "$tmp"
cp "$tmp"/mongodb-linux-*/bin/mongod "$PROGRAMAS/mongodb/bin/"
rm -rf "$tmp"
faltando="$(ldd "$PROGRAMAS/mongodb/bin/mongod" | awk '/not found/{print $1}' | tr '\n' ' ')"
if [ -n "$faltando" ]; then
  info "Instalando bibliotecas do sistema que o MongoDB pede: $faltando"
  apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends libcurl4t64 >/dev/null 2>&1 \
    || apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends libcurl4 >/dev/null 2>&1 || true
fi
versao_mongo="$( { "$PROGRAMAS/mongodb/bin/mongod" --version 2>&1 || true; } | head -1 | awk '{print $3}')"
[[ "$versao_mongo" == v* ]] || falhar "O MongoDB baixado não roda neste sistema: $( { "$PROGRAMAS/mongodb/bin/mongod" --version 2>&1 || true; } | head -2 | tr '\n' ' ')"
ok "MongoDB $versao_mongo"

# ------------------------------------------------------------------ GenieACS (npm, dentro da pasta)
titulo "GenieACS"
mkdir -p "$PROGRAMAS/genieacs"
echo '{ "name": "dmk-acs-genieacs", "private": true }' > "$PROGRAMAS/genieacs/package.json"
npm_modulo install --prefix "$PROGRAMAS/genieacs" 'genieacs@1.2' --no-audit --no-fund --loglevel=error
ok "GenieACS $(node -p "require('$PROGRAMAS/genieacs/node_modules/genieacs/package.json').version")"

# ------------------------------------------------------------------ painel
titulo "Painel DMK ACS"
publicar_app "$CODIGO" "$APP"
for t in "$APP"/testes/teste-*.js; do
  node "$t" >/dev/null 2>&1 || falhar "O teste $(basename "$t") falhou: não instalo uma versão quebrada."
done
ok "Painel $(cat "$APP/VERSION") testado"

IP_PUBLICO="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
umask 077
cat > "$CONFIG/acs.env" <<EOF
# DMK ACS - configuração dos serviços (gerado pelo instalador em $(date -Iseconds)). Só root lê.
GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1:$PORTA_MONGODB/genieacs
GENIEACS_UI_JWT_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
GENIEACS_EXT_DIR=$DADOS/ext
GENIEACS_FS_HOSTNAME=$IP_PUBLICO
GENIEACS_CWMP_PORT=$PORTA_CWMP
GENIEACS_CWMP_INTERFACE=0.0.0.0
GENIEACS_FS_PORT=$PORTA_FS
GENIEACS_FS_INTERFACE=0.0.0.0
GENIEACS_NBI_PORT=$PORTA_NBI
GENIEACS_NBI_INTERFACE=127.0.0.1
GENIEACS_UI_PORT=$PORTA_UI
GENIEACS_UI_INTERFACE=127.0.0.1
DMK_ACS_PORTA=$PORTA_PAINEL
DMK_ACS_INTERFACE=127.0.0.1
DMK_ACS_NBI=http://127.0.0.1:$PORTA_NBI
DMK_ACS_DADOS=$DADOS
DMK_ACS_MODO=producao
DMK_ACS_MOLDURA=$MOLDURA
DMK_ACS_PORTA_MONGODB=$PORTA_MONGODB
DMK_ACS_PROXY=$([ -n "$DOMINIO" ] && echo 1 || echo 0)
DMK_ACS_ENDERECO_AVULSOS=http://${DOMINIO:-$IP_PUBLICO}:$PORTA_CWMP
EOF
umask 022
mkdir -p "$DADOS/ext"
chown -R root:root "$RAIZ"
chown -R "$USUARIO:$USUARIO" "$DADOS"
chmod 750 "$DADOS"
chgrp "$USUARIO" "$CONFIG/acs.env"; chmod 640 "$CONFIG/acs.env"

# ------------------------------------------------------------------ serviços
titulo "Serviços (systemd)"
escrever_servicos
systemctl enable --now dmk-acs.target >/dev/null 2>&1
for s in "${SERVICOS[@]}"; do systemctl enable --now "dmk-acs-$s.service" >/dev/null 2>&1; done
esperar_porta "$PORTA_MONGODB" 60 || falhar "MongoDB não subiu: journalctl -u dmk-acs-mongodb"
for par in "cwmp:$PORTA_CWMP" "nbi:$PORTA_NBI" "fs:$PORTA_FS" "ui:$PORTA_UI" "painel:$PORTA_PAINEL"; do
  esperar_porta "${par#*:}" 60 || falhar "Serviço ${par%%:*} não subiu: journalctl -u dmk-acs-${par%%:*}"
  ok "dmk-acs-${par%%:*} no ar (porta ${par#*:})"
done
for _ in $(seq 1 30); do [[ "$(saude_painel)" == *'"scriptsNoAcs":true'* ]] && break; sleep 2; done
[[ "$(saude_painel)" == *'"scriptsNoAcs":true'* ]] || aviso "O painel ainda não gravou os scripts no ACS (tenta sozinho a cada 30 s)."

# ------------------------------------------------------------------ firewall (só as portas dos roteadores)
UFW_REGRAS=""
if [ "$FIREWALL" -eq 1 ] && command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null)" == *"Status: active"* ]]; then
  for p in "$PORTA_CWMP" "$PORTA_FS"; do
    ufw allow "$p/tcp" comment 'dmk-acs' >/dev/null
    UFW_REGRAS="${UFW_REGRAS:+$UFW_REGRAS, }\"$p/tcp\""
  done
  ok "Firewall: liberadas $PORTA_CWMP e $PORTA_FS (TCP) para os roteadores"
else
  aviso "ufw inativo ou --sem-firewall: libere as portas $PORTA_CWMP e $PORTA_FS (TCP) no firewall do provedor da VPS."
fi

# ------------------------------------------------------------------ painel público (opcional): nginx + HTTPS
if [ -n "$DOMINIO" ]; then
  titulo "Painel público: https://$DOMINIO"
  site="$NGINX/sites-available/dmk-acs.conf"
  cat > "$site" <<EOF
# DMK ACS - painel público. Criado por $CODIGO/vps/instalar.sh; o removedor do módulo apaga este arquivo.
# Segunda barreira contra força bruta: no máximo 10 tentativas de entrada por minuto por IP.
limit_req_zone \$binary_remote_addr zone=dmkacs_entrada:10m rate=10r/m;
server {
    listen 80;
    server_name $DOMINIO;
    client_max_body_size 64k;
    location ~ ^/api/(acesso|app)/(entrar|autenticador|primeiro) {
        limit_req zone=dmkacs_entrada burst=5 nodelay;
        limit_req_status 429;
        include $NGINX/dmk-acs-proxy.inc;
    }
    location / { include $NGINX/dmk-acs-proxy.inc; }
}
EOF
  cat > "$NGINX/dmk-acs-proxy.inc" <<EOF
# DMK ACS - repasse para o painel (127.0.0.1:$PORTA_PAINEL). Criado pelo instalador do DMK ACS.
proxy_pass http://127.0.0.1:$PORTA_PAINEL;
proxy_set_header Host \$host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_set_header X-Forwarded-Host \$host;
EOF
  ln -sf "$site" "$NGINX/sites-enabled/dmk-acs.conf"
  if nginx -t >/dev/null 2>&1; then
    nginx -s reload; ok "nginx: site dmk-acs.conf ativo"
  else
    rm -f "$NGINX/sites-enabled/dmk-acs.conf" "$site" "$NGINX/dmk-acs-proxy.inc"
    falhar "A configuração do nginx não passou no teste (nginx -t). Nada do nginx foi mantido."
  fi
  if command -v certbot >/dev/null; then
    # Conta do Let's Encrypt: se a VPS já tem (ex.: a do DMK Prisma), usa a primeira, senão o certbot
    # pergunta qual e para (modo sem perguntas). Sem conta: cria, com e-mail se informado.
    contas_le="$(ls /etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory 2>/dev/null | head -1 || true)"
    if [ -n "$contas_le" ]; then conta=(--account "$contas_le")
    elif [ -n "$EMAIL" ]; then conta=(-m "$EMAIL"); else conta=(--register-unsafely-without-email); fi
    if certbot --nginx -d "$DOMINIO" "${conta[@]}" --agree-tos --non-interactive --redirect > "$CONFIG/certbot.log" 2>&1; then
      ok "HTTPS ativo (certificado do $DOMINIO)"
    else
      aviso "Não consegui o certificado HTTPS agora. O que o certbot respondeu:"
      grep -vE '^\s*$|^Saving debug|^Ask for help|^-+$' "$CONFIG/certbot.log" | tail -6 | sed 's/^/         /'
      aviso "Depois de resolver, rode: certbot --nginx -d $DOMINIO --redirect"
    fi
  else
    aviso "certbot não encontrado: o painel ficou só em HTTP. Instale o certbot e rode: certbot --nginx -d $DOMINIO"
  fi
fi

INSTALANDO=0
gravar_instalacao "$(cat "$APP/VERSION")" "$UFW_REGRAS" "$DOMINIO"

titulo "DMK ACS instalado"
bash "$AQUI/dados.sh" --sem-titulo
