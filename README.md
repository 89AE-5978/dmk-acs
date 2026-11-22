# DMK ACS

Módulo de **gerenciamento remoto de roteadores (TR-069)** para provedores, integrado ao **DMK Prisma**.

- **Central DMK (admin):** cadastra os provedores que usam o ACS, define o endereço do ACS de cada um, ativa e desativa o módulo.
- **Provedor:** vê os roteadores dos clientes dele em lista, troca **nome e senha do Wi-Fi** com dois campos, reinicia, e tem o passo a passo para conectar os roteadores.
- **Separação entre provedores:** cada provedor tem o seu endereço (ex.: `acs.starnet.com.br`). O roteador fica com o provedor pelo endereço do ACS gravado **nele**. Um provedor nunca vê nem comanda roteador de outro.
- Por baixo roda o **GenieACS** (motor TR-069 de código aberto), que fica escondido: ninguém precisa usar a tela técnica dele.

```
DMK Prisma ──ticket──▶ DMK ACS (painel, :7580) ──NBI──▶ GenieACS (:7557) ◀──CWMP :7547── roteadores
```

## Como o roteador vira "do provedor"

O painel grava no GenieACS o provision `dmk` (roda em toda conexão do roteador). Ele lê `ManagementServer.URL` do roteador, tira a **chave** (host sem porta + caminho) e põe a marca `dmk_<chave>`:

| Endereço do ACS no roteador | Marca |
|---|---|
| `http://acs.starnet.com.br:7547/` | `dmk_acs_starnet_com_br` |
| `http://127.0.0.1:7547/starnet` (simulação) | `dmk_127_0_0_1_starnet` |

O painel só lista e só comanda roteadores com a marca do provedor logado (conferido também em cada comando).

## Wi-Fi em qualquer modelo (parâmetros virtuais)

O painel só conhece três coisas: `dmk_pppoe`, `dmk_wifi_ssid` e `dmk_wifi_senha` (parâmetros virtuais do GenieACS). Os scripts em `servidor/lib/scripts-genieacs.js` traduzem para o lugar certo de cada modelo:

- TR-098 (`InternetGatewayDevice...WLANConfiguration.N`) e TR-181 (`Device.WiFi...`);
- grava na rede principal **e nas de mesmo nome** (2,4 + 5 GHz iguais); rede de visitante fica de fora;
- senha: grava só no campo que o modelo tem (`KeyPassphrase`, `PreSharedKey.1.KeyPassphrase` ou `PreSharedKey.1.PreSharedKey`). A leitura volta vazia, então a senha não fica guardada no banco do ACS.
- O cliente é reconhecido pelo **login PPPoE** lido do roteador.

Comando para roteador que não atende na hora (desligado, atrás de CGNAT) fica na fila do ACS e é aplicado no próximo contato (inform a cada 5 min). Se o roteador **recusar** o comando, o painel mostra o motivo e limpa o comando.

## Integração com o DMK Prisma

O painel não tem usuário/senha próprios: quem entra é o DMK Prisma, que já autenticou a pessoa.

1. O DMK Prisma guarda o **segredo de integração** (`/opt/dmk-acs/dados/segredo-integracao.txt`).
2. Para abrir o módulo, o Prisma pede um ticket (vale 60 s, uso único):
   ```
   POST http://127.0.0.1:7580/api/integracao/ticket
   Authorization: Bearer <segredo>
   {"papel":"central","nome":"Danilo"}            # Central DMK
   {"papel":"provedor","provedor":"starnet","nome":"Operador"}   # empresa (provedor)
   → {"caminho":"entrar?ticket=..."}
   ```
   e abre `<prefixo do módulo>/` + `caminho` (o Prisma faz proxy de `/modulos/acs/` para `127.0.0.1:7580`; as telas usam caminhos relativos e funcionam em qualquer prefixo).
3. O Prisma mostra o módulo só para provedores ativos: `GET /api/integracao/provedores` (Bearer).
4. Central do assinante / robô do WhatsApp trocam o Wi-Fi do cliente pelo login PPPoE:
   ```
   POST /api/integracao/wifi   (Bearer)
   {"provedor":"starnet","pppoe":"starnet.joao","ssid":"CASA","senha":"12345678"}
   ```
5. Nome do cliente na lista: arquivo `dados/clientes.json` (`{"login.pppoe":"NOME"}`), mantido pela integração.

Se o módulo for removido da VPS, o Prisma só deixa de mostrar o menu (o serviço some).

## VPS: instalar, atualizar, remover

Tudo do módulo fica em **`/opt/dmk-acs`** (painel, GenieACS, MongoDB próprio, dados, backup). Fora dela só os serviços `dmk-acs-*` do systemd, o usuário de sistema `dmkacs` e as regras de firewall das portas dos roteadores.

```bash
# >>> NA VPS (root) <<<
git clone <repositório dmk-acs> /opt/dmk-acs/codigo-fonte
bash /opt/dmk-acs/codigo-fonte/vps/instalar.sh      # confere sistema, Node, disco e portas antes de mexer
bash /opt/dmk-acs/codigo-fonte/vps/atualizar.sh     # testa a versão nova antes, backup único, volta sozinho se não subir
bash /opt/dmk-acs/codigo-fonte/vps/remover.sh       # remove tudo do módulo; --salvar=/caminho.tar.gz guarda os dados antes
```

| Porta | Uso | Acesso |
|---|---|---|
| 7547 | CWMP: roteadores conectam aqui | pública |
| 7567 | arquivos (firmware) para os roteadores | pública |
| 7557 | API do GenieACS (NBI) | só 127.0.0.1 |
| 7570 | tela técnica do GenieACS | só 127.0.0.1 (túnel SSH) |
| 7580 | painel DMK ACS | só 127.0.0.1 (Prisma faz proxy) |
| 27117 | MongoDB do módulo | só 127.0.0.1 |

O instalador recusa porta ocupada e diz quem está usando; todas podem ser trocadas (`--porta-painel=...`).

## Testes

```bash
node testes/teste-servidor.js   # painel + GenieACS imitado: separação, ativar/desativar, Wi-Fi, recusa, tickets, integração
bash testes/teste-vps.sh        # atualizador e removedor numa VPS imitada (rollback, backup único, não toca no Prisma)
```

## Próximos passos

- Senha de conexão (CWMP) por provedor, além do endereço.
- Perfis por modelo para ONUs que fogem do padrão (testar com os modelos reais dos clientes).
- Ligação com o cadastro de clientes do DMK Prisma (nome do cliente pelo PPPoE) e o menu do módulo no Prisma.
