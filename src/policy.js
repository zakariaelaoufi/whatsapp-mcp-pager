export const RISK_LEVELS = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const RISK_RANK = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
});

const RANK_TO_RISK = Object.freeze({
  0: 'LOW',
  1: 'MEDIUM',
  2: 'HIGH',
  3: 'CRITICAL',
});

const CRITICAL_PATTERNS = [
  // Destructive filesystem commands
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-[a-zA-Z]*f[a-zA-Z]*r)\b/i,
  /\bdel\s+(?:\/[fFsSqQ]\s*)+\b/i,
  /\brmdir\s+\/[sS]\s+\/[qQ]\b/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  // Destructive DB operations
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\b/i,
  // Force pushes & hard resets
  /\bgit\s+push\s+([^\n]*\s+)?(--force|-f|--force-with-lease)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  // Credential / secret mutations
  /\b(rotate|delete|overwrite|mutate|revoke)\s+(secret|credential|api[_\s-]?key|private[_\s-]?key|token)s?\b/i,
  // Production deploys & destructive cloud operations
  /\b(production\s+deploy|deploy\s+to\s+prod|prod\s+deployment|--prod\b)\b/i,
  /\baws\s+s3\s+(rb|rm)\b.*--force/i,
  /\bterraform\s+destroy\b/i,
  /\bkubectl\s+delete\s+(namespace|ns|deployment|statefulset|pvc|pv)\b/i,
];

const HIGH_PATTERNS = [
  // Database migrations
  /\b(migrate|migration|prisma|alembic|knex\s+migrate|typeorm\s+migration|flyway|liquibase)\b/i,
  // Package publishing
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  // Sudo / chmod / chown / Docker daemon mutations
  /\b(sudo|chmod|chown)\b/i,
  /\bdocker(?:-compose)?\s+(run|rm|rmi|stop|kill|exec|system\s+prune|down|up)\b/i,
  /\bsystemctl\s+(stop|restart|disable|mask)\b/i,
  /\balter\s+table\b/i,
  /\bdelete\s+from\b/i,
];

/**
 * Computes the effective risk level by inspecting `commandOrDiff`, `summary`, and `project`,
 * returning `MAX(agentRisk, derivedRisk)` where `LOW (0) < MEDIUM (1) < HIGH (2) < CRITICAL (3)`.
 *
 * @param {string} [agentRisk='HIGH']
 * @param {object} [context]
 * @param {string} [context.summary]
 * @param {string} [context.commandOrDiff]
 * @param {string} [context.project]
 * @returns {'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'}
 */
export function computeEffectiveRisk(
  agentRisk = 'HIGH',
  { summary = '', commandOrDiff = '', project = '' } = {}
) {
  const normalizedAgent = String(agentRisk || 'HIGH').toUpperCase();
  const agentRank =
    normalizedAgent in RISK_RANK ? RISK_RANK[normalizedAgent] : RISK_RANK.HIGH;

  const combinedText = `${project || ''}\n${summary || ''}\n${commandOrDiff || ''}`;

  let derivedRank = RISK_RANK.LOW;
  if (CRITICAL_PATTERNS.some((re) => re.test(combinedText))) {
    derivedRank = RISK_RANK.CRITICAL;
  } else if (HIGH_PATTERNS.some((re) => re.test(combinedText))) {
    derivedRank = RISK_RANK.HIGH;
  }

  const finalRank = Math.max(agentRank, derivedRank);
  return RANK_TO_RISK[finalRank];
}

/**
 * Evaluates risk policy and returns detailed breakdown (`effectiveRiskLevel`, `derivedRiskLevel`, `escalated`).
 */
export function evaluateRiskPolicy({
  agentRiskLevel = 'HIGH',
  commandOrDiff = '',
  summary = '',
  project = '',
} = {}) {
  const normalizedAgent = String(agentRiskLevel || 'HIGH').toUpperCase();
  const agentRank =
    normalizedAgent in RISK_RANK ? RISK_RANK[normalizedAgent] : RISK_RANK.HIGH;

  const effectiveRiskLevel = computeEffectiveRisk(normalizedAgent, {
    summary,
    commandOrDiff,
    project,
  });
  const derivedRiskLevel = computeEffectiveRisk('LOW', {
    summary,
    commandOrDiff,
    project,
  });

  return {
    effectiveRiskLevel,
    derivedRiskLevel,
    escalated: RISK_RANK[effectiveRiskLevel] > agentRank,
  };
}
