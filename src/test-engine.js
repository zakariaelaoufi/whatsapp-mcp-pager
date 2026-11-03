import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateOpusVoiceNote, transcribeVoiceNote } from './audio.js';
import { config, hasOpenAIKey, hasSTTKey, isWithinQuietHours, PROJECT_ROOT, validateConfig } from './config.js';
import { createDatabase, migrateApprovalRequestsSchema, STATES } from './db.js';
import { ApprovalEngine, parseReply, classifyDecision } from './engine.js';
import { computeEffectiveRisk } from './policy.js';
import { MockProvider } from './providers/mock.js';
import { ringAndInterrupt } from './wakeup.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestHarness({
  escalationTimeoutMs = 5000,
  staleReplyCooldownMs = 30000,
  countdownMs = 0,
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
    countdownMs,
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
      provider.sentTexts.some((m) =>
        m.text.includes(
          '⚠️ A previous request recently closed. Please swipe-to-reply to the current message or include the ID (e.g., Y AP-'
        )
      ),
      'User must be prompted to include the new request ID or swipe-to-reply'
    );

    // Sending only the request ID ("AP-XXXX") with empty decisionText must be ignored and prompt for decision
    await provider.simulateInbound({
      messageId: 'id_only_no_decision',
      channel: 'text',
      text: `${activeR2.request_id}`,
    });
    assert.equal(
      store.getRequest(activeR2.request_id).state,
      STATES.NOTIFIED,
      'Message with only AP-XXXX and empty decisionText must not resolve request'
    );
    assert.ok(
      provider.sentTexts.some((m) => m.text.includes('Please include a decision')),
      'User must be prompted to include a decision when only AP-XXXX is sent'
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

  // ---------------------------------------------------------------------------
  // Test 11: Schema Migration Helper, parseReply, computeEffectiveRisk, Deadline & Clean Shutdown
  // ---------------------------------------------------------------------------
  {
    // 11a. Legacy schema migration adds missing columns idempotently
    const rawDb = new Database(':memory:');
    rawDb.exec(`
      CREATE TABLE approval_requests (
        request_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        summary TEXT NOT NULL,
        command_or_diff TEXT NOT NULL,
        spoken_prompt TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    migrateApprovalRequestsSchema(rawDb);
    migrateApprovalRequestsSchema(rawDb); // Idempotent second run
    const cols = rawDb.pragma('table_info(approval_requests)').map((c) => c.name);
    assert.ok(cols.includes('agent_risk_level'));
    assert.ok(cols.includes('pending_transcript'));
    assert.ok(cols.includes('provider_message_id'));
    rawDb.close();

    // 11b. parseReply strips AP-XXXX and punctuation before classifyDecision
    const parsed1 = parseReply('Y AP-82F4');
    assert.equal(parsed1.requestId, 'AP-82F4');
    assert.equal(parsed1.decisionText, 'Y');
    assert.equal(classifyDecision(parsed1.decisionText), 'APPROVE');

    const parsed2 = parseReply('AP-82F4: N');
    assert.equal(parsed2.requestId, 'AP-82F4');
    assert.equal(parsed2.decisionText, 'N');
    assert.equal(classifyDecision(parsed2.decisionText), 'REJECT');

    const parsedEmpty = parseReply('AP-82F4');
    assert.equal(parsedEmpty.requestId, 'AP-82F4');
    assert.equal(parsedEmpty.decisionText, '');

    // Natural spoken voice note transcripts
    assert.equal(classifyDecision('Okay, go, proceed.'), 'APPROVE');
    assert.equal(classifyDecision('Yes, go ahead and run it please.'), 'APPROVE');
    assert.equal(classifyDecision("No, stop, don't run that."), 'REJECT');
    assert.equal(
      classifyDecision('Yes, but run it on staging first.'),
      'MODIFICATION_REQUESTED'
    );

    // 11c. computeEffectiveRisk escalates properly
    assert.equal(
      computeEffectiveRisk('LOW', { summary: 'drop', commandOrDiff: 'DROP TABLE users' }),
      'CRITICAL'
    );
    assert.equal(
      computeEffectiveRisk('LOW', { summary: 'publish package', commandOrDiff: 'npm publish' }),
      'HIGH'
    );

    // 11d. Idempotent destroy() resolves pending waiters with ENGINE_DESTROYED
    const { engine } = createTestHarness();
    const pendingWait = engine.requestHumanInput({
      project: 'inventory-service',
      question: 'Which port should we use?',
      spokenPrompt: 'Which port?',
      timeoutSeconds: 60,
    });
    await sleep(15);
    await engine.destroy();
    await engine.destroy(); // Idempotent second call
    const destroyRes = await pendingWait;
    assert.equal(destroyRes.final_state, STATES.CANCELLED);
    assert.equal(destroyRes.reason, 'ENGINE_DESTROYED');
    console.error(
      '✅ 11. Schema migration helper, parseReply, computeEffectiveRisk, and idempotent destroy verified'
    );
  }

  // ---------------------------------------------------------------------------
  // Test 12: Auxiliary Modules (isWithinQuietHours, validateConfig, countdownMs, ringAndInterrupt fallback)
  // ---------------------------------------------------------------------------
  {
    // 12a. Quiet hours evaluation (same-day and overnight spans)
    const at0230 = new Date(2026, 10, 3, 2, 30, 0);
    const at1400 = new Date(2026, 10, 3, 14, 0, 0);
    const at2330 = new Date(2026, 10, 3, 23, 30, 0);

    assert.equal(isWithinQuietHours(at0230, '23:00-07:00'), true, '02:30 is within 23:00-07:00');
    assert.equal(isWithinQuietHours(at2330, '23:00-07:00'), true, '23:30 is within 23:00-07:00');
    assert.equal(isWithinQuietHours(at1400, '23:00-07:00'), false, '14:00 is outside 23:00-07:00');
    assert.equal(isWithinQuietHours(at1400, '13:00-15:00'), true, '14:00 is within 13:00-15:00');
    assert.equal(isWithinQuietHours(at1400, ''), false, 'Empty quietHours returns false');

    // 12b. validateConfig rejects placeholder values and allows missing OPENAI_API_KEY by default
    const origWaId = process.env.MY_WHATSAPP_ID;
    const origOpenAi = process.env.OPENAI_API_KEY;
    const origGroq = process.env.GROQ_API_KEY;
    const origConfigOpenAi = config.openaiApiKey;
    const origConfigGroq = config.groqApiKey;
    try {
      process.env.MY_WHATSAPP_ID = '1XXXXXXXXXX@c.us';
      assert.throws(
        () => validateConfig({ silent: true }),
        /MY_WHATSAPP_ID still contains placeholder/
      );

      // Valid MY_WHATSAPP_ID without OPENAI_API_KEY succeeds and disables voice notes gracefully
      process.env.MY_WHATSAPP_ID = '14155552671@c.us';
      process.env.OPENAI_API_KEY = '';
      process.env.GROQ_API_KEY = '';
      config.openaiApiKey = '';
      config.groqApiKey = '';

      assert.doesNotThrow(() => validateConfig({ silent: true }));
      assert.equal(hasOpenAIKey(), false, 'hasOpenAIKey() must be false when OPENAI_API_KEY is unset');
      assert.equal(hasSTTKey(), false, 'hasSTTKey() must be false when both keys are unset');

      const pttMedia = await generateOpusVoiceNote('Hello test');
      assert.equal(pttMedia, null, 'generateOpusVoiceNote must return null when OPENAI_API_KEY is unset');

      await assert.rejects(
        () => transcribeVoiceNote('dGVzdA=='),
        /No OPENAI_API_KEY or GROQ_API_KEY configured/
      );
    } finally {
      if (origWaId === undefined) delete process.env.MY_WHATSAPP_ID;
      else process.env.MY_WHATSAPP_ID = origWaId;
      if (origOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = origOpenAi;
      if (origGroq === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = origGroq;
      config.openaiApiKey = origConfigOpenAi;
      config.groqApiKey = origConfigGroq;
    }

    // 12c. Pre-dispatch countdownMs delays prompt dispatch and respects pre-send cancellation
    const { store, provider, engine } = createTestHarness();
    const abortCtrl = new AbortController();
    const countdownReqPromise = engine.requestApproval({
      project: 'inventory-service',
      summary: 'Countdown abort test',
      commandOrDiff: 'echo countdown',
      spokenPrompt: 'Countdown test',
      riskLevel: 'LOW',
      timeoutSeconds: 30,
      countdownMs: 80,
      signal: abortCtrl.signal,
    });
    await sleep(20);
    assert.equal(provider.sentPrompts.length, 0, 'Prompt must not be sent while countdown is active');
    abortCtrl.abort();
    const countdownRes = await countdownReqPromise;
    assert.equal(countdownRes.final_state, STATES.CANCELLED);
    assert.equal(provider.sentPrompts.length, 0, 'Aborted countdown must never send a prompt');
    await engine.destroy();
    store.close();

    // 12d. ringAndInterrupt falls back to 3 rapid buzzer messages when voice call button is missing
    const sentBuzzers = [];
    const mockWaClient = {
      pupBrowser: {
        isConnected: () => true,
        defaultBrowserContext: () => ({ overridePermissions: async () => {} }),
      },
      pupPage: {
        isClosed: () => false,
        evaluate: async () => false, // Voice call button not found -> triggers buzzer fallback
      },
      sendMessage: async (_chatId, text) => {
        sentBuzzers.push(text);
        if (sentBuzzers.length === 1) {
          // Abort after first buzzer so test finishes without waiting 3s
          buzzerAbort.abort();
        }
      },
    };
    const buzzerAbort = new AbortController();
    await ringAndInterrupt(mockWaClient, '14155552671@c.us', { signal: buzzerAbort.signal });
    assert.equal(sentBuzzers[0], '🚨 RING!', 'Fallback buzzer must send 🚨 RING! on selector failure');

    console.error(
      '✅ 12. Auxiliary modules (isWithinQuietHours, validateConfig, countdownMs, ringAndInterrupt fallback) verified'
    );
  }

  console.error('\n🎉 All Hardened Fail-Closed HITL specifications passed deterministically!');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
