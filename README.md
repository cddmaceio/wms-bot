# WMS Bot — Central de operação

Aplicação Node.js 24 + TypeScript para consultar **Detalhes da Separação** no WMS, validar o CSV, importar os dados na API de conferência e notificar pelo WhatsApp. Agenda, histórico, configurações e filas ficam no SQLite. Não precisa de n8n nem Evolution/EvoAPI.

## Começar localmente

Requer Node.js 24. No PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Coloque o primeiro valor em `ADMIN_TOKEN` e o segundo em `SETTINGS_KEY`. São segredos diferentes. A chave deve ter exatamente 64 caracteres hexadecimais; guarde-a com o backup. Sem ela, configurações e snapshots existentes não podem ser recuperados.

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm ci
npx playwright install chromium
npm run build
npm start
```

Abra **http://127.0.0.1:3001** e informe o `ADMIN_TOKEN`. Configure acesso WMS e API no painel. Agenda, WhatsApp e envio começam desativados. O token da página fica apenas em memória; atualizar a página exige nova autenticação.

Os valores `WMS_*` e `APP_API_*` do ambiente inicializam a configuração na primeira abertura do banco. Depois disso, os valores salvos pelo painel têm prioridade, inclusive valores vazios. Alterar essas variáveis e reiniciar não substitui a configuração salva. Não apague o banco para alterar credenciais.

## Docker Compose e Coolify

O contêiner contém a aplicação e o processo auxiliar WhatsApp. Só a porta HTTP da aplicação é exposta; a comunicação interna usa IPC. O Chromium é instalado pela mesma versão Playwright do lockfile e compartilhado pelos dois componentes. As sessões de navegador são separadas.

Para teste local, depois de configurar `.env`:

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
docker compose logs --tail 100 wms
```

O override local publica `127.0.0.1:3001`. `LOCAL_PORT` altera a porta externa. Para parar preservando os dados: `docker compose stop`. Não use `down -v` para atualizar a aplicação: isso remove o volume.

No Coolify:

1. Criar aplicação Docker Compose usando `compose.yaml` deste repositório.
2. Informar `ADMIN_TOKEN` e `SETTINGS_KEY` nas variáveis privadas do recurso; não versionar `.env`.
3. Associar domínio HTTPS à porta interna **3001** do serviço `wms`.
4. Preservar o volume `wms-data:/data`, usar uma única réplica e evitar deploys com instâncias sobrepostas.
5. Reservar inicialmente 3 GB de memória e `/dev/shm` de 1 GB; medir o consumo na VPS antes de ajustar.
6. Após iniciar, configurar e homologar a operação no painel.

SQLite usa WAL, transações e `synchronous=FULL`. O lock do volume impede duas aplicações no mesmo diretório. Ele não é eleição distribuída: use armazenamento local em um único host, sem SQLite em NFS. O healthcheck monitora o worker e o agendador; desconexão do WhatsApp aparece no painel e não derruba a importação.

## Painel e fluxo

- **Visão geral:** saúde do processamento, WhatsApp, próxima consulta, horários perdidos, disco e auditoria.
- **Execuções:** consultar hoje ou uma data histórica, acompanhar etapas, baixar CSV/screenshot e reenviar um arquivo específico à API.
- **Configurações:** credenciais, destino, token Bearer opcional, fuso, timeouts e retenção.
- **Agenda:** dias e vários horários, sem reiniciar o serviço.
- **WhatsApp:** QR, destinatários, eventos de notificação, teste e conferência de resultados incertos.

Cada execução guarda um snapshot criptografado da configuração. Alterações posteriores valem para novas execuções. Um reenvio à API cria outra execução e usa a configuração atual, preservando o arquivo e o histórico anteriores.

O filtro de data precisa ser preenchido e conferido em ambos os campos. Antes de exportar, o bot aguarda a transferência completa da consulta `GET /api/outbound-reports/api/PalletItem/get-all`, com `initialDate` e `finalDate` correspondentes ao período solicitado. Respostas de configuração, telemetria ou requisições iniciadas antes da consulta não liberam o download. Mudanças no contrato WMS podem exigir ajustar `automation/date-filter.cjs`; o bot falha explicitamente quando não consegue confirmar a consulta.

O parser aceita CSV com BOM UTF-8, `;`, vírgula ou tabulação, aspas e campos multilinha. Exige `codigo_armazem`, `mapas`, `palete` e `codigo_item`, incluindo os nomes portugueses equivalentes. Chaves incompletas ou estrutura inválida bloqueiam o upload. Duplicatas usam essa combinação de campos; a última ocorrência prevalece. Cabeçalho válido sem registros resulta em `no_data` e não chama a API.

### Upload e recuperação

Preserva o contrato `POST /api/conference/upload` com `{ records, file_name }`. O relatório inteiro é enviado, e a API de conferência faz seus próprios lotes. O timeout inicial é de 120 segundos. Redirecionamentos HTTP não são seguidos para evitar transferir o token para outro destino.

HTTP 207 e listas `errors` são pendências, mesmo quando algum contador indica registros processados. Timeout, resposta não JSON, HTTP 500 sem confirmação e interrupção durante upload resultam em `uncertain`: pode haver dados gravados no destino. Não há retry automático de upload. Confira a aplicação destino antes de usar **Reenviar arquivo à API**.

Estados de execução: `queued`, `downloading`, `validating`, `uploading`, `completed`, `partial`, `failed`, `uncertain`, `no_data` e `downloaded` (arquivo validado, API não configurada). A notificação tem estado independente: importação concluída não significa mensagem confirmada.

Após reinício, jobs já enfileirados continuam. Download/validação interrompidos viram falha; o operador pode criar nova consulta. Upload interrompido vira incerto. Horários perdidos são registrados, sem disparo retroativo. A primeira inicialização dentro do minuto de um horário também não dispara esse horário.

O padrão da agenda é todos os dias às 06:00, com fuso `America/Maceio`, inicialmente desativada. A data da consulta é fixada quando o job entra na fila. Há apenas um download por vez; o agendador e os envios continuam independentes.

### WhatsApp

Habilite **WhatsApp**, salve e clique **Conectar / atualizar QR**. No telefone: Aparelhos conectados → Conectar aparelho. A sessão local é exclusiva deste projeto, não reutiliza a do Farol e não é apagada automaticamente quando desconecta.

Em Docker Linux, a aplicação reserva o perfil antes de abrir o Chromium. Após recriação do contêiner, ela verifica os processos e remove somente os marcadores transitórios de uma instância encerrada (`SingletonLock`, `SingletonSocket`, `SingletonCookie` e `DevToolsActivePort`). Cookies e dados de pareamento são preservados. Se houver um navegador usando o perfil ou a verificação não puder ser concluída, a recuperação é bloqueada. Após encerramento forçado, a reserva pode levar cerca de 30 segundos para expirar; não apague a pasta da sessão para contornar esse estado.

Cadastre um destinatário por linha: contatos com DDI+DDD+número e `@c.us`; grupos com seu ID exato e `@g.us`. Nomes de grupos não são identificadores. Para homologação, cadastre exclusivamente o destinatário de teste, ative envio e use **Enviar teste**. Essa ação envia uma mensagem real apenas após confirmação na tela.

Mensagens planejadas permanecem pendentes se envio estiver desativado ou WhatsApp desconectado. Habilitar o envio permite processar essas pendências. Confira a fila antes de ativar. Destinatários removidos são ignorados nos itens ainda pendentes.

`confirmed` indica ACK do servidor, não leitura. Falta de confirmação ou queda durante a tentativa resulta em `uncertain`, sem repetição automática. Outros itens desse destinatário aguardam a conferência. Depois de verificar no aparelho, escolha **Recebi**, **Não recebi: tentar** ou **Ignorar**, informando justificativa. A ação é auditada; mensagens já confirmadas não podem ser repetidas por esse controle. Uma pendência ainda não iniciada pode ser cancelada.

WhatsApp Web pode mudar independentemente do pacote. A versão 1.34.7 tem um patch de compatibilidade de chaves, adaptado do Farol, aplicado no build e verificado antes de ficar `ready`. O patch exige a versão exata; atualizações devem revisar e testar pareamento/envio. Não foi incorporado envio de mídia.

## API administrativa

Use `Authorization: Bearer ADMIN_TOKEN`. Apenas `/health`, a página de entrada e seus arquivos estáticos são públicos. Dados, QR, artefatos e operações exigem autenticação.

| Método / rota | Uso |
|---|---|
| GET `/health` | Saúde mínima; HTTP 503 se worker/agendador não estiver saudável |
| GET `/api/status` | Diagnóstico, próximos horários, slots e disco |
| GET / PUT `/api/settings` | Consultar/alterar configuração; segredos nunca retornam integralmente |
| GET `/api/jobs` | Últimas 100 execuções |
| POST `/api/jobs` | `{ "requestKey":"chave-exclusiva", "date":"2026-10-19" }`; data opcional |
| GET `/api/jobs/:id` | Estado, resultado, tentativas e mensagens |
| GET `/api/jobs/:id/artifacts/csv` | Download autenticado do CSV |
| GET `/api/jobs/:id/artifacts/screenshot` | Download autenticado da screenshot |
| POST `/api/jobs/:id/retry-upload` | `{ "confirmed":true, "requestKey":"outra-chave" }` |
| GET `/api/whatsapp/qr` | QR disponível e estado |
| POST `/api/whatsapp/connect` | Inicializar/reconectar sem apagar a sessão |
| POST `/api/whatsapp/test` | `{ "recipient":"DESTINATARIO_CADASTRADO", "confirmed":true, "requestKey":"teste-1" }` |
| GET `/api/deliveries` | Últimas 200 notificações |
| POST `/api/deliveries/:id/reconcile` | `{ "action":"confirm|retry|skip", "note":"justificativa", "confirmed":true }` |
| GET `/api/audits` | Últimas 100 ações auditadas |

POST de execução responde 202 ao criar, 200 para chave e parâmetros já existentes e 409 para reutilização conflitante. Novas execuções devem usar outra chave. O corpo JSON é limitado a 64 KB. Sem data explícita, usa hoje no fuso configurado; data futura ou inválida é rejeitada. Domingo=0 até sábado=6 na agenda.

## Backup, retenção e restauração

Conteúdo de `/data`: `wms.sqlite3` e WAL, `jobs/`, `wms-profile/`, `whatsapp/`, `whatsapp-cache/`, `logs/` e o lock do serviço. Credenciais e snapshots são criptografados com AES-256-GCM. CSVs, screenshots e sessões também contêm informações privadas: proteja o volume e seus backups.

Backup consistente apenas do banco, com a aplicação ativa:

```sh
docker compose exec wms node dist/backup.js /data/backup-wms.sqlite3
```

Copie o backup para armazenamento externo privado. Para backup completo, pare o serviço e copie o volume inteiro. Preserve `SETTINGS_KEY` separadamente. Não copie apenas o arquivo SQLite bruto enquanto houver transações ativas.

Para restaurar, mantenha a instância original parada, restaure o volume e use a mesma chave. Antes de iniciar, desative agenda e mensagens na base restaurada com o comando abaixo (a configuração salva tem prioridade sobre o ambiente):

```sh
docker compose run --rm wms node dist/restore-safe.js
```

Depois inicie uma única instância, confira histórico, pendências, destino e sessões e só então reative as opções pelo painel. Não execute a origem e sua cópia enviando simultaneamente.

A retenção padrão remove CSVs/screenshots após 30 dias, somente de execuções concluídas, sem dados, baixadas ou falhadas, e sem mensagens pendentes/incertas. Execuções com upload parcial/incerto são preservadas. Banco, auditoria e histórico não são apagados pela retenção. Logs da aplicação têm rotação de 5 MB × 5 arquivos mais o ativo; logs de automação também aparecem no stdout do contêiner. Acompanhe uso de disco no painel.

## Migração do bot anterior

1. Fazer backup dos volumes antigos e registrar as variáveis de integração.
2. Subir esta versão em homologação com volume separado; agenda e mensagens desativadas.
3. Configurar WMS e a API existente, homologar a consulta e conferir os dados importados.
4. Parear WhatsApp e testar somente o destinatário autorizado.
5. Desativar os workflows n8n antes de ativar a agenda nova. Remover dependências antigas somente após observar a operação.

As rotas síncronas antigas (`/run`, `/upload-last`, `/delete-files` e downloads globais) retornam HTTP 410 depois da autenticação. Clientes externos devem migrar para `/api/jobs` e acompanhar o ID. A tela nova já usa esse fluxo. Os arquivos de `n8n/` são apenas referência de migração e não são utilizados pela aplicação.

Para rollback, desative a agenda e mensagens novas, pare a nova aplicação e depois reative a versão/workflow anteriores com seus volumes originais. Não há mudança obrigatória no schema do banco de destino.

## Validação e limites

```sh
npm test
npm run test:ui
docker compose --env-file .env.example config --no-interpolate --quiet
```

Para repetir a validação da imagem no PowerShell, com Docker ativo:

```powershell
docker build -t wms-bot:local-validation .
.\scripts\validate-container.ps1
```

Esse teste usa contêiner e volume temporários exclusivos, sem rede externa, e verifica inicialização, Chromium, persistência após reinício, backup e preparação de restauração. Ao terminar, remove somente os recursos criados para o teste.

Os testes usam exportações simuladas, banco temporário e servidores locais. O teste de navegador exige `npx playwright install chromium`, gera capturas em `test-results/` e não consulta WMS nem envia mensagens.

Veja [docs/VALIDATION.md](docs/VALIDATION.md) para resultados, pendências e dependências. O deploy, login/exportação real, upload de produção e pareamento/entrega reais precisam ser homologados com os acessos da operação.
