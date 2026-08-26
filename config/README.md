# Arquivos de configuração

- `runtime.json`: opções globais não confidenciais.
- `private-credentials.json`: credenciais privadas separadas por servidor.
- `private-credentials.example.json`: modelo vazio para consulta.

O token principal não fica nesta pasta. Ele é lido somente de `Token.json` na raiz do projeto.

O arquivo privado é criado automaticamente quando estiver ausente. Ele deve permanecer fora de repositórios e compartilhamentos.
