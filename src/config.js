import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { redactAuditDetails, redactSecrets } from './redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const AUTH_DATA_PATH = path.resolve(PROJECT_ROOT, '.wwebjs_auth');
export const STALE_REPLY_COOLDOWN_MS = 30000;

// Load .env from project root; pass quiet: true so dotenv v17+ never writes to stdout
dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env'), quiet: true });

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
  STALE_REPLY_COOLDOWN_MS: z
    .string()
    .trim()
    .optional()
    .transform((v) =>
      v !== undefined && v !== '' ? Number.parseInt(v, 10) : STALE_REPLY_COOLDOWN_MS
    ),
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
  staleReplyCooldownMs:
    typeof parsed.STALE_REPLY_COOLDOWN_MS === 'number' && !Number.isNaN(parsed.STALE_REPLY_COOLDOWN_MS)
      ? parsed.STALE_REPLY_COOLDOWN_MS
      : STALE_REPLY_COOLDOWN_MS,
  quietHours: parsed.QUIET_HOURS,
  dbPath: parsed.DB_PATH
    ? path.resolve(PROJECT_ROOT, parsed.DB_PATH)
    : path.resolve(PROJECT_ROOT, '.hitl.sqlite'),
};

/**
 * Validates required configuration via Zod with clear human-readable error messages.
 * Uses console.error exclusively to preserve MCP stdio JSON-RPC integrity.
 */
export function validateConfig({ requireOpenAI = true } = {}) {
  const strictSchema = z
    .object({
      MY_WHATSAPP_ID: z
        .string()
        .trim()
        .min(5, 'MY_WHATSAPP_ID is required (e.g., 14155552671@c.us)')
        .refine((v) => !v.includes('XXXXXXXX'), {
          message: 'MY_WHATSAPP_ID still contains placeholder XXXXXXXX',
        }),
      OPENAI_API_KEY: requireOpenAI
        ? z
            .string()
            .trim()
            .min(10, 'OPENAI_API_KEY is required')
            .refine((v) => v !== 'sk-proj-...', {
              message: 'OPENAI_API_KEY still contains placeholder sk-proj-...',
            })
        : z.string().optional(),
      WAKEUP_MODE: z.enum(['puppeteer', 'twilio']).default('puppeteer'),
      MY_PHONE_E164: z.string().trim().optional(),
      TWILIO_ACCOUNT_SID: z.string().trim().optional(),
      TWILIO_AUTH_TOKEN: z.string().trim().optional(),
      TWILIO_FROM_NUMBER: z.string().trim().optional(),
    })
    .superRefine((val, ctx) => {
      if (val.WAKEUP_MODE === 'twilio') {
        if (!val.MY_PHONE_E164 || val.MY_PHONE_E164.includes('XXXXXXXX')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['MY_PHONE_E164'],
            message: 'MY_PHONE_E164 is required when WAKEUP_MODE=twilio',
          });
        }
        if (!val.TWILIO_ACCOUNT_SID) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TWILIO_ACCOUNT_SID'],
            message: 'TWILIO_ACCOUNT_SID is required when WAKEUP_MODE=twilio',
          });
        }
        if (!val.TWILIO_AUTH_TOKEN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TWILIO_AUTH_TOKEN'],
            message: 'TWILIO_AUTH_TOKEN is required when WAKEUP_MODE=twilio',
          });
        }
        if (!val.TWILIO_FROM_NUMBER) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TWILIO_FROM_NUMBER'],
            message: 'TWILIO_FROM_NUMBER is required when WAKEUP_MODE=twilio',
          });
        }
      }
    });

  const result = strictSchema.safeParse({
    MY_WHATSAPP_ID: process.env.MY_WHATSAPP_ID?.trim() || config.myWhatsappId,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY?.trim() || config.openaiApiKey,
    WAKEUP_MODE: (process.env.WAKEUP_MODE?.trim() || config.wakeupMode || 'puppeteer').toLowerCase(),
    MY_PHONE_E164: process.env.MY_PHONE_E164?.trim() || config.myPhoneE164,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID?.trim() || config.twilioAccountSid,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN?.trim() || config.twilioAuthToken,
    TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER?.trim() || config.twilioFromNumber,
  });

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    const message = `[Config Error] Invalid environment configuration in .env:\n  - ${issues.join('\n  - ')}`;
    console.error(message);
    throw new Error(message);
  }
}

/**
 * Checks whether the given Date falls within optional QUIET_HOURS (format: "HH:MM-HH:MM").
 */
export function isWithinQuietHours(
  now = new Date(),
  quietHoursStr = process.env.QUIET_HOURS || config.quietHours
) {
  if (!quietHoursStr || typeof quietHoursStr !== 'string') return false;
  const match = quietHoursStr.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return false;

  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export { redactAuditDetails, redactSecrets };
