// agents/agent-clientes.js — Agente de Clientes e Agendamento
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/zapi');
const { Clientes, Logs } = require('../utils/sheets');
const { listarEventosDia } = require('../utils/calendar');
const { obterEstado, definirEstado, limparEstado, atualizarDados } = require('../utils/state');
const logger = require('../utils/logger');

const router = express.Router();

const FORM_NPS_URL = process.env.FORM_NPS_URL || process.env.STUDIO_BOOKING_LINK || '#';

// ─── Mensagens padronizadas ──────────────────────────────────────────────────
const MSG = {

  menu: () =>
    `Ola, studio Voll Autodromo! 👋\n\n` +
    `Sou a assistente da *Voll Pilates Studio* 🧘‍♀️\n\n` +
    `O que posso fazer por voce?\n\n` +
    `1️⃣ Agendar uma aula\n` +
    `2️⃣ Ver meus agendamentos\n` +
    `3️⃣ Planos e valores\n` +
    `4️⃣ TotalPass / Welhub\n` +
    `5️⃣ Endereco e horarios\n\n` +
    `Digite o numero da opcao ou sua duvida.`,

  opcaoInvalida: () =>
    `Opcao invalida. Digite 1-5 para o menu.\n\n` +
    `1️⃣ Agendar uma aula\n` +
    `2️⃣ Ver meus agendamentos\n` +
    `3️⃣ Planos e valores\n` +
    `4️⃣ TotalPass / Welhub\n` +
    `5️⃣ Endereco e horarios`,

  pedirNome: () =>
    `Otimo! 😊 Para agendar, primeiro me diz seu *nome completo*:`,

  pedirModalidade: (nome) =>
    `Obrigada, *${nome}*! 🙏\n\n` +
    `Qual modalidade voce prefere?\n\n` +
    `1️⃣ Pilates\n` +
    `2️⃣ Funcional`,

  pedirHorario: (modalidade) =>
    `Otimo! *${modalidade}* 💪\n\n` +
    `Qual horario prefere?\n\n` +
    (modalidade === 'Pilates'
      ? `*Manha:* 07h, 08h, 09h, 10h\n*Tarde:* 15h, 16h, 17h, 18h, 19h, 20h\n*Sabado:* 08h, 09h, 10h, 11h`
      : `*Manha:* 07h, 08h, 09h, 10h, 11h, 12h\n*Tarde:* 15h, 16h, 17h (18h/19h so tercas)\n*Sabado:* 08h, 09h, 10h, 11h`) +
    `\n\nDigite o horario. Ex: *10h* ou *18h*`,

  pedirDia: (horario) =>
    `Perfeito, *${horario}*! 📅\n\n` +
    `Qual dia da semana prefere?\n\n` +
    `1️⃣ Segunda\n` +
    `2️⃣ Terca\n` +
    `3️⃣ Quarta\n` +
    `4️⃣ Quinta\n` +
    `5️⃣ Sexta\n` +
    `6️⃣ Sabado`,

  encaminharAtendente: () =>
    `Vou encaminhar para um atendente para ver disponibilidade de horario. Aguarde! ⏳`,

  pedirNomeOuTelefone: () =>
    `Oi! Para ver seus agendamentos, informe:\n*Nome ou telefone:*`,

  agendamentosEncontrados: (nome, lista) =>
    `${nome}, suas aulas:\n${lista}\n\nPrecisa alterar? Digite *1 sim / 2 nao*.`,

  agendamentosNaoEncontrados: () =>
    `Nenhum agendamento no seu nome. Quer agendar agora? Digite *1*.`,

  planos: () =>
    `Aqui os planos do Voll Pilates Studio 🧘‍♀️:\n\n` +
    `*PILATES*\n` +
    `1x/semana - Mensal: R$ 185 | Trim: R$ 167 | Sem: R$ 148\n` +
    `2x/semana - Mensal: R$ 320 | Trim: R$ 288 | Sem: R$ 256\n` +
    `3x/semana - Mensal: R$ 465 | Trim: R$ 419 | Sem: R$ 372\n` +
    `4x/semana - Mensal: R$ 590 | Trim: R$ 531 | Sem: R$ 472\n\n` +
    `*FUNCIONAL*\n` +
    `1x/semana - Mensal: R$ 165 | Trim: R$ 149 | Sem: R$ 132\n` +
    `2x/semana - Mensal: R$ 280 | Trim: R$ 252 | Sem: R$ 224\n` +
    `3x/semana - Mensal: R$ 395 | Trim: R$ 356 | Sem: R$ 316\n` +
    `4x/semana - Mensal: R$ 495 | Trim: R$ 446 | Sem: R$ 396\n\n` +
    `Pix/cartao/boleto. Quer agendar? Digite *1*.`,

  totalpass: () =>
    `Aqui os planos aceitos no Voll Pilates Studio:\n\n` +
    `*FUNCIONAL*\n` +
    `TP3 TotalPass\n` +
    `Silver+ Welhub ou superior\n\n` +
    `*PILATES*\n` +
    `TP4 TotalPass\n` +
    `Silver+ Welhub ou superior\n\n` +
    `Lembre-se de sempre mostrar seu check-in na recepcao no dia de sua aula. Agendamentos sem cancelamento previo terao um ganho da propria empresa PASS.\n\n` +
    `Se nao esta dando certo o agendamento, digite *1* e informe a situacao.`,

  endereco: () =>
    `📍 *Endereco:* Av. Rubens Montanaro de Borba, 180B\n` +
    `https://maps.app.goo.gl/cHDecPZZRcNksCyE7 (estac. gratis).\n\n` +
    `🕒 *Horarios do estudio:*\n` +
    `Seg-Sex: 07h-13h | 15h-21h\n` +
    `Sab: 08h-12h\n` +
    `Dom: Fechado.\n\n` +
    `Quer horarios de aulas ou agendar? Digite *1*.`,

  lembrete: (dados) =>
    `⏰ *Lembrete da Voll Pilates!*\n\nOla, *${dados.nome}*! 👋\n` +
    `Sua aula e *amanha* as *${dados.horario}*.\n\n` +
    `📍 Av. Rubens Montanaro de Borba, 180B\n\n` +
    `Qualquer duvida, so chamar! 😊`,

  nps: (nome) =>
    `🌟 Ola, *${nome}*! Como foi sua aula hoje?\n` +
    `Nos ajude com uma avaliacao rapida:\n\n` +
    `${FORM_NPS_URL}\n\n` +
    `Ou responda aqui de 0 a 10:\n*(0 = pessimo, 10 = excelente)*`,

  erroGeral: () =>
    `Desculpe, ocorreu um erro. Por favor, tente novamente.`
};

// ─── Skill: capturar lead ────────────────────────────────────────────────────
async function capturarLead(de, profileName) {
  try {
    const existente = await Clientes.buscarPorWhatsApp(de);
    if (!existente) {
      await Clientes.salvarCliente({
        nome: profileName || 'Desconhecido',
        whatsapp: de,
        status: 'Lead'
      });
      logger.info(`✅ Novo lead: ${profileName} (${de})`);
    }
  } catch (erro) {
    logger.warn(`Falha ao capturar lead: ${erro.message}`);
  }
}

// ─── Skill: ver agendamentos ─────────────────────────────────────────────────
async function verAgendamentos(de, mensagem, estado) {
  const etapa = estado?.etapa || 'pedir_nome';

  if (etapa === 'pedir_nome') {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendamento', dados: {} });
    return MSG.pedirNomeOuTelefone();
  }

  if (etapa === 'aguardando_nome_agendamento') {
    const busca = mensagem.trim();
    try {
      const resultado = await Clientes.buscarPorWhatsApp(de);
      const nome = resultado?.dados?.[1] || busca;
      const eventos = await require('../utils/calendar').eventosCliente(busca);

      limparEstado(de);

      if (!eventos || eventos.length === 0) {
        return MSG.agendamentosNaoEncontrados();
      }

      const lista = eventos.map(ev => {
        const inicio = new Date(ev.start?.dateTime || ev.start?.date);
        const dia = inicio.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
        const hora = inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `✅ ${dia} ${hora} (${ev.summary?.replace(/Pilates — |Funcional — /i, '') || 'aula'})`;
      }).join('\n');

      return MSG.agendamentosEncontrados(nome, lista);
    } catch (erro) {
      limparEstado(de);
      logger.error(`Erro ao buscar agendamentos: ${erro.message}`);
      return MSG.agendamentosNaoEncontrados();
    }
  }
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
async function processarMensagem(de, mensagem, profileName) {
  const msgTrim = mensagem.trim();
  const msgLower = msgTrim.toLowerCase();
  const estado = obterEstado(de);

  // Continua fluxo ativo
  if (estado?.agente === 'clientes') {
    // Fluxo de ver agendamentos
    if (estado.etapa === 'aguardando_nome_agendamento') {
      return verAgendamentos(de, msgTrim, estado);
    }
    // Etapa 1: coletando nome
    if (estado.etapa === 'aguardando_nome_agendar') {
      if (msgTrim.length < 3) return `Por favor, informe seu nome completo.`;
      atualizarDados(de, { nome: msgTrim });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_modalidade', dados: { nome: msgTrim } });
      return MSG.pedirModalidade(msgTrim);
    }

    // Etapa 2: coletando modalidade
    if (estado.etapa === 'aguardando_modalidade') {
      let modalidade = '';
      if (msgLower === '1' || /pilates/i.test(msgLower)) modalidade = 'Pilates';
      else if (msgLower === '2' || /funcional/i.test(msgLower)) modalidade = 'Funcional';
      else return `Por favor, escolha:\n1️⃣ Pilates\n2️⃣ Funcional`;

      atualizarDados(de, { modalidade });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_horario', dados: { ...estado.dados, modalidade } });
      return MSG.pedirHorario(modalidade);
    }

    // Etapa 3: coletando horário
    if (estado.etapa === 'aguardando_horario') {
      const horarioMatch = msgTrim.match(/\d{1,2}h?/i);
      if (!horarioMatch) return `Por favor, informe um horario valido. Ex: *10h* ou *18h*`;

      const horario = horarioMatch[0].toLowerCase().replace(/h$/, '') + 'h';
      atualizarDados(de, { horario });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_dia', dados: { ...estado.dados, horario } });
      return MSG.pedirDia(horario);
    }

    // Etapa 4: coletando dia → notifica studio
    if (estado.etapa === 'aguardando_dia') {
      const dias = ['Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];
      const diaMap = {
        '1': 'Segunda', 'segunda': 'Segunda',
        '2': 'Terca', 'terca': 'Terca', 'terca-feira': 'Terca',
        '3': 'Quarta', 'quarta': 'Quarta', 'quarta-feira': 'Quarta',
        '4': 'Quinta', 'quinta': 'Quinta', 'quinta-feira': 'Quinta',
        '5': 'Sexta', 'sexta': 'Sexta', 'sexta-feira': 'Sexta',
        '6': 'Sabado', 'sabado': 'Sabado', 'sábado': 'Sabado'
      };

      const dia = diaMap[msgLower];
      if (!dia) return `Por favor, escolha:\n1️⃣ Segunda\n2️⃣ Terca\n3️⃣ Quarta\n4️⃣ Quinta\n5️⃣ Sexta\n6️⃣ Sabado`;

      const { nome, modalidade, horario } = { ...estado.dados, dia };
      limparEstado(de);

      // Salva lead no CRM
      await Clientes.salvarCliente({
        nome: nome || profileName || 'Desconhecido',
        whatsapp: de,
        status: 'Lead',
        observacoes: `${modalidade} - ${dia} - ${horario}`
      }).catch(() => {});

      // Notifica o studio
      const numeroAluno = de.replace('whatsapp:', '');
      const msgStudio =
        `🔔 *Nova solicitacao de agendamento!*\n\n` +
        `👤 Aluno: *${nome}*\n` +
        `📱 WhatsApp: *${numeroAluno}*\n` +
        `🏋️ Modalidade: *${modalidade}*\n` +
        `📅 Dia: *${dia}*\n` +
        `⏰ Horario: *${horario}*\n\n` +
        `Verifique a disponibilidade e confirme com o aluno.`;

      await enviarMensagem(process.env.DONO_WHATSAPP, msgStudio).catch(e =>
        logger.warn(`Falha ao notificar studio: ${e.message}`)
      );

      await Logs.registrar('CLIENTES', 'INFO', `Agendamento: ${nome} - ${modalidade} ${dia} ${horario}`);
      return MSG.encaminharAtendente();
    }
  }

  // ── Opção 1 ou palavras relacionadas a agendar ───────────────────────────
  if (msgLower === '1' || /agendar|marcar|quero aula|aula/i.test(msgLower)) {
    await capturarLead(de, profileName);
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendar', dados: {} });
    return MSG.pedirNome();
  }

  // ── Opção 2 ──────────────────────────────────────────────────────────────
  if (msgLower === '2' || /meus agendamentos|minhas aulas|ver aula|agendamento/i.test(msgLower)) {
    return verAgendamentos(de, msgTrim, { etapa: 'pedir_nome' });
  }

  // ── Opção 3 ──────────────────────────────────────────────────────────────
  if (msgLower === '3' || /plano|valor|preco|mensalidade|quanto custa/i.test(msgLower)) {
    return MSG.planos();
  }

  // ── Opção 4 ──────────────────────────────────────────────────────────────
  if (msgLower === '4' || /totalpass|welhub|gympass|beneficio|convenio/i.test(msgLower)) {
    return MSG.totalpass();
  }

  // ── Opção 5 ──────────────────────────────────────────────────────────────
  if (msgLower === '5' || /endereco|onde|localizacao|como chegar|horario do studio/i.test(msgLower)) {
    return MSG.endereco();
  }

  // ── Saudações → menu ────────────────────────────────────────────────────
  if (/^(oi|ola|bom dia|boa tarde|boa noite|hey|hi|hello|menu|inicio|start)$/i.test(msgLower)) {
    await capturarLead(de, profileName);
    return MSG.menu();
  }

  // ── NPS: resposta numérica 0-10 ──────────────────────────────────────────
  if (/^\d+$/.test(msgLower) && parseInt(msgLower) >= 0 && parseInt(msgLower) <= 10) {
    const nota = parseInt(msgLower);
    // Evita interpretar opções do menu como NPS
    if (nota >= 1 && nota <= 5) {
      return MSG.opcaoInvalida();
    }
    await Clientes.salvarNPS({ whatsapp: de, nome: profileName, nota });
    const emo = nota >= 9 ? '🌟' : nota >= 7 ? '😊' : '😔';
    return `${emo} Obrigada pela avaliacao *${nota}/10*, ${profileName}! Seu feedback e muito importante para nos! 💙`;
  }

  // ── Fallback: opção inválida ─────────────────────────────────────────────
  await capturarLead(de, profileName);
  return MSG.opcaoInvalida();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem, profileName, isGroup, fromMe } = extrairDadosWebhook(req.body);

    if (!de || !mensagem || fromMe || isGroup) return res.status(200).send('OK');

    logger.info(`[CLIENTES] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem, profileName);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[CLIENTES] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) await enviarMensagem(de, MSG.erroGeral()).catch(() => {});
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

// Lembretes 24h antes — todo dia às 08:00
cron.schedule('0 8 * * 1-6', async () => {
  logger.info('[CRON] Enviando lembretes de aula...');
  try {
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const eventos = await listarEventosDia(amanha);

    for (const evento of eventos) {
      const desc = evento.description || '';
      const wpMatch = desc.match(/WhatsApp: ([\+\d]+)/);
      const nomeMatch = desc.match(/Cliente: (.+)/);
      if (!wpMatch) continue;

      const whatsapp = wpMatch[1];
      const nome = nomeMatch ? nomeMatch[1].trim() : 'cliente';
      const inicio = new Date(evento.start?.dateTime);
      const horario = inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      await enviarMensagem(`whatsapp:${whatsapp}`, MSG.lembrete({ nome, horario }));
      logger.info(`✅ Lembrete enviado para ${nome}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (erro) {
    logger.error(`[CRON LEMBRETES] ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

// NPS pós-aula — todo dia às 12:00
cron.schedule('0 12 * * 1-6', async () => {
  logger.info('[CRON] Enviando NPS pos-aula...');
  try {
    const hoje = new Date();
    const eventos = await listarEventosDia(hoje);

    for (const evento of eventos) {
      const desc = evento.description || '';
      const wpMatch = desc.match(/WhatsApp: ([\+\d]+)/);
      const nomeMatch = desc.match(/Cliente: (.+)/);
      const inicio = new Date(evento.start?.dateTime);

      if (inicio > hoje || !wpMatch) continue;

      const whatsapp = wpMatch[1];
      const nome = nomeMatch ? nomeMatch[1].trim() : 'cliente';

      await enviarMensagem(`whatsapp:${whatsapp}`, MSG.nps(nome));
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (erro) {
    logger.error(`[CRON NPS] ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
