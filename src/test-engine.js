import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { createDatabase, STATES } from './db.js';
import { ApprovalEngine } from './engine.js';
import { MockProvider } from './providers/mock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestHarness({
  escalationTimeoutMs = 5000,
  staleReplyCooldownMs = 30000,
  reconcileOnInit = false,
  store: existingStore = null,
} = {}) {
  const store = existingStore || createDatabase(':memory:');
  const provider = new MockProvider({ allowedSenderId: '14155552671@c.us' });
  const engine = new ApprovalEngine({
    store,
    provider,
    escalationTimeoutMs,
    staleReplyCooldownMs,
    quietHours: '',
    reconcileOnInit,
  });
  return { store, provider, engine };
}

async function runTests() {
  console.error('🧪 Running Hardened Fail-Closed WhatsApp HITL Engine Test Suite (10 Specs)...\n');

  // ---------------------------------------------------------------------------
  // Test 1: Clean install (`npm ls better-sqlite3` & package.json declaration)
  // ---------------------------------------------------------------------------
  {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.resolve(PROJECT_ROOT, 'package.json'), 'utf8')
    );
    assert.ok(
      pkgJson.dependencies && pkgJson.dependencies['better-sqlite3'],
      'better-sqlite3 must be explicitly declared in package.json dependencies'
    );
    assert.equal(pkgJson.engines?.node, '>=20.0.0');

    const lsOut = execSync('npm ls better-sqlite3 --depth=0', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.ok(lsOut.includes('better-sqlite3@'), 'npm ls better-sqlite3 must succeed cleanly');
    console.error('✅ 1. Clean install verified (npm ls better-sqlite3 & package.json engines)');
  }

  // ---------------------------------------------------------------------------
  // Test 2: LOW risk text approval & rejection
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness({ staleReplyCooldownMs: 0 });

    // 2a. Approval ('Y')
    const pApprove = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Run unit tests',
      commandOrDiff: 'npm run test:unit',
      spokenPrompt: 'Should I run unit tests?',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });
    await sleep(15);
    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const resApprove = await pApprove;
    assert.equal(resApprove.final_state, STATES.APPROVED);
    assert.equal(resApprove.risk_level, 'LOW');

    // 2b. Rejection ('N')
    const pReject = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Run linter',
      commandOrDiff: 'npm run lint',
      spokenPrompt: 'Should I run the linter?',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });
    await sleep(15);
    await provider.simulateInbound({ channel: 'text', text: 'N' });
    const resReject = await pReject;
    assert.equal(resReject.final_state, STATES.REJECTED);

    await engine.destroy();
    store.close();
    console.error('✅ 2. LOW risk text approval & rejection');
  }

  // ---------------------------------------------------------------------------
  // Test 3: Server-side risk escalation (agent passes LOW for `rm -rf /tmp/data` -> CRITICAL)
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const p = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Clean up temporary data directory',
      commandOrDiff: 'rm -rf /tmp/data',
      spokenPrompt: 'Should I remove the temporary data directory?',
      riskLevel: 'LOW', // Agent under-reports risk as LOW
      timeoutSeconds: 30,
    });

    await sleep(15);
    const active = store.getActiveRequest();
    assert.equal(
      active.risk_level,
      'CRITICAL',
      'Server policy must upgrade rm -rf /tmp/data from LOW to CRITICAL'
    );
    assert.equal(active.agent_risk_level, 'LOW');

    // Because it was upgraded to CRITICAL, a voice note "Yes" must NOT approve immediately!
    await provider.simulateInbound({ channel: 'voice_note', text: 'Yes' });
    const afterVoice = store.getRequest(active.request_id);
    assert.equal(afterVoice.state, STATES.AWAITING_CONFIRMATION);

    // Confirm with text 'Y'
    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const res = await p;
    assert.equal(res.final_state, STATES.APPROVED);
    assert.equal(res.risk_level, 'CRITICAL');

    await engine.destroy();
    store.close();
    console.error(
      '✅ 3. Server-side risk escalation (agent passes LOW for `rm -rf /tmp/data`, upgraded to CRITICAL)'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 4: HIGH/CRITICAL voice approval requires AWAITING_CONFIRMATION -> Y text confirmation
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const p = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Apply production schema migration',
      commandOrDiff: 'npx prisma migrate deploy',
      spokenPrompt: 'Should I apply the production schema migration?',
      riskLevel: 'HIGH',
      timeoutSeconds: 30,
    });

    await sleep(15);
    const active = store.getActiveRequest();

    await provider.simulateInbound({ channel: 'voice_note', text: 'Yes, run it' });

    const mid = store.getRequest(active.request_id);
    assert.equal(mid.state, STATES.AWAITING_CONFIRMATION);
    assert.equal(mid.pending_transcript, 'Yes, run it');
    assert.ok(
      provider.sentTexts.some(
        (m) =>
          m.text.includes('📝 Heard: "Yes, run it"') &&
          m.text.includes(`⚠️ High-risk action [${active.request_id}]: Reply Y to confirm execution or N to reject.`)
      ),
      'Must send exact high-risk voice confirmation prompt'
    );

    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const res = await p;
    assert.equal(res.final_state, STATES.APPROVED);
    assert.equal(res.human_instructions, 'Yes, run it');

    await engine.destroy();
    store.close();
    console.error(
      '✅ 4. HIGH/CRITICAL voice approval requires AWAITING_CONFIRMATION -> Y text confirmation'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 5: NEEDS_CLARIFICATION and MODIFICATION_REQUESTED return immediately as terminal states
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness({ staleReplyCooldownMs: 0 });

    // 5a. NEEDS_CLARIFICATION
    const pClarify = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Update cache TTL',
      commandOrDiff: 'REDIS_TTL=3600',
      spokenPrompt: 'Should I update the cache TTL?',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });
    await sleep(15);
    await provider.simulateInbound({
      channel: 'voice_note',
      text: 'Which environment is this for?',
    });
    const resClarify = await pClarify;
    assert.equal(resClarify.final_state, STATES.NEEDS_CLARIFICATION);
    assert.equal(resClarify.human_instructions, 'Which environment is this for?');

    // 5b. MODIFICATION_REQUESTED
    const pModify = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Deploy Kubernetes manifests',
      commandOrDiff: 'kubectl apply -f k8s/',
      spokenPrompt: 'Ready to apply Kubernetes manifests.',
      riskLevel: 'MEDIUM',
      timeoutSeconds: 30,
    });
    await sleep(15);
    await provider.simulateInbound({
      channel: 'text',
      text: 'Use --dry-run=client first',
    });
    const resModify = await pModify;
    assert.equal(resModify.final_state, STATES.MODIFICATION_REQUESTED);
    assert.equal(resModify.human_instructions, 'Use --dry-run=client first');

    await engine.destroy();
    store.close();
    console.error(
      '✅ 5. NEEDS_CLARIFICATION and MODIFICATION_REQUESTED return immediately as terminal states'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 6: One-active-request lock rejects a concurrent second request with BUSY_ACTIVE_REQUEST
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const firstPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'First active request',
      commandOrDiff: 'echo "first"',
      spokenPrompt: 'First request.',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });

    await sleep(15);
    const active = store.getActiveRequest();
    assert.ok(active);

    // Concurrent second request while first is still NOTIFIED
    const secondResult = await engine.requestApproval({
      project: 'inventory-service',
      summary: 'Second concurrent request',
      commandOrDiff: 'echo "second"',
      spokenPrompt: 'Second request.',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });

    assert.equal(secondResult.code, 'BUSY_ACTIVE_REQUEST');
    assert.equal(secondResult.error, 'BUSY_ACTIVE_REQUEST');
    assert.equal(secondResult.active_request_id, active.request_id);
    assert.equal(provider.sentPrompts.length, 1, 'Second request must not send a WhatsApp prompt');

    // Resolve first request
    await provider.simulateInbound({ channel: 'text', text: 'Y' });
    const firstResult = await firstPromise;
    assert.equal(firstResult.final_state, STATES.APPROVED);

    await engine.destroy();
    store.close();
    console.error(
      '✅ 6. One-active-request lock rejects a concurrent second request with BUSY_ACTIVE_REQUEST'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 7: Stale-reply protection blocks an unquoted "Y" sent 2 seconds after a previous request expired
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness({
      escalationTimeoutMs: 5000,
      staleReplyCooldownMs: 30000, // 30s cooldown
    });

    // Request 1 expires quickly (50ms)
    const r1 = await engine.requestApproval({
      project: 'inventory-service',
      summary: 'First request that expires',
      commandOrDiff: 'echo 1',
      spokenPrompt: 'First request',
      riskLevel: 'LOW',
      timeoutSeconds: 0.05,
    });
    assert.equal(r1.final_state, STATES.EXPIRED);

    // Immediately create Request 2 (within the 30s cooldown window after Request 1 expired)
    const r2Promise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Second request created right after R1 expired',
      commandOrDiff: 'echo 2',
      spokenPrompt: 'Second request',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
    });

    await sleep(20);
    const activeR2 = store.getActiveRequest();
    assert.ok(activeR2);
    assert.notEqual(activeR2.request_id, r1.request_id);

    // Simulate user sending an unquoted delayed "Y" (intended for R1) 2 seconds after R1 expired
    await provider.simulateInbound({
      messageId: 'delayed_unquoted_y',
      channel: 'text',
      text: 'Y',
    });

    // R2 must NOT be approved by the unquoted "Y" during cooldown!
    const r2StillWaiting = store.getRequest(activeR2.request_id);
    assert.equal(
      r2StillWaiting.state,
      STATES.NOTIFIED,
      'Unquoted Y within 30s cooldown after previous expiration must be blocked'
    );
    assert.ok(
      provider.sentTexts.some((m) => m.text.includes(`please include [${activeR2.request_id}]`)),
      'User must be prompted to include the new request ID or swipe-to-reply'
    );

    // Also test Rule 1: quoting the old closed request R1 rejects with "already closed"
    await provider.simulateInbound({
      messageId: 'quoted_stale_r1',
      channel: 'text',
      text: 'Y',
      quotedRequestId: r1.request_id,
    });
    assert.ok(
      provider.sentTexts.some((m) =>
        m.text.includes(`⚠️ That request ([${r1.request_id}]) is already closed.`)
      ),
      'Quoting an expired request must warn that it is already closed'
    );

    // Now user replies with explicit ID ("Y AP-XXXX") -> approves R2!
    await provider.simulateInbound({
      messageId: 'explicit_r2_approve',
      channel: 'text',
      text: `Y ${activeR2.request_id}`,
    });
    const r2Result = await r2Promise;
    assert.equal(r2Result.final_state, STATES.APPROVED);

    await engine.destroy();
    store.close();
    console.error(
      '✅ 7. Stale-reply protection blocks unquoted "Y" within 30s cooldown after previous expiration'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 8: Secret redaction scrubs API keys and DB passwords from both WhatsApp text and TTS spoken_prompt
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const p = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Connect with key sk-proj-abcdef1234567890abcdef',
      commandOrDiff:
        'DATABASE_URL="postgres://admin:my_super_secret_db_pass@db.internal:5432/prod" node migrate.js',
      spokenPrompt:
        'Hey, I am running migrate with key sk-proj-abcdef1234567890abcdef and postgres://admin:my_super_secret_db_pass@db.internal:5432/prod',
      riskLevel: 'HIGH',
      timeoutSeconds: 30,
    });

    await sleep(15);
    assert.equal(provider.sentPrompts.length, 1);
    const sent = provider.sentPrompts[0];

    assert.ok(
      !sent.formattedText.includes('sk-proj-abcdef1234567890abcdef'),
      'API key must be redacted from WhatsApp text'
    );
    assert.ok(
      !sent.formattedText.includes('my_super_secret_db_pass'),
      'DB password must be redacted from WhatsApp text'
    );
    assert.ok(
      !sent.spokenPrompt.includes('sk-proj-abcdef1234567890abcdef'),
      'API key must be redacted from TTS spoken_prompt'
    );
    assert.ok(
      !sent.spokenPrompt.includes('my_super_secret_db_pass'),
      'DB password must be redacted from TTS spoken_prompt'
    );

    await provider.simulateInbound({ channel: 'text', text: 'N' });
    await p;
    await engine.destroy();
    store.close();
    console.error(
      '✅ 8. Secret redaction scrubs API keys and DB passwords from both WhatsApp text and TTS spoken_prompt'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 9: Startup recovery marks orphaned non-terminal requests as EXPIRED (EXPIRED_ON_SERVER_RESTART)
  // ---------------------------------------------------------------------------
  {
    const store = createDatabase(':memory:');
    const orphaned = store.createRequest({
      project: 'inventory-service',
      summary: 'Orphaned request before crash',
      commandOrDiff: 'echo "orphan"',
      spokenPrompt: 'Orphaned request',
      riskLevel: 'HIGH',
      timeoutSeconds: 600,
    });
    store.transitionState({
      requestId: orphaned.request_id,
      toState: STATES.NOTIFIED,
      eventType: 'PROMPT_DISPATCHED',
    });

    // Initialize new engine with reconcileOnInit: true (simulating server restart)
    const { engine } = createTestHarness({ store, reconcileOnInit: true });

    const afterRestart = store.getRequest(orphaned.request_id);
    assert.equal(afterRestart.state, STATES.EXPIRED);

    const audits = store.getAuditEventsForRequest(orphaned.request_id);
    assert.ok(
      audits.some((a) => a.event_type === 'EXPIRED_ON_SERVER_RESTART'),
      'Startup recovery must log EXPIRED_ON_SERVER_RESTART in audit_events'
    );

    await engine.destroy();
    store.close();
    console.error(
      '✅ 9. Startup recovery marks orphaned non-terminal requests as EXPIRED (EXPIRED_ON_SERVER_RESTART)'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 10: MCP AbortSignal cancellation clears timers, transitions to CANCELLED, and notifies provider
  // ---------------------------------------------------------------------------
  {
    const { store, provider, engine } = createTestHarness();
    const abortController = new AbortController();

    const p = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Long running approval that gets aborted by IDE',
      commandOrDiff: 'npm run deploy',
      spokenPrompt: 'Should I deploy?',
      riskLevel: 'HIGH',
      timeoutSeconds: 60,
      signal: abortController.signal,
    });

    await sleep(20);
    const active = store.getActiveRequest();
    assert.ok(active);

    // Abort the MCP request via AbortSignal
    abortController.abort();
    const res = await p;

    assert.equal(res.final_state, STATES.CANCELLED);
    assert.equal(res.decision, STATES.CANCELLED);
    assert.equal(engine.activeTrackers.size, 0, 'All timers for cancelled request must be cleared');
    assert.ok(
      provider.sentTexts.some((m) =>
        m.text.includes(`🚫 Request [${active.request_id}] was cancelled`)
      ),
      'Cancellation notice must be dispatched to WhatsApp provider'
    );

    await engine.destroy();
    store.close();
    console.error(
      '✅ 10. MCP AbortSignal cancellation clears timers, transitions to CANCELLED, and dispatches notice'
    );
  }

  console.error('\n🎉 All 10 Hardened Fail-Closed HITL specifications passed deterministically!');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
