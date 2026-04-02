// agents/agent-clientes.js — Agente de Clientes e Agendamento
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook, normalizarNumero } = require('../utils/zapi');
const { Clientes, Logs } = require('../utils/sheets');
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];
const { listarEventosDia } = require('../utils/calendar');
const { obterEstado, definirEstado, limparEstado, atualizarDados } = require('../utils/state');
const logger = require('../utils/logger');

const router = express.Router();

const DONO = () => process.env.DONO_WHATSAPP;

// Armazena agendamentos pendentes aguardando resposta do dono
// chave: numero do aluno (sem prefixo), valor: { nome, modalidade, dia, horario }
const pendentesAgendamento = new Map();

// Último número pendente — usado para mapear respostas 1/2/3 do dono
let ultimoPendente = null;

// ─── Controle de inatividade ─────────────────────────────────────────────────
const ultimaAtividade = new Map();  // de -> timestamp última mensagem
const avisoInatividade = new Set(); // de (já recebeu aviso de inatividade)

const TIMEOUT_AVISO_MS  = 2 * 60 * 1000; // 2 min → envia aviso
const TIMEOUT_FECHAR_MS = 8 * 60 * 1000; // 8 min → encerra conversa

setInterval(async () => {
  const agora = Date.now();
  for (const [de, ultimaVez] of ultimaAtividade.entries()) {
    const inativo = agora - ultimaVez;
    const estado = obterEstado(de);
    if (!estado) {
      ultimaAtividade.delete(de);
      avisoInatividade.delete(de);
      continue;
    }
    if (inativo >= TIMEOUT_FECHAR_MS) {
      limparEstado(de);
      ultimaAtividade.delete(de);
      avisoInatividade.delete(de);
      await enviarMensagem(de,
        `⌛ Conversa encerrada por inatividade.\n\nQuando quiser, é só mandar *oi* para recomeçar! 😊`
      ).catch(() => {});
    } else if (inativo >= TIMEOUT_AVISO_MS && !avisoInatividade.has(de)) {
      avisoInatividade.add(de);
      await enviarMensagem(de,
        `⏳ Ainda está por aí? Vou encerrar sua conversa em alguns minutos por inatividade.\n\nBasta responder qualquer coisa para continuar. 😊`
      ).catch(() => {});
    }
  }
}, 2 * 60 * 1000);

// ─── Helpers de horário ──────────────────────────────────────────────────────

/**
 * Retorna true se estiver dentro do horário de funcionamento do studio.
 * Seg-Sex: 07h-13h | 15h-21h   Sab: 08h-12h   Dom: fechado
 */
function dentroDoPeriodoAtendimento() {
  const agora = new Date();
  const dia = agora.getDay(); // 0=Dom, 6=Sab
  const h = agora.getHours() + agora.getMinutes() / 60;
  if (dia === 0) return false;
  if (dia === 6) return h >= 8 && h < 12;
  return (h >= 7 && h < 13) || (h >= 15 && h < 21);
}

/**
 * Calcula a próxima data do dia da semana dentro de 6 dias.
 * Retorna { data: Date, dataFormatada: string } ou null se não houver.
 */
function proximaDataDia(diaSemana) {
  const diasIdx = { 'Segunda': 1, 'Terca': 2, 'Quarta': 3, 'Quinta': 4, 'Sexta': 5, 'Sabado': 6 };
  const target = diasIdx[diaSemana];
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 6; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    if (d.getDay() === target) {
      return {
        data: d,
        dataFormatada: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
      };
    }
  }
  return null;
}

/**
 * Retorna o nome do atendente responsável no horário atual, ou null se nenhum definido.
 * Até 12h → Messias   15h-19:30h → Marina
 */
function obterAtendente() {
  const agora = new Date();
  const h = agora.getHours() + agora.getMinutes() / 60;
  if (h >= 7 && h < 12) return 'Messias';
  if (h >= 15 && h < 19.5) return 'Marina';
  return null;
}

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

  encaminharAtendente: (dia, dataFormatada, horario) =>
    `Perfeito! Vou verificar a disponibilidade para *${dia}, ${dataFormatada}* às *${horario}*.\n\nAguarde a confirmação! ⏳`,

  agendamentoConfirmado: (dados) =>
    `✅ *Seu agendamento foi confirmado!*\n\n` +
    `👤 ${dados.nome}\n` +
    `🏋️ ${dados.modalidade}\n` +
    `📅 ${dados.dia}${dados.dataFormatada ? `, ${dados.dataFormatada}` : ''}\n` +
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
  aguardandoAtendente: (nome, atendente) =>
    `Ola, *${nome}*! 👋 ` +
    (atendente
      ? `O atendente *${atendente}* vai entrar em contato em breve.`
      : `Um atendente vai entrar em contato em breve.`) +
    `\n\nSe preferir, pode ligar ou mandar mensagem diretamente:\n📱 ${process.env.STUDIO_PHONE || ''}`,

  foraDoHorario: () =>
    `😔 Que pena! No momento os atendentes não estão disponíveis.\n\n` +
    `🕒 *Horários de atendimento:*\n` +
    `Seg-Sex: 07h às 13h | 15h às 21h\n` +
    `Sábado: 08h às 12h\n` +
    `Domingo: Fechado\n\n` +
    `Volte nesse horário e teremos um atendente pronto para te ajudar! 💙`,

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

  // ── Pós-aula ──
  posAulaFeedback: () =>
    `🧘‍♀️ *Que bom ter voce com a gente hoje!*\n\n` +
    `Gostou da aula? Responda:\n\n` +
    `*1* — 😍 Sim, adorei!\n` +
    `*2* — 😐 Tenho sugestoes`,

  posAulaSim: () =>
    `🎉 Que otimo! Ficamos muito alegres com essa noticia! 💙\n\n` +
    `Ficariamos muito gratos se voce avaliar nosso studio no Google Maps! 🙏\n\n` +
    `https://www.google.com/search?sca_esv=b78cf8500232fcdc&sxsrf=ANbL-n4b1RN85qdBNe6wyrHPb-cGHOG2OQ:1775075599658&si=AL3DRZEsmMGCryMMFSHJ3StBhOdZ2-6yYkXd_doETEE1OR-qOY23akEhMvB9Sq_mbvgiULF_OoQf4OD1bsxDADd9bpNbExiPVmkvwIjA0ccuW4DEVzI4fVAc204iOuIRElj6QXOllPlGgupPr6Y43Y9D-_ndCXbSJdE8p5_VFdNf1oxs8Q2nb_8%3D&q=Voll+Pilates+Studios+-+Aut%C3%B3dromo+Coment%C3%A1rios&sa=X&ved=2ahUKEwjeo8T0v82TAxUJrJUCHe83IYEQ0bkNegQIJxAF&biw=1680&bih=841&dpr=2`,

  posAulaNao: () =>
    `Obrigada pelo feedback! 🙏\n\nTem algo que gostaria de sugerir ou melhorar? Conta pra gente:`,

  posAulaMelhoriaRecebida: () =>
    `💙 Obrigada pela sua opiniao! Vamos sempre buscar melhorar para voces.\n\nAte a proxima aula! 🧘‍♀️`,

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

async function notificarStudioAgendamento(nome, numero, modalidade, dia, dataFormatada, horario) {
  pendentesAgendamento.set(numero, { nome, modalidade, dia, dataFormatada, horario });
  ultimoPendente = numero;

  const texto =
    `🔔 *Nova solicitacao de agendamento!*\n\n` +
    `👤 Aluno: *${nome}*\n` +
    `📱 WhatsApp: *${numero}*\n` +
    `🏋️ Modalidade: *${modalidade}*\n` +
    `📅 Dia: *${dia}, ${dataFormatada}*\n` +
    `⏰ Horario: *${horario}*\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `Responda com:\n` +
    `*1* — ✅ Confirmar vaga\n` +
    `*2* — ❌ Sem vaga\n` +
    `*3* — 💬 Mensagem livre`;

  await enviarMensagem(DONO(), texto).catch(e =>
    logger.warn(`Falha notificar studio: ${e.message}`)
  );
}

async function notificarStudioAtendente(nome, numero, atendente) {
  const quem = atendente ? `*${atendente}*, você tem` : `Tem`;
  const msg =
    `🙋 *Aluno quer falar com atendente!*\n\n` +
    `👤 Nome: *${nome}*\n` +
    `📱 WhatsApp: *${numero}*\n` +
    (atendente ? `👩‍💼 Atendente: *${atendente}*\n` : '') +
    `\n━━━━━━━━━━━━━━\n` +
    `${quem} um novo contato aguardando.\n\n` +
    `💬 Para responder:\n` +
    `/msg ${numero} [seu texto aqui]`;

  await enviarMensagem(DONO(), msg).catch(e =>
    logger.warn(`Falha notificar studio: ${e.message}`)
  );
}

// ─── Clique de botão do dono ─────────────────────────────────────────────────
async function processarBotaoDono(buttonId) {
  // confirmar_<numero>
  if (buttonId.startsWith('confirmar_')) {
    const numero = buttonId.replace('confirmar_', '');
    const dados = pendentesAgendamento.get(numero);
    if (!dados) return `⚠️ Agendamento nao encontrado. Use /confirmar ${numero} [modalidade] [dia] [horario]`;

    let nomeAluno = dados.nome;
    try {
      const cliente = await Clientes.buscarPorWhatsApp(`whatsapp:+${numero}`);
      if (cliente?.dados?.[1]) nomeAluno = cliente.dados[1];
    } catch (e) {}

    await enviarMensagem(`whatsapp:+${numero}`, MSG.agendamentoConfirmado({ nome: nomeAluno, ...dados, dataFormatada: dados.dataFormatada }));
    pendentesAgendamento.delete(numero);
    return `✅ Confirmacao enviada para ${nomeAluno} (+${numero})`;
  }

  // semvaga_<numero>
  if (buttonId.startsWith('semvaga_')) {
    const numero = buttonId.replace('semvaga_', '');
    await enviarMensagem(`whatsapp:+${numero}`,
      `😔 Infelizmente o horario solicitado nao tem vaga no momento.\n\n` +
      `Mas temos outros horarios disponiveis! Gostaria de escolher outra opcao?\n\n` +
      `*PILATES*\nManha: 07h, 08h, 09h, 10h\nTarde: 15h, 16h, 17h, 18h, 19h, 20h\n\n` +
      `*FUNCIONAL*\nManha: 07h, 08h, 09h, 10h, 11h, 12h\nTarde: 15h, 16h, 17h\n\n` +
      `Responda com o horario e dia que prefere ou digite *1* para reiniciar.`
    );
    pendentesAgendamento.delete(numero);
    return `✅ Mensagem de sem vaga enviada para +${numero}`;
  }

  // msg_<numero> — pede para digitar a mensagem livre
  if (buttonId.startsWith('msg_')) {
    const numero = buttonId.replace('msg_', '');
    return `✏️ Digite a mensagem para enviar ao aluno (+${numero}):\n/msg ${numero} [sua mensagem aqui]`;
  }

  return null;
}

// ─── Comandos do dono ────────────────────────────────────────────────────────
async function processarComandoDono(mensagem, de) {
  const msgTrim = mensagem.trim();

  // /confirmar <numero> <modalidade> <dia> <horario>
  const confirmarMatch = msgTrim.match(/^\/confirmar\s+(\d+)\s+(\w+)\s+(\w+)\s+(\w+)/i);
  if (confirmarMatch) {
    const [, numero, modalidade, dia, horario] = confirmarMatch;
    const para = `whatsapp:+${normalizarNumero(numero)}`;

    // Tenta buscar o nome do aluno na planilha
    let nomeAluno = 'Aluno';
    try {
      const cliente = await Clientes.buscarPorWhatsApp(`whatsapp:+${normalizarNumero(numero)}`);
      if (cliente?.dados?.[1]) nomeAluno = cliente.dados[1];
    } catch (e) {}

    await enviarMensagem(para, MSG.agendamentoConfirmado({ nome: nomeAluno, modalidade, dia, horario }));
    return `✅ Confirmacao enviada para +${numero}`;
  }

  // /semvaga <numero>
  const semVagaMatch = msgTrim.match(/^\/semvaga\s+(\d+)/i);
  if (semVagaMatch) {
    const [, numero] = semVagaMatch;
    const para = `whatsapp:+${normalizarNumero(numero)}`;
    await enviarMensagem(para,
      `😔 Infelizmente o horario solicitado nao tem vaga no momento.\n\n` +
      `Mas temos outros horarios disponiveis! Gostaria de escolher outra opcao?\n\n` +
      `*PILATES*\nManha: 07h, 08h, 09h, 10h\nTarde: 15h, 16h, 17h, 18h, 19h, 20h\n\n` +
      `*FUNCIONAL*\nManha: 07h, 08h, 09h, 10h, 11h, 12h\nTarde: 15h, 16h, 17h\n\n` +
      `Responda com o horario e dia que prefere ou digite *1* para reiniciar o agendamento.`
    );
    return `✅ Mensagem de sem vaga enviada para +${numero}`;
  }

  // /msg <numero> <texto livre>
  const msgMatch = msgTrim.match(/^\/msg\s+(\d+)\s+(.+)/is);
  if (msgMatch) {
    const [, numero, texto] = msgMatch;
    await enviarMensagem(`whatsapp:+${normalizarNumero(numero)}`, texto.trim());
    return `✅ Mensagem enviada para +${numero}`;
  }

  // /posAula <numero>
  const posAulaMatch = msgTrim.match(/^\/posaula\s+(\d+)/i);
  if (posAulaMatch) {
    const [, numero] = posAulaMatch;
    const para = `whatsapp:+${normalizarNumero(numero)}`;
    definirEstado(para, { agente: 'clientes', etapa: 'aguardando_feedback_pos_aula', dados: { numero } });
    await enviarMensagem(para, MSG.posAulaFeedback());
    return `✅ Mensagem pos-aula enviada para +${numero}`;
  }

  // /testePosAula — envia a mensagem pós-aula para o proprio numero do dono
  if (/^\/testeposaula$/i.test(msgTrim)) {
    const para = de; // manda para si mesmo
    definirEstado(para, { agente: 'clientes', etapa: 'aguardando_feedback_pos_aula', dados: {} });
    await enviarMensagem(para, MSG.posAulaFeedback());
    return `🧪 Teste enviado! Responda *1* ou *2* para testar o fluxo completo.`;
  }

  // /ajuda
  if (/^\/ajuda$/i.test(msgTrim)) {
    return (
      `*Comandos disponiveis:*\n\n` +
      `✅ */confirmar* [numero] [modalidade] [dia] [horario]\n` +
      `_Ex: /confirmar 5511999998888 Pilates Quarta 10h_\n\n` +
      `❌ */semvaga* [numero]\n` +
      `_Ex: /semvaga 5511999998888_\n\n` +
      `💬 */msg* [numero] [texto livre]\n` +
      `_Ex: /msg 5511999998888 Ola, tudo bem?_\n\n` +
      `🧘 */posAula* [numero]\n` +
      `_Ex: /posAula 5511999998888_\n\n` +
      `❓ */ajuda* — lista os comandos`
    );
  }

  return null;
}

// ─── Roteador principal ───────────────────────────────────────────────────────
async function processarMensagem(de, mensagem, profileName) {
  const msgTrim = mensagem.trim();
  let msgLower = msgTrim.toLowerCase().trim();
  msgLower = msgLower
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const estado = obterEstado(de);
  const donoNumero = normalizarNumero(DONO());
  const remetenteNumero = normalizarNumero(de);

  // ── Registra atividade e reseta aviso de inatividade ─────────────────────
  ultimaAtividade.set(de, Date.now());
  avisoInatividade.delete(de);

  // ── Dono: respostas rápidas 1/2/3 (só se não tiver fluxo ativo próprio) ──
  if (remetenteNumero === donoNumero && ['1', '2', '3'].includes(msgTrim) && !estado) {
    if (!ultimoPendente) return `Nenhum agendamento pendente no momento.`;
    const actionMap = {
      '1': `confirmar_${ultimoPendente}`,
      '2': `semvaga_${ultimoPendente}`,
      '3': `msg_${ultimoPendente}`
    };
    const resposta = await processarBotaoDono(actionMap[msgTrim]);
    return resposta || `Acao processada.`;
  }

  // ── Comandos do dono ──────────────────────────────────────────────────────
  if (remetenteNumero === donoNumero && msgTrim.startsWith('/')) {
    if (/^\/testeposaula$/i.test(msgTrim)) {
      definirEstado(de, { agente: 'clientes', etapa: 'aguardando_feedback_pos_aula', dados: {} });
      await enviarMensagem(de, MSG.posAulaFeedback());
      return null;
    }

    const resposta = await processarComandoDono(msgTrim, de);
    return resposta || `Comando nao reconhecido. Digite */ajuda* para ver os comandos.`;
  }

  // ── Fluxos ativos ────────────────────────────────────────────────────────
  // Se o aluno digitar uma opção do menu (1-6) enquanto espera texto (nome/telefone),
  // reseta o estado e trata como nova seleção de menu
  // Se aluno digitar 1-6, sempre limpa o estado e cai no menu
  if (/^[1-6]$/.test(msgTrim) && estado?.agente === 'clientes') {
    limparEstado(de);
    // não entra nos fluxos ativos abaixo
  } else if (estado?.agente === 'clientes') {

    // Ver agendamentos
    if (estado.etapa === 'aguardando_nome_agendamento') {
      if (msgTrim.length < 3) return `Por favor, informe seu *nome ou telefone*:`;
      try {
        const resultado = await Clientes.buscarPorWhatsApp(de);
        limparEstado(de);

        const nome = resultado?.dados?.[1] || msgTrim;
        const obs = resultado?.dados?.[6]; // "Pilates - Quarta - 10h"

        if (!obs) return MSG.agendamentosNaoEncontrados();

        const lista = `✅ ${obs}`;
        // Envia mensagem extra de boas-vindas após a lista
        enviarMensagem(de,
          `💧 Nao esqueca de trazer sua *agua* e usar *roupas confortaveis*, te esperamos aqui! 🧘‍♀️\n\n` +
          `Sabe chegar no nosso studio?\n` +
          `📍 https://maps.app.goo.gl/cHDecPZZRcNksCyE7`
        ).catch(() => {});
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

      const dataInfo = proximaDataDia(dia);
      if (!dataInfo) {
        return `😔 *${dia}* não tem vaga disponível nos próximos 6 dias.\n\nEscolha outro dia:\n1️⃣ Segunda\n2️⃣ Terca\n3️⃣ Quarta\n4️⃣ Quinta\n5️⃣ Sexta\n6️⃣ Sabado`;
      }

      const { nome, modalidade, horario } = estado.dados;
      limparEstado(de);

      await Clientes.salvarCliente({ nome, whatsapp: de, status: 'Lead', observacoes: `${modalidade} - ${dia} ${dataInfo.dataFormatada} - ${horario}` }).catch(() => {});

      await notificarStudioAgendamento(nome, normalizarNumero(de), modalidade, dia, dataInfo.dataFormatada, horario);

      await Logs.registrar('CLIENTES', 'INFO', `Agendamento: ${nome} - ${modalidade} ${dia} ${dataInfo.dataFormatada} ${horario}`);
      return MSG.encaminharAtendente(dia, dataInfo.dataFormatada, horario);
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

    // ── Fluxo Pós-aula ──
    if (estado.etapa === 'aguardando_feedback_pos_aula') {
      if (msgLower === '1' || /sim|adorei|gostei|amei|otimo|ótimo/i.test(msgLower)) {
        limparEstado(de);
        const atendente = obterAtendente();
        // Notifica atendente para follow-up de venda
        const nomeAluno = profileName || normalizarNumero(de);
        await enviarMensagem(DONO(),
          `🌟 *Aluno satisfeito — oportunidade de venda!*\n\n` +
          `👤 ${nomeAluno}\n` +
          `📱 +${normalizarNumero(de)}\n` +
          (atendente ? `👩‍💼 Atendente: *${atendente}*\n` : '') +
          `\nGostou da aula e pode virar aluno! Entre em contato. 💙`
        ).catch(() => {});
        return MSG.posAulaSim();
      }
      if (msgLower === '2' || /nao|não|sugestao|melhora/i.test(msgLower)) {
        definirEstado(de, { agente: 'clientes', etapa: 'aguardando_melhoria_pos_aula', dados: estado.dados });
        return MSG.posAulaNao();
      }
      return `Responda *1* — Sim ou *2* — Tenho sugestoes.`;
    }

    if (estado.etapa === 'aguardando_melhoria_pos_aula') {
      const melhoria = msgTrim;
      limparEstado(de);
      await Logs.registrar('CLIENTES', 'FEEDBACK', `Sugestao de melhoria: ${melhoria} (${de})`).catch(() => {});
      await enviarMensagem(DONO(),
        `💬 *Sugestao de melhoria recebida!*\n\n` +
        `📱 +${normalizarNumero(de)}\n\n` +
        `"${melhoria}"`
      ).catch(() => {});
      return MSG.posAulaMelhoriaRecebida();
    }

    // ── Fluxo Atendente ──
    if (estado.etapa === 'aguardando_nome_atendente') {
      const nome = msgTrim.length >= 3 ? msgTrim : profileName;
      const atendente = obterAtendente();
      limparEstado(de);

      await notificarStudioAtendente(nome, normalizarNumero(de), atendente);

      await Logs.registrar('CLIENTES', 'INFO', `Atendente solicitado: ${nome} (${de})`);
      return MSG.aguardandoAtendente(nome, atendente);
    }
  }

  // ── Opção 9 — atendente (dentro de outros fluxos) ────────────────────────
  if (msgLower === '9' || /atendente|humano|falar com/i.test(msgLower)) {
    if (!dentroDoPeriodoAtendimento()) return MSG.foraDoHorario();
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_atendente', dados: {} });
    return `Para te conectar com um atendente, me diz seu *nome*:`;
  }

  // ── Opcoes do menu ────────────────────────────────────────────────────────
  if (/1|agendar|marcar|quero aula|reserva|aula|agende/i.test(msgLower)) {
    await capturarLead(de, profileName);
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendar', dados: {} });
    return MSG.pedirNomeAgendar();
  } else if (/2|agendamentos?|minhas? aulas?|ver agend/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_agendamento', dados: {} });
    return MSG.pedirNomeOuTelefone();
  } else if (/3|plano|valor|preco|mensalidade|custa|pre[çc]o/i.test(msgLower)) {
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_planos', dados: {} });
    return MSG.pedirNomePlanos();
  } else if (/4|totalpass|welhub|gympass/i.test(msgLower)) {
    return MSG.totalpass();
  } else if (/5|endere[çc]o|onde|localiza|chegar/i.test(msgLower)) {
    return MSG.endereco();
  } else if (/6|atendente|alguem|humano|operador/i.test(msgLower)) {
    if (!dentroDoPeriodoAtendimento()) return MSG.foraDoHorario();
    definirEstado(de, { agente: 'clientes', etapa: 'aguardando_nome_atendente', dados: {} });
    return `Para te conectar com um atendente, me diz seu *nome*:`;
  }

  if (/^(oi|ola|bom dia|boa tarde|boa noite|hey|hi|menu|inicio|start)$/i.test(msgLower)) {
    await capturarLead(de, profileName);
    return MSG.menu();
  }

  // NPS
  const npsNum = parseInt(msgLower);
  if (/^\d+$/.test(msgLower) && npsNum >= 7 && npsNum <= 10) {
    await Clientes.salvarNPS({ whatsapp: de, nome: profileName, nota: npsNum }).catch(() => {});
    const emo = npsNum >= 9 ? '🌟' : '😊';
    return `${emo} Obrigada pela avaliacao *${npsNum}/10*, ${profileName}! 💙`;
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
// ─── Cron: mensagem pós-aula automática ──────────────────────────────────────
// Roda 5 min depois de cada hora em dias de aula (Seg-Sab)
// Verifica quais alunos tinham aula no dia/horário que acabou de terminar
cron.schedule('5 * * * 1-6', async () => {
  try {
    const agora = new Date();
    const horaTerminou = agora.getHours() - 1; // aula de 1h que terminou agora
    if (horaTerminou < 0) return; // meia-noite, ignora
    const horarioAula = `${horaTerminou}h`;
    const diaHoje = DIAS_SEMANA[agora.getDay()];

    const alunos = await Clientes.listarComAgendamento();
    for (const aluno of alunos) {
      const obs = (aluno[6] || '').toLowerCase();
      if (!obs.includes(diaHoje.toLowerCase()) || !obs.includes(horarioAula)) continue;

      const whatsapp = aluno[2]; // col WhatsApp
      if (!whatsapp) continue;

      definirEstado(whatsapp, { agente: 'clientes', etapa: 'aguardando_feedback_pos_aula', dados: {} });
      await enviarMensagem(whatsapp, MSG.posAulaFeedback()).catch(e =>
        logger.warn(`[CRON POS-AULA] Falha ao enviar para ${whatsapp}: ${e.message}`)
      );
      await new Promise(r => setTimeout(r, 1500)); // pausa entre envios
    }
    logger.info(`[CRON POS-AULA] ${diaHoje} ${horarioAula} — ${alunos.length} verificados`);
  } catch (e) { logger.error(`[CRON POS-AULA] ${e.message}`); }
}, { timezone: 'America/Sao_Paulo' });

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
