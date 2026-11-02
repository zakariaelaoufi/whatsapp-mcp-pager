import { config } from './config.js';
import { createDatabase } from './db.js';
import { ApprovalEngine } from './engine.js';
import { WhatsAppWebProvider } from './providers/whatsapp.js';

async function runLiveFlow() {
  console.error('🚀 Starting live WhatsApp Fail-Closed HITL approval test...');

  const store = createDatabase(config.dbPath);
  const provider = new WhatsAppWebProvider();
  const engine = new ApprovalEngine({
    store,
    provider,
    escalationTimeoutMs: config.escalationTimeoutMs,
    quietHours: config.quietHours,
  });

  try {
    const result = await engine.requestApproval({
      project: 'inventory-service',
      summary: 'Apply production schema migration (drops legacy_sessions table)',
      commandOrDiff: 'npx prisma migrate deploy',
      spokenPrompt:
        'Hey! I am ready to apply the production schema migration on inventory service. Reply Y to approve, N to reject, or send a voice note.',
      riskLevel: 'HIGH',
      timeoutSeconds: 600,
    });

    console.error('\n✅ Terminal Decision Reached!');
    console.error(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\n❌ Live test flow failed:', err.message);
    process.exitCode = 1;
  } finally {
    await engine.destroy();
    store.close();
    process.exit();
  }
}

runLiveFlow();
