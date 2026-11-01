import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const AUTH_DATA_PATH = path.resolve(PROJECT_ROOT, '.wwebjs_auth');

// Load .env from project root; pass quiet: true so dotenv v17+ never writes to stdout
dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env'), quiet: true });

export const config = {
  myWhatsappId: process.env.MY_WHATSAPP_ID?.trim() || '',
  myPhoneE164: process.env.MY_PHONE_E164?.trim() || '',
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || '',
  groqApiKey: process.env.GROQ_API_KEY?.trim() || '',
  wakeupMode: (process.env.WAKEUP_MODE?.trim() || 'puppeteer').toLowerCase(),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || '',
  escalationTimeoutMs: Number.parseInt(process.env.ESCALATION_TIMEOUT_MS || '60000', 10) || 60000,
};

/**
 * Validates required configuration before running WhatsApp / Audio flows.
 * Uses console.error exclusively to preserve MCP stdio JSON-RPC integrity.
 */
export function validateConfig({ requireOpenAI = true } = {}) {
  const missing = [];

  if (!config.myWhatsappId || config.myWhatsappId.includes('XXXXXXXX')) {
    missing.push('MY_WHATSAPP_ID (e.g., 14155552671@c.us)');
  }

  if (requireOpenAI && (!config.openaiApiKey || config.openaiApiKey === 'sk-proj-...')) {
    missing.push('OPENAI_API_KEY');
  }

  if (config.wakeupMode === 'twilio') {
    if (!config.myPhoneE164 || config.myPhoneE164.includes('XXXXXXXX')) {
      missing.push('MY_PHONE_E164 (required when WAKEUP_MODE=twilio)');
    }
    if (!config.twilioAccountSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!config.twilioAuthToken) missing.push('TWILIO_AUTH_TOKEN');
    if (!config.twilioFromNumber) missing.push('TWILIO_FROM_NUMBER');
  }

  if (missing.length > 0) {
    const message = `[Config Error] Missing or placeholder environment variables in .env:\n  - ${missing.join('\n  - ')}`;
    console.error(message);
    throw new Error(message);
  }
}

