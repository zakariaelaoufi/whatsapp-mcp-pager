import assert from 'node:assert/strict';
import { createDatabase, STATES } from './db.js';
import { ApprovalEngine } from './engine.js';
import { MockProvider } from './providers/mock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestHarness({ escalationTimeoutMs = 5000, reminderCounter = 0, countdownTickMs = 20 } = {}) {
  const store = createDatabase(':memory:');
  const provider = new MockProvider({ allowedSenderId: '14155552671@c.us' });
  const engine = new ApprovalEngine({
    store,
    provider,
    escalationTimeoutMs,
    quietHours: '',
    reminderCounter,
    countdownTickMs,
  });
  return { store, provider, engine };
}

async function runTests() {
  console.error('🧪 Running Fail-Closed WhatsApp HITL Engine Test Suite...\n');

  // ---------------------------------------------------------------------------
  // Test 1: Valid LOW risk approval via text ('Y') -> resolves APPROVED (+ secret redaction)
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Run linter with token sk-1234567890abcdef1234',
      commandOrDiff: 'API_KEY=super_secret_val npm run lint',
      spokenPrompt: 'Should I run the linter?',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });

    await sleep(20);
    assert.equal(provider.sentPrompts.length, 1);
    assert.ok(
      !provider.sentPrompts[0].formattedText.includes('super_secret_val'),
      'Secrets must be redacted from outbound commandOrDiff'
    );
    assert.ok(
      !provider.sentPrompts[0].formattedText.includes('sk-1234567890abcdef1234'),
      'API keys must be redacted from outbound summary'
    );

    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const result = await approvalPromise;

    assert.equal(result.final_state, STATES.APPROVED);
    assert.equal(result.decision, STATES.APPROVED);
    assert.equal(result.channel, 'text');
    await engine.destroy();
    store.close();
    console.error('✅ 1. Valid LOW risk approval via text (Y) -> resolves APPROVED (+ secret redaction)');
  }

  // ---------------------------------------------------------------------------
  // Test 2: Explicit rejection ('N') -> resolves REJECTED
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Drop staging database',
      commandOrDiff: 'DROP DATABASE staging;',
      spokenPrompt: 'Should I drop the staging database?',
      riskLevel: 'CRITICAL',
      timeoutSeconds: 30,
    });

    await sleep(20);
    await provider.simulateInbound({ channel: 'text', text: 'N' });
    const result = await approvalPromise;

    assert.equal(result.final_state, STATES.REJECTED);
    assert.equal(result.decision, STATES.REJECTED);
    await engine.destroy();
    store.close();
    console.error('✅ 2. Explicit rejection (N) -> resolves REJECTED');
  }

  // ---------------------------------------------------------------------------
  // Test 3: HIGH risk voice note ("Yes, run it") -> transitions to AWAITING_CONFIRMATION -> 'Y' text -> APPROVED
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Apply production schema migration',
      commandOrDiff: 'npx prisma migrate deploy',
      spokenPrompt: 'Should I apply the production schema migration?',
      riskLevel: 'HIGH',
      timeoutSeconds: 30,
    });

    await sleep(20);
    const activeBefore = store.getActiveRequest();
    assert.equal(activeBefore.state, STATES.NOTIFIED);

    // Send voice note with affirmative intent on a HIGH risk request
    await provider.simulateInbound({
      channel: 'voice_note',
      text: 'Yes, run it',
    });

    // Must NOT resolve yet; must be in AWAITING_CONFIRMATION
    const afterVoice = store.getRequest(activeBefore.request_id);
    assert.equal(afterVoice.state, STATES.AWAITING_CONFIRMATION);
    assert.ok(
      provider.sentTexts.some((m) => m.text.includes('High-Risk Action:')),
      'Server must prompt user for Y/N text confirmation after high-risk voice note'
    );

    // Subsequent 'Y' text confirms and resolves to APPROVED
    await provider.simulateInbound({
      channel: 'text',
      text: 'Y',
    });

    const result = await approvalPromise;
    assert.equal(result.final_state, STATES.APPROVED);
    assert.equal(result.decision, STATES.APPROVED);
    assert.equal(result.human_instructions, 'Yes, run it');
    await engine.destroy();
    store.close();
    console.error(
      '✅ 3. HIGH risk voice note ("Yes, run it") -> AWAITING_CONFIRMATION -> subsequent Y text -> APPROVED'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 4: Modification reply ("Use --dry-run first") -> resolves MODIFICATION_REQUESTED
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Deploy Kubernetes manifests',
      commandOrDiff: 'kubectl apply -f k8s/',
      spokenPrompt: 'Ready to apply Kubernetes manifests.',
      riskLevel: 'MEDIUM',
      timeoutSeconds: 30,
    });

    await sleep(20);
    await provider.simulateInbound({
      channel: 'text',
      text: 'Use --dry-run first',
    });

    const result = await approvalPromise;
    assert.equal(result.final_state, STATES.MODIFICATION_REQUESTED);
    assert.equal(result.decision, STATES.MODIFICATION_REQUESTED);
    assert.equal(result.human_instructions, 'Use --dry-run first');
    await engine.destroy();
    store.close();
    console.error(
      '✅ 4. Modification reply ("Use --dry-run first") -> resolves MODIFICATION_REQUESTED with exact feedback'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 5: Unauthorized sender phone number -> ignored and logged in audit_events
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Restart worker service',
      commandOrDiff: 'pm2 restart worker',
      spokenPrompt: 'Should I restart the worker?',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });

    await sleep(20);
    const active = store.getActiveRequest();

    // Intruder sends 'Y' from an unauthorized number
    await provider.simulateInbound({
      messageId: 'intruder_msg_001',
      senderId: '99999999999@c.us',
      channel: 'text',
      text: 'Y',
    });

    // Request must still be NOTIFIED
    const stillActive = store.getRequest(active.request_id);
    assert.equal(stillActive.state, STATES.NOTIFIED);

    // Audit log must record UNAUTHORIZED_SENDER_IGNORED
    const audits = store.getAllAuditEvents();
    assert.ok(
      audits.some(
        (a) =>
          a.event_type === 'UNAUTHORIZED_SENDER_IGNORED' &&
          a.sender_id === '99999999999@c.us' &&
          a.message_id === 'intruder_msg_001'
      ),
      'Unauthorized sender must be logged in audit_events'
    );

    // Now allowlisted sender approves
    await provider.simulateInbound({ channel: 'text', text: 'Approve' });
    const result = await approvalPromise;
    assert.equal(result.final_state, STATES.APPROVED);
    await engine.destroy();
    store.close();
    console.error('✅ 5. Unauthorized sender phone number -> ignored and logged in audit_events');
  }

  // ---------------------------------------------------------------------------
  // Test 6: Duplicate inbound message_id -> processed once (idempotent)
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Run database backup',
      commandOrDiff: 'pg_dump prod > backup.sql',
      spokenPrompt: 'Should I run the database backup?',
      riskLevel: 'HIGH',
      timeoutSeconds: 30,
    });

    await sleep(20);

    // Send voice note with messageId 'dup_msg_100'
    await provider.simulateInbound({
      messageId: 'dup_msg_100',
      channel: 'voice_note',
      text: 'Yes, run it',
    });

    const textsAfterFirst = provider.sentTexts.length;

    // Replay the exact same messageId 'dup_msg_100'
    await provider.simulateInbound({
      messageId: 'dup_msg_100',
      channel: 'voice_note',
      text: 'Yes, run it',
    });

    assert.equal(
      provider.sentTexts.length,
      textsAfterFirst,
      'Duplicate message_id must not trigger a second outbound response'
    );

    const audits = store.getAllAuditEvents();
    assert.ok(
      audits.some((a) => a.event_type === 'DUPLICATE_MESSAGE_IGNORED'),
      'Duplicate message_id must be logged as DUPLICATE_MESSAGE_IGNORED'
    );

    // Complete request
    await provider.simulateInbound({ messageId: 'unique_confirm_101', channel: 'text', text: 'Y' });
    const result = await approvalPromise;
    assert.equal(result.final_state, STATES.APPROVED);
    await engine.destroy();
    store.close();
    console.error('✅ 6. Duplicate inbound message_id -> processed once (idempotent)');
  }

  // ---------------------------------------------------------------------------
  // Test 7: Request expiration timeout -> transitions to EXPIRED (Fail-Closed), late "Y" rejected
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness({ escalationTimeoutMs: 30 });
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Delete old S3 bucket',
      commandOrDiff: 'aws s3 rb s3://legacy-bucket --force',
      spokenPrompt: 'Should I delete the old S3 bucket?',
      riskLevel: 'CRITICAL',
      timeoutSeconds: 0.1, // 100ms expiration for fast test
    });

    const result = await approvalPromise;
    assert.equal(result.final_state, STATES.EXPIRED);
    assert.equal(result.decision, STATES.EXPIRED);
    assert.equal(provider.wakeUpCalls.length, 1, 'Wake-up ring should have triggered before expiry');

    // Now send a late "Y" after expiration
    await provider.simulateInbound({
      messageId: 'late_msg_999',
      channel: 'text',
      text: 'Y',
    });

    // State in SQLite must remain EXPIRED (Immutability Rule)
    const finalRecord = store.getRequest(result.request_id);
    assert.equal(finalRecord.state, STATES.EXPIRED);

    // User must receive the automatic ignored warning
    assert.ok(
      provider.sentTexts.some((m) =>
        m.text.includes('⚠️ No active request waiting (or request already closed). Ignored.')
      ),
      'Late reply after expiration must receive automatic warning'
    );

    await engine.destroy();
    store.close();
    console.error(
      '✅ 7. Request expiration timeout -> transitions to EXPIRED (Fail-Closed), and late "Y" reply is rejected'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 8: Per-request REMINDER_COUNTER decrements (3 -> 2 -> 1 -> 0) before dispatching WhatsApp
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness({
      reminderCounter: 3,
      countdownTickMs: 25,
    });

    const countdownTicks = [];
    const approvalPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Run production migration',
      commandOrDiff: 'npm run migrate',
      spokenPrompt: 'Should I run the migration?',
      riskLevel: 'LOW',
      onHeartbeat: ({ remainingCountdown }) => {
        if (remainingCountdown !== undefined) {
          countdownTicks.push(remainingCountdown);
        }
      },
    });

    // While countdown is still > 0 (e.g. after 30ms, only 1 tick elapsed -> counter at 2), WhatsApp must NOT be sent yet
    await sleep(30);
    assert.equal(
      provider.sentPrompts.length,
      0,
      'WhatsApp reminder must NOT be sent while per-request countdown is still > 0'
    );

    // Wait for countdown to finish (3 ticks * 25ms = 75ms total)
    await sleep(65);
    assert.deepEqual(countdownTicks, [2, 1, 0], 'Counter must decrement 3 -> 2 -> 1 -> 0');
    assert.equal(
      provider.sentPrompts.length,
      1,
      'WhatsApp reminder must be dispatched once countdown reaches 0'
    );

    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const res = await approvalPromise;
    assert.equal(res.final_state, STATES.APPROVED);

    // Also verify that if cancelled on screen before countdown reaches 0, WhatsApp is never sent
    const abortController = new AbortController();
    const cancelledPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Cancelled on screen',
      commandOrDiff: 'echo test',
      spokenPrompt: 'Cancelled on screen',
      riskLevel: 'LOW',
      signal: abortController.signal,
    });
    await sleep(25);
    abortController.abort();
    const cancelledRes = await cancelledPromise;
    assert.equal(cancelledRes.final_state, STATES.REJECTED);
    assert.equal(
      provider.sentPrompts.length,
      1,
      'Aborted request before countdown hits 0 must never send WhatsApp'
    );

    await engine.destroy();
    store.close();
    console.error(
      '✅ 8. Per-request REMINDER_COUNTER decrements (3 -> 2 -> 1 -> 0) and only sends WhatsApp when wait exceeds countdown'
    );
  }

  console.error('\n🎉 All 8 Fail-Closed HITL Engine specifications passed deterministically!');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});

