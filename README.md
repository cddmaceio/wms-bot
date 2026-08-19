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

### Opção 1 — Trigger agendado + HTTP Request

```
Cron (todo dia 6h) → HTTP POST /run → processa resultado
```

No nó HTTP Request do n8n:
- Method: `POST`
- URL: `https://wms-bot.seu-dominio.com/run`
- Body: `{ "date": "{{ $now.toFormat('yyyy-MM-dd') }}" }`
- Se tiver Basic Auth: adicione as credenciais

### Opção 2 — Webhook receptor (WEBHOOK_URL)

Configure `WEBHOOK_URL=https://seu-n8n.com/webhook/wms-csv` e o bot enviará automaticamente após cada download:

```json
{
  "source": "wms-bot",
  "fileName": "wms-separacao-2026-03-31.csv",
  "content": "MAPAS,PALETE,CAIXA,...\n566577,...",
  "sentAt": "2026-03-31T09:00:00.000Z"
}
```

No n8n, use um nó **Webhook** para receber, depois **Code** para parsear o CSV com `csv-parse` ou a biblioteca padrão.

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
