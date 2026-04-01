// utils/google-auth.js — Autenticação Google unificada
// Suporta arquivo local (dev) ou variável de ambiente GOOGLE_CREDENTIALS (produção/Railway)
const { google } = require('googleapis');
const fs = require('fs');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar'
];

let auth;

function getAuth() {
  if (auth) return auth;

  // Produção: credenciais como variável de ambiente (JSON string)
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES
    });
    return auth;
  }

  // Desenvolvimento: arquivo local
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './credentials/google-service-account.json';
  if (fs.existsSync(keyFile)) {
    auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
    return auth;
  }

  throw new Error('Credenciais Google não encontradas. Configure GOOGLE_CREDENTIALS ou o arquivo JSON.');
}

module.exports = { getAuth };
