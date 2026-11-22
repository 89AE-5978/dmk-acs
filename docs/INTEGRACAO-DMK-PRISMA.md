# DMK ACS — integração com o DMK Prisma (API v1.2)

Documento de referência para quem programa o lado do **DMK Prisma**. O DMK ACS gerencia os roteadores
dos clientes por TR-069 (GenieACS por baixo) e o Prisma distribui o módulo para os provedores dele.

- Repositório: https://github.com/89AE-5978/dmk-acs (este arquivo: `docs/INTEGRACAO-DMK-PRISMA.md`)
- Instalação na VPS: `/opt/dmk-acs` (ver `README.md`, seção "VPS")
- Produção: VPS **srv2071960**, painel público **https://acs.danilodss.com.br**, CWMP `http://acs.danilodss.com.br:7547`

## 1. Como as peças se ligam

```
Navegador do operador ──HTTPS──> https://acs.danilodss.com.br/entrar?ticket=…   (abre o módulo do provedor)
Roteadores dos clientes ──TR-069──> http://acs.danilodss.com.br:7547/<código-do-provedor>/
DMK Prisma (Central e empresas) ──HTTP local──> http://127.0.0.1:7580/api/integracao/…  (Bearer <chave>)
```

- **Cada provedor tem um endereço de ACS próprio.** O roteador que usa esse endereço pertence àquele
  provedor e só ele vê/controla. Padrão criado pela API: `<endereço base>/<código>` → ex.:
  `http://acs.danilodss.com.br:7547/starnet/`. Um provedor também pode usar domínio próprio
  (`acs.starnet.com.br`, registro A para a VPS, nuvem cinza na Cloudflare).
- **O cliente do provedor é achado pelo login PPPoE** que o próprio roteador informa ao ACS.
  É a chave entre o contrato do Prisma e o roteador no ACS.
- **Clientes avulsos** (sem provedor, vendidos pela DMK) são do painel da DMK e do app DMK Wi-Fi;
  não passam pelo Prisma.

## 2. Autenticação e regras da API

- Base: `http://127.0.0.1:7580` (o ACS e o Prisma estão na mesma VPS). Porta em
  `/opt/dmk-acs/config/acs.env` (`DMK_ACS_PORTA`).
- Cabeçalho: `Authorization: Bearer <chave>`; corpo `Content-Type: application/json`.
- **Chave**: `/opt/dmk-acs/dados/segredo-integracao.txt` (64 hex). Também em
  `bash /opt/dmk-acs/codigo-fonte/vps/dados.sh` e no painel (Conexão → Mostrar chave, pede o autenticador).
  "Gerar chave nova" no painel invalida a anterior na hora.
- **Só local**: pedido que chega pelo nginx público (com `X-Real-IP`/`X-Forwarded-For`) recebe **404**,
  mesmo com a chave certa. Não exponha a API por proxy.
- Erros: JSON `{ "erro": "mensagem", "campo"?: "nome-do-campo" }`. 400 = dado inválido (o `campo`
  diz qual), 401 = chave errada, 403 = provedor desativado no ACS, 404 = não achado, 502/504 = ACS
  (GenieACS) fora do ar ou roteador não respondeu.
- Código do provedor (`:id`): `^[a-z0-9][a-z0-9-]{1,39}$` (minúsculas, números, hífen). Use um código
  estável da empresa no Prisma (ex.: o id da instalação/empresa).

## 3. Endpoints

| Método | Caminho | Uso |
|---|---|---|
| GET | `/api/integracao/info` | `{ versao, acs:{scriptsOk,erro}, enderecoBase, onlineMin }` — saúde e endereço base do CWMP |
| GET | `/api/integracao/provedores` | Lista: `[{ id, nome, ativo, enderecoAcs, roteadores, online, criadoEm, atualizadoEm }]` |
| GET | `/api/integracao/provedores/:id` | Um provedor (mesmo formato) |
| PUT | `/api/integracao/provedores/:id` | **Cria ou altera** (idempotente). Corpo `{ nome, ativo?, enderecoAcs? }`. 201 criou / 200 alterou |
| DELETE | `/api/integracao/provedores/:id` | Tira o provedor do ACS (empresa excluída). Os roteadores ficam sem dono |
| PUT | `/api/integracao/provedores/:id/clientes` | Nomes na lista do módulo: `{ clientes: { "login.pppoe": "NOME" } }` — **substitui** a lista (até 5 MB) |
| POST | `/api/integracao/ticket` | Link de entrada: `{ papel:"provedor", provedor:id, nome:"Operador" }` ou `{ papel:"central", nome }` → `{ caminho:"entrar?ticket=…" }` |
| GET | `/api/integracao/roteador?provedor=id&pppoe=login` | Roteador do assinante: `{ id, serial, fabricante, modelo, versao, pppoe, cliente, ssid, ip, ultimoContato, online }` |
| POST | `/api/integracao/wifi` | `{ provedor, pppoe, ssid, senha? }` → `{ situacao: "aplicado" \| "na-fila" }`. Senha vazia troca só o nome |
| POST | `/api/integracao/reiniciar` | `{ provedor, pppoe }` → `{ situacao }` |

Detalhes:
- `PUT /provedores/:id` sem `enderecoAcs` **na criação** usa `<enderecoBase>/<id>/`. Na alteração,
  campo omitido = mantém. `ativo:false` bloqueia o módulo do provedor (ticket 403, Wi-Fi/reinício 403,
  tela do provedor bloqueada) sem apagar nada.
- `enderecoAcs` é único: dois provedores não podem ter o mesmo. O caminho `/c/` é reservado aos avulsos.
- Wi-Fi: nome 1–32 caracteres ASCII; senha 8–63 ASCII (vazia = não muda). O ACS grava 2,4 GHz e 5 GHz
  com o mesmo nome/senha (redes de mesmo nome).
- `situacao: "aplicado"` = o roteador respondeu e gravou. `"na-fila"` = roteador não atendeu agora;
  o ACS aplica no próximo contato (até ~5 min com inform de 300 s). Mostre isso ao usuário.
- Tickets valem **60 s e uma vez só**. Abra no navegador `https://acs.danilodss.com.br/` + `caminho`
  (nova aba). Não use iframe: o cookie do ACS é do domínio dele.

## 4. Exemplos (na VPS)

```bash
# >>> NA VPS srv2071960 (root) <<<
K="$(cat /opt/dmk-acs/dados/segredo-integracao.txt)"; A=http://127.0.0.1:7580
curl -s -H "Authorization: Bearer $K" $A/api/integracao/info
curl -s -X PUT -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
     -d '{"nome":"STARNET TELECOM"}' $A/api/integracao/provedores/starnet
curl -s -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
     -d '{"papel":"provedor","provedor":"starnet","nome":"Maria (operadora)"}' $A/api/integracao/ticket
curl -s -H "Authorization: Bearer $K" "$A/api/integracao/roteador?provedor=starnet&pppoe=joao.silva"
```

## 5. Roteador do cliente do provedor (o que o provedor configura)

No roteador/ONU (tela TR-069 / Gerenciamento remoto): ACS URL = `enderecoAcs` do provedor; usuário e senha
do ACS em branco (o ACS não confere); Inform periódico ligado, 300 s. O roteador aparece no módulo do
provedor em até 5 min, com o login PPPoE lido do próprio equipamento. Portas que precisam estar abertas
na VPS: 7547 e 7567 (TCP) — já conferidas em produção.

## 6. Segurança (obrigatório no lado do Prisma)

- A chave fica só no servidor (configuração cifrada da Central, como os outros segredos). Nunca no
  navegador, em URL, log, print ou repositório.
- O backend do Prisma confere a permissão do usuário e o módulo da empresa **antes** de chamar o ACS;
  o ACS confia no Prisma para dizer de qual provedor é o pedido.
- Registre na auditoria do Prisma quem trocou Wi-Fi/reiniciou (o ACS também registra em
  `/opt/dmk-acs/dados/auditoria.log`).
