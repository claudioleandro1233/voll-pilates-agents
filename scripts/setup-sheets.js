// scripts/setup-sheets.js — Configura abas e cabeçalhos nas planilhas existentes
require('dotenv').config();
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './credentials/google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// ─── Definição das planilhas e suas abas ─────────────────────────────────────
const PLANILHAS = [
  {
    envKey: 'GOOGLE_SHEETS_CLIENTES_ID',
    titulo: 'Clientes',
    abas: [
      { nome: 'Clientes',  cabecalho: ['Data', 'Nome', 'WhatsApp', 'Email', 'Status', 'Plano', 'Observações'] },
      { nome: 'NPS',       cabecalho: ['Data', 'WhatsApp', 'Nome', 'Nota', 'Comentário'] }
    ]
  },
  {
    envKey: 'GOOGLE_SHEETS_FINANCEIRO_ID',
    titulo: 'Financeiro',
    abas: [
      { nome: 'Transacoes', cabecalho: ['Data', 'Tipo', 'Valor', 'Categoria', 'Descrição', 'WhatsApp Cliente'] }
    ]
  },
  {
    envKey: 'GOOGLE_SHEETS_OPERACIONAL_ID',
    titulo: 'Operacional',
    abas: [
      { nome: 'Estoque',    cabecalho: ['Item', 'Quantidade', 'Unidade', 'Última Atualização', 'Observações'] },
      { nome: 'Manutencao', cabecalho: ['Data', 'Item', 'Descrição', 'Status', 'Responsável'] }
    ]
  },
  {
    envKey: 'GOOGLE_SHEETS_MARKETING_ID',
    titulo: 'Marketing',
    abas: [
      { nome: 'Conteudo', cabecalho: ['Data', 'Plataforma', 'Tipo', 'Legenda', 'Hashtags', 'Status'] },
      { nome: 'Metricas', cabecalho: ['Data', 'Plataforma', 'Seguidores', 'Alcance', 'Engajamento', 'Observações'] }
    ]
  },
  {
    envKey: 'GOOGLE_SHEETS_LOGS_ID',
    titulo: 'Logs',
    abas: [
      { nome: 'Logs', cabecalho: ['Data', 'Agente', 'Nível', 'Mensagem', 'Detalhes'] }
    ]
  }
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function listarAbas(spreadsheetId) {
  const resp = await sheets.spreadsheets.get({ spreadsheetId });
  return resp.data.sheets.map(s => ({
    nome: s.properties.title,
    sheetId: s.properties.sheetId
  }));
}

async function criarAba(spreadsheetId, nome) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: nome } } }]
    }
  });
}

async function renomearPrimeira(spreadsheetId, novoNome, sheetId) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, title: novoNome },
          fields: 'title'
        }
      }]
    }
  });
}

async function inserirCabecalho(spreadsheetId, aba, cabecalho) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${aba}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [cabecalho] }
  });
}

async function formatarCabecalho(spreadsheetId, sheetId, numColunas) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numColunas },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.18, green: 0.53, blue: 0.53 },
                horizontalAlignment: 'CENTER'
              }
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numColunas }
          }
        }
      ]
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 Configurando planilhas Voll Pilates Studio...\n');

  for (const planilha of PLANILHAS) {
    const spreadsheetId = process.env[planilha.envKey];

    if (!spreadsheetId || spreadsheetId.startsWith('1xxx')) {
      console.log(`⏭️  ${planilha.titulo}: ID não configurado no .env, pulando.\n`);
      continue;
    }

    console.log(`📊 Configurando "${planilha.titulo}" (${spreadsheetId})...`);

    try {
      const abasExistentes = await listarAbas(spreadsheetId);
      const nomesExistentes = abasExistentes.map(a => a.nome);

      for (let i = 0; i < planilha.abas.length; i++) {
        const aba = planilha.abas[i];
        process.stdout.write(`   └─ Aba "${aba.nome}"... `);

        let sheetId;

        if (nomesExistentes.includes(aba.nome)) {
          // Já existe — só pega o ID
          sheetId = abasExistentes.find(a => a.nome === aba.nome).sheetId;
          process.stdout.write('(já existe) ');
        } else if (i === 0 && nomesExistentes.includes('Página1') || nomesExistentes.includes('Sheet1') || nomesExistentes.includes('Planilha1')) {
          // Renomeia a aba padrão inicial
          const abaPadrao = abasExistentes.find(a => ['Página1', 'Sheet1', 'Planilha1'].includes(a.nome));
          if (abaPadrao) {
            await renomearPrimeira(spreadsheetId, aba.nome, abaPadrao.sheetId);
            sheetId = abaPadrao.sheetId;
            process.stdout.write('(renomeada) ');
          } else {
            await criarAba(spreadsheetId, aba.nome);
            const abasAtuais = await listarAbas(spreadsheetId);
            sheetId = abasAtuais.find(a => a.nome === aba.nome).sheetId;
            process.stdout.write('(criada) ');
          }
        } else {
          await criarAba(spreadsheetId, aba.nome);
          const abasAtuais = await listarAbas(spreadsheetId);
          sheetId = abasAtuais.find(a => a.nome === aba.nome).sheetId;
          process.stdout.write('(criada) ');
        }

        await inserirCabecalho(spreadsheetId, aba.nome, aba.cabecalho);
        await formatarCabecalho(spreadsheetId, sheetId, aba.cabecalho.length);
        console.log('✅');
      }

      console.log(`   ✅ "${planilha.titulo}" configurada!\n`);
    } catch (erro) {
      console.error(`   ❌ Erro: ${erro.message}\n`);
      if (erro.message.includes('not have permission') || erro.message.includes('403')) {
        console.error(`   👉 Compartilhe a planilha com: voll-pilates-agent@main-guild-396017.iam.gserviceaccount.com (Editor)\n`);
      }
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅  Configuração concluída!');
  console.log('Próximo passo: configurar o Google Calendar');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
