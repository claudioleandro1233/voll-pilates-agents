// utils/state.js — Gerenciamento de estado de conversa (in-memory)
// Em produção, substitua pelo Redis para persistência entre restarts

const logger = require('./logger');

// Map: whatsapp_number → { agente, etapa, dados, timestamp }
const conversas = new Map();

// TTL: 30 minutos (ms)
const TTL = 30 * 60 * 1000;

/**
 * Obtém estado atual da conversa
 * @param {string} numero - WhatsApp do usuário
 * @returns {object|null}
 */
function obterEstado(numero) {
  const estado = conversas.get(numero);
  if (!estado) return null;

  // Verifica TTL
  if (Date.now() - estado.timestamp > TTL) {
    conversas.delete(numero);
    return null;
  }

  return estado;
}

/**
 * Define estado da conversa
 * @param {string} numero
 * @param {object} estado - { agente, etapa, dados }
 */
function definirEstado(numero, estado) {
  conversas.set(numero, {
    ...estado,
    timestamp: Date.now()
  });
  logger.debug(`Estado definido [${numero}]: ${estado.agente}/${estado.etapa}`);
}

/**
 * Limpa estado da conversa (após conclusão)
 * @param {string} numero
 */
function limparEstado(numero) {
  conversas.delete(numero);
  logger.debug(`Estado limpo [${numero}]`);
}

/**
 * Atualiza dados do estado atual
 * @param {string} numero
 * @param {object} novosDados
 */
function atualizarDados(numero, novosDados) {
  const atual = obterEstado(numero);
  if (atual) {
    conversas.set(numero, {
      ...atual,
      dados: { ...(atual.dados || {}), ...novosDados },
      timestamp: Date.now()
    });
  }
}

// Limpeza periódica de estados expirados (a cada 15 min)
setInterval(() => {
  const agora = Date.now();
  let removidos = 0;
  for (const [numero, estado] of conversas.entries()) {
    if (agora - estado.timestamp > TTL) {
      conversas.delete(numero);
      removidos++;
    }
  }
  if (removidos > 0) logger.debug(`🧹 ${removidos} estados expirados removidos`);
}, 15 * 60 * 1000);

module.exports = { obterEstado, definirEstado, limparEstado, atualizarDados };
