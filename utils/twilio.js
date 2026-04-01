// utils/twilio.js — Wrapper do cliente Twilio para WhatsApp
require('dotenv').config();
const twilio = require('twilio');
const logger = require('./logger');

// Inicializa cliente Twilio com credenciais do .env
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = process.env.TWILIO_WHATSAPP_FROM;

/**
 * Envia mensagem WhatsApp via Twilio
 * @param {string} to - Número destino (formato: whatsapp:+55119...)
 * @param {string} body - Texto da mensagem
 * @returns {Promise<object>} - Resposta do Twilio
 */
async function enviarMensagem(to, body) {
  try {
    // Garante prefixo whatsapp:
    const destino = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    const mensagem = await client.messages.create({
      from: FROM,
      to: destino,
      body: body
    });

    logger.info(`✅ WhatsApp enviado para ${destino} | SID: ${mensagem.sid}`);
    return mensagem;
  } catch (erro) {
    logger.error(`❌ Erro ao enviar WhatsApp para ${to}: ${erro.message}`);
    throw erro;
  }
}

/**
 * Envia mensagem com template de mídia (imagem)
 * @param {string} to - Número destino
 * @param {string} body - Texto
 * @param {string} mediaUrl - URL da mídia
 */
async function enviarMensagemComMidia(to, body, mediaUrl) {
  try {
    const destino = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    const mensagem = await client.messages.create({
      from: FROM,
      to: destino,
      body: body,
      mediaUrl: [mediaUrl]
    });

    logger.info(`✅ WhatsApp c/ mídia enviado para ${destino} | SID: ${mensagem.sid}`);
    return mensagem;
  } catch (erro) {
    logger.error(`❌ Erro ao enviar mídia para ${to}: ${erro.message}`);
    throw erro;
  }
}

/**
 * Valida se o payload do webhook Twilio é autêntico
 * @param {object} req - Request Express
 * @returns {boolean}
 */
function validarWebhookTwilio(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.BASE_URL}${req.originalUrl}`;

  return twilio.validateRequest(authToken, signature, url, req.body);
}

/**
 * Extrai dados padronizados do payload Twilio
 * @param {object} body - req.body do webhook
 * @returns {object} - { de, para, mensagem, numMidia, urlMidia }
 */
function extrairDadosWebhook(body) {
  return {
    de: body.From || '',
    para: body.To || '',
    mensagem: (body.Body || '').trim(),
    numMidia: parseInt(body.NumMedia || '0'),
    urlMidia: body.MediaUrl0 || null,
    tipoMidia: body.MediaContentType0 || null,
    profileName: body.ProfileName || 'Desconhecido',
    waId: body.WaId || ''
  };
}

/**
 * Formata resposta TwiML para Twilio (resposta imediata)
 * @param {string} mensagem
 * @returns {string} XML TwiML
 */
function respostaTwiML(mensagem) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const resp = new MessagingResponse();
  resp.message(mensagem);
  return resp.toString();
}

module.exports = {
  client,
  enviarMensagem,
  enviarMensagemComMidia,
  validarWebhookTwilio,
  extrairDadosWebhook,
  respostaTwiML
};
