# WMS Bot · Detalhes da Separação

Bot Node.js + Playwright para download automático do relatório **Detalhes da Separação** do WMS Ambev (`wmst2.ambev.com.br`), com dashboard web e integração via webhook.

---

## Estrutura do projeto

```
wms-bot/
├── index.js        ← servidor Express + lógica Playwright
├── package.json
├── Dockerfile
└── README.md
```

---

## Deploy no Coolify

### 1. Conectar o GitHub ao Coolify (primeira vez)

- No Coolify, acesse **Settings → Source → GitHub**
- Clique em **Install GitHub App** e autorize a conta `cddmaceio` (repositorios `wms-bot`)
- Alternativa: usar um **Personal Access Token** (classic, escopo `repo`)
- Confirme que o source GitHub aparece conectado

### 2. Criar novo App no Coolify

- Acesse seu Coolify
- Clique em **+ New Resource → Application → GitHub**
- Selecione o repositório `cddmaceio/wms-bot`, branch `main`
- **Build Pack:** Dockerfile (auto-detectado pelo `Dockerfile` na raiz)

### 3. Variáveis de ambiente obrigatórias

No Coolify, vá em **Environment Variables** e adicione:

```env
# Credenciais WMS
WMS_USER=08749530496br1l         # seu usuário WMS
WMS_PASS=sua_senha_aqui

# Porta do serviço (diferente do bees-bot que usa 3000)
PORT=3001

# Caminhos internos (mapeados via volumes)
SESSION_FILE=/data/wms-profile/storageState.json
DOWNLOAD_DIR=/data/downloads

# Integração com Supabase Edge Function (opcional)
# URL base do projeto Supabase (Settings → API)
APP_API_URL=https://xxxxxxxxxxx.supabase.co
# anon key (Settings → API → anon public)
APP_API_TOKEN=suas_anon_key
# Endpoint da Edge Function (opcional)
APP_API_ENDPOINT=/functions/v1/processar-carga/bulk-upsert-with-maps
```

### 4. Persistent Storages (volumes)

Adicione dois volumes em **Storages → Persistent Storages**:

| Volume name       | Mount path           | Descrição                       |
|-------------------|----------------------|---------------------------------|
| `wms-profile`     | `/data/wms-profile`  | Persiste a sessão autenticada   |
| `wms-downloads`   | `/data/downloads`    | Armazena CSVs e screenshots     |

### 5. Porta e domínio

- Porta interna: `3001` (o Coolify detecta automaticamente pelo `EXPOSE` do Dockerfile)
- Crie um domínio em **Domains** apontando para a porta `3001` (SSL automático via Let's Encrypt)
- Ative **Basic Auth** no proxy do Coolify para proteger o painel

### 6. Deploy

- Clique em **Deploy** — o Coolify faz build + deploy automaticamente
- Na primeira vez, o build demora um pouco (instalação do Chromium do Playwright)
- A partir de então, todo **push no `main`** dispara novo deploy automático

---

## Como funciona

### Fluxo de execução (`POST /run`)

1. Carrega a sessão salva (`storageState.json`) se existir
2. Navega para `wmst2.ambev.com.br/wmsnew/#/separation/separation-details`
3. Verifica se está logado — se não estiver, faz login com `WMS_USER` + `WMS_PASS`
4. Salva automaticamente a sessão após login bem-sucedido
5. Preenche o filtro de data (período = hoje ou data informada)
6. Clica em **Consultar**
7. Clica no botão de **Download/Exportar**
8. Salva o CSV em `/data/downloads/wms-separacao-YYYY-MM-DD.csv`
9. Se `WEBHOOK_URL` estiver configurado, envia o CSV (conteúdo + metadata) via `POST JSON`
10. Tira screenshot de sucesso

### Sessão salva

Após o primeiro login bem-sucedido, a sessão é salva em `storageState.json`.  
Nas execuções seguintes, o bot reutiliza os cookies sem precisar logar novamente.  
Se a sessão expirar, o bot detecta e faz login automático novamente.

---

## Endpoints da API

| Método | Rota                | Descrição                                  |
|--------|---------------------|--------------------------------------------|
| GET    | `/`                 | Dashboard web                              |
| GET    | `/health`           | Status do serviço (JSON)                   |
| GET    | `/session-status`   | Se há sessão salva                         |
| POST   | `/run`              | Executa o fluxo de download                |
| GET    | `/files`            | Lista CSVs disponíveis (JSON)              |
| GET    | `/download-last`    | Baixa o CSV mais recente                   |
| GET    | `/view-last-csv`    | Visualiza o CSV mais recente (texto)       |
| GET    | `/view-debug-last`  | Visualiza última screenshot                |
| GET    | `/download-debug-last` | Baixa última screenshot               |
| POST   | `/delete-files`     | Apaga todos os CSVs e screenshots          |

### POST /run — payload

```json
{
  "date": "2026-03-31"
}
```
Se `date` não for enviado, usa a data de hoje.  
Aceita formatos: `yyyy-mm-dd` ou `dd/mm/yyyy`.

---

## Integração com n8n

Workflow importável: [`n8n/wms-bot-workflow.json`](n8n/wms-bot-workflow.json).

O workflow dispara o bot **todos os dias às 6h**, e o próprio bot baixa o CSV do WMS **e** envia para o Supabase (Edge Function `bulk-upsert-with-maps`) internamente. O n8n apenas checa o resultado e notifica no WhatsApp via Evolution API.

### Fluxo

```
[1] Agendamento diário às 6h   (cron 0 6 * * *)
        ↓
[2] Config                      (Set — variáveis/placeholders)
        ↓
[3] Executar Bot (baixar e enviar CSV)  (POST {BOT_URL}/run, onError: continue, timeout 10 min)
        ↓
[4] Executou com sucesso?       (IF $json.success === true)
   ├── sim → [5] Upload OK?      (IF $json.upload?.ok === true)
   │            ├── sim → [6] Notificar Sucesso (✅ mapas · registros · erros)
   │            └── não → [7] API não configurada?  (IF $json.upload == null)
   │                         ├── sim → [8] Notificar Sem API (ℹ️ APP_API_URL não configurada)
   │                         └── não → [9] Notificar Erro Upload (❌ upload.error/status)
   └── não → [10] Notificar Erro Execução (❌ error do /run)
```

O body do `POST /run` envia a data **do dia anterior** (às 6h o relatório do dia anterior está completo):

```json
{
  "date": "{{ $now.minus({days: 1}).toFormat('yyyy-MM-dd') }}"
}
```

### Nó `Config` (preencher após importar)

| Variável | Exemplo | Observação |
|---|---|---|
| `BOT_URL` | `http://wms-bot:3001` | Se n8n e bot estiverem na mesma rede Coolify, use o nome do serviço/container; senão a URL pública `http://IP:3001` |
| `EVOLUTION_BASE_URL` | `https://SEU-EVOLUTION.com.br` | URL da instância Evolution |
| `EVOLUTION_APIKEY` | `SEU-APIKEY` | API Key da instância Evolution |
| `EVOLUTION_NUMBER` | `5511999999999` | WhatsApp que recebe as notificações |

### Importação

1. No n8n: **Workflows → Import from File** → selecione `n8n/wms-bot-workflow.json`.
2. Preencha o nó **Config** com os valores reais.
3. Ative o workflow (o n8n roda o `POST /run` com a data de ontem).

### Notificações WhatsApp (Evolution API)

| Caso | Mensagem |
|---|---|
| ✅ Upload OK | `✅ WMS Bot — Detalhes da Separação importado.` + data, mapas, registros, erros, arquivo |
| ❌ Erro no upload | `❌ WMS Bot — falha no upload para a API.` + erro/status |
| ℹ️ Sem API | `ℹ️ WMS Bot — CSV baixado, mas APP_API_URL não configurada no bot.` |
| ❌ Erro na execução | `❌ WMS Bot — falha na execução.` + erro do `/run` |

---

## Ajuste fino do seletor de download

Se o botão de download do WMS não for encontrado automaticamente, inspecione o elemento no DevTools e ajuste os candidatos na função `clickDownloadBtn` em `index.js`.

Exemplo de seletor customizado para adicionar:
```javascript
page.locator('button[aria-label="Exportar CSV"]').first(),
page.locator('.export-btn').first(),
```

---

## Diferenças em relação ao BEES Bot

| Característica      | BEES Bot              | WMS Bot                   |
|---------------------|-----------------------|---------------------------|
| Autenticação        | Azure AD MFA          | Usuário + Senha simples    |
| Sessão MFA manual   | Sim (noVNC)           | Não necessário             |
| Login automático    | Não                   | Sim (via env vars)         |
| Porta               | 3000                  | 3001                       |
| Site                | bees-platform.com     | wmst2.ambev.com.br         |
