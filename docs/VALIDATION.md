# Validação da refatoração

## Verificações executadas

- Compilação TypeScript aprovada.
- 49 testes automatizados aprovados: parser CSV, datas, criptografia, API autenticada, fila, concorrência, upload parcial/incerto, reenvio sem download, agenda, recuperação após reinício, retenção, backup, processo WhatsApp desativado, locks de volume/perfil e confirmação de mensagens. A regressão do filtro usa o endpoint e os parâmetros observados no WMS real, incluindo datas com espaço antes do horário, respostas alheias, datas divergentes, falhas de rede e transferência interrompida. Os testes antigos de login/download foram preservados.
- Teste Playwright do painel aprovado: login, configuração, agenda, consulta simulada, download autenticado, detalhes, WhatsApp, logout e ausência de rolagem horizontal em 390 px.
- Capturas locais: `test-results/painel-desktop.png` e `test-results/painel-mobile.png`.
- Definição Compose validada com `docker compose --env-file .env.example config --no-interpolate --quiet`.
- Imagem Docker construída em Linux amd64 com Node.js 24, SQLite nativo e Chromium.
- Teste de contêiner aprovado com `--network none`: saúde HTTP, autenticação, SQLite WAL, IPC WhatsApp desativado, navegador, persistência das configurações após reinício, backup e preparação da restauração com agenda/envios desativados.
- O contêiner e o volume temporários foram removidos após o teste. A imagem local de validação permanece disponível.

Os números finais dos testes estão no resultado da execução de `npm test`. A suíte automatizada usa dados simulados e não envia mensagens externas nem utiliza credenciais reais. A homologação WMS abaixo foi executada separadamente, com a sessão local da operação.

## Homologação pendente

O Docker Desktop estava inicialmente parado; após inicialização, o build e o teste Linux amd64 foram aprovados. Não houve deploy na VPS. Se o servidor usa ARM64, é necessário homologar o build e a execução nessa arquitetura.

A investigação do timeout local confirmou uma consulta real HTTP 200 em `/api/outbound-reports/api/PalletItem/get-all`, com `initialDate` e `finalDate` correspondentes ao dia solicitado. A versão inicial procurava `separation`/`separacao` na URL e ignorava essa resposta, causando timeout mesmo com a tela preenchida. A correção associa a resposta a uma requisição nova do endpoint real e confere ambas as datas, sem usar telemetria ou configurações como sinal de conclusão.

O WMS envia datas no formato `AAAA-MM-DD HH:mm:ss`, com espaço antes do horário. Após contemplar esse formato, a validação isolada no contêiner concluiu consulta e download reais de 20/10/2026. O CSV foi interpretado com 2.252 registros únicos e 7 duplicatas removidas. Os artefatos privados ficam em `/data/diagnostics/`; esse teste não cria execução no histórico do painel nem chama API de destino ou WhatsApp. O contêiner local foi reconstruído e recriado preservando o volume.

Importação na API de produção e entrega real de mensagens WhatsApp continuam fora desta validação. O diagnóstico reutiliza apenas a sessão WMS local e não aciona o destino nem o envio de mensagens.

## Dependências WhatsApp

Foi identificado um bloqueio Chromium remanescente de um contêiner anterior no perfil LocalAuth persistente. A recuperação passa a adquirir uma reserva exclusiva e verificar `/proc` antes de remover apenas os marcadores transitórios. Os testes verificam preservação dos cookies, recusa quando há navegador ativo, falha sem acesso aos processos e exclusão entre instâncias. O encerramento do processo auxiliar ganhou prazo para fechar o navegador e liberar a reserva.

A correção foi aplicada ao contêiner local com a fila ociosa e o envio desativado. O log confirmou `profile_lock_recovered`; em seguida, a API retornou `whatsapp.state=qr`, `ready=false` e `lastError=null`. Esse estado disponibiliza o pareamento pelo painel, mas não comprova uma sessão já pareada nem entrega de mensagens. Nenhuma mensagem foi enviada nessa verificação.

`npm audit` encontrou nove entradas de severidade alta na cadeia de `whatsapp-web.js` → Puppeteer, envolvendo `extract-zip` e `basic-ftp`. A tentativa `npm audit fix`, sem `--force`, não resolveu. A sugestão automática envolve downgrade incompatível de WhatsApp e não foi aplicada.

Referências: [extract-zip](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), [basic-ftp](https://github.com/advisories/GHSA-c475-qrg2-pj4r). O aplicativo não recebe ZIPs de navegadores nem usa FTP e o Puppeteer não baixa seu próprio navegador; isso reduz esses caminhos de exposição, mas não elimina os avisos do lockfile.

O patch local de chaves é versionado em `bridge/patch-wwebjs.cjs`, exige whatsapp-web.js 1.34.7 e é testado com a estrutura real instalada. Não habilita automaticamente envios incertos. Qualquer atualização exige revisar o patch e homologar sessão, retorno de identificador e ACK no aparelho.

Documentação primária: [LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html), [eventos do cliente](https://docs.wwebjs.dev/Client.html), [Playwright em Docker](https://playwright.dev/docs/docker).
