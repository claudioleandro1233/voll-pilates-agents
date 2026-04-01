# 🧘 Voll Pilates Studio — Agentes IA Autônomos

Sistema de 5 agentes WhatsApp para automatizar o estúdio **@vollpilatesautodromo**.

---

## Agentes

| Agente | Webhook | Responsabilidade |
|---|---|---|
| **Clientes** | `POST /webhook/clientes` | Agendamento, lembretes, CRM, NPS |
| **Financeiro** | `POST /webhook/financeiro` | Gastos, entradas, relatórios, inadimplentes |
| **Marketing** | `POST /webhook/marketing` | Posts IG, métricas, conteúdo |
| **Operacional** | `POST /webhook/operacional` | Estoque, manutenção, sábados |
| **Supervisor** | `POST /webhook/supervisor` | Dashboard diário, prioridades, status |

---

## Setup

### 1. Clonar e instalar

```bash
git clone <repo>
cd voll-pilates-agents
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com suas credenciais reais
```

### 3. Google APIs — Service Account

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Crie um projeto → ative **Sheets API**, **Calendar API**, **Drive API**
3. Crie uma **Service Account** → gere chave JSON
4. Salve em `credentials/google-service-account.json`
5. **Compartilhe** cada planilha/calendar com o e-mail da service account

### 4. Google Sheets — Estrutura das abas

Cada planilha precisa das abas abaixo (crie e compartilhe com a service account):

**Planilha Clientes** (`GOOGLE_SHEETS_CLIENTES_ID`):
- Aba `Clientes`: Data | Nome | WhatsApp | Email | Status | Plano | Observações
- Aba `NPS`: Data | WhatsApp | Nome | Nota | Comentário

**Planilha Financeiro** (`GOOGLE_SHEETS_FINANCEIRO_ID`):
- Aba `Transacoes`: Data | Tipo | Valor | Categoria | Descrição | WhatsApp Cliente

**Planilha Operacional** (`GOOGLE_SHEETS_OPERACIONAL_ID`):
- Aba `Estoque`: Item | Quantidade | Unidade | Última Atualização | Observações
- Aba `Manutencao`: Data | Item | Descrição | Status | Responsável

**Planilha Marketing** (`GOOGLE_SHEETS_MARKETING_ID`):
- Aba `Conteudo`: Data | Plataforma | Tipo | Legenda | Hashtags | Status
- Aba `Metricas`: Data | Plataforma | Seguidores | Alcance | Engajamento | Obs

**Planilha Logs** (`GOOGLE_SHEETS_LOGS_ID`):
- Aba `Logs`: Data | Agente | Nível | Mensagem | Detalhes

### 5. Twilio WhatsApp

1. Crie conta em [twilio.com](https://www.twilio.com)
2. Ative o **WhatsApp Sandbox** (ou número aprovado)
3. Configure o webhook no painel Twilio:
   - **URL:** `https://seu-app.vercel.app/webhook/clientes`
   - **Método:** POST

### 6. Rodar localmente

```bash
npm run dev
# ou
npm start
```

### 7. Testar sintaxe e parsers

```bash
npm test
```

---

## Deploy

### Vercel

```bash
npm i -g vercel
vercel --prod
```

Crie um `vercel.json`:
```json
{
  "version": 2,
  "builds": [{ "src": "app.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "/app.js" }]
}
```

> **Atenção:** Crons não funcionam em Vercel (serverless). Use Railway, Render ou Heroku para crons.

### Railway (recomendado para crons)

```bash
railway init
railway up
```

### Heroku

```bash
heroku create voll-pilates-agents
heroku config:set $(cat .env | xargs)
git push heroku main
```

---

## Exemplos de mensagens para testar cada webhook

### Agente Clientes (`/webhook/clientes`)

```
# Simular via curl:
curl -X POST http://localhost:3000/webhook/clientes \
  -d "From=whatsapp:+5511999998888&To=whatsapp:+14155238886&Body=oi&ProfileName=Teste"

# Fluxo de agendamento:
Body=agendar
Body=Maria Silva       # nome
Body=20/05             # data
Body=2                 # escolha do horário (2ª opção)
Body=SIM               # confirmação
```

### Agente Financeiro (`/webhook/financeiro`)

```
Body=gasto R$150 aluguel
Body=entrada R$80 aula
Body=recebei 200 mensalidade Ana
Body=relatório
Body=inadimplentes
```

### Agente Marketing (`/webhook/marketing`)

```
Body=gerar post
Body=post motivacional Comece o seu dia com Pilates!
Body=post dica Respiração é a chave do Pilates
Body=salvar
Body=métricas instagram 1580 seguidores 320 alcance
Body=conteúdo pendente
```

### Agente Operacional (`/webhook/operacional`)

```
Body=estoque colchonetes 10
Body=estoque 5 elásticos
Body=ver estoque
Body=manutenção reformer - trocar cabo de aço
Body=próximo sábado
```

### Agente Supervisor (`/webhook/supervisor`)

```
Body=dashboard
Body=prioridades
Body=erros
Body=status
```

---

## Crons automáticos

| Horário | Agente | Ação |
|---|---|---|
| Seg–Sáb 07:30 | Supervisor | Dashboard diário → dono |
| Seg–Sáb 08:00 | Clientes + Supervisor | Lembretes aulas + Prioridades |
| Seg–Sáb 12:00 | Clientes | NPS pós-aula |
| Seg–Sáb 11:30 | Supervisor | Encerramento do dia |
| Segunda 08:30 | Marketing | Sugestão de post da semana |
| Segunda 09:00 | Financeiro | Relatório semanal |
| Quarta 09:00 | Operacional | Alerta estoque baixo |
| Quinta 10:00 | Financeiro | Alerta inadimplentes |
| Sábado 07:00 | Operacional | Checklist de abertura |

---

## Estrutura de arquivos

```
voll-pilates-agents/
├── app.js                     # Servidor principal
├── package.json
├── .env.example
├── agents/
│   ├── agent-clientes.js      # Agendamento, CRM, NPS
│   ├── agent-financeiro.js    # Gastos, entradas, relatórios
│   ├── agent-marketing.js     # Posts, métricas, conteúdo
│   ├── agent-operacional.js   # Estoque, manutenção
│   └── agent-supervisor.js    # Dashboard, orquestração
├── utils/
│   ├── twilio.js              # WhatsApp API
│   ├── sheets.js              # Google Sheets CRUD
│   ├── calendar.js            # Google Calendar
│   ├── state.js               # Estado de conversas
│   └── logger.js              # Winston logger
├── credentials/               # google-service-account.json (gitignore!)
├── logs/                      # Logs automáticos (gitignore!)
└── test/
    └── simulate.js            # Testes de parsers/lógica
```

---

## Segurança

- Rate limit: 60 req/min por IP
- Variáveis sensíveis sempre em `.env` (nunca comitar)
- Adicione ao `.gitignore`: `credentials/`, `logs/`, `.env`
- Para produção, valide assinatura Twilio (descomentar `validarWebhookTwilio` no app.js)
