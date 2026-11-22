#!/usr/bin/env bash
# Teste do ATUALIZADOR e do REMOVEDOR numa "VPS de mentira" (pastas temporárias + systemd imitado).
# Não precisa de root de verdade nem de internet:  bash testes/teste-vps.sh
set -Eeuo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap '/usr/bin/pkill -f "$T/" 2>/dev/null || true; rm -rf "$T"' EXIT
export DMK_ACS_RAIZ="$T/opt/dmk-acs" DMK_ACS_SYSTEMD="$T/systemd" DMK_ACS_NGINX="$T/nginx"
RAIZ="$DMK_ACS_RAIZ"; LOG="$T/chamadas.log"
falha() { echo "FALHOU: $1"; echo "--- chamadas:"; cat "$LOG" 2>/dev/null; exit 1; }

# --- comandos do sistema imitados (registram a chamada); systemctl liga o painel de verdade
mkdir -p "$T/bin" "$DMK_ACS_SYSTEMD" "$T/opt/DMK-Prisma"
echo "nao mexer" > "$T/opt/DMK-Prisma/arquivo.txt"
echo "[Unit]" > "$DMK_ACS_SYSTEMD/dmk-prisma.service"     # serviço de OUTRO sistema: tem que ficar
mkdir -p "$T/nginx/sites-available" "$T/nginx/sites-enabled"
echo "server { server_name prisma; }" > "$T/nginx/sites-available/dmk-prisma.conf"; ln -s "$T/nginx/sites-available/dmk-prisma.conf" "$T/nginx/sites-enabled/dmk-prisma.conf"
echo "# painel" > "$T/nginx/sites-available/dmk-acs.conf"; ln -s "$T/nginx/sites-available/dmk-acs.conf" "$T/nginx/sites-enabled/dmk-acs.conf"; echo "# inc" > "$T/nginx/dmk-acs-proxy.inc"
for c in useradd userdel pkill ufw nginx certbot; do printf '#!/bin/sh\necho "%s $*" >> "%s"\n' "$c" "$LOG" > "$T/bin/$c"; done
cat > "$T/bin/id" <<'EOF'
#!/bin/sh
# nesta VPS de mentira: somos root e o usuário do módulo existe
[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }
[ "$1" = dmkacs ] && exit 0
exec /usr/bin/id "$@"
EOF
cat > "$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >> "$LOG"
if [ "\$1" = restart ] && [[ " \$* " == *" dmk-acs-painel "* ]]; then
  /usr/bin/pkill -f "$RAIZ/app/servidor/servidor.js" 2>/dev/null; sleep 0.3
  ( set -a; . "$RAIZ/config/acs.env"; set +a; nohup node "$RAIZ/app/servidor/servidor.js" >> "$T/painel.log" 2>&1 & )
fi
exit 0
EOF
chmod +x "$T/bin"/*
export PATH="$T/bin:$PATH"

# --- "GitHub": repositório com a versão 1.0.0
git init -q --bare "$T/origem.git"
git -C "$T" clone -q "$T/origem.git" trabalho 2>/dev/null
cp -a "$REPO/servidor" "$REPO/testes" "$REPO/vps" "$T/trabalho/"
echo 1.0.0 > "$T/trabalho/VERSION"
git -C "$T/trabalho" -c user.name=t -c user.email=t@t add -A
git -C "$T/trabalho" -c user.name=t -c user.email=t@t commit -qm v1.0.0
git -C "$T/trabalho" push -q origin HEAD:main 2>/dev/null
publicar() { echo "$1" > "$T/trabalho/VERSION"; git -C "$T/trabalho" -c user.name=t -c user.email=t@t commit -qam "$1"; git -C "$T/trabalho" push -q origin HEAD:main 2>/dev/null; }

# --- "instalação" 1.0.0 (o instalador real baixa MongoDB/GenieACS; aqui montamos o resultado dele)
mkdir -p "$RAIZ"/{dados,config,backups}
git clone -q -b main "$T/origem.git" "$RAIZ/codigo-fonte" 2>/dev/null
. "$REPO/vps/lib.sh"
PORTA_PAINEL=$((20000 + RANDOM % 20000))
publicar_app "$RAIZ/codigo-fonte" "$RAIZ/app"
cat > "$RAIZ/config/acs.env" <<EOF
GENIEACS_CWMP_PORT=7547
GENIEACS_FS_PORT=7567
GENIEACS_NBI_PORT=59999
GENIEACS_UI_PORT=7570
DMK_ACS_PORTA=$PORTA_PAINEL
DMK_ACS_INTERFACE=127.0.0.1
DMK_ACS_NBI=http://127.0.0.1:59999
DMK_ACS_DADOS=$RAIZ/dados
DMK_ACS_MODO=producao
DMK_ACS_PORTA_MONGODB=27117
EOF
echo '{"provedores":[{"id":"starnet","nome":"STARNET","enderecoAcs":"http://acs.starnet.com.br:7547/","ativo":true}]}' > "$RAIZ/dados/provedores.json"
gravar_instalacao 1.0.0 '"7547/tcp", "7567/tcp"' painel.dmk.teste
systemctl restart dmk-acs-painel
for _ in $(seq 1 20); do [[ "$(saude_painel)" == *1.0.0* ]] && break; sleep 0.5; done
[[ "$(saude_painel)" == *'"versao":"1.0.0"'* ]] || falha "painel 1.0.0 não subiu"
echo "ok  instalação simulada 1.0.0 no ar"

# 1) Já atualizado: não faz nada
[[ "$(bash "$RAIZ/codigo-fonte/vps/atualizar.sh")" == *"Já está na versão 1.0.0"* ]] || falha "deveria dizer que já está atualizado"
echo "ok  sem versão nova: nada a fazer"

# 2) Versão nova boa
publicar 1.0.1
bash "$RAIZ/codigo-fonte/vps/atualizar.sh" > "$T/saida.txt" || { cat "$T/saida.txt"; falha "atualização 1.0.1"; }
[[ "$(saude_painel)" == *'"versao":"1.0.1"'* ]] || falha "painel não ficou na 1.0.1"
grep -q '"versao": "1.0.1"' "$RAIZ/instalacao.json" || falha "instalacao.json"
grep -q '"7547/tcp", "7567/tcp"' "$RAIZ/instalacao.json" || falha "regras do firewall perdidas"
grep -q '"dominio": "painel.dmk.teste"' "$RAIZ/instalacao.json" || falha "domínio do painel perdido na atualização"
[[ "$(tar -tzf "$RAIZ/backups/ultimo.tar.gz")" == *dados/provedores.json* ]] || falha "backup sem provedores"
[ "$(ls "$RAIZ/backups")" = "ultimo.tar.gz" ] || falha "backup acumulando"
grep -q STARNET "$RAIZ/dados/provedores.json" || falha "provedores perdidos"
[ -f "$DMK_ACS_SYSTEMD/dmk-acs-painel.service" ] || falha "serviço não escrito"
echo "ok  1.0.0 -> 1.0.1 (backup único, provedores preservados)"

# 3) Versão que NÃO passa no teste: nada muda
echo "throw new Error('quebrado')" >> "$T/trabalho/servidor/lib/sessao.js"; publicar 1.0.2
if bash "$RAIZ/codigo-fonte/vps/atualizar.sh" > "$T/saida.txt" 2>&1; then falha "aceitou versão quebrada"; fi
grep -q "não passou no teste .*Nada foi alterado" "$T/saida.txt" || { cat "$T/saida.txt"; falha "mensagem do teste"; }
[[ "$(saude_painel)" == *'"versao":"1.0.1"'* ]] || falha "deveria continuar na 1.0.1"
echo "ok  1.0.2 quebrada recusada antes de trocar"

# 4) Versão que passa no teste mas NÃO sobe em produção: volta sozinha para a anterior
git -C "$T/trabalho" show HEAD~1:servidor/lib/sessao.js > "$T/trabalho/servidor/lib/sessao.js"   # volta o arquivo bom (da 1.0.1)
sed -i "1a if (require.main === module) process.exit(3);   // só quebra rodando como serviço" "$T/trabalho/servidor/servidor.js"
publicar 1.0.3
if bash "$RAIZ/codigo-fonte/vps/atualizar.sh" > "$T/saida.txt" 2>&1; then falha "não percebeu que a 1.0.3 não subiu"; fi
grep -q "Voltou para a 1.0.1" "$T/saida.txt" || { cat "$T/saida.txt"; falha "rollback"; }
[[ "$(saude_painel)" == *'"versao":"1.0.1"'* ]] || falha "rollback não deixou a 1.0.1 no ar"
[ "$(cat "$RAIZ/app/VERSION")" = 1.0.1 ] || falha "app não voltou"
echo "ok  1.0.3 não subiu: voltou sozinha para a 1.0.1"

# 5) Remoção completa com backup, sem tocar em mais nada
bash "$RAIZ/codigo-fonte/vps/remover.sh" --confirmar --salvar="$T/backup-final.tar.gz" > "$T/saida.txt" 2>&1 || { cat "$T/saida.txt"; falha "remover"; }
[ ! -e "$RAIZ" ] || falha "pasta do módulo ficou"
[[ "$(ls "$DMK_ACS_SYSTEMD")" == *dmk-acs* ]] && falha "serviço do módulo ficou"
[ -f "$DMK_ACS_SYSTEMD/dmk-prisma.service" ] || falha "APAGOU SERVIÇO DE OUTRO SISTEMA"
[ "$(cat "$T/opt/DMK-Prisma/arquivo.txt")" = "nao mexer" ] || falha "MEXEU NO DMK PRISMA"
[[ "$(tar -tzf "$T/backup-final.tar.gz")" == *dados/provedores.json* ]] || falha "backup final"
grep -q "ufw delete allow 7547/tcp" "$LOG" && grep -q "ufw delete allow 7567/tcp" "$LOG" || falha "regras do firewall"
grep -q "userdel dmkacs" "$LOG" || falha "usuário"
[ ! -e "$T/nginx/sites-available/dmk-acs.conf" ] && [ ! -e "$T/nginx/sites-enabled/dmk-acs.conf" ] && [ ! -e "$T/nginx/dmk-acs-proxy.inc" ] || falha "site do nginx do módulo ficou"
[ -f "$T/nginx/sites-available/dmk-prisma.conf" ] && [ -L "$T/nginx/sites-enabled/dmk-prisma.conf" ] || falha "APAGOU O SITE DO DMK PRISMA NO NGINX"
grep -q "certbot delete --cert-name painel.dmk.teste" "$LOG" || falha "certificado do painel não removido"
echo "ok  remoção completa: serviços, nginx e certificado do módulo (DMK Prisma intacto)"

# 6) Trava de segurança: removedor não apaga pasta com outro nome
if DMK_ACS_RAIZ="$T/opt" bash "$REPO/vps/remover.sh" --confirmar >/dev/null 2>&1; then falha "apagaria $T/opt"; fi
[ -d "$T/opt/DMK-Prisma" ] || falha "trava de segurança"
echo "ok  trava: só apaga pasta chamada dmk-acs"

echo "teste-vps: OK (todos os passos)"
