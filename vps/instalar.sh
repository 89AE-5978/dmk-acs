#!/usr/bin/env bash
# DMK ACS - INSTALADOR (VPS Ubuntu/Debian x86_64, como root).
#
#   git clone <repositório dmk-acs> /opt/dmk-acs/codigo-fonte
#   bash /opt/dmk-acs/codigo-fonte/vps/instalar.sh
#
# Opções: --dominio=painel.dmksolutions.io --email=voce@dominio   painel público com HTTPS (nginx + certbot)
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
  ubuntu:24.04) MONGO_OS=ubuntu2404; MONGO_VERSOES="8.0.4 8.0.3" ;;
  ubuntu:20.04) MONGO_OS=ubuntu2004; MONGO_VERSOES="7.0.14 7.0.12" ;;
  debian:12)    MONGO_OS=debian12;   MONGO_VERSOES="7.0.14 7.0.12" ;;
  debian:11)    MONGO_OS=debian11;   MONGO_VERSOES="7.0.14 7.0.12" ;;
  *) falhar "Sistema $PRETTY_NAME não testado. Suportados: Ubuntu 20.04/22.04/24.04, Debian 11/12." ;;
esac
ok "$PRETTY_NAME"
versao_node_ok || falhar "Precisa do Node.js 18 ou mais novo (o mesmo do DMK Prisma). node -v: $(node -v 2>/dev/null || echo ausente)"
ok "Node.js $(node -v)"
command -v npm >/dev/null || falhar "npm não encontrado (vem junto com o Node.js)."
for c in curl tar git ss; do command -v "$c" >/dev/null || falhar "Falta o comando $c."; done
if [ -n "$DOMINIO" ]; then
  [[ "$DOMINIO" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && "$DOMINIO" == *.* ]] || falhar "Domínio inválido: $DOMINIO"
  [ -n "$EMAIL" ] || falhar "Com --dominio informe também --email= (aviso de vencimento do certificado)."
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
  apt-get install -y --no-install-recommends libcurl4 2>/dev/null || apt-get install -y --no-install-recommends libcurl4t64
fi
ok "MongoDB $("$PROGRAMAS/mongodb/bin/mongod" --version | head -1 | awk '{print $3}')"

# ------------------------------------------------------------------ GenieACS (npm, dentro da pasta)
titulo "GenieACS"
mkdir -p "$PROGRAMAS/genieacs"
echo '{ "name": "dmk-acs-genieacs", "private": true }' > "$PROGRAMAS/genieacs/package.json"
npm install --prefix "$PROGRAMAS/genieacs" 'genieacs@1.2' --no-audit --no-fund --loglevel=error
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
    certbot --nginx -d "$DOMINIO" -m "$EMAIL" --agree-tos --non-interactive --redirect >/dev/null 2>&1 \
      && ok "HTTPS ativo (certificado do $DOMINIO)" \
      || aviso "Não consegui o certificado agora (o DNS do $DOMINIO já aponta para esta VPS?). Depois rode: certbot --nginx -d $DOMINIO"
  else
    aviso "certbot não encontrado: o painel ficou só em HTTP. Instale o certbot e rode: certbot --nginx -d $DOMINIO"
  fi
fi

INSTALANDO=0
gravar_instalacao "$(cat "$APP/VERSION")" "$UFW_REGRAS" "$DOMINIO"

titulo "DMK ACS instalado"
cat <<EOF
  Pasta ............ $RAIZ   (tudo do módulo fica aqui)
  Painel ........... http://127.0.0.1:$PORTA_PAINEL/   (só nesta VPS; o DMK Prisma abre por ele)
  Roteadores ....... http://acs.<dominio-do-provedor>:$PORTA_CWMP/   (DNS do provedor -> $IP_PUBLICO)
  Segredo p/ Prisma  $DADOS/segredo-integracao.txt
  Painel público ... $([ -n "$DOMINIO" ] && echo "https://$DOMINIO/admin/" || echo "não (instale com --dominio=... para publicar)")
  PRIMEIRO ACESSO .. código $(cat "$DADOS/primeiro-acesso.txt" 2>/dev/null || echo "(veja: journalctl -u dmk-acs-painel | grep PRIMEIRO)")
  Serviços ......... systemctl status 'dmk-acs-*'      Logs: journalctl -u dmk-acs-painel -f
  Atualizar ........ bash $CODIGO/vps/atualizar.sh
  Remover .......... bash $CODIGO/vps/remover.sh

  Painel técnico do GenieACS (só se precisar), por túnel:
    >>> NO SEU PC (PowerShell) <<<
    ssh -N -L $PORTA_UI:127.0.0.1:$PORTA_UI root@$IP_PUBLICO      e abra http://localhost:$PORTA_UI/
EOF
