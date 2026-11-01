import { askHumanWithWakeUpCall, getWhatsAppClient } from './whatsapp.js';

async function runTestFlow() {
  console.error('🚀 Starting standalone WhatsApp Walkie-Talkie + Wake-Up Ring test...');
  console.error('⏳ Waiting for WhatsApp session to become ready...');

  try {
    const result = await askHumanWithWakeUpCall({
      summary:
        'Finished generating the database migration for dropping legacy user tables. Need human confirmation before applying changes to production.',
      commandOrDiff: 'npx prisma migrate deploy --preview-feature\n# Drops table: legacy_sessions',
      spokenPrompt:
        'Hey! I finished the database schema migration. It drops the legacy sessions table. Should I run the migration now, or hold off?',
    });

    console.error('\n✅ Human Response Received!');
    console.error(`📡 Channel: ${result.channel}`);
    console.error(`💬 Instructions: ${result.human_response}\n`);
  } catch (err) {
    console.error('\n❌ Test flow failed:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      const client = getWhatsAppClient();
      await client.destroy();
    } catch {
      // Ignore cleanup errors
    }
    process.exit();
  }
}

runTestFlow();

