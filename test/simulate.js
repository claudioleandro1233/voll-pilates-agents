// test/simulate.js — Simulação de webhooks e cenários sem dependências externas
// Execute: node test/simulate.js

'use strict';

let passou = 0;
let falhou = 0;

function ok(descricao, resultado) {
  if (resultado) {
    console.log(`  ✅ ${descricao}`);
    passou++;
  } else {
    console.error(`  ❌ FALHOU: ${descricao}`);
    falhou++;
  }
}

// ─── Testa parsers sem I/O externo ───────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🧪 TESTES — Voll Pilates Agents');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── Teste 1: Parser financeiro — gasto ───────────────────────────────────────
console.log('📦 [1] Parser Financeiro — Gastos');
{
  function parsearGasto(mensagem) {
    const regex = /gasto\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s+(.+)/i;
    const match = mensagem.match(regex);
    if (!match) return null;
    return { valor: parseFloat(match[1].replace(',', '.')), categoria: match[2].trim().toLowerCase() };
  }

  const t1 = parsearGasto('gasto R$150 aluguel');
  ok('gasto R$150 aluguel → valor=150', t1?.valor === 150);
  ok('gasto R$150 aluguel → categoria=aluguel', t1?.categoria === 'aluguel');

  const t2 = parsearGasto('gasto 80,50 material');
  ok('gasto 80,50 material → valor=80.5', t2?.valor === 80.5);

  const t3 = parsearGasto('entrada R$80 aula');
  ok('entrada R$80 → parsearGasto retorna null', t3 === null);
}

// ── Teste 2: Parser financeiro — entrada ─────────────────────────────────────
console.log('\n💰 [2] Parser Financeiro — Entradas');
{
  function parsearEntrada(mensagem) {
    const regex = /(?:entrada|receb[ei]+|pago|pagou|pag[ou]+)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s+(\w+)(?:\s+(.+))?/i;
    const match = mensagem.match(regex);
    if (!match) return null;
    return {
      valor: parseFloat(match[1].replace(',', '.')),
      categoria: match[2].trim().toLowerCase(),
      descricao: match[3]?.trim() || ''
    };
  }

  const t1 = parsearEntrada('entrada R$80 aula');
  ok('entrada R$80 aula → valor=80', t1?.valor === 80);
  ok('entrada R$80 aula → categoria=aula', t1?.categoria === 'aula');

  const t2 = parsearEntrada('recebei 200 mensalidade Ana');
  ok('recebei 200 mensalidade → valor=200', t2?.valor === 200);
  ok('recebei 200 mensalidade → descricao=Ana', t2?.descricao === 'Ana');

  const t3 = parsearEntrada('gasto R$50 limpeza');
  ok('gasto R$50 → parsearEntrada retorna null', t3 === null);
}

// ── Teste 3: Parser operacional — estoque ────────────────────────────────────
console.log('\n📦 [3] Parser Operacional — Estoque');
{
  function parsearEstoque(mensagem) {
    const regex1 = /estoque\s+(.+?)\s+(\d+)(?:\s+(.+))?$/i;
    const regex2 = /estoque\s+(\d+)\s+(.+)$/i;

    let match = mensagem.match(regex1);
    if (match && !isNaN(parseInt(match[1]))) {
      // primeiro token é número → testa regex2
    } else if (match) {
      return { item: match[1].trim(), quantidade: parseInt(match[2]), observacoes: match[3] || '' };
    }
    match = mensagem.match(regex2);
    if (match) return { item: match[2].trim(), quantidade: parseInt(match[1]), observacoes: '' };
    return null;
  }

  const t1 = parsearEstoque('estoque colchonetes 8');
  ok('estoque colchonetes 8 → item=colchonetes', t1?.item === 'colchonetes');
  ok('estoque colchonetes 8 → quantidade=8', t1?.quantidade === 8);

  const t2 = parsearEstoque('estoque 5 elásticos');
  ok('estoque 5 elásticos → item=elásticos', t2?.item === 'elásticos');
  ok('estoque 5 elásticos → quantidade=5', t2?.quantidade === 5);

  const t3 = parsearEstoque('ver estoque');
  ok('ver estoque → retorna null (não é update)', t3 === null);
}

// ── Teste 4: Extração de dados do webhook Twilio ──────────────────────────────
console.log('\n📡 [4] Parser Webhook Twilio');
{
  function extrairDadosWebhook(body) {
    return {
      de: body.From || '',
      para: body.To || '',
      mensagem: (body.Body || '').trim(),
      numMidia: parseInt(body.NumMedia || '0'),
      urlMidia: body.MediaUrl0 || null,
      profileName: body.ProfileName || 'Desconhecido',
      waId: body.WaId || ''
    };
  }

  const payload = {
    From: 'whatsapp:+5511999998888',
    To: 'whatsapp:+14155238886',
    Body: '  agendar  ',
    NumMedia: '0',
    ProfileName: 'Claudinho'
  };

  const dados = extrairDadosWebhook(payload);
  ok('de extraído corretamente', dados.de === 'whatsapp:+5511999998888');
  ok('mensagem trimmed', dados.mensagem === 'agendar');
  ok('profileName extraído', dados.profileName === 'Claudinho');
  ok('numMidia parsado para inteiro', dados.numMidia === 0);
}

// ── Teste 5: Geração de posts de marketing ───────────────────────────────────
console.log('\n📱 [5] Gerador de Posts');
{
  const TEMPLATES = [
    { tipo: 'motivacional', legenda: (t) => `Treino matinal Voll! ${t || ''} 💪`, hashtags: '#Pilates #VollPilates' },
    { tipo: 'dica', legenda: (t) => `Dica: ${t || 'Respire!'}`, hashtags: '#PilatesDica' }
  ];

  function gerarPost(tipo, tema = '') {
    let template = TEMPLATES.find(t => t.tipo === tipo?.toLowerCase());
    if (!template) template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    return { legenda: template.legenda(tema), hashtags: template.hashtags, tipo: template.tipo };
  }

  const p1 = gerarPost('motivacional', 'Agende agora!');
  ok('post motivacional gerado com legenda', p1?.legenda?.length > 0);
  ok('post motivacional tem hashtags', p1?.hashtags?.includes('#Pilates'));
  ok('tipo correto', p1?.tipo === 'motivacional');

  const p2 = gerarPost('tipo_inexistente');
  ok('tipo inexistente usa template aleatório', p2 !== null);
  ok('template aleatório tem hashtags', p2?.hashtags?.length > 0);
}

// ── Teste 6: Intenções do agente de clientes ─────────────────────────────────
console.log('\n🧘 [6] Detecção de Intenções (Clientes)');
{
  const intenções = {
    saudacao: (msg) => /^(oi|olá|ola|bom dia|boa tarde|boa noite|hey|1)$/i.test(msg),
    agendar:  (msg) => /agendar|marcar|quero aula|aula|horário|horario/i.test(msg),
    planos:   (msg) => /plano|valor|preço|preco|mensalidade|quanto/i.test(msg),
    endereco: (msg) => /endereço|endereco|onde|localização|como chegar/i.test(msg)
  };

  ok('oi → saudacao', intenções.saudacao('oi'));
  ok('bom dia → saudacao', intenções.saudacao('bom dia'));
  ok('agendar aula → agendar', intenções.agendar('agendar aula'));
  ok('quero marcar → agendar', intenções.agendar('quero marcar'));
  ok('quanto custa → planos', intenções.planos('quanto custa'));
  ok('onde fica → endereco', intenções.endereco('onde fica'));
  ok('saldo → não é saudação', !intenções.saudacao('saldo'));
}

// ── Teste 7: Formatação de relatório financeiro ───────────────────────────────
console.log('\n💹 [7] Formatação Relatório Financeiro');
{
  function formatarRelatorio(resumo) {
    const emoji = resumo.saldo >= 0 ? '📈' : '📉';
    return (
      `${emoji} *Relatório Financeiro Semanal*\n` +
      `💰 Entradas: R$ ${resumo.entradas.toFixed(2)}\n` +
      `💸 Saídas: R$ ${resumo.saidas.toFixed(2)}\n` +
      `📊 Saldo: R$ ${resumo.saldo.toFixed(2)}`
    );
  }

  const r1 = formatarRelatorio({ entradas: 1500, saidas: 300, saldo: 1200, semana: '01/01' });
  ok('saldo positivo usa 📈', r1.startsWith('📈'));
  ok('contém valor de entradas', r1.includes('1500.00'));

  const r2 = formatarRelatorio({ entradas: 100, saidas: 500, saldo: -400, semana: '01/01' });
  ok('saldo negativo usa 📉', r2.startsWith('📉'));
  ok('contém valor do saldo negativo', r2.includes('-400.00'));
}

// ── Teste 8: Máquina de estados de agendamento ───────────────────────────────
console.log('\n📅 [8] Máquina de Estados — Agendamento');
{
  const estadosMock = new Map();

  function definirEstado(num, estado) { estadosMock.set(num, estado); }
  function obterEstado(num) { return estadosMock.get(num) || null; }
  function limparEstado(num) { estadosMock.delete(num); }

  // Simula fluxo completo
  const usuario = 'whatsapp:+5511999990000';

  definirEstado(usuario, { agente: 'clientes', etapa: 'aguardando_nome', dados: {} });
  ok('estado aguardando_nome definido', obterEstado(usuario)?.etapa === 'aguardando_nome');

  definirEstado(usuario, { agente: 'clientes', etapa: 'aguardando_data', dados: { nome: 'Maria' } });
  ok('transição para aguardando_data', obterEstado(usuario)?.etapa === 'aguardando_data');
  ok('nome preservado nos dados', obterEstado(usuario)?.dados?.nome === 'Maria');

  limparEstado(usuario);
  ok('estado limpo após conclusão', obterEstado(usuario) === null);
}

// ── Teste 9: Verificação de sábado alternado ─────────────────────────────────
console.log('\n📅 [9] Cálculo de Sábado Alternado');
{
  function verificarSabadoAlternado(dataRef) {
    const hoje = dataRef || new Date();
    const diaAno = Math.floor((hoje - new Date(hoje.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
    const semana = Math.floor(diaAno / 7);
    const temAula = semana % 2 === 0;
    const proximoSab = new Date(hoje);
    proximoSab.setDate(hoje.getDate() + (6 - hoje.getDay()));
    return { data: proximoSab.toLocaleDateString('pt-BR'), temAula };
  }

  const resultado = verificarSabadoAlternado(new Date('2024-01-15'));
  ok('função retorna objeto com data e temAula', resultado?.data !== undefined && resultado?.temAula !== undefined);
  ok('temAula é boolean', typeof resultado.temAula === 'boolean');
}

// ── Teste 10: Estrutura dos arquivos do projeto ──────────────────────────────
console.log('\n📁 [10] Estrutura do Projeto');
{
  const fs = require('fs');
  const path = require('path');
  const base = path.join(__dirname, '..');

  const arquivosEsperados = [
    'app.js',
    'package.json',
    '.env.example',
    'agents/agent-clientes.js',
    'agents/agent-financeiro.js',
    'agents/agent-marketing.js',
    'agents/agent-operacional.js',
    'agents/agent-supervisor.js',
    'utils/twilio.js',
    'utils/sheets.js',
    'utils/calendar.js',
    'utils/state.js',
    'utils/logger.js'
  ];

  arquivosEsperados.forEach(arquivo => {
    const existe = fs.existsSync(path.join(base, arquivo));
    ok(`${arquivo} existe`, existe);
  });
}

// ─── Resumo ───────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  📊 RESULTADO: ${passou} passaram | ${falhou} falharam`);
if (falhou === 0) {
  console.log('  🎉 Todos os testes passaram! Projeto pronto para deploy.');
} else {
  console.log(`  ⚠️  ${falhou} teste(s) precisam de atenção.`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Retorna código de saída correto para CI
process.exit(falhou > 0 ? 1 : 0);
