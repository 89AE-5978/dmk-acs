#!/usr/bin/env bash
# DMK ACS - REMOVEDOR completo (VPS, como root).
#
#   bash /opt/dmk-acs/codigo-fonte/vps/remover.sh
#
# Opções: --salvar=/caminho/backup.tar.gz  guarda provedores, segredo e banco do ACS antes
#         --confirmar                       não pergunta (para scripts)
#         --manter-codigo                   mantém /opt/dmk-acs/codigo-fonte (usado pelo instalador)
#         --silencioso
#
# Remove SÓ o que o instalador criou: serviços dmk-acs-*, regras do firewall do módulo, usuário
# dmkacs, o site dmk-acs.conf do nginx e o certificado do domínio do painel (se instalado com
# --dominio) e a pasta /opt/dmk-acs. DMK Prisma, nginx e os outros sistemas da VPS não são tocados.
# Depois de remover, o DMK Prisma só deixa de mostrar o módulo ACS (o serviço some).
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$AQUI/lib.sh"

CONFIRMADO=0; SILENCIOSO=0; MANTER_CODIGO=0; SALVAR=""
for arg in "$@"; do
  case "$arg" in
    --confirmar) CONFIRMADO=1 ;;
    --silencioso) SILENCIOSO=1 ;;
    --manter-codigo) MANTER_CODIGO=1 ;;
    --salvar=*) SALVAR="${arg#*=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) falhar "Opção desconhecida: $arg" ;;
  esac
done
diz() { [ "$SILENCIOSO" -eq 1 ] || "$@"; }

exigir_root
# Trava de segurança: só apaga uma pasta chamada dmk-acs, nunca / ou outra coisa
case "$(basename "$RAIZ")" in dmk-acs) ;; *) falhar "Pasta do módulo inesperada: $RAIZ" ;; esac
[ "$RAIZ" != "/" ] || falhar "Pasta inválida."

diz titulo "DMK ACS - remoção completa"
if [ "$CONFIRMADO" -eq 0 ]; then
  cat <<EOF
  Vai ser removido:
    - serviços: $(ls "$SYSTEMD" 2>/dev/null | grep -E '^dmk-acs(-.*)?\.(service|target)$' | tr '\n' ' ')
    - pasta:    $RAIZ  (painel, GenieACS, MongoDB, provedores e o banco do ACS)
    - usuário:  $USUARIO
    - firewall: regras liberadas pelo módulo
    - nginx:    site dmk-acs.conf e o certificado do painel público (se houver)
  NÃO é tocado: DMK Prisma, nginx, conector, outros sistemas.
  Os roteadores dos clientes continuam funcionando; só deixam de ser gerenciados.
EOF
  [ -n "$SALVAR" ] || aviso "Sem --salvar=arquivo.tar.gz: provedores e histórico do ACS serão apagados de vez."
  read -r -p "  Digite REMOVER para confirmar: " resposta
  [ "$resposta" = "REMOVER" ] || { info "Nada foi feito."; exit 0; }
fi

# 1) Para os serviços (o banco fecha certinho antes do backup)
if command -v systemctl >/dev/null; then
  systemctl disable --now dmk-acs.target >/dev/null 2>&1 || true
  for s in "${SERVICOS[@]}"; do systemctl disable --now "dmk-acs-$s.service" >/dev/null 2>&1 || true; done
fi
diz ok "Serviços parados"

# 2) Backup opcional (fora da pasta do módulo, no caminho que você escolheu)
if [ -n "$SALVAR" ] && [ -d "$DADOS" ]; then
  case "$(readlink -m "$SALVAR")" in "$RAIZ"/*) falhar "Salve o backup fora de $RAIZ (ela será apagada)." ;; esac
  mkdir -p "$(dirname "$SALVAR")"
  tar -czf "$SALVAR" -C "$RAIZ" dados config $( [ -f "$INSTALACAO" ] && echo instalacao.json )
  diz ok "Backup salvo em $SALVAR"
fi

# 3) Regras do firewall que o módulo criou (lidas do instalacao.json)
if [ -f "$INSTALACAO" ] && command -v ufw >/dev/null; then
  for regra in $(grep -o '"[0-9]*/tcp"' "$INSTALACAO" | tr -d '"'); do
    ufw delete allow "$regra" >/dev/null 2>&1 && diz ok "Firewall: regra $regra removida" || true
  done
fi

# 3b) Painel público: site do nginx e certificado do domínio do módulo (só os do DMK ACS)
dominio="$( [ -f "$INSTALACAO" ] && sed -n 's/.*"dominio": "\([^"]*\)".*/\1/p' "$INSTALACAO" )"
if [ -e "$NGINX/sites-available/dmk-acs.conf" ] || [ -e "$NGINX/sites-enabled/dmk-acs.conf" ] || [ -e "$NGINX/dmk-acs-proxy.inc" ]; then
  rm -f "$NGINX/sites-enabled/dmk-acs.conf" "$NGINX/sites-available/dmk-acs.conf" "$NGINX/dmk-acs-proxy.inc"
  if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then nginx -s reload >/dev/null 2>&1 || true; fi
  diz ok "nginx: site dmk-acs.conf removido"
fi
if [ -n "$dominio" ] && command -v certbot >/dev/null; then
  certbot delete --cert-name "$dominio" --non-interactive >/dev/null 2>&1 && diz ok "Certificado de $dominio removido" || true
fi

# 4) Arquivos de serviço
removidos=0
for f in "$SYSTEMD"/dmk-acs.target "$SYSTEMD"/dmk-acs-*.service; do
  [ -e "$f" ] || continue
  rm -f "$f"; removidos=$((removidos + 1))
done
if command -v systemctl >/dev/null; then systemctl daemon-reload >/dev/null 2>&1 || true; systemctl reset-failed 'dmk-acs*' >/dev/null 2>&1 || true; fi
diz ok "Serviços do sistema removidos ($removidos arquivos)"

# 5) Processos que sobraram e usuário
if id "$USUARIO" >/dev/null 2>&1; then
  pkill -u "$USUARIO" >/dev/null 2>&1 || true
  sleep 1
  userdel "$USUARIO" >/dev/null 2>&1 || true
  diz ok "Usuário $USUARIO removido"
fi

# 6) Pasta do módulo
if [ -d "$RAIZ" ]; then
  if [ "$MANTER_CODIGO" -eq 1 ] && [ -d "$CODIGO" ]; then
    find "$RAIZ" -mindepth 1 -maxdepth 1 ! -name codigo-fonte -exec rm -rf {} +
    diz ok "Pasta $RAIZ limpa (código-fonte mantido)"
  else
    rm -rf "$RAIZ"
    diz ok "Pasta $RAIZ apagada"
  fi
fi

diz titulo "DMK ACS removido. Nada mais da VPS foi alterado."
