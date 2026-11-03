export const RISK_LEVELS = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

const RISK_WEIGHT = Object.freeze({
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
});

const WEIGHT_TO_RISK = Object.freeze({
  1: 'LOW',
  2: 'MEDIUM',
  3: 'HIGH',
  4: 'CRITICAL',
});

const CRITICAL_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-[a-zA-Z]*f[a-zA-Z]*r)\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\btruncate\b/i,
  /\bgit\s+push\s+([^\n]*\s+)?(--force|-f|--force-with-lease)\b/i,
  /\b(production\s+deploy|deploy\s+to\s+prod|prod\s+deployment|--prod\b)\b/i,
  /\b(rotate|delete|overwrite|mutate|revoke)\s+(secret|credential|api[_\s-]?key|private[_\s-]?key|token)s?\b/i,
  /\baws\s+s3\s+(rb|rm)\b.*--force/i,
  /\bterraform\s+destroy\b/i,
  /\bkubectl\s+delete\s+(namespace|ns|deployment|statefulset|pvc|pv)\b/i,
];

const HIGH_PATTERNS = [
  /\b(migrate|migration|prisma|alembic|knex\s+migrate|typeorm\s+migration|flyway|liquibase)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(docker|docker-compose|systemctl|service|chmod|chown|sudo|iptables|ufw|kubectl\s+apply)\b/i,
  /\balter\s+table\b/i,
  /\bdelete\s+from\b/i,
];

/**
 * Derives the minimum required risk level by inspecting `commandOrDiff` and `summary`,
 * then returns `MAX(agentRequestedRisk, serverDerivedRisk)`.
 *
 * @param {object} params
 * @param {string} [params.agentRiskLevel]
 * @param {string} [params.commandOrDiff]
 * @param {string} [params.summary]
 * @returns {{ effectiveRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', derivedRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', escalated: boolean }}
 */
export function evaluateRiskPolicy({
  agentRiskLevel = 'HIGH',
  commandOrDiff = '',
  summary = '',
} = {}) {
  const normalizedAgentRisk = String(agentRiskLevel || 'HIGH').toUpperCase();
  const agentWeight = RISK_WEIGHT[normalizedAgentRisk] || RISK_WEIGHT.HIGH;

  const combinedText = `${summary || ''}\n${commandOrDiff || ''}`;

  let derivedWeight = RISK_WEIGHT.LOW;

  if (CRITICAL_PATTERNS.some((re) => re.test(combinedText))) {
    derivedWeight = RISK_WEIGHT.CRITICAL;
  } else if (HIGH_PATTERNS.some((re) => re.test(combinedText))) {
    derivedWeight = RISK_WEIGHT.HIGH;
  }

  const finalWeight = Math.max(agentWeight, derivedWeight);
  const effectiveRiskLevel = WEIGHT_TO_RISK[finalWeight];
  const derivedRiskLevel = WEIGHT_TO_RISK[derivedWeight];

  return {
    effectiveRiskLevel,
    derivedRiskLevel,
    escalated: finalWeight > agentWeight,
  };
}

