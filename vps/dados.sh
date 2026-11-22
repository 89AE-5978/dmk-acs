#!/usr/bin/env bash
# DMK ACS - mostra os dados de acesso (VPS, como root):
#
#   bash /opt/dmk-acs/codigo-fonte/vps/dados.sh
#
# Painel público, código de primeiro acesso (enquanto não existir administrador), endereço dos
# roteadores e os dados para ligar o módulo no DMK Prisma (endereço interno + chave de integração).
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$AQUI/lib.sh"

[ "${1:-}" = "--sem-titulo" ] || titulo "DMK ACS - dados de acesso"
exigir_root
carregar_config

dominio="$(sed -n 's/.*"dominio": "\([^"]*\)".*/\1/p' "$INSTALACAO" 2>/dev/null)"
if [ -n "$dominio" ]; then
  esquema=http; [ -d "/etc/letsencrypt/live/$dominio" ] && esquema=https
  painel="$esquema://$dominio"
else
  painel="(sem domínio: só nesta VPS em http://127.0.0.1:$PORTA_PAINEL)"
fi
if grep -q '"ufw": \[ *\]' "$INSTALACAO" 2>/dev/null; then
  portas="portas $PORTA_CWMP e $PORTA_FS (TCP): libere no firewall do provedor da VPS, se houver"
else
  portas="portas $PORTA_CWMP e $PORTA_FS (TCP) liberadas no firewall (ufw) para os roteadores"
fi
roteadores="${DMK_ACS_ENDERECO_AVULSOS:-http://<ip-da-vps>:$PORTA_CWMP}"
chave="$(cat "$DADOS/segredo-integracao.txt" 2>/dev/null || echo '(o painel cria ao ligar)')"
if [ -f "$DADOS/primeiro-acesso.txt" ]; then
  primeiro="código $(cat "$DADOS/primeiro-acesso.txt")   (abra o painel e crie o seu usuário)"
else
  primeiro="já feito (entre com usuário, senha e o código do app autenticador)"
fi

cat <<EOF
  Painel (administração) .. $painel/admin/
  PRIMEIRO ACESSO ......... $primeiro
  App do cliente avulso ... $painel/app/
  ACS dos roteadores ...... $roteadores/<provedor>   (cliente avulso: $roteadores/c/<CÓDIGO>)
                            $portas

  Ligar no DMK Prisma (Central > módulo ACS):
    Endereço do ACS ....... http://127.0.0.1:$PORTA_PAINEL      (mesma VPS do Prisma)
    Chave de integração ... $chave
    (a chave também está em $DADOS/segredo-integracao.txt; só funciona de dentro da VPS)

  Atualizar / remover ..... curl -fsSL https://raw.githubusercontent.com/89AE-5978/dmk-acs/main/dmk-acs.sh | sudo bash
  Serviços ................ systemctl status 'dmk-acs-*'      Logs: journalctl -u dmk-acs-painel -f
EOF
