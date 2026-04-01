// utils/sheets.js — Wrapper Google Sheets API v4
require('dotenv').config();
const { google } = require('googleapis');
const { getAuth } = require('./google-auth');
const logger = require('./logger');

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}


// ─── IDs das planilhas por domínio ─────────────────────────────────────────
const SHEET_IDS = {
  clientes:    () => process.env.GOOGLE_SHEETS_CLIENTES_ID,
  financeiro:  () => process.env.GOOGLE_SHEETS_FINANCEIRO_ID,
  operacional: () => process.env.GOOGLE_SHEETS_OPERACIONAL_ID,
  marketing:   () => process.env.GOOGLE_SHEETS_MARKETING_ID,
  logs:        () => process.env.GOOGLE_SHEETS_LOGS_ID
};

// ─── Funções genéricas ──────────────────────────────────────────────────────

/**
 * Lê todas as linhas de uma aba
 * @param {string} dominio - 'clientes' | 'financeiro' | 'operacional' | 'marketing' | 'logs'
 * @param {string} aba - Nome da aba (ex: 'Clientes', 'Transacoes')
 * @param {string} range - Range opcional (padrão: A:Z)
 * @returns {Promise<Array>} Array de arrays com os valores
 */
async function lerLinhas(dominio, aba, range = 'A:Z') {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = SHEET_IDS[dominio]();

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${aba}!${range}`
    });

    return resp.data.values || [];
  } catch (erro) {
    logger.error(`Erro ao ler Sheet [${dominio}/${aba}]: ${erro.message}`);
    throw erro;
  }
}

/**
 * Adiciona uma nova linha ao final da aba
 * @param {string} dominio
 * @param {string} aba
 * @param {Array} valores - Array com os valores da linha
 */
async function adicionarLinha(dominio, aba, valores) {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = SHEET_IDS[dominio]();

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${aba}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [valores]
      }
    });

    logger.debug(`✅ Linha adicionada em [${dominio}/${aba}]: ${valores.join(' | ')}`);
  } catch (erro) {
    logger.error(`Erro ao adicionar linha em [${dominio}/${aba}]: ${erro.message}`);
    throw erro;
  }
}

/**
 * Atualiza uma célula ou range específico
 * @param {string} dominio
 * @param {string} aba
 * @param {string} range - Ex: 'B5' ou 'B5:C5'
 * @param {Array} valores - Array de arrays com valores
 */
async function atualizarCelula(dominio, aba, range, valores) {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = SHEET_IDS[dominio]();

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${aba}!${range}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: valores }
    });

    logger.debug(`✅ Célula atualizada [${dominio}/${aba}!${range}]`);
  } catch (erro) {
    logger.error(`Erro ao atualizar célula [${dominio}/${aba}!${range}]: ${erro.message}`);
    throw erro;
  }
}

/**
 * Busca uma linha por valor em coluna específica
 * @param {string} dominio
 * @param {string} aba
 * @param {number} coluna - Índice da coluna (0 = A)
 * @param {string} valor - Valor a buscar
 * @returns {Promise<{linha: number, dados: Array}|null>}
 */
async function buscarLinha(dominio, aba, coluna, valor) {
  try {
    const linhas = await lerLinhas(dominio, aba);
    const idx = linhas.findIndex(
      (linha) => linha[coluna] && linha[coluna].toString().toLowerCase() === valor.toString().toLowerCase()
    );

    if (idx === -1) return null;
    return { linha: idx + 1, dados: linhas[idx] };
  } catch (erro) {
    logger.error(`Erro ao buscar linha [${dominio}/${aba}]: ${erro.message}`);
    throw erro;
  }
}

// ─── Funções específicas por domínio ───────────────────────────────────────

// CLIENTES
const Clientes = {
  /**
   * Salva novo lead/cliente
   * Col: Data | Nome | WhatsApp | Email | Status | Plano | Observações
   */
  async salvarCliente(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.nome || '',
      dados.whatsapp || '',
      dados.email || '',
      dados.status || 'Lead',
      dados.plano || '',
      dados.observacoes || ''
    ];
    await adicionarLinha('clientes', 'Clientes', linha);
  },

  async buscarPorWhatsApp(numero) {
    return buscarLinha('clientes', 'Clientes', 2, numero);
  },

  async listarAtivos() {
    const linhas = await lerLinhas('clientes', 'Clientes');
    return linhas.slice(1).filter(l => l[4] === 'Ativo'); // Pula cabeçalho
  },

  /**
   * Salva resposta NPS
   * Col: Data | WhatsApp | Nome | Nota | Comentário
   */
  async salvarNPS(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.whatsapp,
      dados.nome || '',
      dados.nota,
      dados.comentario || ''
    ];
    await adicionarLinha('clientes', 'NPS', linha);
  },

  /**
   * Busca clientes inadimplentes (pagamento vencido)
   */
  async listarInadimplentes() {
    const linhas = await lerLinhas('clientes', 'Clientes');
    return linhas.slice(1).filter(l => l[4] === 'Inadimplente');
  }
};

// FINANCEIRO
const Financeiro = {
  /**
   * Registra transação
   * Col: Data | Tipo | Valor | Categoria | Descrição | WhatsApp Cliente
   */
  async registrarTransacao(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.tipo || 'entrada',       // 'entrada' ou 'saída'
      dados.valor.toFixed(2),
      dados.categoria || 'Outros',
      dados.descricao || '',
      dados.whatsapp || ''
    ];
    await adicionarLinha('financeiro', 'Transacoes', linha);
  },

  /**
   * Soma entradas e saídas da semana atual
   */
  async resumoSemanal() {
    const linhas = await lerLinhas('financeiro', 'Transacoes');
    const hoje = new Date();
    const inicioSemana = new Date(hoje);
    inicioSemana.setDate(hoje.getDate() - hoje.getDay());

    let entradas = 0;
    let saidas = 0;

    linhas.slice(1).forEach(linha => {
      const [dia, mes, ano] = (linha[0] || '').split('/');
      const data = new Date(`${ano}-${mes}-${dia}`);

      if (data >= inicioSemana) {
        const valor = parseFloat(linha[2]?.replace(',', '.') || 0);
        if (linha[1] === 'entrada') entradas += valor;
        else if (linha[1] === 'saída') saidas += valor;
      }
    });

    return {
      entradas,
      saidas,
      saldo: entradas - saidas,
      semana: inicioSemana.toLocaleDateString('pt-BR')
    };
  }
};

// OPERACIONAL
const Operacional = {
  /**
   * Atualiza quantidade de estoque
   * Col: Item | Quantidade | Unidade | Última Atualização | Observações
   */
  async atualizarEstoque(item, quantidade, observacoes = '') {
    const resultado = await buscarLinha('operacional', 'Estoque', 0, item);
    const data = new Date().toLocaleDateString('pt-BR');

    if (resultado) {
      // Atualiza linha existente (colunas B, D, E)
      const linhaIdx = resultado.linha + 1; // +1 pelo cabeçalho
      await atualizarCelula('operacional', 'Estoque', `B${linhaIdx}:E${linhaIdx}`, [[
        quantidade.toString(),
        resultado.dados[2] || 'un',
        data,
        observacoes
      ]]);
    } else {
      // Cria novo item
      await adicionarLinha('operacional', 'Estoque', [item, quantidade.toString(), 'un', data, observacoes]);
    }
  },

  async listarEstoque() {
    return lerLinhas('operacional', 'Estoque');
  },

  async registrarManutencao(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.item,
      dados.descricao,
      dados.status || 'Pendente',
      dados.responsavel || ''
    ];
    await adicionarLinha('operacional', 'Manutencao', linha);
  }
};

// MARKETING
const Marketing = {
  /**
   * Salva ideia de conteúdo
   * Col: Data | Plataforma | Tipo | Legenda | Hashtags | Status
   */
  async salvarConteudo(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.plataforma || 'Instagram',
      dados.tipo || 'Post',
      dados.legenda || '',
      dados.hashtags || '',
      dados.status || 'Rascunho'
    ];
    await adicionarLinha('marketing', 'Conteudo', linha);
  },

  async listarConteudoPendente() {
    const linhas = await lerLinhas('marketing', 'Conteudo');
    return linhas.slice(1).filter(l => l[5] === 'Rascunho');
  },

  /**
   * Salva métricas manuais
   * Col: Data | Plataforma | Seguidores | Alcance | Engajamento | Observações
   */
  async salvarMetricas(dados) {
    const linha = [
      new Date().toLocaleDateString('pt-BR'),
      dados.plataforma || 'Instagram',
      dados.seguidores || '',
      dados.alcance || '',
      dados.engajamento || '',
      dados.observacoes || ''
    ];
    await adicionarLinha('marketing', 'Metricas', linha);
  }
};

// LOGS
const Logs = {
  async registrar(agente, nivel, mensagem, detalhes = '') {
    const linha = [
      new Date().toLocaleString('pt-BR'),
      agente,
      nivel, // 'INFO' | 'WARN' | 'ERROR'
      mensagem,
      detalhes
    ];
    try {
      await adicionarLinha('logs', 'Logs', linha);
    } catch (e) {
      // Não propaga erro de log para evitar loop
      logger.warn(`Falha ao salvar log na Sheet: ${e.message}`);
    }
  }
};

module.exports = {
  lerLinhas,
  adicionarLinha,
  atualizarCelula,
  buscarLinha,
  Clientes,
  Financeiro,
  Operacional,
  Marketing,
  Logs
};
