// agents/agent-marketing.js — Agente de Marketing
// Responsável: Geração de posts IG, análise métricas manuais, agendamento conteúdo

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { enviarMensagem, extrairDadosWebhook } = require('../utils/zapi');
const { Marketing, Logs } = require('../utils/sheets');
const logger = require('../utils/logger');

const router = express.Router();

const DONO_WHATSAPP = () => process.env.DONO_WHATSAPP;
const BOOKING_LINK = () => process.env.STUDIO_BOOKING_LINK || 'link na bio';
const INSTAGRAM = () => process.env.STUDIO_INSTAGRAM || '@vollpilatesautodromo';

// ─── Banco de templates de post ──────────────────────────────────────────────
const TEMPLATES_POST = [
  {
    tipo: 'motivacional',
    legenda: (tema) =>
      `💪 *Seu corpo agradece cada aula!*\n\n` +
      `${tema ? tema + '\n\n' : ''}` +
      `No Pilates, cada movimento é intencional. Cada aula é um presente para o seu corpo e mente. 🧘‍♀️✨\n\n` +
      `Comece hoje! Agende uma aula experimental gratuita:\n📍 ${BOOKING_LINK()}\n\n`,
    hashtags: '#Pilates #VollPilates #BemEstar #Saúde #PilatesMotivação #TreinoMatinal #QualidadeDeVida #PilatesBrasil #CoreForte #Flexibilidade'
  },
  {
    tipo: 'horario',
    legenda: (tema) =>
      `⏰ *Encaixe o Pilates na sua rotina!*\n\n` +
      `${tema ? tema + '\n\n' : ''}` +
      `Temos horários de manhã para você começar o dia com energia! ☀️\n\n` +
      `📅 Seg–Sex: 07h às 10h45\n📅 Sábado: 08h às 11h45\n\n` +
      `Agende agora: ${BOOKING_LINK()}\n`,
    hashtags: '#Pilates #VollPilates #HorárioFlexível #PilatesManhã #Autodromo #StudioPilates #AulaDegrupo #Saúde'
  },
  {
    tipo: 'beneficio',
    legenda: (tema) =>
      `🌟 *${tema || 'Você sabia? O Pilates transforma!'}*\n\n` +
      `✅ Melhora a postura\n✅ Alivia dores crônicas\n✅ Fortalece o core\n✅ Reduz o estresse\n✅ Aumenta a flexibilidade\n\n` +
      `Junte-se à família Voll Pilates! 💙\nPrimeira aula gratuita: ${BOOKING_LINK()}\n`,
    hashtags: '#Pilates #VollPilates #BeneficiosPilates #Postura #CorpoSaudavel #MenteCorpoAlma #PilatesParaTodos #BemEstarTotal'
  },
  {
    tipo: 'depoimento',
    legenda: (tema) =>
      `💬 *"${tema || 'O Pilates mudou minha vida. Minha postura e disposicao melhoraram 100%!'}*"\n\n` +
      `Nada nos deixa mais felizes do que ver a transformação dos nossos alunos! 🥰\n\n` +
      `Venha fazer parte dessa história!\n📍 ${BOOKING_LINK()}\n`,
    hashtags: '#Pilates #VollPilates #Depoimento #Transformação #ResultadosPilates #AlunoFeliz #Motivação #PilatesFunciona'
  },
  {
    tipo: 'dica',
    legenda: (tema) =>
      `💡 *Dica de Pilates:* ${tema || 'Respiração é a chave!'}\n\n` +
      `Sabia que respirar corretamente durante os exercícios potencializa seus resultados?\n\n` +
      `Na Voll Pilates, trabalhamos técnica com muito cuidado. 🧘‍♀️\n\nAgende: ${BOOKING_LINK()}\n`,
    hashtags: '#Pilates #VollPilates #DicaDePilates #TécnicaPilates #MovimentoConsciente #StudioPilates #Respiração #BemEstar'
  }
];

// ─── Skills ──────────────────────────────────────────────────────────────────

/**
 * Skill: Gerar post Instagram
 * @param {string} tipo - Tipo do post (motivacional, horario, beneficio, dica, depoimento)
 * @param {string} tema - Tema/ideia adicional
 */
function gerarPost(tipo, tema = '') {
  const tiposDisponiveis = TEMPLATES_POST.map(t => t.tipo);

  let template;
  if (tipo && tiposDisponiveis.includes(tipo.toLowerCase())) {
    template = TEMPLATES_POST.find(t => t.tipo === tipo.toLowerCase());
  } else {
    // Seleciona template aleatório
    template = TEMPLATES_POST[Math.floor(Math.random() * TEMPLATES_POST.length)];
  }

  const legenda = template.legenda(tema);
  const hashtags = template.hashtags;

  return { legenda, hashtags, tipo: template.tipo };
}

/**
 * Formata post para WhatsApp
 */
function formatarPostWhatsApp(post) {
  return (
    `📱 *Post gerado para o Instagram:*\n` +
    `_Tipo: ${post.tipo}_\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `${post.legenda}\n` +
    `${post.hashtags}\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `_Copie e cole no Instagram ${INSTAGRAM()}_\n\n` +
    `Deseja salvar este conteúdo? Responda *"salvar"*.`
  );
}

/**
 * Skill: Registrar métricas
 * Parser: "métricas instagram 1500 seguidores 200 alcance"
 */
function parsearMetricas(mensagem) {
  const regex = /m[eé]tricas?\s+(\w+)\s+(\d+)\s+(?:seguidores?)(?:\s+(\d+)\s+(?:alcance|views?))?/i;
  const match = mensagem.match(regex);
  if (!match) return null;

  return {
    plataforma: match[1],
    seguidores: match[2],
    alcance: match[3] || ''
  };
}

/**
 * Skill: Ajuda marketing
 */
function ajuda() {
  return (
    `📣 *Agente de Marketing — Comandos:*\n\n` +
    `📱 Gerar post:\n  _gerar post_\n  _gerar post motivacional_\n  _post dica [sua ideia]_\n\n` +
    `📊 Salvar métricas:\n  _métricas instagram 1500 seguidores 300 alcance_\n\n` +
    `📋 Ver conteúdos pendentes:\n  _conteúdo pendente_\n\n` +
    `💡 Tipos de post disponíveis:\n  motivacional, horario, beneficio, dica, depoimento`
  );
}

// ─── Roteador de mensagens ───────────────────────────────────────────────────
// Armazena último post gerado por usuário (temporário)
const ultimoPost = new Map();

async function processarMensagem(de, mensagem) {
  const msgLower = mensagem.toLowerCase().trim();

  // Gerar post
  if (/^(?:gerar?\s+)?post|^post\s/i.test(msgLower) || /gera\s+(?:um\s+)?post|idéia\s+de\s+post/i.test(msgLower)) {
    // Extrai tipo e tema da mensagem
    const partes = mensagem.replace(/^(?:gerar?\s+)?post\s*/i, '').trim();
    const tiposConhecidos = ['motivacional', 'horario', 'beneficio', 'dica', 'depoimento'];
    let tipo = '';
    let tema = partes;

    for (const t of tiposConhecidos) {
      if (partes.toLowerCase().startsWith(t)) {
        tipo = t;
        tema = partes.slice(t.length).trim();
        break;
      }
    }

    const post = gerarPost(tipo, tema);
    ultimoPost.set(de, post);
    return formatarPostWhatsApp(post);
  }

  // Salvar último post gerado
  if (/^salvar$/i.test(msgLower)) {
    const post = ultimoPost.get(de);
    if (!post) return `Nenhum post recente para salvar. Diga *"gerar post"* primeiro.`;

    await Marketing.salvarConteudo({
      plataforma: 'Instagram',
      tipo: post.tipo,
      legenda: post.legenda,
      hashtags: post.hashtags,
      status: 'Rascunho'
    });
    ultimoPost.delete(de);
    await Logs.registrar('MARKETING', 'INFO', `Post ${post.tipo} salvo`);
    return `✅ Post salvo com sucesso na planilha de conteúdo!`;
  }

  // Registrar métricas
  const metricas = parsearMetricas(mensagem);
  if (metricas) {
    await Marketing.salvarMetricas(metricas);
    return (
      `✅ *Métricas registradas!*\n\n` +
      `📱 Plataforma: *${metricas.plataforma}*\n` +
      `👥 Seguidores: *${metricas.seguidores}*\n` +
      `${metricas.alcance ? `👁️ Alcance: *${metricas.alcance}*\n` : ''}` +
      `📅 Data: *${new Date().toLocaleDateString('pt-BR')}*`
    );
  }

  // Conteúdo pendente
  if (/conteúdo|conteudo|pendente|rascunho/i.test(msgLower)) {
    const pendentes = await Marketing.listarConteudoPendente();
    if (!pendentes || pendentes.length === 0) {
      return `📋 Nenhum conteúdo pendente. Diga *"gerar post"* para criar um!`;
    }
    const lista = pendentes.slice(0, 5).map((p, i) =>
      `${i + 1}. [${p[2]}] ${p[3]?.slice(0, 60)}...`
    ).join('\n');
    return `📋 *Conteúdos pendentes (${pendentes.length}):*\n\n${lista}`;
  }

  return ajuda();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { de, mensagem, isGroup, fromMe } = extrairDadosWebhook(req.body);

    if (!de || !mensagem || fromMe || isGroup) return res.status(200).send('OK');

    logger.info(`[MARKETING] Mensagem de ${de}: "${mensagem}"`);

    const resposta = await processarMensagem(de, mensagem);
    await enviarMensagem(de, resposta);

    res.status(200).send('OK');
  } catch (erro) {
    logger.error(`[MARKETING] Erro no webhook: ${erro.message}`);
    const { de } = extrairDadosWebhook(req.body);
    if (de) {
      await enviarMensagem(de, `❌ Erro ao processar. Tente novamente.`).catch(() => {});
    }
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Crons ───────────────────────────────────────────────────────────────────

/**
 * Envia ideia de post toda segunda-feira às 08:30 para o dono
 */
cron.schedule('30 8 * * 1', async () => {
  logger.info('[CRON] Enviando ideia de conteúdo semanal...');
  try {
    const post = gerarPost(''); // Tipo aleatório
    const msg =
      `💡 *Sugestão de post para esta semana:*\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `${post.legenda}\n${post.hashtags}\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `Responda *"salvar"* para guardar ou ignore para descartar.`;

    await enviarMensagem(DONO_WHATSAPP(), msg);
    await Logs.registrar('MARKETING', 'INFO', 'Sugestão de conteúdo semanal enviada');
  } catch (erro) {
    logger.error(`[CRON MARKETING] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

/**
 * Lembrete de postar — Quarta e sexta às 07:30
 */
cron.schedule('30 7 * * 3,5', async () => {
  try {
    const pendentes = await Marketing.listarConteudoPendente();
    if (pendentes.length > 0) {
      await enviarMensagem(
        DONO_WHATSAPP(),
        `📱 *Lembrete de Marketing:*\nVocê tem *${pendentes.length} post(s)* aguardando publicação!\nAcesse a planilha de conteúdo para ver os rascunhos.`
      );
    }
  } catch (erro) {
    logger.error(`[CRON LEMBRETE MARKETING] Erro: ${erro.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = router;
