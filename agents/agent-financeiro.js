// agents/agent-financeiro.js — Agente Financeiro
// Responsável: Registro gastos, entrada/saída, relatórios semanais, alertas inadimplentes

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/zapi');
const { Financeiro, Clientes, Logs } = require('../utils/sheets');
const logger = require('../utils/logger');

const router = express.Router();

const DONO_WHATSAPP = () => process.env.DONO_WHATSAPP;

// ─── Categorias válidas ──────────────────────────────────────────────────────
const CATEGORIAS_ENTRADA = ['aula', 'mensalidade', 'avulsa', 'pacote', 'outros'];
const CATEGORIAS_SAIDA = [
  'aluguel', 'energia', 'agua', 'internet', 'material', 'manutencao',
  'marketing', 'equipamento', 'salario', 'impostos', 'outros'
];

// ─── Parsers de mensagem ─────────────────────────────────────────────────────

/**
 * Parser: "gasto R$150 aluguel" ou "gasto 150 aluguel"
 * Retorna { valor, categoria } ou null
 */
function parsearGasto(mensagem) {
  const regex = /gasto\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s+(.+)/i;
  const match = mensagem.match(regex);
  if (!match) return null;

  const valor = parseFloat(match[1].replace(',', '.'));
  const categoria = match[2].trim().toLowerCase();
  return { valor, categoria };
}

/**
 * Parser: "entrada R$80 aula Ana" ou "pago 80 mensalidade"
 */
function parsearEntrada(mensagem) {
  const regex = /(?:entrada|receb[ei]+|pago|pagou|pag[ou]+)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s+(\w+)(?:\s+(.+))?/i;
  const match = mensagem.match(regex);
  if (!match) return null;

  const valor = parseFloat(match[1].replace(',', '.'));
  const categoria = match[2].trim().toLowerCase();
  const descricao = match[3]?.trim() || '';
  return { valor, categoria, descricao };
}

/**
 * Parser: "inadimplentes" ou "quem não pagou"
 */
function pedirInadimplentes(mensagem) {
  return /inadimplente|não pagou|nao pagou|em atraso|devendo/i.test(mensagem);
}

/**
 * Parser: "relatório" ou "resumo" ou "saldo"
 */
function pedirRelatorio(mensagem) {
  return /relat[oó]rio|resumo|saldo|quanto\s+(?:entr|sai|fiz)|movimentac/i.test(mensagem);
}

// ─── Skills ──────────────────────────────────────────────────────────────────

/**
 * Skill: Registrar gasto
 */
async function registrarGasto(de, dados) {
  await Financeiro.registrarTransacao({
    tipo: 'saída',
    valor: dados.valor,
    categoria: dados.categoria,
    descricao: dados.descricao || '',
    whatsapp: de
  });

  await Logs.registrar('FINANCEIRO', 'INFO', `Saída: R$${dados.valor.toFixed(2)} - ${dados.categoria}`);
  return (
    `✅ *Saída registrada!*\n\n` +
    `💸 Valor: *R$ ${dados.valor.toFixed(2)}*\n` +
    `🏷️ Categoria: *${dados.categoria}*\n` +
    `📅 Data: *${new Date().toLocaleDateString('pt-BR')}*`
  );
}

/**
 * Skill: Registrar entrada
 */
async function registrarEntrada(de, dados) {
  await Financeiro.registrarTransacao({
    tipo: 'entrada',
    valor: dados.valor,
    categoria: dados.categoria,
    descricao: dados.descricao || '',
    whatsapp: de
  });

  await Logs.registrar('FINANCEIRO', 'INFO', `Entrada: R$${dados.valor.toFixed(2)} - ${dados.categoria}`);
  return (
    `✅ *Entrada registrada!*\n\n` +
    `💰 Valor: *R$ ${dados.valor.toFixed(2)}*\n` +
    `🏷️ Categoria: *${dados.categoria}*\n` +
    `📅 Data: *${new Date().toLocaleDateString('pt-BR')}*`
  );
}

/**
 * Skill: Relatório semanal
 */
async function gerarRelatorio() {
  const resumo = await Financeiro.resumoSemanal();

  const emoji = resumo.saldo >= 0 ? '📈' : '📉';
  return (
    `${emoji} *Relatório Financeiro Semanal*\n` +
    `_Semana iniciada em ${resumo.semana}_\n\n` +
    `💰 Entradas: *R$ ${resumo.entradas.toFixed(2)}*\n` +
    `💸 Saídas: *R$ ${resumo.saidas.toFixed(2)}*\n` +
    `━━━━━━━━━━━━━━\n` +
    `📊 Saldo: *R$ ${resumo.saldo.toFixed(2)}*\n\n` +
    `📅 Gerado em: ${new Date().toLocaleString('pt-BR')}`
  );
}

/**
 * Skill: Listar inadimplentes
 */
async function listarInadimplentes() {
  const lista = await Clientes.listarInadimplentes();

  if (!lista || lista.length === 0) {
    return `✅ Nenhum cliente inadimplente no momento! 🎉`;
  }

  const nomes = lista.map(c => `• ${c[1]} — ${c[2]}`).join('\n');
  return `⚠️ *Clientes inadimplentes (${lista.length}):*\n\n${nomes}`;
}

/**
 * Skill: Ajuda financeiro
 */
function ajuda() {
  return (
    `💼 *Agente Financeiro — Comandos:*\n\n` +
    `📝 Registrar gasto:\n  _gasto R$150 aluguel_\n  _gasto 80 material_\n\n` +
    `💰 Registrar entrada:\n  _entrada R$80 aula_\n  _recebei 200 mensalidade_\n\n` +
    `📊 Ver relatório:\n  _relatório_ ou _saldo_\n\n` +
    `⚠️ Inadimplentes:\n  _inadimplentes_`
  );
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
async function processarMensagem(de, mensagem) {
  const msgLower = mensagem.toLowerCase().trim();

  // Registrar gasto
  const dadosGasto = parsearGasto(mensagem);
  if (dadosGasto) {
    if (dadosGasto.valor <= 0) return `⚠️ Valor inválido. Ex: _gasto R$150 aluguel_`;
    return registrarGasto(de, dadosGasto);
  }

  // Registrar entrada
  const dadosEntrada = parsearEntrada(mensagem);
  if (dadosEntrada) {
    if (dadosEntrada.valor <= 0) return `⚠️ Valor inválido. Ex: _entrada R$80 aula_`;
    return registrarEntrada(de, dadosEntrada);
  }

  // Relatório
  if (pedirRelatorio(msgLower)) {
    return gerarRelatorio();
  }

  // Inadimplentes
  if (pedirInadimplentes(msgLower)) {
    return listarInadimplentes();
  }

  // Ajuda / default
  return ajuda();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem, isGroup, fromMe } = extrairDadosWebhook(req.body);

    if (!de || !mensagem || fromMe || isGroup) return res.status(200).send('OK');

    logger.info(`[FINANCEIRO] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[FINANCEIRO] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) {
      await enviarMensagem(de, `❌ Erro ao processar. Tente novamente.`).catch(() => {});
    }
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

/**
 * Relatório semanal — Toda segunda-feira às 09:00
 */
cron.schedule('0 9 * * 1', async () => {
  logger.info('[CRON] Gerando relatório financeiro semanal...');
  try {
    const relatorio = await gerarRelatorio();
    await enviarMensagem(DONO_WHATSAPP(), `📊 *Relatório automático de segunda-feira:*\n\n${relatorio}`);
    await Logs.registrar('FINANCEIRO', 'INFO', 'Relatório semanal enviado ao dono');
  } catch (erro) {
    logger.error(`[CRON RELATÓRIO] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * Alerta inadimplentes — Toda quinta-feira às 10:00
 */
cron.schedule('0 10 * * 4', async () => {
  logger.info('[CRON] Verificando inadimplentes...');
  try {
    const inadimplentes = await Clientes.listarInadimplentes();
    if (inadimplentes.length > 0) {
      const msg = await listarInadimplentes();
      await enviarMensagem(DONO_WHATSAPP(), `⚠️ *Alerta Financeiro — Inadimplentes:*\n\n${msg}`);
      await Logs.registrar('FINANCEIRO', 'WARN', `${inadimplentes.length} inadimplentes detectados`);
    }
  } catch (erro) {
    logger.error(`[CRON INADIMPLENTES] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
