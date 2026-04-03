import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
];

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SERVICE_ACCOUNT_PATH = path.join(PROJECT_ROOT, 'service-account.json');
const CREDENTIALS_PATH = path.join(PROJECT_ROOT, 'credentials.json');
const TOKEN_PATH = path.join(PROJECT_ROOT, 'token.json');

function getAdcPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'gcloud', 'application_default_credentials.json');
  }
  return path.join(process.env.HOME || '', '.config', 'gcloud', 'application_default_credentials.json');
}

/**
 * Authorize with Google Sheets API.
 * Tries: 1) Service Account, 2) ADC, 3) OAuth credentials+token
 * Returns an auth client or throws.
 */
export async function authorize(): Promise<any> {
  // Strategy 1: Service Account
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_ACCOUNT_PATH,
        scopes: SCOPES,
      });
      return await auth.getClient();
    } catch (err) {
      console.warn('[auth] Service account failed, trying next strategy');
    }
  }

  // Strategy 2: ADC
  if (fs.existsSync(getAdcPath())) {
    try {
      const auth = new GoogleAuth({ scopes: SCOPES });
      return await auth.getClient();
    } catch {
      console.warn('[auth] ADC failed, trying credentials.json');
    }
  }

  // Strategy 3: OAuth credentials.json + token.json
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('No Google credentials found. Place service-account.json or credentials.json in project root.');
  }

  const content = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_secret, client_id } = content.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3456/oauth2callback');

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('No token.json found. Run sheet-helper setup first to authorize OAuth.');
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

export function getAuthStatus(): { method: string; ready: boolean } {
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    try {
      const content = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
      if (content?.type === 'service_account' && content?.client_email) {
        return { method: 'service-account', ready: true };
      }
    } catch {}
  }
  if (fs.existsSync(getAdcPath())) {
    return { method: 'adc', ready: true };
  }
  if (fs.existsSync(CREDENTIALS_PATH) && fs.existsSync(TOKEN_PATH)) {
    return { method: 'oauth', ready: true };
  }
  return { method: 'none', ready: false };
}
