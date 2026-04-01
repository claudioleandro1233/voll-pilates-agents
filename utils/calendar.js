// utils/calendar.js — Wrapper Google Calendar API v3
require('dotenv').config();
const { google } = require('googleapis');
const logger = require('./logger');

// ─── Horários do studio ─────────────────────────────────────────────────────
// Seg-Sex: 07:00–10:45 (slots de 45min)
// Sáb alternados: 08:00–11:45
const HORARIOS_SEMANA = ['07:00', '07:45', '08:30', '09:15', '10:00', '10:45'];
const HORARIOS_SABADO = ['08:00', '08:45', '09:30', '10:15', '11:00', '11:45'];

function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID;

// ─── Funções de agenda ──────────────────────────────────────────────────────

/**
 * Lista eventos de um dia específico
 * @param {Date} data - Data para consulta
 * @returns {Promise<Array>} Lista de eventos
 */
async function listarEventosDia(data) {
  try {
    const calendar = getCalendarClient();
    const inicio = new Date(data);
    inicio.setHours(6, 0, 0, 0);
    const fim = new Date(data);
    fim.setHours(23, 59, 59, 999);

    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID(),
      timeMin: inicio.toISOString(),
      timeMax: fim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    return resp.data.items || [];
  } catch (erro) {
    logger.error(`Erro ao listar eventos do Calendar: ${erro.message}`);
    throw erro;
  }
}

/**
 * Verifica horários livres em um dia
 * @param {Date} data
 * @returns {Promise<string[]>} Lista de horários livres
 */
async function horariosLivres(data) {
  try {
    const diaSemana = data.getDay(); // 0=Dom, 6=Sáb
    const horariosPossiveis = diaSemana === 6 ? HORARIOS_SABADO : HORARIOS_SEMANA;

    // Domingo não há aulas
    if (diaSemana === 0) return [];

    const eventos = await listarEventosDia(data);
    const horariosOcupados = eventos.map(ev => {
      const inicio = new Date(ev.start?.dateTime || ev.start?.date);
      return `${String(inicio.getHours()).padStart(2, '0')}:${String(inicio.getMinutes()).padStart(2, '0')}`;
    });

    return horariosPossiveis.filter(h => !horariosOcupados.includes(h));
  } catch (erro) {
    logger.error(`Erro ao verificar horários livres: ${erro.message}`);
    return [];
  }
}

/**
 * Cria evento de aula no Calendar
 * @param {object} dados - { clienteNome, clienteWhatsApp, data, horario, plano }
 * @returns {Promise<object>} Evento criado
 */
async function criarEventoAula(dados) {
  try {
    const calendar = getCalendarClient();

    // Monta data/hora de início e fim (45 min)
    const [ano, mes, dia] = dados.data.split('-');
    const [hora, minuto] = dados.horario.split(':');

    const inicio = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia), parseInt(hora), parseInt(minuto));
    const fim = new Date(inicio.getTime() + 45 * 60 * 1000);

    const evento = {
      summary: `Pilates — ${dados.clienteNome}`,
      description: `Cliente: ${dados.clienteNome}\nWhatsApp: ${dados.clienteWhatsApp}\nPlano: ${dados.plano || 'Avulso'}`,
      location: process.env.STUDIO_ADDRESS,
      start: {
        dateTime: inicio.toISOString(),
        timeZone: 'America/Sao_Paulo'
      },
      end: {
        dateTime: fim.toISOString(),
        timeZone: 'America/Sao_Paulo'
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 1440 } // 24h antes
        ]
      }
    };

    const resp = await calendar.events.insert({
      calendarId: CALENDAR_ID(),
      requestBody: evento
    });

    logger.info(`✅ Evento criado no Calendar: ${dados.clienteNome} - ${dados.data} ${dados.horario}`);
    return resp.data;
  } catch (erro) {
    logger.error(`Erro ao criar evento no Calendar: ${erro.message}`);
    throw erro;
  }
}

/**
 * Cancela/exclui um evento
 * @param {string} eventId - ID do evento
 */
async function cancelarEvento(eventId) {
  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId: CALENDAR_ID(),
      eventId
    });
    logger.info(`✅ Evento ${eventId} cancelado`);
  } catch (erro) {
    logger.error(`Erro ao cancelar evento ${eventId}: ${erro.message}`);
    throw erro;
  }
}

/**
 * Retorna próximos eventos (7 dias) de um cliente
 * @param {string} nomeCliente
 */
async function eventosCliente(nomeCliente) {
  try {
    const calendar = getCalendarClient();
    const agora = new Date();
    const em7Dias = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);

    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID(),
      timeMin: agora.toISOString(),
      timeMax: em7Dias.toISOString(),
      q: nomeCliente,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return resp.data.items || [];
  } catch (erro) {
    logger.error(`Erro ao buscar eventos do cliente ${nomeCliente}: ${erro.message}`);
    return [];
  }
}

/**
 * Formata horários livres para mensagem WhatsApp
 * @param {Date} data
 * @param {string[]} horarios
 * @returns {string}
 */
function formatarHorarios(data, horarios) {
  if (!horarios || horarios.length === 0) return 'Nenhum horário disponível nesse dia.';
  const dataFormatada = data.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const lista = horarios.map((h, i) => `  ${i + 1}. ${h}`).join('\n');
  return `📅 *${dataFormatada}*\nHorários livres:\n${lista}`;
}

module.exports = {
  listarEventosDia,
  horariosLivres,
  criarEventoAula,
  cancelarEvento,
  eventosCliente,
  formatarHorarios,
  HORARIOS_SEMANA,
  HORARIOS_SABADO
};
