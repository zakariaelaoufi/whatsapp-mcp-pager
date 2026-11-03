const SENSITIVE_ENV_KEYS = [
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

let registeredEnvMap = {};

/**
 * Registers parsed .env key-value pairs from config initialization so `redact.js`
 * stays a pure module with zero filesystem side effects on import.
 *
 * @param {Record<string, string>} envMap
 */
export function registerEnvSecrets(envMap = {}) {
  if (envMap && typeof envMap === 'object') {
    registeredEnvMap = { ...registeredEnvMap, ...envMap };
  }
}

function collectLiteralSecrets() {
  const secrets = new Set();

  for (const key of SENSITIVE_ENV_KEYS) {
    const val = process.env[key]?.trim() || registeredEnvMap[key]?.trim();
    if (val && val.length >= 8 && val !== 'sk-proj-...') {
      secrets.add(val);
    }
  }

  for (const source of [registeredEnvMap, process.env]) {
    if (!source || typeof source !== 'object') continue;
    for (const [k, v] of Object.entries(source)) {
      if (
        /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|PRIVATE)(?:_|$)/i.test(k) &&
        typeof v === 'string' &&
        v.trim().length >= 8 &&
        v.trim() !== 'sk-proj-...'
      ) {
        secrets.add(v.trim());
      }
    }
  }

  return secrets;
}

/**
 * Redacts sensitive secrets, API keys, PEM blocks, AWS keys, Bearer tokens, and DB passwords
 * from any string before persisting to SQLite or dispatching over WhatsApp / TTS.
 *
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return String(input);
  if (!input) return '';

  let sanitized = input;

  // 1. Redact literal secret values from .env / process.env
  for (const secret of collectLiteralSecrets()) {
    sanitized = sanitized.split(secret).join('[REDACTED_SECRET]');
  }

  // 2. Redact PEM private key blocks
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  );

  // 3. Redact database connection string passwords (postgres://user:pass@host, mysql://, mongodb://, redis://)
  sanitized = sanitized.replace(
    /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
    '$1[REDACTED_DB_PASS]$3'
  );

  // 4. Redact OpenAI, Groq, GitHub, Slack, and AWS Access Key IDs
  sanitized = sanitized.replace(
    /\b(sk-[a-zA-Z0-9_-]{10,}|gsk_[a-zA-Z0-9_-]{10,}|gh[pousr]_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    '[REDACTED_KEY]'
  );

  // 5. Redact Bearer tokens
  sanitized = sanitized.replace(
    /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
    '$1[REDACTED_TOKEN]'
  );

  // 6. Redact inline key=value secret assignments
  sanitized = sanitized.replace(
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)[A-Z0-9_]*\s*=\s*)(['"]?)([^\s'"]+)\2/gi,
    '$1$2[REDACTED]$2'
  );

  return sanitized;
}

/**
 * Recursively redacts all string properties inside an object or array for safe audit logging.
 *
 * @param {any} value
 * @returns {any}
 */
export function redactAuditDetails(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactAuditDetails(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactAuditDetails(v);
    }
    return out;
  }
  return value;
}

