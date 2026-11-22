#!/usr/bin/env bash
# DMK ACS - ATUALIZADOR (VPS, como root).
#
#   bash /opt/dmk-acs/codigo-fonte/vps/atualizar.sh
#
# Opções: --versao=main|v1.2.0   ramo ou tag do GitHub (padrão: main)
#         --forcar               reaplica mesmo se já estiver na versão
#         --genieacs             atualiza também o GenieACS (dentro da série 1.2)
#
# Passos: baixa do GitHub -> TESTA a versão nova antes de trocar -> backup único (regravado) em
# /opt/dmk-acs/backups/ultimo.tar.gz -> troca o painel -> confere se subiu. Se a versão nova não
# subir, volta sozinho para a anterior. Provedores, segredo e banco do ACS são preservados.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$AQUI/lib.sh"

REF="main"; FORCAR=0; GENIE=0
for arg in "$@"; do
  case "$arg" in
    --versao=*) REF="${arg#*=}" ;;
    --forcar) FORCAR=1 ;;
    --genieacs) GENIE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) falhar "Opção desconhecida: $arg" ;;
  esac
done

exigir_root
[ -f "$INSTALACAO" ] || falhar "DMK ACS não está instalado em $RAIZ (use vps/instalar.sh)."
carregar_config
titulo "DMK ACS - atualização"

atual="$(cat "$APP/VERSION" 2>/dev/null || echo '?')"
info "Versão em uso: $atual"

# 1) Baixa do GitHub (sem mexer em nada ainda)
git -C "$CODIGO" fetch --tags --prune origin >/dev/null 2>&1 || falhar "Não consegui falar com o GitHub (git fetch em $CODIGO)."
if git -C "$CODIGO" rev-parse -q --verify "refs/tags/$REF" >/dev/null; then alvo="refs/tags/$REF"; else alvo="origin/$REF"; fi
git -C "$CODIGO" rev-parse -q --verify "$alvo" >/dev/null || falhar "Versão/ramo '$REF' não existe no GitHub."
nova="$(git -C "$CODIGO" show "$alvo:VERSION" | tr -d '[:space:]')"
info "Versão no GitHub ($REF): $nova"
if [ "$nova" = "$atual" ] && [ "$FORCAR" -eq 0 ] && [ "$GENIE" -eq 0 ]; then ok "Já está na versão $atual. Nada a fazer."; exit 0; fi

# 2) Monta e TESTA a versão nova numa pasta temporária
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git -C "$CODIGO" archive "$alvo" | tar -x -C "$tmp"
node "$tmp/testes/teste-servidor.js" >/dev/null 2>&1 || falhar "A versão $nova não passou no teste. Nada foi alterado."
ok "Versão $nova testada"

# 3) Backup único (regravado): painel em uso, configuração e provedores. O banco do ACS não muda
#    numa atualização do painel e fica fora (é grande); o removedor tem --salvar para ele.
mkdir -p "$BACKUPS"
tar -czf "$BACKUPS/ultimo.tar.gz.tmp" -C "$RAIZ" app config instalacao.json \
  $(cd "$RAIZ" && ls -d dados/provedores.json dados/segredo-integracao.txt dados/clientes.json 2>/dev/null)
mv -f "$BACKUPS/ultimo.tar.gz.tmp" "$BACKUPS/ultimo.tar.gz"
ok "Backup em $BACKUPS/ultimo.tar.gz (substitui o anterior)"

# 4) Troca o painel (o código-fonte só passa para a versão nova depois que ela subir)
ufw_atual="$(grep -o '"ufw": \[[^]]*\]' "$INSTALACAO" | sed 's/.*\[\(.*\)\]/\1/')"
rm -rf "$APP.anterior"; mv "$APP" "$APP.anterior"
publicar_app "$tmp" "$APP"
escrever_servicos

if [ "$GENIE" -eq 1 ]; then
  info "Atualizando o GenieACS (série 1.2)"
  npm install --prefix "$PROGRAMAS/genieacs" 'genieacs@1.2' --no-audit --no-fund --loglevel=error
  systemctl restart dmk-acs-cwmp dmk-acs-nbi dmk-acs-fs dmk-acs-ui
  for p in "$PORTA_CWMP" "$PORTA_NBI" "$PORTA_FS" "$PORTA_UI"; do esperar_porta "$p" 60 || falhar "GenieACS não voltou na porta $p: journalctl -u 'dmk-acs-*'"; done
  ok "GenieACS $(node -p "require('$PROGRAMAS/genieacs/node_modules/genieacs/package.json').version")"
fi

systemctl restart dmk-acs-painel
subiu=0
for _ in $(seq 1 20); do
  if [[ "$(saude_painel)" == *"\"versao\":\"$nova\""* ]]; then subiu=1; break; fi
  sleep 1
done

if [ "$subiu" -eq 1 ]; then
  rm -rf "$APP.anterior"
  git -C "$CODIGO" reset --hard -q "$alvo"
  gravar_instalacao "$nova" "$ufw_atual"
  titulo "DMK ACS atualizado: $atual -> $nova"
else
  erro "A versão $nova não respondeu. Voltando para a $atual..."
  rm -rf "$APP"; mv "$APP.anterior" "$APP"
  systemctl restart dmk-acs-painel
  sleep 3
  saude_painel >/dev/null && aviso "Voltou para a $atual. Veja o motivo em: journalctl -u dmk-acs-painel -n 80" \
    || erro "O painel não respondeu nem na versão anterior: journalctl -u dmk-acs-painel -n 80"
  exit 1
fi
