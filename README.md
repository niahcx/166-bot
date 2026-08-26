# 166 Community v13.0 Professional

Bot de vendas e atendimento para Discord, escrito em Node.js e TypeScript. Toda a administração operacional ocorre dentro do Discord pelo comando `/painel`.

## Sistemas incluídos

- Produtos publicados individualmente, com banner, descrição, campos, preço, demonstração, quantidade e entrega manual ou automática.
- Carrinho privado com revisão, quantidade, cupom, métodos de pagamento, QR Code, atualização de status e prevenção de cliques repetidos.
- Pagamentos PIX por Mercado Pago, Efí Bank, Stripe, MisticPay, Purin Cash, IMAP verificado e PIX manual.
- Adaptadores de gateway isolados, timeout, retry, idempotência, erros sanitizados e consulta de status.
- Avisos automáticos de restock em canal selecionável, com quantidade nova, total e histórico persistente.
- Entrega automática por estoque individual ou estoque fantasma.
- Os dois botões privados do pagamento retornam somente o PIX copia e cola bruto; chave/e-mail não são exibidos separadamente.
- Cupons com período, valor mínimo, limites globais e por usuário, escopo de produtos e histórico de usos aprovados.
- Painéis de tickets com menu ou botões, campos informativos, opções independentes, emoji por opção, categoria, cargos, mensagens e limites.
- Painéis públicos de tickets em um único Container V2, com banner, conteúdo e controles no mesmo bloco.
- Select de ticket reiniciado imediatamente após a escolha, inclusive quando abre modal.
- Validador recursivo de payload que bloqueia `custom_id` duplicado antes da API do Discord.
- Botão para notificar o cliente do ticket por menção e mensagem privada, com proteção contra spam.
- Vinculação opcional do ticket a uma compra do cliente antes de liberar o envio de mensagens.
- Pagamentos manuais sem expiração automática; permanecem pendentes até aprovação ou cancelamento da equipe.
- Produto automático entregue somente por mensagem privada, sem expor o conteúdo no canal do carrinho.
- Compositor de mensagens Components V2 com título, descrição, banner, miniatura, rodapé, emojis e botões de link.
- Fechamento e abertura automáticos de canais por horário, com seleção de canais e mensagens configuráveis.
- Permissões administrativas por usuário e cargo.
- Backups do servidor, bloqueio de canais, sorteios, automações, proteção, logs e pedidos de stock.
- Emojis da aplicação instalados e conferidos automaticamente na inicialização.
- Banco JSON v13 legível, atômico e dividido por servidor/sistema, incluindo histórico de gateway e restock.
- Administração normalizada em um Container Components V2, mantendo banner, conteúdo e controles no mesmo bloco.

## Requisitos

- Node.js 22 ou superior.
- Aplicação criada no Discord Developer Portal.
- Intents necessários habilitados no portal e nas permissões do convite.
- Permissão do bot para enviar mensagens, gerenciar canais, gerenciar cargos, ler histórico e usar componentes.
- Para instalar ou substituir emojis da aplicação, o token precisa pertencer à aplicação que executa o bot.

## Instalação

```bash
npm install
npm run build
npm start
```

O arquivo principal compilado é:

```text
dist/index.js
```

## Token

O token é lido exclusivamente de `Token.json`:

```json
{
  "token": "COLE_O_TOKEN_REAL_AQUI"
}
```

O bot interrompe a inicialização quando o arquivo estiver ausente, inválido ou com valor de exemplo. O token não é impresso nos logs.

## Configuração global

Edite `config/runtime.json`:

```json
{
  "clientId": "",
  "guildId": "",
  "ownerIds": ["SEU_ID_DO_DISCORD"],
  "databasePath": "database",
  "autoInstallEmojis": true,
  "emojiInstallLimit": 0,
  "logLevel": "info"
}
```

`guildId` pode ficar vazio para registrar os comandos globalmente. Durante testes, informar o ID do servidor acelera a atualização dos comandos.

## Credenciais privadas

Tokens financeiros, senhas IMAP e certificados ficam em `config/private-credentials.json`, separados por servidor. O painel de pagamentos grava essas informações nesse arquivo sem misturá-las com pedidos, tickets, produtos ou usuários.

O arquivo é ignorado pelo Git. Mantenha acesso restrito à pasta do projeto e aos backups da hospedagem.

## Banco de dados

Cada servidor possui a própria estrutura:

```text
database/<ID_DO_SERVIDOR>/
├── carrinhos/
├── cupons/
├── logs/
├── loja/
├── pagamentos/
├── produtos/
├── tickets/
├── usuarios/
└── backups/
```

Arquivos e diretórios ausentes são criados automaticamente. As gravações usam arquivo intermediário e renomeação atômica para reduzir risco de corrupção. A migração da estrutura antiga preserva o arquivo de origem.

## Tickets

Fluxo de configuração:

```text
/painel
→ Tickets
→ Criar ou selecionar painel
→ Campos do painel
→ Opções de atendimento
→ Publicar / atualizar
```

Cada opção permite configurar nome, descrição, emoji, categoria, cargos responsáveis, prefixo do canal, mensagem inicial, mensagem de encerramento, limite simultâneo, pedido de motivo e menção da equipe. É possível alterar a ordem e ativar ou desativar cada opção.

Ao publicar, o bot valida todas as opções ativas e monta um único Container V2. Banner, textos, campos e menu ou botões permanecem dentro do mesmo bloco. Um painel sem opções ativas não é publicado.

## Produtos e entrega automática

O título público utiliza exatamente o nome cadastrado, sem inserir emoji automaticamente. O painel público usa Components V2 e a identificação de entrega automática utiliza, sem alterações, os sete recortes enviados no `public.zip`. Eles são publicados lado a lado em um Text Display. Nenhum banner artificial é utilizado.

A sequência está em:

```text
assets/emojis/entrega-automatica/
```

Ordem aplicada:

```text
entrega0.png
entrega1.png
entrega2.png
entrega3.png
entrega4.png
entrega5.png
entrega6.png
```

Os IDs instalados são persistidos. A sincronização reutiliza emojis existentes, substitui arquivos alterados e informa falhas ou falta de capacidade da aplicação.

## Botões PIX de cópia

`Copiar PIX copia e cola` e `Copiar código PIX` respondem exatamente com `order.pixCode`, sem título, bloco de código, e-mail ou chave avulsa.

`Copiar produto` responde somente com a unidade específica entregue naquela compra, preservando todas as linhas cadastradas.

Os dois controles validam o comprador e o pedido antes de responder. Outro usuário não consegue acessar o conteúdo.

## Verificação local

```bash
npm run check
npm run build
npm run verify:assets
npm run test:smoke
npm run test:security
npm run test:payments
npm run test:audit
```

O relatório técnico atual está em `MELHORIAS_V13.md`. Os relatórios das versões anteriores foram mantidos para histórico.

## Exibição da entrega automática

Produtos automáticos usam os sete emojis `entrega0` a `entrega6` diretamente no Discord, exatamente na ordem do arquivo enviado. A frase aparece no cabeçalho do Components V2.

O botão de compra usa o emoji funcional `cart`. Para atualizar mensagens publicadas anteriormente, abra o produto no `/painel` e use **Atualizar mensagem**.
