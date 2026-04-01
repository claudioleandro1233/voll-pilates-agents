// app.js — Servidor principal Voll Pilates Agents
// Registra rotas de todos os agentes e middlewares globais

require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const fs = require('fs');
const path = require('path');

// Cria pasta de logs se não existir
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ─── Importa agentes ─────────────────────────────────────────────────────────
const agentClientes    = require('./agents/agent-clientes');
const agentFinanceiro  = require('./agents/agent-financeiro');
const agentMarketing   = require('./agents/agent-marketing');
const agentOperacional = require('./agents/agent-operacional');
const agentSupervisor  = require('./agents/agent-supervisor');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares globais ──────────────────────────────────────────────────────

// Parse de body (Twilio envia form-urlencoded)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Rate limiting — 60 req/min por IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Aguarde um momento.' }
});
app.use('/webhook', limiter);

// Log de todas as requisições
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path} — IP: ${req.ip}`);
  next();
});

// ─── Rotas de webhooks (agentes) ─────────────────────────────────────────────
app.use('/webhook/clientes',    agentClientes);
app.use('/webhook/financeiro',  agentFinanceiro);
app.use('/webhook/marketing',   agentMarketing);
app.use('/webhook/operacional', agentOperacional);
app.use('/webhook/supervisor',  agentSupervisor);

// ─── Rota de saúde (health check) ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    studio: process.env.STUDIO_NAME || 'Voll Pilates Studio',
    versao: '1.0.0',
    ambiente: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    agentes: ['clientes', 'financeiro', 'marketing', 'operacional', 'supervisor']
  });
});

// ─── Rota raiz ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    app: '🧘 Voll Pilates Studio — Agentes IA',
    webhooks: {
      clientes:    '/webhook/clientes',
      financeiro:  '/webhook/financeiro',
      marketing:   '/webhook/marketing',
      operacional: '/webhook/operacional',
      supervisor:  '/webhook/supervisor'
    },
    saude: '/health'
  });
});

// ─── Handler de erros global ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Erro não tratado: ${err.message}\n${err.stack}`);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.path}` });
});

// ─── Inicia servidor ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 Voll Pilates Agents rodando na porta ${PORT}`);
  logger.info(`📡 Webhooks registrados:`);
  logger.info(`   POST /webhook/clientes`);
  logger.info(`   POST /webhook/financeiro`);
  logger.info(`   POST /webhook/marketing`);
  logger.info(`   POST /webhook/operacional`);
  logger.info(`   POST /webhook/supervisor`);
  logger.info(`   GET  /health`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM recebido. Encerrando servidor...');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT recebido. Encerrando servidor...');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  logger.error(`Exceção não capturada: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Promise rejeitada sem tratamento: ${reason}`);
});

module.exports = app;
