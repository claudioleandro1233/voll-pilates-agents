// agents/agent-supervisor.js — Agente Supervisor (Dashboard e Orquestrador)
// Responsável: Dashboard unificado, relatório diário, priorização de tarefas, logs de erro

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/twilio');
const { Clientes, Financeiro, Operacional, Logs, lerLinhas } = require('../utils/sheets');
const { listarEventosDia } = require('../utils/calendar');
const logger = require('../utils/logger');

const router = express.Router();

const DONO_WHATSAPP = () => process.env.DONO_WHATSAPP;

// ─── Skills ──────────────────────────────────────────────────────────────────

/**
 * Skill: Dashboard financeiro do dia
 */
async function getDadosFinanceiros() {
  try {
    return await Financeiro.resumoSemanal();
  } catch (e) {
    logger.warn(`Supervisor: erro ao buscar financeiro: ${e.message}`);
    return { entradas: 0, saidas: 0, saldo: 0, semana: '?' };
  }
}

/**
 * Skill: Resumo de clientes ativos
 */
async function getDadosClientes() {
  try {
    const ativos = await Clientes.listarAtivos();
    const inadimplentes = await Clientes.listarInadimplentes();
    return { ativos: ativos.length, inadimplentes: inadimplentes.length };
  } catch (e) {
    logger.warn(`Supervisor: erro ao buscar clientes: ${e.message}`);
    return { ativos: 0, inadimplentes: 0 };
  }
}

/**
 * Skill: Aulas do dia
 */
async function getAulasDia() {
  try {
    const hoje = new Date();
    const eventos = await listarEventosDia(hoje);
    return {
      total: eventos.length,
      lista: eventos.map(ev => {
        const inicio = new Date(ev.start?.dateTime || ev.start?.date);
        const horario = inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const nome = (ev.description || '').match(/Cliente: (.+)/)?.[1]?.trim() || ev.summary;
        return `${horario} — ${nome}`;
      })
    };
  } catch (e) {
    logger.warn(`Supervisor: erro ao buscar aulas: ${e.message}`);
    return { total: 0, lista: [] };
  }
}

/**
 * Skill: Estoque crítico
 */
async function getEstoqueCritico() {
  try {
    const linhas = await Operacional.listarEstoque();
    const MINIMOS = {
      'colchonetes': 5, 'elásticos': 10, 'toalhas': 8,
      'água mineral': 12, 'álcool gel': 2
    };

    return linhas.slice(1)
      .filter(l => l[0])
      .filter(l => {
        const item = l[0].toLowerCase();
        const qtd = parseInt(l[1] || 999);
        return MINIMOS[item] && qtd <= MINIMOS[item];
      })
      .map(l => l[0]);
  } catch (e) {
    return [];
  }
}

/**
 * Skill: Erros recentes dos logs
 */
async function getErrosRecentes() {
  try {
    const linhas = await lerLinhas('logs', 'Logs');
    const ultimasLinhas = linhas.slice(-20); // Últimas 20 entradas
    return ultimasLinhas
      .filter(l => l[2] === 'ERROR')
      .slice(-5) // Últimos 5 erros
      .map(l => `[${l[0]}] ${l[1]}: ${l[3]}`);
  } catch (e) {
    return [];
  }
}

/**
 * Skill: Gerar dashboard completo
 */
async function gerarDashboard() {
  const [financeiro, clientes, aulas, estoqueCritico, erros] = await Promise.all([
    getDadosFinanceiros(),
    getDadosClientes(),
    getAulasDia(),
    getEstoqueCritico(),
    getErrosRecentes()
  ]);

  const hoje = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
  });

  let msg = `📊 *Dashboard Voll Pilates*\n_${hoje}_\n\n`;

  // Seção aulas
  msg += `🧘 *Aulas Hoje (${aulas.total}):*\n`;
  if (aulas.total === 0) {
    msg += `  Nenhuma aula agendada.\n`;
  } else {
    aulas.lista.slice(0, 6).forEach(a => { msg += `  • ${a}\n`; });
  }

  // Seção clientes
  msg += `\n👥 *Clientes:*\n`;
  msg += `  Ativos: *${clientes.ativos}*\n`;
  if (clientes.inadimplentes > 0) {
    msg += `  ⚠️ Inadimplentes: *${clientes.inadimplentes}*\n`;
  }

  // Seção financeira
  msg += `\n💰 *Financeiro (semana):*\n`;
  msg += `  Entradas: *R$ ${financeiro.entradas.toFixed(2)}*\n`;
  msg += `  Saídas: *R$ ${financeiro.saidas.toFixed(2)}*\n`;
  msg += `  Saldo: *R$ ${financeiro.saldo.toFixed(2)}*\n`;

  // Estoque crítico
  if (estoqueCritico.length > 0) {
    msg += `\n📦 *Estoque baixo:*\n`;
    estoqueCritico.forEach(item => { msg += `  ⚠️ ${item}\n`; });
  }

  // Erros recentes
  if (erros.length > 0) {
    msg += `\n❌ *Erros recentes (${erros.length}):*\n`;
    erros.forEach(e => { msg += `  • ${e}\n`; });
  }

  // Status geral
  const semProblemas = clientes.inadimplentes === 0 && estoqueCritico.length === 0 && erros.length === 0;
  msg += semProblemas
    ? `\n✅ *Status: Tudo em ordem!*`
    : `\n⚠️ *Atenção nos itens destacados.*`;

  return msg;
}

/**
 * Skill: Prioridades do dia
 */
async function getPrioridades() {
  const [clientes, aulas, estoque] = await Promise.all([
    getDadosClientes(),
    getAulasDia(),
    getEstoqueCritico()
  ]);

  const prioridades = [];

  if (aulas.total > 0) {
    prioridades.push(`🧘 ${aulas.total} aula(s) hoje — confirme presença dos alunos`);
  }
  if (clientes.inadimplentes > 0) {
    prioridades.push(`💰 ${clientes.inadimplentes} inadimplente(s) — cobrar pagamento`);
  }
  if (estoque.length > 0) {
    prioridades.push(`📦 Estoque baixo: ${estoque.join(', ')} — reabastecer`);
  }
  if (prioridades.length === 0) {
    prioridades.push(`✅ Nenhuma prioridade urgente hoje. Bom trabalho!`);
  }

  return `📋 *Prioridades de hoje:*\n\n${prioridades.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}

function ajuda() {
  return (
    `🤖 *Agente Supervisor — Comandos:*\n\n` +
    `📊 Dashboard completo:\n  _dashboard_ ou _resumo_\n\n` +
    `📋 Prioridades do dia:\n  _prioridades_\n\n` +
    `❌ Ver erros:\n  _erros_\n\n` +
    `🔄 Status do sistema:\n  _status_`
  );
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
async function processarMensagem(de, mensagem) {
  const msgLower = mensagem.toLowerCase().trim();

  if (/dashboard|resumo|relat[oó]rio|overview/i.test(msgLower)) {
    return gerarDashboard();
  }

  if (/prioridade|tarefa|o que fazer|agenda/i.test(msgLower)) {
    return getPrioridades();
  }

  if (/erro|bug|falha|log/i.test(msgLower)) {
    const erros = await getErrosRecentes();
    if (erros.length === 0) return `✅ Nenhum erro recente registrado.`;
    return `❌ *Erros recentes:*\n\n${erros.map(e => `• ${e}`).join('\n')}`;
  }

  if (/status|sistema|funcionando/i.test(msgLower)) {
    return (
      `✅ *Status dos Agentes:*\n\n` +
      `🧘 Clientes: Online\n` +
      `💰 Financeiro: Online\n` +
      `📣 Marketing: Online\n` +
      `🏢 Operacional: Online\n` +
      `🤖 Supervisor: Online\n\n` +
      `_${new Date().toLocaleString('pt-BR')}_`
    );
  }

  return ajuda();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem } = extrairDadosWebhook(req.body);

    if (!de || !mensagem) return res.status(400).json({ erro: 'Dados inválidos' });

    logger.info(`[SUPERVISOR] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[SUPERVISOR] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) {
      await enviarMensagem(de, `❌ Erro no Supervisor. Verifique os logs.`).catch(() => {});
    }
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

/**
 * Dashboard diário — Todo dia às 07:30 (antes das aulas)
 */
cron.schedule('30 7 * * 1-6', async () => {
  logger.info('[CRON] Enviando dashboard diário ao dono...');
  try {
    const dashboard = await gerarDashboard();
    await enviarMensagem(DONO_WHATSAPP(), dashboard);
    await Logs.registrar('SUPERVISOR', 'INFO', 'Dashboard diário enviado');
  } catch (erro) {
    logger.error(`[CRON DASHBOARD] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * Prioridades da manhã — Todo dia às 08:00
 */
cron.schedule('0 8 * * 1-6', async () => {
  try {
    const prioridades = await getPrioridades();
    await enviarMensagem(DONO_WHATSAPP(), prioridades);
  } catch (erro) {
    logger.error(`[CRON PRIORIDADES] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * Encerramento do dia — Todo dia às 11:30
 */
cron.schedule('30 11 * * 1-6', async () => {
  try {
    const financeiro = await getDadosFinanceiros();
    const aulas = await getAulasDia();

    const msg =
      `🌅 *Encerramento do dia — Voll Pilates*\n\n` +
      `🧘 Aulas realizadas: *${aulas.total}*\n` +
      `💰 Entradas hoje: verificar planilha\n` +
      `💸 Saldo semanal: *R$ ${financeiro.saldo.toFixed(2)}*\n\n` +
      `Bom descanso! Até amanhã 💙`;

    await enviarMensagem(DONO_WHATSAPP(), msg);
  } catch (erro) {
    logger.error(`[CRON ENCERRAMENTO] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
