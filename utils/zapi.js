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

module.exports = { enviarMensagem, extrairDadosWebhook, normalizarNumero };
