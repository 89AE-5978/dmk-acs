#!/usr/bin/env bash
# DMK ACS - comando único na VPS (instala, atualiza, remove). Rode como root:
#
#   curl -fsSL https://raw.githubusercontent.com/89AE-5978/dmk-acs/main/dmk-acs.sh | sudo bash
#
# Sem DMK ACS na VPS: pergunta só o domínio do painel e instala tudo em /opt/dmk-acs.
# Já instalado: mostra um menu (atualizar, ver dados de acesso, remover).
# Também aceita direto: ... | sudo bash -s -- instalar --dominio=acs.exemplo.com.br
#                                         ... | sudo bash -s -- atualizar | dados | remover
#
# O script inteiro fica dentro de principal(), chamado só na última linha: se a conexão cair no
# meio do download, nada pela metade é executado.

principal() {
  set -Eeuo pipefail
  local REPO="${DMK_ACS_REPO:-https://github.com/89AE-5978/dmk-acs.git}"
  local RAIZ="${DMK_ACS_RAIZ:-/opt/dmk-acs}"
  local CODIGO="$RAIZ/codigo-fonte"
  local ACAO="" DOMINIO="" EXTRAS=()

  cor() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
  ok() { cor 32 "  [ok] $1"; }
  info() { echo "  ...  $1"; }
  aviso() { cor 33 "  [!]  $1"; }
  falhar() { cor 31 "  [x]  $1" >&2; exit 1; }
  # Perguntas vêm do teclado mesmo com o script chegando pelo "curl | bash"
  tem_teclado() { ( : < /dev/tty ) 2>/dev/null; }
  perguntar() { local r=""; if tem_teclado; then read -r -p "$1" r < /dev/tty || true; fi; printf '%s' "$r"; }

  for arg in "$@"; do
    case "$arg" in
      instalar|atualizar|remover|dados) ACAO="$arg" ;;
      --dominio=*) DOMINIO="${arg#*=}" ;;
      -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]:-dmk-acs.sh}" 2>/dev/null || true; return 0 ;;
      *) EXTRAS+=("$arg") ;;   # repassado ao instalar.sh / atualizar.sh / remover.sh (ex.: --porta-painel=7680)
    esac
  done

  [ "$(id -u)" -eq 0 ] || falhar "Rode como root:  curl -fsSL .../dmk-acs.sh | sudo bash"
  echo; cor '1;36' "DMK ACS - gerenciamento de roteadores (TR-069)"

  if [ -z "$ACAO" ]; then
    if [ -f "$RAIZ/instalacao.json" ]; then
      echo "  Já instalado em $RAIZ (versão $(cat "$RAIZ/app/VERSION" 2>/dev/null || echo '?'))."
      echo "    1) Atualizar para a última versão do GitHub"
      echo "    2) Ver os dados de acesso (painel, primeiro acesso, conexão com o DMK Prisma)"
      echo "    3) Remover o DMK ACS desta VPS"
      echo "    0) Sair"
      case "$(perguntar '  Escolha [1]: ')" in
        ''|1) ACAO=atualizar ;; 2) ACAO=dados ;; 3) ACAO=remover ;; *) return 0 ;;
      esac
    else
      ACAO=instalar
    fi
  fi

  case "$ACAO" in
    atualizar)
      [ -f "$RAIZ/instalacao.json" ] || falhar "DMK ACS não está instalado nesta VPS."
      bash "$CODIGO/vps/atualizar.sh" "${EXTRAS[@]}"; return ;;
    remover)
      [ -f "$RAIZ/instalacao.json" ] || [ -d "$RAIZ" ] || falhar "DMK ACS não está instalado nesta VPS."
      if tem_teclado; then bash "$CODIGO/vps/remover.sh" "${EXTRAS[@]}" < /dev/tty; else bash "$CODIGO/vps/remover.sh" "${EXTRAS[@]}"; fi
      return ;;
    dados)
      [ -f "$RAIZ/instalacao.json" ] || falhar "DMK ACS não está instalado nesta VPS."
      bash "$CODIGO/vps/dados.sh"; return ;;
  esac

  # ------------------------------------------------------------------ instalar
  [ ! -f "$RAIZ/instalacao.json" ] || falhar "Já instalado. Rode o comando de novo sem argumentos para atualizar ou remover."
  if [ -z "$DOMINIO" ]; then
    echo
    echo "  Domínio do painel (crie antes no DNS um registro A apontando para o IP desta VPS)."
    DOMINIO="$(perguntar '  Domínio (ex.: acs.dmksolutions.io): ')"
  fi
  DOMINIO="$(printf '%s' "$DOMINIO" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s/[[:space:]]//g')"
  [[ "$DOMINIO" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && "$DOMINIO" == *.* ]] \
    || falhar "Domínio inválido: '${DOMINIO}'. Rode de novo e digite só o nome, ex.: acs.dmksolutions.io"

  # Programas que o módulo usa (só instala o que falta; nada é atualizado à força).
  # apt espera até 5 min se outra instalação do sistema estiver rodando (ex.: atualização automática)
  # e mostra o andamento: nada de tela parada sem dizer o que está fazendo.
  apt_instalar() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "$@" 2>&1 | grep -E '^(Setting up|Configurando|E:)' | sed 's/^/       /' || true; }
  info "Conferindo os programas da VPS"
  local faltam=()
  for c in git curl ss; do command -v "$c" >/dev/null || faltam+=("$c"); done
  command -v nginx >/dev/null || faltam+=(nginx)
  command -v certbot >/dev/null || faltam+=(certbot)
  if [ "${#faltam[@]}" -gt 0 ]; then
    if [[ " ${faltam[*]} " == *" nginx "* ]] && [ -n "$(ss -Hltn 'sport = :80' 2>/dev/null)" ]; then
      falhar "A porta 80 já é usada por outro programa (não o nginx). O painel público precisa do nginx."
    fi
    command -v apt-get >/dev/null || falhar "Faltam: ${faltam[*]} (e não há apt-get para instalar)."
    local pacotes=(ca-certificates)
    for c in "${faltam[@]}"; do
      case "$c" in ss) pacotes+=(iproute2) ;; certbot) pacotes+=(certbot python3-certbot-nginx) ;; *) pacotes+=("$c") ;; esac
    done
    info "Instalando o que falta: ${pacotes[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -qq || true
    apt_instalar "${pacotes[@]}"
    for c in "${faltam[@]}"; do command -v "$c" >/dev/null || falhar "Não consegui instalar: $c"; done
  fi
  # certbot sem o plugin do nginx (instalado por snap/pip não precisa; pelo apt precisa do pacote)
  if command -v apt-get >/dev/null && dpkg -s certbot >/dev/null 2>&1 && ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
    info "Instalando o plugin do nginx para o certbot"
    apt_instalar python3-certbot-nginx
  fi

  local nodev; nodev="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//' || true)"
  if [ -z "$nodev" ] || [ "$nodev" -lt 18 ]; then
    info "Instalando o Node.js 20 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || falhar "Não consegui preparar o Node.js 20."
    apt_instalar nodejs
    command -v node >/dev/null || falhar "Não consegui instalar o Node.js 20."
  fi
  ok "Programas: git, nginx, certbot, Node.js $(node -v)"

  # DNS: avisa já (o certificado HTTPS só sai com o domínio apontando para esta VPS)
  local ip dns
  info "Conferindo o DNS de $DOMINIO"
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  dns="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk 'NR==1{print $1}')"
  # Cloudflare com a nuvem laranja (proxy) no domínio: os roteadores não chegam na porta do ACS
  # (o proxy só repassa 80/443 e algumas outras) e todo acesso ao painel viria do IP da Cloudflare,
  # o que quebraria o bloqueio de IP suspeito. Tem que ser "DNS only" (nuvem cinza).
  case "$dns" in
    104.1[6-9].*|104.2[0-9].*|104.3[01].*|172.6[4-9].*|172.7[01].*|188.114.9[6-9].*|162.158.*|141.101.*|108.162.*|190.93.*|197.234.*|198.41.*|173.245.*|103.21.*|103.22.*|103.31.*)
      falhar "O $DOMINIO está com a nuvem LARANJA da Cloudflare (proxy, IP $dns). No painel da Cloudflare > DNS, deixe o registro A de '${DOMINIO%%.*}' como 'DNS only' (nuvem cinza) apontando para $ip, espere 1 minuto e rode o comando de novo." ;;
  esac
  if [ "$dns" = "$ip" ]; then ok "DNS: $DOMINIO aponta para esta VPS ($ip)"
  else aviso "DNS: $DOMINIO aponta para '${dns:-nada}', esta VPS é $ip. O HTTPS pode falhar agora (o instalador avisa e diz como refazer)."; fi

  # Código do GitHub dentro da pasta do módulo (origem das atualizações)
  info "Baixando o código do GitHub"
  mkdir -p "$RAIZ"
  if [ -d "$CODIGO/.git" ]; then
    git -C "$CODIGO" fetch -q origin && git -C "$CODIGO" reset -q --hard origin/main
  else
    rm -rf "$CODIGO"; git clone -q "$REPO" "$CODIGO" || falhar "Não consegui baixar $REPO"
  fi
  ok "Código $(cat "$CODIGO/VERSION") baixado em $CODIGO"

  bash "$CODIGO/vps/instalar.sh" --dominio="$DOMINIO" "${EXTRAS[@]}"
}

principal "$@"
