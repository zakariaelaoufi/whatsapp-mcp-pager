import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const AUTH_DATA_PATH = path.resolve(PROJECT_ROOT, '.wwebjs_auth');

// Load .env from project root; pass quiet: true so dotenv v17+ never writes to stdout
const dotenvResult = dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env'), quiet: true });
const parsedEnv = dotenvResult?.parsed || {};

const envSchema = z.object({
  MY_WHATSAPP_ID: z.string().trim().default(''),
  MY_PHONE_E164: z.string().trim().default(''),
  OPENAI_API_KEY: z.string().trim().default(''),
  GROQ_API_KEY: z.string().trim().default(''),
  WAKEUP_MODE: z
    .string()
    .trim()
    .transform((v) => (v || 'puppeteer').toLowerCase())
    .pipe(z.enum(['puppeteer', 'twilio']).catch('puppeteer')),
  TWILIO_ACCOUNT_SID: z.string().trim().default(''),
  TWILIO_AUTH_TOKEN: z.string().trim().default(''),
  TWILIO_FROM_NUMBER: z.string().trim().default(''),
  ESCALATION_TIMEOUT_MS: z
    .string()
    .trim()
    .optional()
    .transform((v) => Number.parseInt(v || '60000', 10) || 60000),
  QUIET_HOURS: z.string().trim().default(''),
  DB_PATH: z.string().trim().default(''),
});

const parsed = envSchema.parse(process.env);

export const config = {
  myWhatsappId: parsed.MY_WHATSAPP_ID,
  myPhoneE164: parsed.MY_PHONE_E164,
  openaiApiKey: parsed.OPENAI_API_KEY,
  groqApiKey: parsed.GROQ_API_KEY,
  wakeupMode: parsed.WAKEUP_MODE,
  twilioAccountSid: parsed.TWILIO_ACCOUNT_SID,
  twilioAuthToken: parsed.TWILIO_AUTH_TOKEN,
  twilioFromNumber: parsed.TWILIO_FROM_NUMBER,
  escalationTimeoutMs: parsed.ESCALATION_TIMEOUT_MS,
  quietHours: parsed.QUIET_HOURS,
  dbPath: parsed.DB_PATH
    ? path.resolve(PROJECT_ROOT, parsed.DB_PATH)
    : path.resolve(PROJECT_ROOT, '.hitl.sqlite'),
};

/**
 * Validates required configuration before running live WhatsApp / Audio flows.
 * Uses console.error exclusively to preserve MCP stdio JSON-RPC integrity.
 */
export function validateConfig({ requireOpenAI = true } = {}) {
  const missing = [];

  const whatsappId = process.env.MY_WHATSAPP_ID?.trim() || config.myWhatsappId;
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || config.openaiApiKey;
  const wakeupMode = (process.env.WAKEUP_MODE?.trim() || config.wakeupMode || 'puppeteer').toLowerCase();

  if (!whatsappId || whatsappId.includes('XXXXXXXX')) {
    missing.push('MY_WHATSAPP_ID (e.g., 14155552671@c.us)');
  }

  if (requireOpenAI && (!openaiKey || openaiKey === 'sk-proj-...')) {
    missing.push('OPENAI_API_KEY');
  }

  if (wakeupMode === 'twilio') {
    const phone = process.env.MY_PHONE_E164?.trim() || config.myPhoneE164;
    if (!phone || phone.includes('XXXXXXXX')) {
      missing.push('MY_PHONE_E164 (required when WAKEUP_MODE=twilio)');
    }
    if (!(process.env.TWILIO_ACCOUNT_SID?.trim() || config.twilioAccountSid)) {
      missing.push('TWILIO_ACCOUNT_SID');
    }
    if (!(process.env.TWILIO_AUTH_TOKEN?.trim() || config.twilioAuthToken)) {
      missing.push('TWILIO_AUTH_TOKEN');
    }
    if (!(process.env.TWILIO_FROM_NUMBER?.trim() || config.twilioFromNumber)) {
      missing.push('TWILIO_FROM_NUMBER');
    }
  }

  if (missing.length > 0) {
    const message = `[Config Error] Missing or placeholder environment variables in .env:\n  - ${missing.join('\n  - ')}`;
    console.error(message);
    throw new Error(message);
  }
}

/**
 * Redacts sensitive secrets, API keys, and tokens from any command or diff string
 * before persisting to SQLite or dispatching over WhatsApp.
 *
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (!input || typeof input !== 'string') return '';

  let sanitized = input;

  // 1. Redact any literal secret values loaded from .env / process.env
  const sensitiveEnvKeys = [
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'DATABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ];

  const literalSecrets = new Set();
  for (const key of sensitiveEnvKeys) {
    const val = process.env[key]?.trim() || parsedEnv[key]?.trim();
    if (val && val.length >= 8 && val !== 'sk-proj-...') {
      literalSecrets.add(val);
    }
  }

  for (const [k, v] of Object.entries(parsedEnv)) {
    if (
      /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|PRIVATE)/i.test(k) &&
      typeof v === 'string' &&
      v.trim().length >= 8
    ) {
      literalSecrets.add(v.trim());
    }
  }

  for (const secret of literalSecrets) {
    sanitized = sanitized.split(secret).join('[REDACTED_SECRET]');
  }

  // 2. Redact common token & credential patterns
  sanitized = sanitized
    // OpenAI / Groq / Anthropic / GitHub / Slack / Stripe style keys
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|gsk_[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{12,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/g, '[REDACTED_KEY]')
    // Bearer tokens
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_TOKEN]')
    // Inline env assignments like API_KEY=..., PASSWORD=..., SECRET=..., TOKEN=...
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)[A-Z0-9_]*\s*=\s*)(['"]?)([^\s'"]+)\2/gi,
      '$1$2[REDACTED]$2'
    )
    // Connection string passwords (e.g. postgres://user:pass@host)
    .replace(/([a-zA-Z0-9+.-]+:\/\/[^:\s/]+:)([^@\s]+)(@)/g, '$1[REDACTED]$3');

  return sanitized;
}

/**
 * Checks whether the given Date falls within optional QUIET_HOURS (format: "HH:MM-HH:MM").
 * Supports overnight ranges like "23:00-07:00".
 *
 * @param {Date} [now]
 * @param {string} [quietHoursStr]
 * @returns {boolean}
 */
export function isWithinQuietHours(now = new Date(), quietHoursStr = process.env.QUIET_HOURS || config.quietHours) {
  if (!quietHoursStr || typeof quietHoursStr !== 'string') return false;
  const match = quietHoursStr.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return false;

  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight window (e.g., 23:00-07:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
