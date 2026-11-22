# DMK ACS

Módulo de **gerenciamento remoto de roteadores (TR-069)** para provedores, integrado ao **DMK Prisma**.

- **Admin DMK (painel público `/admin/`):** usuário + senha + app autenticador. Seções Provedores, Clientes avulsos, Segurança e Conexão (DMK Prisma).
- **Central DMK (admin):** cadastra os provedores que usam o ACS, define o endereço do ACS de cada um, ativa e desativa o módulo.
- **Clientes avulsos ("DMK Wi-Fi"):** gerenciamento sem provedor. O cliente ganha um endereço de ACS com código próprio (`<base>/c/CÓDIGO`) e o **app DMK Wi-Fi** (`/app/`, instalável no celular) para trocar nome e senha do Wi-Fi e reiniciar.
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

## Segurança do painel público

- Senha em **scrypt** (sal aleatório), nunca em texto; regra de senha forte (10+ e 3 tipos de caractere).
- **App autenticador** (TOTP, RFC 6238) na entrada do admin, sem reuso de código; 8 **códigos de recuperação** de uso único.
- **Primeiro acesso** só com o código que fica no servidor (`dados/primeiro-acesso.txt` e no log): ninguém da internet cria o admin antes de você.
- **Bloqueio de conta**: 5 erros seguidos = 15 min (dobra a cada bloqueio, até 24 h). **Bloqueio de IP**: 10 erros em 15 min = 1 h (reincidente 24 h). Ritmo: 20 tentativas/min por IP. No nginx: 10 tentativas/min por IP nas rotas de entrada.
- Mensagens genéricas (não revela se o usuário existe); 2ª etapa presa ao IP; sessão do admin cai com 30 min sem uso.
- Cookies HttpOnly + SameSite=Strict (+ Secure em HTTPS); pedidos de outra origem recusados (anti-CSRF); CSP rígida; HSTS em HTTPS.
- Ações sensíveis (ver/trocar a chave do Prisma, senha, códigos) pedem o autenticador na hora.
- **Auditoria** em `dados/auditoria.log` (entradas, erros, bloqueios, trocas de Wi-Fi), sem senhas, com tamanho limitado.
- Painel público: instalar com `--dominio=painel.seudominio --email=voce@dominio` (nginx + certificado HTTPS; o removedor apaga só o que é do módulo).

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

## VPS: instalar, atualizar, remover (um comando só)

Antes: crie no DNS um registro **A** do domínio do painel (ex.: `acs.dmksolutions.io`) apontando para o IP da VPS. Na Cloudflare, deixe como **DNS only (nuvem cinza)**: com o proxy (nuvem laranja) os roteadores não chegam na porta 7547 e o bloqueio de IP veria só o IP da Cloudflare; o comando recusa e explica.

```bash
# >>> NA VPS (root) <<<
curl -fsSL https://raw.githubusercontent.com/89AE-5978/dmk-acs/main/dmk-acs.sh | sudo bash
```

- **Primeira vez:** pergunta só o **domínio**. Instala o que faltar (git, nginx, certbot, Node.js 20), baixa o código,
  instala tudo em `/opt/dmk-acs`, liga os serviços, publica o painel com **HTTPS** e mostra:
  o link do painel, o **código de primeiro acesso** (você cria seu usuário, senha e liga o app autenticador),
  o endereço dos roteadores e os dados para ligar no **DMK Prisma** (endereço interno + chave de integração).
- **Já instalado:** o mesmo comando mostra o menu **1) Atualizar · 2) Ver dados de acesso · 3) Remover**.
- Sem perguntas (para scripts): `... | sudo bash -s -- instalar --dominio=acs.exemplo.com.br`, `... -s -- atualizar`, `... -s -- dados`, `... -s -- remover --confirmar`.

O atualizador testa a versão nova antes de trocar, guarda um backup único (`/opt/dmk-acs/backups/ultimo.tar.gz`) e volta sozinho se não subir.
O removedor apaga só o que o módulo criou (serviços `dmk-acs-*`, usuário `dmkacs`, regras de firewall, site `dmk-acs.conf` do nginx e o certificado dele, a pasta `/opt/dmk-acs`); DMK Prisma e outros sistemas não são tocados.

Tudo do módulo fica em **`/opt/dmk-acs`** (painel, GenieACS, MongoDB próprio, dados, backup).

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
node testes/teste-seguranca.js  # login, autenticador, bloqueios de conta/IP, anti-CSRF, clientes avulsos e app
bash testes/teste-vps.sh        # atualizador e removedor numa VPS imitada (rollback, backup único, não toca no Prisma)
```

## Próximos passos

- Senha de conexão (CWMP) por provedor/cliente, além do endereço.
- Recuperação da senha do app pelo WhatsApp (conector DMK).
- Perfis por modelo para ONUs que fogem do padrão (testar com os modelos reais dos clientes).
- Ligação com o cadastro de clientes do DMK Prisma (nome do cliente pelo PPPoE) e o menu do módulo no Prisma.
