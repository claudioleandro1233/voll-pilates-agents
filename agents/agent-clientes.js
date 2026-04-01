// agents/agent-clientes.js — Agente de Clientes e Agendamento
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook, normalizarNumero } = require('../utils/zapi');
const { Clientes, Logs } = require('../utils/sheets');
const { listarEventosDia } = require('../utils/calendar');
const { obterEstado, definirEstado, limparEstado, atualizarDados } = require('../utils/state');
const logger = require('../utils/logger');

const router = express.Router();

const FORM_NPS_URL = process.env.FORM_NPS_URL || process.env.STUDIO_BOOKING_LINK || '#';
const DONO = () => process.env.DONO_WHATSAPP;

// ─── Tabela de preços ────────────────────────────────────────────────────────
const PRECOS = {
  Pilates:   { 1: { mensal: 185, trim: 167, sem: 148 }, 2: { mensal: 320, trim: 288, sem: 256 }, 3: { mensal: 465, trim: 419, sem: 372 }, 4: { mensal: 590, trim: 531, sem: 472 } },
  Funcional: { 1: { mensal: 165, trim: 149, sem: 132 }, 2: { mensal: 280, trim: 252, sem: 224 }, 3: { mensal: 395, trim: 356, sem: 316 }, 4: { mensal: 495, trim: 446, sem: 396 } }
};

// ─── Mensagens ───────────────────────────────────────────────────────────────
const MSG = {

  menu: () =>
    `Ola, studio Voll Autodromo! 👋\n\n` +
    `Sou a assistente da *Voll Pilates Studio* 🧘‍♀️\n\n` +
    `O que posso fazer por voce?\n\n` +
    `1️⃣ Agendar uma aula\n` +
    `2️⃣ Ver meus agendamentos\n` +
    `3️⃣ Planos e valores\n` +
    `4️⃣ TotalPass / Welhub\n` +
    `5️⃣ Endereco e horarios\n` +
    `6️⃣ Falar com atendente\n\n` +
    `Digite o numero da opcao ou sua duvida.`,

  opcaoInvalida: () =>
    `Opcao invalida. Digite 1-6 para o menu.\n\n` +
    `1️⃣ Agendar  2️⃣ Agendamentos  3️⃣ Planos\n` +
    `4️⃣ TotalPass  5️⃣ Endereco  6️⃣ Atendente`,

  // ── Agendamento ──
  pedirNomeAgendar: () => `Otimo! 😊 Para agendar, primeiro me diz seu *nome completo*:`,

  pedirModalidadeAgendar: (nome) =>
    `Obrigada, *${nome}*! 🙏\n\nQual modalidade voce prefere?\n\n1️⃣ Pilates\n2️⃣ Funcional`,

  pedirHorario: (modalidade) =>
    `Otimo! *${modalidade}* 💪\n\nQual horario prefere?\n\n` +
    (modalidade === 'Pilates'
      ? `*Manha:* 07h, 08h, 09h, 10h\n*Tarde:* 15h, 16h, 17h, 18h, 19h, 20h\n*Sabado:* 08h, 09h, 10h, 11h`
      : `*Manha:* 07h, 08h, 09h, 10h, 11h, 12h\n*Tarde:* 15h, 16h, 17h (18h/19h so tercas)\n*Sabado:* 08h, 09h, 10h, 11h`) +
    `\n\nDigite o horario. Ex: *10h* ou *18h*`,

  pedirDia: (horario) =>
    `Perfeito, *${horario}*! 📅\n\nQual dia da semana prefere?\n\n` +
    `1️⃣ Segunda\n2️⃣ Terca\n3️⃣ Quarta\n4️⃣ Quinta\n5️⃣ Sexta\n6️⃣ Sabado`,

  encaminharAtendente: () =>
    `Vou encaminhar para um atendente para ver disponibilidade. Aguarde! ⏳`,

  agendamentoConfirmado: (dados) =>
    `✅ *Seu agendamento foi confirmado!*\n\n` +
    `👤 ${dados.nome}\n` +
    `🏋️ ${dados.modalidade}\n` +
    `📅 ${dados.dia}\n` +
    `⏰ ${dados.horario}\n\n` +
    `📍 Av. Rubens Montanaro de Borba, 180B\n\n` +
    `Qualquer duvida, estamos aqui! 😊`,

  // ── Planos ──
  pedirNomePlanos: () => `Para te mostrar o plano ideal, primeiro me diz seu *nome completo*:`,

  pedirModalidadePlanos: (nome) =>
    `Ola, *${nome}*! 😊\n\nQual modalidade te interessa?\n\n1️⃣ Pilates\n2️⃣ Funcional`,

  pedirFrequencia: (modalidade) =>
    `*${modalidade}* — Quantas vezes por semana voce pretende treinar?\n\n` +
    `1️⃣ 1x por semana\n2️⃣ 2x por semana\n3️⃣ 3x por semana\n4️⃣ 4x por semana`,

  mostrarPlano: (nome, modalidade, freq) => {
    const p = PRECOS[modalidade][freq];
    return (
      `💰 *Plano para voce, ${nome}:*\n\n` +
      `🏋️ Modalidade: *${modalidade}*\n` +
      `📅 Frequencia: *${freq}x/semana*\n\n` +
      `*Mensal:* R$ ${p.mensal}\n` +
      `*Trimestral:* R$ ${p.trim}/mes (economize ${p.mensal - p.trim}/mes)\n` +
      `*Semestral:* R$ ${p.sem}/mes (economize ${p.mensal - p.sem}/mes)\n\n` +
      `💳 Pix, cartao ou boleto.\n\n` +
      `Quer agendar uma aula? Digite *1*.\n` +
      `Prefere falar com atendente? Digite *9*.`
    );
  },

  // ── Atendente ──
  aguardandoAtendente: (nome) =>
    `Ola, *${nome}*! 👋 Um atendente vai entrar em contato em breve.\n\nSe preferir, pode ligar ou mandar mensagem diretamente:\n📱 ${process.env.STUDIO_PHONE || ''}`,

  // ── Ver agendamentos ──
  pedirNomeOuTelefone: () => `Para ver seus agendamentos, informe seu *nome ou telefone*:`,
  agendamentosEncontrados: (nome, lista) => `${nome}, suas aulas:\n${lista}\n\nPrecisa alterar? Digite *1 sim / 2 nao*.`,
  agendamentosNaoEncontrados: () => `Nenhum agendamento no seu nome. Quer agendar agora? Digite *1*.`,

  // ── Outros ──
  totalpass: () =>
    `Planos aceitos no Voll Pilates Studio:\n\n` +
    `*FUNCIONAL*\nTP3 TotalPass\nSilver+ Welhub ou superior\n\n` +
    `*PILATES*\nTP4 TotalPass\nSilver+ Welhub ou superior\n\n` +
    `Lembre-se de mostrar seu check-in na recepcao.\n\n` +
    `Dificuldade no agendamento? Digite *6* para falar com atendente.`,

  endereco: () =>
    `📍 *Endereco:* Av. Rubens Montanaro de Borba, 180B\n` +
    `https://maps.app.goo.gl/cHDecPZZRcNksCyE7 (estac. gratis).\n\n` +
    `🕒 *Horarios:*\nSeg-Sex: 07h-13h | 15h-21h\nSab: 08h-12h\nDom: Fechado.\n\n` +
    `Quer agendar? Digite *1*.`,

  lembrete: (dados) =>
    `⏰ *Lembrete da Voll Pilates!*\n\nOla, *${dados.nome}*! 👋\n` +
    `Sua aula e *amanha* as *${dados.horario}*.\n\n` +
    `📍 Av. Rubens Montanaro de Borba, 180B\n\nQualquer duvida, so chamar! 😊`,

  nps: (nome) =>
    `🌟 Ola, *${nome}*! Como foi sua aula hoje?\nResponda de 0 a 10:\n*(0 = pessimo, 10 = excelente)*`,

  erroGeral: () => `Desculpe, ocorreu um erro. Por favor, tente novamente.`
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function capturarLead(de, profileName) {
  try {
    const existente = await Clientes.buscarPorWhatsApp(de);
    if (!existente) {
      await Clientes.salvarCliente({ nome: profileName || 'Desconhecido', whatsapp: de, status: 'Lead' });
    }
  } catch (e) {
    logger.warn(`Falha ao capturar lead: ${e.message}`);
  }
}

async function notificarStudio(titulo, campos) {
  const linhas = Object.entries(campos).map(([k, v]) => `${k}: *${v}*`).join('\n');
  await enviarMensagem(DONO(), `🔔 *${titulo}*\n\n${linhas}`).catch(e =>
    logger.warn(`Falha notificar studio: ${e.message}`)
  );
}

// ─── Comandos do dono (respostas para alunos) ────────────────────────────────
// /confirmar 5511999998888 Pilates Quarta 10h
// /msg 5511999998888 Ola, seu horario esta confirmado!
async function processarComandoDono(mensagem) {
  const msgTrim = mensagem.trim();

  // /confirmar <numero> <modalidade> <dia> <horario>
  const confirmarMatch = msgTrim.match(/^\/confirmar\s+(\d+)\s+(\w+)\s+(\w+)\s+(\w+)/i);
  if (confirmarMatch) {
    const [, numero, modalidade, dia, horario] = confirmarMatch;
    const para = `whatsapp:+${normalizarNumero(numero)}`;
    await enviarMensagem(para, MSG.agendamentoConfirmado({ nome: 'Aluno', modalidade, dia, horario }));
    return `✅ Confirmacao enviada para +${numero}`;
  }

  // /msg <numero> <texto livre>
  const msgMatch = msgTrim.match(/^\/msg\s+(\d+)\s+(.+)/is);
  if (msgMatch) {
    const [, numero, texto] = msgMatch;
    const para = `whatsapp:+${normalizarNumero(numero)}`;
    await enviarMensagem(para, texto.trim());
    return `✅ Mensagem enviada para +${numero}`;
  }

  // /ajuda — lista comandos disponíveis
  if (/^\/ajuda$/i.test(msgTrim)) {
    return (
      `*Comandos disponíveis:*\n\n` +
      `*/confirmar* [numero] [modalidade] [dia] [horario]\n` +
      `Ex: /confirmar 5511999998888 Pilates Quarta 10h\n\n` +
      `*/msg* [numero] [texto]\n` +
      `Ex: /msg 5511999998888 Seu horario esta confirmado!\n\n` +
      `*/ajuda* — lista os comandos`
    );
  }

  return null; // Não é comando
}

// ─── Roteador principal ───────────────────────────────────────────────────────
async function processarMensagem(de, mensagem, profileName) {
  const msgTrim = mensagem.trim();
  const msgLower = msgTrim.toLowerCase();
  const estado = obterEstado(de);
  const donoNumero = normalizarNumero(DONO());
  const remetenteNumero = normalizarNumero(de);

  // ── Comandos do dono ──────────────────────────────────────────────────────
  if (remetenteNumero === donoNumero && msgTrim.startsWith('/')) {
    const resposta = await processarComandoDono(msgTrim);
    return resposta || `Comando nao reconhecido. Digite */ajuda* para ver os comandos.`;
  }

  // ── Fluxos ativos ────────────────────────────────────────────────────────
  if (estado?.agente === 'clientes') {

    // Ver agendamentos
    if (estado.etapa === 'aguardando_nome_agendamento') {
      const busca = msgTrim;
      try {
        const resultado = await Clientes.buscarPorWhatsApp(de);
        const nome = resultado?.dados?.[1] || busca;
        const eventos = await require('../utils/calendar').eventosCliente(busca);
        limparEstado(de);
        if (!eventos || eventos.length === 0) return MSG.agendamentosNaoEncontrados();
        const lista = eventos.map(ev => {
          const inicio = new Date(ev.start?.dateTime || ev.start?.date);
          return `✅ ${inicio.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })} ${inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        }).join('\n');
        return MSG.agendamentosEncontrados(nome, lista);
      } catch (e) {
        limparEstado(de);
        return MSG.agendamentosNaoEncontrados();
      }
    }

    // ── Fluxo Agendamento ──
    if (estado.etapa === 'aguardando_nome_agendar') {
      if (msgTrim.length < 3) return `Por favor, informe seu nome completo.`;
      atualizarDados(de, { nome: msgTrim });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_modalidade_agendar', dados: { nome: msgTrim } });
      return MSG.pedirModalidadeAgendar(msgTrim);
    }

    if (estado.etapa === 'aguardando_modalidade_agendar') {
      let modalidade = '';
      if (msgLower === '1' || /pilates/i.test(msgLower)) modalidade = 'Pilates';
      else if (msgLower === '2' || /funcional/i.test(msgLower)) modalidade = 'Funcional';
      else return `Por favor, escolha:\n1️⃣ Pilates\n2️⃣ Funcional`;
      atualizarDados(de, { modalidade });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_horario_agendar', dados: { ...estado.dados, modalidade } });
      return MSG.pedirHorario(modalidade);
    }

    if (estado.etapa === 'aguardando_horario_agendar') {
      const m = msgTrim.match(/\d{1,2}/);
      if (!m) return `Informe um horario valido. Ex: *10h* ou *18h*`;
      const horario = m[0] + 'h';
      atualizarDados(de, { horario });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_dia_agendar', dados: { ...estado.dados, horario } });
      return MSG.pedirDia(horario);
    }

    if (estado.etapa === 'aguardando_dia_agendar') {
      const diaMap = {
        '1': 'Segunda', 'segunda': 'Segunda',
        '2': 'Terca', 'terca': 'Terca',
        '3': 'Quarta', 'quarta': 'Quarta',
        '4': 'Quinta', 'quinta': 'Quinta',
        '5': 'Sexta', 'sexta': 'Sexta',
        '6': 'Sabado', 'sabado': 'Sabado', 'sabado': 'Sabado'
      };
      const dia = diaMap[msgLower];
      if (!dia) return `Escolha:\n1️⃣ Segunda\n2️⃣ Terca\n3️⃣ Quarta\n4️⃣ Quinta\n5️⃣ Sexta\n6️⃣ Sabado`;

      const { nome, modalidade, horario } = estado.dados;
      limparEstado(de);

      await Clientes.salvarCliente({ nome, whatsapp: de, status: 'Lead', observacoes: `${modalidade} - ${dia} - ${horario}` }).catch(() => {});

      await notificarStudio('Nova solicitacao de agendamento!', {
        '👤 Aluno': nome,
        '📱 WhatsApp': normalizarNumero(de),
        '🏋️ Modalidade': modalidade,
        '📅 Dia': dia,
        '⏰ Horario': horario,
        '\nResponder': `\n/confirmar ${normalizarNumero(de)} ${modalidade} ${dia} ${horario}`
      });

      await Logs.registrar('CLIENTES', 'INFO', `Agendamento: ${nome} - ${modalidade} ${dia} ${horario}`);
      return MSG.encaminharAtendente();
    }

    // ── Fluxo Planos ──
    if (estado.etapa === 'aguardando_nome_planos') {
      if (msgTrim.length < 3) return `Por favor, informe seu nome completo.`;
      atualizarDados(de, { nome: msgTrim });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_modalidade_planos', dados: { nome: msgTrim } });
      return MSG.pedirModalidadePlanos(msgTrim);
    }

    if (estado.etapa === 'aguardando_modalidade_planos') {
      let modalidade = '';
      if (msgLower === '1' || /pilates/i.test(msgLower)) modalidade = 'Pilates';
      else if (msgLower === '2' || /funcional/i.test(msgLower)) modalidade = 'Funcional';
      else return `Por favor, escolha:\n1️⃣ Pilates\n2️⃣ Funcional`;
      atualizarDados(de, { modalidade });
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_frequencia_planos', dados: { ...estado.dados, modalidade } });
      return MSG.pedirFrequencia(modalidade);
    }

    if (estado.etapa === 'aguardando_frequencia_planos') {
      const freqMap = { '1': 1, '2': 2, '3': 3, '4': 4 };
      const freq = freqMap[msgLower];
      if (!freq) return `Escolha:\n1️⃣ 1x/semana\n2️⃣ 2x/semana\n3️⃣ 3x/semana\n4️⃣ 4x/semana`;
      const { nome, modalidade } = estado.dados;
      limparEstado(de);
      return MSG.mostrarPlano(nome, modalidade, freq);
    }

    // ── Fluxo Atendente ──
    if (estado.etapa === 'aguardando_nome_atendente') {
      const nome = msgTrim.length >= 3 ? msgTrim : profileName;
      limparEstado(de);

      await notificarStudio('Aluno quer falar com atendente!', {
        '👤 Nome': nome,
        '📱 WhatsApp': normalizarNumero(de),
        '\nResponder': `\n/msg ${normalizarNumero(de)} [sua mensagem]`
      });

      await Logs.registrar('CLIENTES', 'INFO', `Atendente solicitado: ${nome} (${de})`);
      return MSG.aguardandoAtendente(nome);
    }
  }

  // ── Opção 9 — atendente (dentro de outros fluxos) ────────────────────────
  if (msgLower === '9' || /atendente|humano|falar com/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_atendente', dados: {} });
    return `Para te conectar com um atendente, me diz seu *nome*:`;
  }

  // ── Opcoes do menu ────────────────────────────────────────────────────────
  if (msgLower === '1' || /agendar|marcar|quero aula/i.test(msgLower)) {
    await capturarLead(de, profileName);
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendar', dados: {} });
    return MSG.pedirNomeAgendar();
  }

  if (msgLower === '2' || /meus agendamentos|ver aula/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendamento', dados: {} });
    return MSG.pedirNomeOuTelefone();
  }

  if (msgLower === '3' || /plano|valor|preco|mensalidade|quanto custa/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_planos', dados: {} });
    return MSG.pedirNomePlanos();
  }

  if (msgLower === '4' || /totalpass|welhub|gympass/i.test(msgLower)) {
    return MSG.totalpass();
  }

  if (msgLower === '5' || /endereco|onde|localizacao|como chegar/i.test(msgLower)) {
    return MSG.endereco();
  }

  if (msgLower === '6' || /atendente|falar com alguem|humano/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_atendente', dados: {} });
    return `Para te conectar com um atendente, me diz seu *nome*:`;
  }

  if (/^(oi|ola|bom dia|boa tarde|boa noite|hey|hi|menu|inicio|start)$/i.test(msgLower)) {
    await capturarLead(de, profileName);
    return MSG.menu();
  }

  // NPS
  if (/^\d+$/.test(msgLower)) {
    const n = parseInt(msgLower);
    if (n >= 0 && n <= 10 && n > 6) {
      await Clientes.salvarNPS({ whatsapp: de, nome: profileName, nota: n });
      const emo = n >= 9 ? '🌟' : '😊';
      return `${emo} Obrigada pela avaliacao *${n}/10*, ${profileName}! 💙`;
    }
  }

  await capturarLead(de, profileName);
  return MSG.opcaoInvalida();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem, profileName, isGroup, fromMe } = extrairDadosWebhook(req.body);
    if (!de || !mensagem || fromMe || isGroup) return res.status(200).send('OK');

    logger.info(`[CLIENTES] ${de}: "${mensagem}"`);
    const resposta = await processarMensagem(de, mensagem, profileName);
    await enviarMensagem(de, resposta);
    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[CLIENTES] Erro: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) await enviarMensagem(de, MSG.erroGeral()).catch(() => {});
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────
cron.schedule('0 8 * * 1-6', async () => {
  try {
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const eventos = await listarEventosDia(amanha);
    for (const ev of eventos) {
      const desc = ev.description || '';
      const wpM = desc.match(/WhatsApp: ([\+\d]+)/);
      const nomeM = desc.match(/Cliente: (.+)/);
      if (!wpM) continue;
      const horario = new Date(ev.start?.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      await enviarMensagem(`whatsapp:+${normalizarNumero(wpM[1])}`, MSG.lembrete({ nome: nomeM?.[1]?.trim() || 'aluno', horario }));
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) { logger.error(`[CRON LEMBRETES] ${e.message}`); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 12 * * 1-6', async () => {
  try {
    const hoje = new Date();
    const eventos = await listarEventosDia(hoje);
    for (const ev of eventos) {
      const desc = ev.description || '';
      const wpM = desc.match(/WhatsApp: ([\+\d]+)/);
      const nomeM = desc.match(/Cliente: (.+)/);
      const inicio = new Date(ev.start?.dateTime);
      if (inicio > hoje || !wpM) continue;
      await enviarMensagem(`whatsapp:+${normalizarNumero(wpM[1])}`, MSG.nps(nomeM?.[1]?.trim() || 'aluno'));
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) { logger.error(`[CRON NPS] ${e.message}`); }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
