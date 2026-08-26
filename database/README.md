# Banco de dados por servidor

A pasta `modelo/` contém a estrutura v13 completa criada para cada servidor. Ela é documentação executável: todos os arquivos são JSON válidos e podem ser usados para conferência, mas o bot cria a pasta real automaticamente com o ID do servidor.

Durante a execução, o bot cria `database/<guildId>/` e mantém cada sistema em arquivos JSON separados. Credenciais financeiras, senhas e certificados ficam em `config/private-credentials.json`, nunca nos arquivos de pedidos, tickets, produtos ou usuários.

## Regras de escrita

- Diretórios e arquivos ausentes são criados automaticamente.
- Dados são normalizados antes de salvar.
- A gravação ocorre primeiro em arquivo intermediário e depois substitui o arquivo principal.
- A migração de estruturas anteriores preserva a origem.
- Cada servidor usa seu próprio diretório.
- Gateways registram somente metadados operacionais; chaves e secrets nunca entram no banco.
- Avisos de restock e tentativas de gateway possuem histórico próprio.

Não renomeie o diretório de um servidor enquanto o bot estiver em execução. Para editar um arquivo manualmente, pare o processo, faça uma cópia e mantenha o JSON válido.
