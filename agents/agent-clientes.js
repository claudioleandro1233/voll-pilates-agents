// agents/agent-clientes.js — Agente de Clientes e Agendamento
// Responsável: Agendamento, lembretes, CRM leads, NPS pós-aula

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/twilio');
const { Clientes, Logs } = require('../utils/sheets');
const { horariosLivres, criarEventoAula, listarEventosDia, formatarHorarios } = require('../utils/calendar');
const { obterEstado, definirEstado, limparEstado, atualizarDados } = require('../utils/state');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Constantes ─────────────────────────────────────────────────────────────
const FORM_NPS_URL = process.env.FORM_NPS_URL || process.env.STUDIO_BOOKING_LINK || '#';
const PRECO_AVULSA = process.env.PRECO_AULA_AVULSA || '80';
const PRECO_2X = process.env.PRECO_MENSALIDADE_2X || '200';
const PRECO_3X = process.env.PRECO_MENSALIDADE_3X || '280';

// ─── Mensagens padronizadas ──────────────────────────────────────────────────
const MSG = {
  boas_vindas: (nome) => `Olá${nome ? `, *${nome}*` : ''}! 👋\nSou a assistente da *Voll Pilates Studio* 🧘‍♀️\n\nO que posso fazer por você?\n\n1️⃣ Agendar uma aula\n2️⃣ Ver meus agendamentos\n3️⃣ Planos e valores\n4️⃣ Endereço e horários\n\nDigite o número da opção ou sua dúvida.`,

  planos: () =>
    `💳 *Planos Voll Pilates:*\n\n` +
    `• Aula avulsa: *R$ ${PRECO_AVULSA}*\n` +
    `• Mensalidade 2x/semana: *R$ ${PRECO_2X}*\n` +
    `• Mensalidade 3x/semana: *R$ ${PRECO_3X}*\n\n` +
    `📍 ${process.env.STUDIO_ADDRESS}\n` +
    `⏰ Seg-Sex 07h–10h45 | Sáb alt 08h–11h45\n\n` +
    `Para agendar uma aula experimental gratuita, responda *"agendar"*.`,

  endereco: () =>
    `📍 *Voll Pilates Studio*\n${process.env.STUDIO_ADDRESS}\n\n` +
    `⏰ *Horários:*\nSeg–Sex: 07:00 às 10:45\nSábado (alternados): 08:00 às 11:45\n\n` +
    `Instagram: ${process.env.STUDIO_INSTAGRAM}`,

  pedirNome: () => `Para agendar, preciso do seu nome completo. Como você se chama?`,

  pedirData: () => `Qual data você prefere para a aula?\nResponda no formato *DD/MM* (ex: 15/01)\n\nAulas disponíveis de seg a sex e alguns sábados.`,

  semHorarios: (data) => `😔 Não há horários disponíveis em *${data}*.\nPor favor, escolha outra data.`,

  pedirHorario: (texto) => `${texto}\n\nDigite o *número* do horário desejado.`,

  confirmacao: (dados) =>
    `✅ *Confirmar agendamento:*\n\n` +
    `👤 ${dados.nome}\n` +
    `📅 ${dados.dataFormatada}\n` +
    `⏰ ${dados.horario}\n\n` +
    `Responda *SIM* para confirmar ou *NÃO* para cancelar.`,

  agendado: (dados) =>
    `🎉 *Aula agendada com sucesso!*\n\n` +
    `📅 ${dados.dataFormatada} às ${dados.horario}\n` +
    `📍 ${process.env.STUDIO_ADDRESS}\n\n` +
    `Você receberá um lembrete 24h antes. Até lá! 💪`,

  lembrete: (dados) =>
    `⏰ *Lembrete da Voll Pilates!*\n\nOlá, *${dados.nome}*! 👋\n` +
    `Sua aula é *amanhã* às *${dados.horario}*.\n\n` +
    `📍 ${process.env.STUDIO_ADDRESS}\n\n` +
    `Qualquer dúvida, só chamar! 😊`,

  nps: (nome) =>
    `🌟 Olá, *${nome}*! Como foi sua aula hoje?\nNos ajude com uma avaliação rápida:\n\n` +
    `${FORM_NPS_URL}\n\n` +
    `Ou responda aqui de 0 a 10:\n*(0 = péssimo, 10 = excelente)*`,

  erroGeral: () => `Desculpe, ocorreu um erro. Por favor, tente novamente ou entre em contato: ${process.env.STUDIO_PHONE}`
};

// ─── Skills ──────────────────────────────────────────────────────────────────

/**
 * Skill: Processar fluxo de agendamento (máquina de estados)
 */
async function processarAgendamento(de, mensagem, estado) {
  const etapa = estado?.etapa || 'inicio';
  const dados = estado?.dados || {};

  switch (etapa) {
    case 'inicio': {
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome', dados: {} });
      return MSG.pedirNome();
    }

    case 'aguardando_nome': {
      const nome = mensagem.trim();
      if (nome.length < 3) return `Por favor, informe seu nome completo.`;
      atualizarDados(de, { nome });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_data', dados: { nome } });
      return MSG.pedirData();
    }

    case 'aguardando_data': {
      const dataMatch = mensagem.match(/(\d{1,2})[\/\-](\d{1,2})/);
      if (!dataMatch) return `Formato inválido. Use DD/MM, ex: *15/01*`;

      const dia = parseInt(dataMatch[1]);
      const mes = parseInt(dataMatch[2]) - 1;
      const ano = new Date().getFullYear();
      const dataSolicitada = new Date(ano, mes, dia);

      // Valida dia da semana (0=Dom, bloqueado)
      if (dataSolicitada.getDay() === 0) {
        return `🚫 Não temos aulas aos domingos. Por favor, escolha outro dia.`;
      }

      const horarios = await horariosLivres(dataSolicitada);
      if (!horarios || horarios.length === 0) {
        return MSG.semHorarios(`${dia.toString().padStart(2, '0')}/${(mes + 1).toString().padStart(2, '0')}`);
      }

      const dataStr = `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      atualizarDados(de, { data: dataStr, horarios });
      definirEstado(de, {
        agente: 'clientes',
        etapa: 'aguardando_horario',
        dados: { ...dados, data: dataStr, horarios }
      });

      return MSG.pedirHorario(formatarHorarios(dataSolicitada, horarios));
    }

    case 'aguardando_horario': {
      const escolha = parseInt(mensagem.trim()) - 1;
      const horarios = dados.horarios || [];

      if (isNaN(escolha) || escolha < 0 || escolha >= horarios.length) {
        return `Número inválido. Digite um número entre 1 e ${horarios.length}.`;
      }

      const horario = horarios[escolha];
      const [ano, mes, dia] = dados.data.split('-');
      const dataFormatada = `${dia}/${mes}/${ano}`;

      atualizarDados(de, { horario, dataFormatada });
      definirEstado(de, {
        agente: 'clientes',
        etapa: 'aguardando_confirmacao',
        dados: { ...dados, horario, dataFormatada }
      });

      return MSG.confirmacao({ nome: dados.nome, dataFormatada, horario });
    }

    case 'aguardando_confirmacao': {
      const resposta = mensagem.trim().toUpperCase();

      if (resposta === 'SIM' || resposta === 'S') {
        // Cria evento no Calendar
        await criarEventoAula({
          clienteNome: dados.nome,
          clienteWhatsApp: de,
          data: dados.data,
          horario: dados.horario,
          plano: dados.plano || 'Avulso'
        });

        // Salva no CRM
        await Clientes.salvarCliente({
          nome: dados.nome,
          whatsapp: de,
          status: 'Lead',
          observacoes: `Agendamento: ${dados.dataFormatada} ${dados.horario}`
        });

        await Logs.registrar('CLIENTES', 'INFO', `Agendamento criado: ${dados.nome} - ${dados.dataFormatada} ${dados.horario}`);
        limparEstado(de);
        return MSG.agendado({ dataFormatada: dados.dataFormatada, horario: dados.horario });

      } else if (resposta === 'NÃO' || resposta === 'NAO' || resposta === 'N') {
        limparEstado(de);
        return `Tudo bem! Agendamento cancelado. Se precisar, é só chamar! 😊`;
      } else {
        return `Por favor, responda *SIM* para confirmar ou *NÃO* para cancelar.`;
      }
    }

    default: {
      limparEstado(de);
      return MSG.boas_vindas('');
    }
  }
}

/**
 * Skill: Listar agendamentos do cliente
 */
async function listarAgendamentos(de) {
  try {
    const cliente = await Clientes.buscarPorWhatsApp(de);
    if (!cliente) return `Não encontrei agendamentos para este número. Deseja *agendar* uma aula?`;

    const nome = cliente.dados[1];
    const eventos = await require('../utils/calendar').eventosCliente(nome);

    if (!eventos || eventos.length === 0) {
      return `Não há próximas aulas agendadas, *${nome}*. Deseja *agendar* uma?`;
    }

    const lista = eventos.map(ev => {
      const inicio = new Date(ev.start?.dateTime || ev.start?.date);
      return `• ${inicio.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} às ${inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }).join('\n');

    return `📅 *Suas próximas aulas, ${nome}:*\n\n${lista}`;
  } catch (erro) {
    logger.error(`Erro ao listar agendamentos: ${erro.message}`);
    return MSG.erroGeral();
  }
}

/**
 * Skill: Captura e salva lead no CRM
 */
async function capturarLead(de, nome, profileName) {
  try {
    const existente = await Clientes.buscarPorWhatsApp(de);
    if (!existente) {
      await Clientes.salvarCliente({
        nome: nome || profileName || 'Desconhecido',
        whatsapp: de,
        status: 'Lead'
      });
      logger.info(`✅ Novo lead salvo: ${nome || profileName} (${de})`);
    }
  } catch (erro) {
    logger.warn(`Falha ao capturar lead: ${erro.message}`);
  }
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
async function processarMensagem(de, mensagem, profileName) {
  const msgLower = mensagem.toLowerCase();
  const estado = obterEstado(de);

  // Se há estado ativo de agendamento, continua o fluxo
  if (estado && estado.agente === 'clientes') {
    return processarAgendamento(de, mensagem, estado);
  }

  // Intenções
  if (/^(oi|olá|ola|bom dia|boa tarde|boa noite|hey|hi|1)$/i.test(msgLower)) {
    await capturarLead(de, null, profileName);
    return MSG.boas_vindas(profileName);
  }

  if (/agendar|marcar|quero aula|aula|horário|horario/i.test(msgLower)) {
    await capturarLead(de, null, profileName);
    return processarAgendamento(de, mensagem, { etapa: 'inicio' });
  }

  if (/meus agendamentos|minhas aulas|ver aula|agendamento|marcado/i.test(msgLower) || msgLower === '2') {
    return listarAgendamentos(de);
  }

  if (/plano|valor|preço|preco|mensalidade|quanto|custo|investimento/i.test(msgLower) || msgLower === '3') {
    return MSG.planos();
  }

  if (/endereço|endereco|onde|localização|localizacao|como chegar|horário do studio|horarios/i.test(msgLower) || msgLower === '4') {
    return MSG.endereco();
  }

  // NPS numérico (resposta ao formulário)
  if (/^\d+$/.test(msgLower) && parseInt(msgLower) >= 0 && parseInt(msgLower) <= 10) {
    const nota = parseInt(msgLower);
    await Clientes.salvarNPS({ whatsapp: de, nome: profileName, nota });
    const emo = nota >= 9 ? '🌟' : nota >= 7 ? '😊' : '😔';
    return `${emo} Obrigada pela avaliação *${nota}/10*, ${profileName}! Seu feedback é muito importante para nós! 💙`;
  }

  // Fallback
  await capturarLead(de, null, profileName);
  return MSG.boas_vindas(profileName);
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem, profileName } = extrairDadosWebhook(req.body);

    if (!de || !mensagem) {
      return res.status(400).json({ erro: 'Dados inválidos' });
    }

    logger.info(`[CLIENTES] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem, profileName);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[CLIENTES] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) {
      await enviarMensagem(de, MSG.erroGeral()).catch(() => {});
    }
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

/**
 * Lembretes 24h antes da aula — Executa todo dia às 08:00
 */
cron.schedule('0 8 * * 1-6', async () => {
  logger.info('[CRON] Enviando lembretes de aula (24h)...');
  try {
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);

    const eventos = await listarEventosDia(amanha);

    for (const evento of eventos) {
      const descricao = evento.description || '';
      const whatsappMatch = descricao.match(/WhatsApp: ([\+\d]+)/);
      const nomeMatch = descricao.match(/Cliente: (.+)/);

      if (!whatsappMatch) continue;

      const whatsapp = whatsappMatch[1];
      const nome = nomeMatch ? nomeMatch[1].trim() : 'cliente';
      const inicio = new Date(evento.start?.dateTime);
      const horario = inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      await enviarMensagem(`whatsapp:${whatsapp}`, MSG.lembrete({ nome, horario }));
      logger.info(`✅ Lembrete enviado para ${nome} (${whatsapp})`);

      // Pequeno delay para não estourar rate limit Twilio
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (erro) {
    logger.error(`[CRON LEMBRETES] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * NPS pós-aula — Executa todo dia às 12:00 (envia para quem teve aula hoje)
 */
cron.schedule('0 12 * * 1-6', async () => {
  logger.info('[CRON] Enviando NPS pós-aula...');
  try {
    const hoje = new Date();
    const eventos = await listarEventosDia(hoje);

    for (const evento of eventos) {
      const descricao = evento.description || '';
      const whatsappMatch = descricao.match(/WhatsApp: ([\+\d]+)/);
      const nomeMatch = descricao.match(/Cliente: (.+)/);
      const inicio = new Date(evento.start?.dateTime);

      // Só envia NPS para aulas que já passaram
      if (inicio > hoje) continue;
      if (!whatsappMatch) continue;

      const whatsapp = whatsappMatch[1];
      const nome = nomeMatch ? nomeMatch[1].trim() : 'cliente';

      await enviarMensagem(`whatsapp:${whatsapp}`, MSG.nps(nome));
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (erro) {
    logger.error(`[CRON NPS] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
