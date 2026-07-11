# 💨 Lista De Pods — Pedidos & Contabilidade em Tempo Real

Site somente para **pedidos** (sem preços públicos — cada cliente tem seu preço negociado), com estoque a pronta entrega em tempo real e contabilidade de lucro por pedido.

## Dois sócios, mesmo estoque

O sistema atende **2 sócios** que dividem a **mesma lista/estoque de pods**, mas têm
**clientes, preços, lucro e notificação separados**:

- **Estoque é único e compartilhado** — os dois veem e baixam do mesmo número. Um pedido de
  qualquer sócio desconta do mesmo estoque.
- **Cada sócio tem seu link de cadastro:** `SEU_DOMINIO/login/krauz` (sócio 1) e
  `SEU_DOMINIO/login/boss` (sócio 2). Quem se cadastra por um link **vira cliente daquele
  sócio** e só aparece no painel dele. No domínio pelado (`/`) só dá pra **logar** — criar
  conta exige o link do vendedor.
- **Painel por sócio:** cada sócio entra em `/admin` com o **seu próprio usuário e senha** e
  só vê os **seus** clientes, pedidos e contabilidade. Um sócio não enxerga nem mexe nos dados
  do outro.
- **Notificação separada:** cada sócio recebe o Pushcut dos **seus** pedidos/cadastros.
- Produtos, estoque e modelos (a lista de preços) são **compartilhados** — qualquer sócio
  importa/edita a lista; combinem quem cuida disso.

Os sócios (nome, slug do link, senha e URL de notificação) são configurados por variáveis de
ambiente — veja **[Configuração dos sócios](#configuração-dos-sócios-variáveis-de-ambiente)**.

## Fluxo

0. **Cliente novo cria a conta** na loja (nome, WhatsApp, usuário e senha) e fica **pendente**. O admin recebe notificação, abre a aba **Clientes** do painel, **preenche o preço de cada modelo para aquele cliente** (ex: V55 = R$ 55 para um, R$ 57 para outro) e aprova. Cadastros também podem ser recusados, e clientes aprovados podem ser bloqueados.
1. **Cliente** entra com usuário e senha e vê os produtos **com os preços dele** e a quantidade disponível. Monta o pedido, informa só o endereço (nome e WhatsApp vêm da conta) e **revisa tudo** — incluindo o total em R$ — antes de confirmar.
2. Ao enviar o pedido, **o estoque é reservado na hora** (as peças já saem do disponível) e uma **notificação é disparada** (Pushcut) para avisar que chegou pedido novo.
3. **Admin** recebe o pedido no painel (com aviso sonoro) e decide:
   - ✔ **Aceitar** → o estoque permanece abaixado (a reserva vira venda).
   - ✖ **Recusar** → a quantidade **volta ao estoque automaticamente**.
4. Após aceitar, o admin **lança o faturamento (quanto cobrou) e o custo do produto** — o sistema calcula o **lucro** automaticamente na planilha de contabilidade.
5. O cliente acompanha o status do pedido (pendente / aceito / recusado) na própria loja.

## Arquitetura (Vercel + Supabase)

O site roda na **Vercel** (arquivos estáticos na CDN + API em serverless functions) com os
dados no **Supabase (Postgres)**:

- `public/` — loja e painel (estáticos, servidos pela CDN da Vercel);
- `api/[[...path]].js` — toda a API `/api/*` numa function (região `iad1`, perto do banco);
- `lib/app.js` — o núcleo das rotas (o mesmo para Vercel e para `node server.js` local);
- `lib/db.js` — pool do Postgres; **toda mutação de estoque roda em transação com advisory
  lock**, o que impede venda duplicada mesmo com várias functions em paralelo;
- `scripts/migrate.js` — cria as tabelas (idempotente); `scripts/import-data.js` — importa um
  `data.json` legado para o banco;
- sessões (admin e cliente) e rate-limit ficam em tabelas (serverless não tem memória entre
  requests); o "tempo real" é polling leve de `/api/events` (versão dos dados).

## Como rodar localmente

```bash
npm install
# defina DATABASE_URL no ambiente ou num arquivo .env na raiz:
#   DATABASE_URL=postgresql://usuario:senha@host:6543/postgres
node server.js
```

- **Loja (cliente):** http://localhost:3000
- **Painel admin:** http://localhost:3000/admin

### Deploy na Vercel

```bash
vercel deploy --prod
```

Variáveis de ambiente necessárias no projeto da Vercel: `DATABASE_URL` (string de conexão do
pooler do Supabase, porta 6543) e as senhas dos sócios (`P1_PASSWORD`, `P2_PASSWORD`).

### Configuração dos sócios (variáveis de ambiente)

Cada sócio entra no painel (`/admin`) com o **seu próprio usuário e senha** e tem **nome** e
**URL de notificação (Pushcut)** próprios. Tudo por variáveis de ambiente (na Vercel, em
Settings → Environment Variables):

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `P1_USER` | Usuário do painel do **sócio 1** | `krauz` |
| `P1_PASSWORD` | Senha do painel do sócio 1. Aceita também `ADMIN_PASSWORD`. | `Krauz#` |
| `P1_NOTIFY` | URL de notificação (Pushcut) do sócio 1 | Pushcut embutido |
| `P1_NAME` | Nome exibido do sócio 1 | `Krauz` |
| `P2_USER` | Usuário do painel do **sócio 2** | `boss` |
| `P2_PASSWORD` | Senha do painel do sócio 2 | `Boss#` |
| `P2_NOTIFY` | URL de notificação (Pushcut) do sócio 2 | Pushcut embutido |
| `P2_NAME` | Nome exibido do sócio 2 | `Boss` |
| `DATABASE_URL` | String de conexão do Postgres (Supabase, pooler porta 6543) | — |
| `PORT` | Porta do servidor local | `3000` |

```bash
P1_USER=krauz P1_PASSWORD=senhaForte1 P1_NOTIFY="https://api.pushcut.io/TOKEN1/notifications/Pedido%20Gerado" \
P2_USER=boss  P2_PASSWORD=senhaForte2 P2_NOTIFY="https://api.pushcut.io/TOKEN2/notifications/Pedido%20Gerado" \
node server.js
```

> **Importante:** o painel controla estoque, preços e clientes — **sempre** defina
> `P1_PASSWORD` e `P2_PASSWORD` fortes em produção. Sem isso, são usadas senhas padrão
> embutidas (`Krauz#` / `Boss#`), que **não devem** ir para produção. Ao iniciar, o servidor
> imprime os links de cadastro de cada sócio e avisa se alguma senha ainda é a padrão.

O login do admin, o login do cliente e o cadastro têm **trava anti-força-bruta e
anti-flood por IP** (5 tentativas de senha erradas → bloqueio de 1 min; até 8 cadastros
por IP por minuto).

### Acessar pelo celular (mesma rede Wi-Fi)

Descubra o IP do computador:

```bash
ipconfig getifaddr en0
```

E acesse no celular: `http://SEU_IP:3000`

## Painel admin

- **Início (Dashboard)** — visão do dia e do mês: lucro, faturamento, pedidos pendentes, aguardando custo, **estoque baixo** (produtos acabando) e **mais vendidos**.
- **Pedidos** — três seções: aguardando aprovação (aceitar/recusar), aceitos sem lucro calculável, e histórico. Link direto para o WhatsApp do cliente e "Enviar resumo". Clique no pedido para ver detalhes e editar itens (estoque ajusta sozinho).
- **Clientes** — cadastros pendentes para aprovar/recusar (com a tabela de preços por modelo), e clientes aprovados com edição de preços e bloqueio.
- **Estoque** — importar lista, adicionar, editar, ativar/desativar e excluir produtos, com **busca, filtro por categoria (marca)** e botão **Copiar lista** (gera o texto com os estoques para colar no WhatsApp).
- **Contabilidade** — em tempo real: lucro, faturamento, custo, margem e a planilha de vendas. Na parte de **Configurações** cada sócio define o **seu link do Pushcut** e o **seu custo por peça (por modelo)**. Com o custo preenchido, o **lucro de cada pedido é calculado automaticamente** (faturamento pelo preço do cliente − custo por modelo), sem lançar nada à mão; ainda dá para ajustar um pedido específico quando quiser.

## Importar lista de estoque

Na aba **Estoque → Importar lista**, cole a lista no formato usado no WhatsApp:

```
-- MARCA DO POD

17 SABOR DO POD
40 OUTRO SABOR
```

- Linhas `-- MARCA` iniciam uma seção de marca/modelo.
- Linhas `quantidade sabor` viram produtos com o nome `MARCA – Sabor`.
- Qualquer outra linha (avisos, títulos) é ignorada e listada na conferência.

O sistema mostra um **resumo para conferência** (marcas, sabores, quantidades, novos × existentes, linhas ignoradas) e **só aplica depois que você aprovar**. Na aprovação você escolhe:

- **Substituir** o estoque pelo da lista (lista completa de inventário) ou **somar** ao atual (chegada de mercadoria);
- Opcionalmente **desativar** produtos do site que não estão na lista.

## Notificações de pedido (Pushcut)

Sempre que um pedido (ou cadastro) é gerado, o servidor envia um POST com `{ title, text }`
para o Pushcut **do sócio dono** daquele pedido/cliente — configurado em `P1_NOTIFY`
(sócio 1) e `P2_NOTIFY` (sócio 2). Assim cada sócio só recebe os avisos dos **seus** pedidos.

Como o código-fonte foi entregue, recomenda-se **gerar um novo token no Pushcut** para cada
sócio e passá-lo por `P1_NOTIFY` / `P2_NOTIFY`, em vez de manter o token embutido como padrão.

## Dados

Tudo fica no **Postgres do Supabase** (produtos, pedidos e clientes — senhas guardadas com
hash scrypt, nunca em texto). O Supabase mantém backups automáticos do banco. Para trazer um
`data.json` do sistema antigo (modo arquivo), use:

```bash
DATABASE_URL=... node scripts/import-data.js caminho/do/data.json
```

## Robustez do estoque

- **Estoque reservado no pedido, devolvido na recusa:** o pedido reserva o estoque na hora (pendente ou aceito seguram as peças); **recusar devolve** ao estoque; aceitar mantém.
- **Recontagem ciente de reserva:** ao "Substituir o estoque" por uma lista (ou editar o estoque de um produto), o número digitado é a **contagem física** (inclui o que está reservado). O disponível é `físico − reservado`, então recontar nunca cria unidades fantasma.
- **Conservação:** aceitar mantém a reserva; recusar devolve exatamente ao físico; editar itens ajusta pela diferença e recalcula o total pelos preços do cliente.
- **Preço congelado:** o preço de cada item é gravado no momento do pedido. Aceitar,
  recusar ou **editar itens** nunca altera o preço já fechado dos itens existentes — só
  itens novos adicionados na edição usam o preço atual do cliente.
- **Concorrência real (serverless):** toda mutação de estoque (pedido, edição, aceite,
  recusa, importação, recontagem) roda numa transação Postgres com **advisory lock** — mesmo
  com várias instâncias da function em paralelo, nunca se vende a mesma unidade duas vezes.
- **Segurança:** nomes de cliente/produto/marca são escapados no painel e na loja (sem
  injeção de HTML), inclusive na conferência da importação; o tempo real exige
  sessão; login do admin, login do cliente e cadastro têm trava anti-força-bruta/flood por
  IP; excluir um produto com pedido em aberto é bloqueado (para não perder a reserva);
  e, num aparelho compartilhado, o logout limpa carrinho e endereço para não vazarem ao
  próximo cliente.

## Testes automatizados

Há uma suíte de regressão que sobe o servidor contra **schemas isolados** (`podtest_*`) no
Postgres — nunca toca no schema `public` — e trava os invariantes de estoque, importação,
preço (incluindo o congelamento na edição), concorrência, autenticação, rate limit, XSS e um
fluxo completo de interface (cadastro → carrinho → pedido → admin aceita → contabilidade).
Rode com `bash tests/run-all.sh` (precisa de `DATABASE_URL` e do pacote `playwright` para as
partes de navegador).
