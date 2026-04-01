// agents/agent-operacional.js — Agente Operacional
// Responsável: Controle de estoque, manutenção, alertas sábado, horários alternados

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/twilio');
const { Operacional, Logs } = require('../utils/sheets');
const logger = require('../utils/logger');

const router = express.Router();

const DONO_WHATSAPP = () => process.env.DONO_WHATSAPP;

// ─── Itens típicos do studio ──────────────────────────────────────────────────
const ITENS_PADRAO = [
  'Colchonetes', 'Elásticos', 'Bolas pequenas', 'Bosu',
  'Foam Roller', 'Toalhas', 'Água mineral', 'Álcool gel'
];

// Estoque mínimo por item (para alertas)
const ESTOQUE_MINIMO = {
  'colchonetes': 5,
  'elásticos': 10,
  'bolas pequenas': 5,
  'toalhas': 8,
  'água mineral': 12,
  'álcool gel': 2
};

// ─── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Parser: "estoque colchonetes 8" ou "estoque 8 colchonetes"
 */
function parsearEstoque(mensagem) {
  // Formato: estoque <item> <quantidade>
  const regex1 = /estoque\s+(.+?)\s+(\d+)(?:\s+(.+))?$/i;
  // Formato: estoque <quantidade> <item>
  const regex2 = /estoque\s+(\d+)\s+(.+)$/i;

  let match = mensagem.match(regex1);
  if (match && !isNaN(parseInt(match[1]))) {
    // match[1] é número → formato 2
  } else if (match) {
    return {
      item: match[1].trim(),
      quantidade: parseInt(match[2]),
      observacoes: match[3] || ''
    };
  }

  match = mensagem.match(regex2);
  if (match) {
    return {
      item: match[2].trim(),
      quantidade: parseInt(match[1]),
      observacoes: ''
    };
  }

  return null;
}

/**
 * Parser: "manutenção [item] [descrição]"
 */
function parsearManutencao(mensagem) {
  const regex = /manuten[çc][aã]o\s+(.+?)(?:\s*[-:]\s*(.+))?$/i;
  const match = mensagem.match(regex);
  if (!match) return null;

  return {
    item: match[1].trim(),
    descricao: match[2]?.trim() || 'Verificar necessidade de manutenção'
  };
}

// ─── Skills ──────────────────────────────────────────────────────────────────

/**
 * Skill: Atualizar estoque
 */
async function atualizarEstoque(de, dados) {
  await Operacional.atualizarEstoque(dados.item, dados.quantidade, dados.observacoes);

  const itemLower = dados.item.toLowerCase();
  const minimo = ESTOQUE_MINIMO[itemLower];
  let alertaBaixo = '';

  if (minimo && dados.quantidade <= minimo) {
    alertaBaixo = `\n\n⚠️ *Atenção:* Estoque abaixo do mínimo recomendado (${minimo} unidades)!`;
  }

  await Logs.registrar('OPERACIONAL', 'INFO', `Estoque: ${dados.item} → ${dados.quantidade}`);

  return (
    `✅ *Estoque atualizado!*\n\n` +
    `📦 Item: *${dados.item}*\n` +
    `🔢 Quantidade: *${dados.quantidade}*\n` +
    `📅 Data: *${new Date().toLocaleDateString('pt-BR')}*` +
    alertaBaixo
  );
}

/**
 * Skill: Listar estoque completo
 */
async function listarEstoque() {
  const linhas = await Operacional.listarEstoque();
  if (!linhas || linhas.length <= 1) {
    return `📦 Estoque vazio. Use *"estoque [item] [quantidade]"* para registrar.`;
  }

  const items = linhas.slice(1) // Pula cabeçalho
    .filter(l => l[0]) // Remove linhas vazias
    .map(l => {
      const item = l[0] || '';
      const qtd = parseInt(l[1] || 0);
      const minimo = ESTOQUE_MINIMO[item.toLowerCase()] || 0;
      const alerta = (minimo && qtd <= minimo) ? ' ⚠️' : '';
      return `• ${item}: *${qtd}*${alerta}`;
    })
    .join('\n');

  return `📦 *Estoque Voll Pilates:*\n\n${items}\n\n_⚠️ = abaixo do mínimo_`;
}

/**
 * Skill: Registrar manutenção
 */
async function registrarManutencao(de, dados) {
  await Operacional.registrarManutencao({
    item: dados.item,
    descricao: dados.descricao,
    status: 'Pendente',
    responsavel: de
  });

  await Logs.registrar('OPERACIONAL', 'WARN', `Manutenção registrada: ${dados.item}`);

  return (
    `🔧 *Manutenção registrada!*\n\n` +
    `🛠️ Item: *${dados.item}*\n` +
    `📝 Descrição: *${dados.descricao}*\n` +
    `📅 Data: *${new Date().toLocaleDateString('pt-BR')}*\n` +
    `🔖 Status: *Pendente*`
  );
}

/**
 * Skill: Verificar se o sábado desta semana tem aula (sábados alternados)
 */
function verificarSabadoAlternado() {
  const hoje = new Date();
  const diaAno = Math.floor((hoje - new Date(hoje.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
  const semana = Math.floor(diaAno / 7);
  // Sábados pares têm aula (ajuste conforme necessidade do studio)
  const temAula = semana % 2 === 0;

  const proximoSab = new Date(hoje);
  proximoSab.setDate(hoje.getDate() + (6 - hoje.getDay()));

  return {
    data: proximoSab.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
    temAula
  };
}

/**
 * Skill: Verificar itens com estoque baixo
 */
async function verificarEstoqueBaixo() {
  const linhas = await Operacional.listarEstoque();
  const baixos = [];

  linhas.slice(1).forEach(l => {
    if (!l[0]) return;
    const item = l[0].toLowerCase();
    const qtd = parseInt(l[1] || 0);
    const minimo = ESTOQUE_MINIMO[item];
    if (minimo && qtd <= minimo) {
      baixos.push({ item: l[0], quantidade: qtd, minimo });
    }
  });

  return baixos;
}

function ajuda() {
  return (
    `🏢 *Agente Operacional — Comandos:*\n\n` +
    `📦 Atualizar estoque:\n  _estoque colchonetes 8_\n  _estoque 5 elásticos_\n\n` +
    `📋 Ver estoque:\n  _ver estoque_ ou _listar estoque_\n\n` +
    `🔧 Registrar manutenção:\n  _manutenção aparelho - trocar cabo_\n\n` +
    `📅 Próximo sábado:\n  _próximo sábado_`
  );
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
async function processarMensagem(de, mensagem) {
  const msgLower = mensagem.toLowerCase().trim();

  // Atualizar estoque
  if (/^estoque\s/i.test(msgLower)) {
    const dados = parsearEstoque(mensagem);
    if (!dados) return `Formato: _estoque [item] [quantidade]_\nEx: _estoque colchonetes 8_`;
    if (isNaN(dados.quantidade) || dados.quantidade < 0) return `Quantidade inválida.`;
    return atualizarEstoque(de, dados);
  }

  // Ver estoque
  if (/ver\s+estoque|listar\s+estoque|estoque\s*$|inventário|inventario/i.test(msgLower)) {
    return listarEstoque();
  }

  // Registrar manutenção
  if (/^manuten/i.test(msgLower)) {
    const dados = parsearManutencao(mensagem);
    if (!dados) return `Formato: _manutenção [item] - [descrição]_\nEx: _manutenção reformer - lubrificar trilhos_`;
    return registrarManutencao(de, dados);
  }

  // Próximo sábado
  if (/pr[oó]ximo\s+s[aá]bado|s[aá]bado\s+(?:tem|vai|haverá)/i.test(msgLower)) {
    const sab = verificarSabadoAlternado();
    if (sab.temAula) {
      return `📅 O sábado *${sab.data}* tem aula! ✅\nHorário: 08:00 às 11:45`;
    } else {
      return `📅 O sábado *${sab.data}* é de *folga* 😴\nPróximas aulas: segunda a sexta, 07:00–10:45.`;
    }
  }

  return ajuda();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem } = extrairDadosWebhook(req.body);

    if (!de || !mensagem) return res.status(400).json({ erro: 'Dados inválidos' });

    logger.info(`[OPERACIONAL] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[OPERACIONAL] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) {
      await enviarMensagem(de, `❌ Erro ao processar. Tente novamente.`).catch(() => {});
    }
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

/**
 * Alerta de manutenção preventiva — Todo sábado às 07:00
 */
cron.schedule('0 7 * * 6', async () => {
  logger.info('[CRON] Verificando necessidades de manutenção (sábado)...');
  try {
    const sab = verificarSabadoAlternado();

    let msg = `🔧 *Checklist Operacional — Sábado ${sab.data}*\n\n`;
    msg += sab.temAula ? `✅ Há aulas hoje (08:00–11:45)\n\n` : `😴 Sem aulas hoje.\n\n`;
    msg += `*Verificar antes de abrir:*\n`;
    msg += `☐ Aparelhos limpos e organizados\n`;
    msg += `☐ Colchonetes higienizados\n`;
    msg += `☐ Banheiros abastecidos\n`;
    msg += `☐ Elásticos e acessórios nos lugares\n`;
    msg += `☐ Ar condicionado/ventilação funcionando`;

    await enviarMensagem(DONO_WHATSAPP(), msg);

    // Verifica estoque baixo
    const baixos = await verificarEstoqueBaixo();
    if (baixos.length > 0) {
      const listaB = baixos.map(b => `• ${b.item}: ${b.quantidade} (mín: ${b.minimo})`).join('\n');
      await enviarMensagem(
        DONO_WHATSAPP(),
        `⚠️ *Estoque baixo — Reabastecer:*\n\n${listaB}`
      );
    }

    await Logs.registrar('OPERACIONAL', 'INFO', 'Checklist sábado enviado');
  } catch (erro) {
    logger.error(`[CRON OPERACIONAL SÁBADO] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * Alerta estoque baixo — Toda quarta às 09:00
 */
cron.schedule('0 9 * * 3', async () => {
  try {
    const baixos = await verificarEstoqueBaixo();
    if (baixos.length > 0) {
      const lista = baixos.map(b => `• ${b.item}: ${b.quantidade} unid. (mín: ${b.minimo})`).join('\n');
      await enviarMensagem(
        DONO_WHATSAPP(),
        `📦 *Alerta de Estoque Baixo:*\n\n${lista}\n\nAtualize: _estoque [item] [quantidade]_`
      );
    }
  } catch (erro) {
    logger.error(`[CRON ESTOQUE] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
