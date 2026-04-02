// utils/zapi.js — Wrapper Z-API para WhatsApp (substitui Twilio)
require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

const BASE_URL = () =>
  `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

const HEADERS = () => {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.ZAPI_CLIENT_TOKEN) h['Client-Token'] = process.env.ZAPI_CLIENT_TOKEN;
  return h;
};

/**
 * Normaliza número para formato Z-API (551199999999)
 * Aceita: +5511999998888, 5511999998888, whatsapp:+5511999998888
 */
function normalizarNumero(numero) {
  return numero
    .replace('whatsapp:', '')
    .replace('+', '')
    .replace(/\D/g, '');
}

/**
 * Envia mensagem de texto via Z-API
 * @param {string} para - Número destino (qualquer formato)
 * @param {string} mensagem - Texto da mensagem
 */
async function enviarMensagem(para, mensagem) {
  try {
    const phone = normalizarNumero(para);

    const resp = await axios.post(
      `${BASE_URL()}/send-text`,
      { phone, message: mensagem },
      { headers: HEADERS() }
    );

    logger.info(`✅ Z-API enviado para ${phone} | zaapId: ${resp.data?.zaapId}`);
    return resp.data;
  } catch (erro) {
    const msg = erro.response?.data || erro.message;
    logger.error(`❌ Erro Z-API ao enviar para ${para}: ${JSON.stringify(msg)}`);
    throw erro;
  }
}

/**
 * Extrai dados padronizados do webhook Z-API
 * @param {object} body - req.body do webhook
 * @returns {{ de, mensagem, profileName, isGroup, fromMe }}
 */
function extrairDadosWebhook(body) {
  // Ignora mensagens enviadas pelo próprio bot e grupos
  const de = body.phone ? `whatsapp:+${normalizarNumero(body.phone)}` : '';
  const mensagem = body.text?.message || body.message || '';
  const profileName = body.senderName || body.chatName || 'Desconhecido';
  const isGroup = body.isGroup || false;
  const fromMe = body.fromMe || false;

  return { de, mensagem: mensagem.trim(), profileName, isGroup, fromMe };
}

/**
 * Envia mensagem com botões interativos (máx 3 botões, label até 25 chars)
 * @param {string} para - Número destino
 * @param {string} mensagem - Texto da mensagem
 * @param {Array} botoes - [{ id, label }]
 */
async function enviarMensagemComBotoes(para, mensagem, botoes) {
  try {
    const phone = normalizarNumero(para);

    const resp = await axios.post(
      `${BASE_URL()}/send-button-list`,
      {
        phone,
        message: mensagem,
        buttonList: { buttons: botoes }
      },
      { headers: HEADERS() }
    );

    logger.info(`✅ Z-API botoes enviado para ${phone} | zaapId: ${resp.data?.zaapId}`);
    return resp.data;
  } catch (erro) {
    // Fallback: envia como texto simples se botões falharem
    logger.warn(`⚠️ Botoes nao suportados, enviando como texto: ${erro.message}`);
    const textoBotoes = botoes.map(b => `• ${b.label}`).join('\n');
    return enviarMensagem(para, `${mensagem}\n\n${textoBotoes}`);
  }
}

/**
 * Extrai dados de clique em botão do webhook Z-API
 */
function extrairBotaoClicado(body) {
  // Verifica se é resposta de botão
  if (body.mediaType === 'conversation_button' || body.type === 'conversation_button') {
    const botaoSelecionado = (body.buttons || []).find(b => b.selected);
    return botaoSelecionado?.id || null;
  }
  // Fallback: tenta pegar pelo campo buttonId
  return body.buttonId || body.selectedButtonId || null;
}

module.exports = { enviarMensagem, enviarMensagemComBotoes, extrairBotaoClicado, extrairDadosWebhook, normalizarNumero };
