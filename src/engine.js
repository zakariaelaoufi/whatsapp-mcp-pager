import { config, isWithinQuietHours, STALE_REPLY_COOLDOWN_MS } from './config.js';
import { ACTIVE_WAITING_STATES, STATES, TERMINAL_STATES } from './db.js';
import { computeEffectiveRisk, evaluateRiskPolicy } from './policy.js';
import { redactSecrets } from './redact.js';

const AFFIRMATIVE_PATTERNS = new Set([
  'y',
  'yes',
  'yep',
  'yeah',
  'yup',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'go',
  'go ahead',
  'sure',
  'alright',
  'lgtm',
  'proceed',
  'do it',
  'run it',
  'execute',
  'execute it',
  'ship it',
  'yes run it',
  'yes go ahead',
  'okay go go',
  'okay go proceed',
  'ok go ahead',
  'ok run it',
]);

const AFFIRMATIVE_CORE_WORDS = new Set([
  'y',
  'yes',
  'yep',
  'yeah',
  'yup',
  'ok',
  'okay',
  'sure',
  'alright',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'proceed',
  'go',
  'ahead',
  'run',
  'do',
  'execute',
  'ship',
  'lgtm',
]);

const AFFIRMATIVE_FILLER_WORDS = new Set([
  'it',
  'that',
  'this',
  'now',
  'please',
  'thanks',
  'thank',
  'you',
  'and',
  'lets',
  'sounds',
  'looks',
  'good',
  'great',
  'fine',
  'by',
  'me',
  'i',
]);

const NEGATIVE_PATTERNS = new Set([
  'n',
  'no',
  'nope',
  'nah',
  'reject',
  'rejected',
  'cancel',
  'stop',
  'abort',
  'deny',
  'denied',
  'dont',
  'do not',
  'no cancel',
  'no stop',
  'dont run it',
  'do not run it',
]);

const NEGATIVE_CORE_WORDS = new Set([
  'n',
  'no',
  'nope',
  'nah',
  'reject',
  'rejected',
  'cancel',
  'stop',
  'abort',
  'deny',
  'denied',
  'dont',
  'not',
  'never',
]);

const NEGATIVE_FILLER_WORDS = new Set([
  'do',
  'run',
  'execute',
  'proceed',
  'go',
  'ahead',
  'it',
  'that',
  'this',
  'now',
  'please',
  'thanks',
  'thank',
  'you',
  'wait',
  'hold',
  'on',
]);

/**
 * Section 4: Parses an inbound human reply string:
 * - Extracts any request ID matching `/\b(AP-[0-9A-F]{4,8})\b/i` as `requestId`.
 * - Removes the matched `requestId` (and optional surrounding brackets) and strips
 *   leading/trailing whitespace and separator punctuation (`^[\s:,\-]+|[\s:,\-]+$`)
 *   to produce `decisionText`.
 *
 * @param {string} rawText
 * @returns {{ requestId: string | null, decisionText: string }}
 */
export function parseReply(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { requestId: null, decisionText: '' };
  }

  const idMatch = rawText.match(/\b(AP-[0-9A-F]{4,8})\b/i);
  const requestId = idMatch ? idMatch[1].toUpperCase() : null;

  const withoutId = rawText.replace(/\[?\bAP-[0-9A-F]{4,8}\b\]?/gi, ' ');
  const decisionText = withoutId
    .replace(/^[\s:,\-]+|[\s:,\-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    requestId,
    decisionText,
  };
}

/**
 * Classifies a cleaned `decisionText` string into one of four intents:
 * - 'APPROVE'
 * - 'REJECT'
 * - 'NEEDS_CLARIFICATION'
 * - 'MODIFICATION_REQUESTED'
 *
 * @param {string} decisionText
 * @returns {'APPROVE' | 'REJECT' | 'NEEDS_CLARIFICATION' | 'MODIFICATION_REQUESTED'}
 */
export function classifyDecision(decisionText) {
  if (!decisionText || typeof decisionText !== 'string') {
    return 'REJECT';
  }

  const trimmed = decisionText.trim();
  if (!trimmed) {
    return 'REJECT';
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[,!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (AFFIRMATIVE_PATTERNS.has(normalized)) {
    return 'APPROVE';
  }

  if (NEGATIVE_PATTERNS.has(normalized)) {
    return 'REJECT';
  }

  if (
    trimmed.endsWith('?') ||
    /^(what|why|how|where|when|which|who|can you explain|can you clarify|is this|does this|will this)\b/i.test(
      trimmed
    )
  ) {
    return 'NEEDS_CLARIFICATION';
  }

  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 0 && words.length <= 10) {
    const allAffirmative =
      words.some((w) => AFFIRMATIVE_CORE_WORDS.has(w)) &&
      words.every((w) => AFFIRMATIVE_CORE_WORDS.has(w) || AFFIRMATIVE_FILLER_WORDS.has(w));
    if (allAffirmative) {
      return 'APPROVE';
    }

    const allNegative =
      words.some((w) => NEGATIVE_CORE_WORDS.has(w)) &&
      words.every((w) => NEGATIVE_CORE_WORDS.has(w) || NEGATIVE_FILLER_WORDS.has(w));
    if (allNegative) {
      return 'REJECT';
    }
  }

  return 'MODIFICATION_REQUESTED';
}

/**
 * Formats timeout seconds as a compact string (e.g. 600 -> "10m", 45 -> "45s").
 */
function formatExpiry(timeoutSeconds) {
  if (timeoutSeconds >= 60 && timeoutSeconds % 60 === 0) {
    return `${timeoutSeconds / 60}m`;
  }
  if (timeoutSeconds > 60) {
    return `${Math.round(timeoutSeconds / 60)}m`;
  }
  return `${timeoutSeconds}s`;
}

/**
 * Builds the structured WhatsApp Markdown message per Section 4.1.
 */
export function formatApprovalMessage({
  requestId,
  project,
  riskLevel,
  timeoutSeconds,
  summary,
  commandOrDiff,
}) {
  return [
    `🤖 *Approval Needed [${requestId}]*`,
    `📂 *Project:* ${project}`,
    `⚠️ *Risk:* ${riskLevel} | ⏳ *Expires:* ${formatExpiry(timeoutSeconds)}`,
    '',
    `📋 *Summary:* ${summary}`,
    '💻 *Action:*',
    '```',
    commandOrDiff,
    '```',
    '',
    'Reply with:',
    '• *Y* / *Approve* to authorize',
    '• *N* / *Reject* to cancel',
    '• Or send a *text / voice note* with modifications or questions.',
  ].join('\n');
}

/**
 * Builds a structured WhatsApp Markdown message for open-ended human input (`request_human_input`).
 */
export function formatHumanInputMessage({ requestId, project, timeoutSeconds, question }) {
  return [
    `🤖 *Agent Question [${requestId}]*`,
    `📂 *Project:* ${project}`,
    `⏳ *Expires:* ${formatExpiry(timeoutSeconds)}`,
    '',
    `❓ *Question:* ${question}`,
    '',
    '🎙️ _Reply with text or hold the mic to send a voice note._',
  ].join('\n');
}

/**
 * Converts a database request row into the canonical MCP response payload.
 */
export function toResultPayload(req, extra = {}) {
  if (!req) return null;
  const payload = {
    request_id: req.request_id,
    internal_id: req.internal_id,
    agent_risk_level: req.agent_risk_level ?? req.risk_level,
    risk_level: req.risk_level,
    state: req.state,
    final_state: req.state,
    decision: req.decision || req.state,
    human_instructions: req.human_instructions || '',
    pending_transcript: req.pending_transcript || null,
    channel: req.channel || 'none',
    ...extra,
  };
  if (req.state === STATES.CANCELLED && !payload.code) {
    payload.code = STATES.CANCELLED;
  }
  return payload;
}

/**
 * Formal Fail-Closed Approval Engine.
 */
export class ApprovalEngine {
  /**
   * @param {object} options
   * @param {ReturnType<import('./db.js').createDatabase>} options.store
   * @param {import('./providers/interface.js').NotificationProvider} options.provider
   * @param {number} [options.escalationTimeoutMs]
   * @param {number} [options.staleReplyCooldownMs]
   * @param {number} [options.countdownMs]
   * @param {string} [options.quietHours]
   * @param {boolean} [options.reconcileOnInit]
   */
  constructor({
    store,
    provider,
    escalationTimeoutMs = config.escalationTimeoutMs,
    staleReplyCooldownMs = config.staleReplyCooldownMs ?? STALE_REPLY_COOLDOWN_MS,
    countdownMs = 0,
    quietHours = config.quietHours,
    reconcileOnInit = false,
  }) {
    this.store = store;
    this.provider = provider;
    this.escalationTimeoutMs = escalationTimeoutMs;
    this.staleReplyCooldownMs = staleReplyCooldownMs;
    this.countdownMs = countdownMs;
    this.quietHours = quietHours;
    this._destroyed = false;

    /**
     * @type {Map<string, {
     *   countdownTimer?: NodeJS.Timeout,
     *   escalationTimer?: NodeJS.Timeout,
     *   expirationTimer?: NodeJS.Timeout,
     *   wakeUpAbort?: AbortController,
     *   promptInFlight?: boolean,
     *   promptDispatched?: boolean,
     *   abortHandler?: () => void,
     *   abortSignal?: AbortSignal,
     *   resolvers: Set<(res: object) => void>
     * }>}
     */
    this.activeTrackers = new Map();

    if (reconcileOnInit) {
      this.reconcileOnStartup();
    }

    this._unsubscribeActivity =
      typeof this.provider.onInboundActivity === 'function'
        ? this.provider.onInboundActivity(() => {
            if (this._destroyed) return;
            const active = this.store.getActiveRequest();
            if (active) {
              this._clearEscalationTimer(active.request_id);
            }
          })
        : null;

    this._unsubscribeInbound = this.provider.onInboundMessage((inbound) =>
      this._handleInboundMessage(inbound)
    );
  }

  /**
   * Section 5.1: Marks all orphaned PENDING, NOTIFIED, or AWAITING_CONFIRMATION requests
   * as EXPIRED with audit reason "EXPIRED_ON_SERVER_RESTART".
   */
  reconcileOnStartup(now = Date.now()) {
    const reconciled = this.store.reconcileOnStartup(now);
    for (const req of reconciled) {
      this._resolveWaiters(req.request_id, req);
    }
    return reconciled;
  }

  _getOrCreateTracker(requestId) {
    let tracker = this.activeTrackers.get(requestId);
    if (!tracker) {
      tracker = {
        countdownTimer: undefined,
        escalationTimer: undefined,
        expirationTimer: undefined,
        wakeUpAbort: undefined,
        promptInFlight: false,
        promptDispatched: false,
        abortHandler: undefined,
        abortSignal: undefined,
        resolvers: new Set(),
      };
      this.activeTrackers.set(requestId, tracker);
    }
    return tracker;
  }

  _detachAbortListener(tracker) {
    if (tracker?.abortSignal && tracker?.abortHandler) {
      try {
        tracker.abortSignal.removeEventListener('abort', tracker.abortHandler);
      } catch {
        // Ignore
      }
      tracker.abortHandler = undefined;
      tracker.abortSignal = undefined;
    }
  }

  _clearTimers(requestId) {
    const tracker = this.activeTrackers.get(requestId);
    if (!tracker) return;
    if (tracker.countdownTimer) {
      clearTimeout(tracker.countdownTimer);
      tracker.countdownTimer = undefined;
    }
    if (tracker.escalationTimer) {
      clearTimeout(tracker.escalationTimer);
      tracker.escalationTimer = undefined;
    }
    if (tracker.wakeUpAbort) {
      tracker.wakeUpAbort.abort();
      tracker.wakeUpAbort = undefined;
    }
    if (tracker.expirationTimer) {
      clearTimeout(tracker.expirationTimer);
      tracker.expirationTimer = undefined;
    }
  }

  _clearEscalationTimer(requestId) {
    const tracker = this.activeTrackers.get(requestId);
    if (!tracker) return;
    if (tracker.escalationTimer) {
      clearTimeout(tracker.escalationTimer);
      tracker.escalationTimer = undefined;
    }
    if (tracker.wakeUpAbort) {
      tracker.wakeUpAbort.abort();
      tracker.wakeUpAbort = undefined;
    }
  }

  _resolveWaiters(requestId, updatedReq, extra = {}) {
    this._clearTimers(requestId);
    const tracker = this.activeTrackers.get(requestId);
    if (!tracker) return;

    this._detachAbortListener(tracker);

    const payload =
      updatedReq && updatedReq.request_id
        ? toResultPayload(updatedReq, extra)
        : {
            request_id: requestId,
            state: STATES.CANCELLED,
            final_state: STATES.CANCELLED,
            decision: STATES.CANCELLED,
            code: STATES.CANCELLED,
            human_instructions: extra.reason || 'CANCELLED',
            channel: 'none',
            ...extra,
          };

    for (const resolve of Array.from(tracker.resolvers)) {
      resolve(payload);
    }
    tracker.resolvers.clear();
    this.activeTrackers.delete(requestId);
  }

  /**
   * Attaches a single full-lifecycle AbortSignal listener covering countdown,
   * sendPrompt(), and waitForApproval().
   */
  _attachLifecycleAbortSignal(requestId, signal) {
    if (!signal) return;
    const tracker = this._getOrCreateTracker(requestId);
    this._detachAbortListener(tracker);

    const onAbort = () => {
      this._detachAbortListener(tracker);
      this.cancelRequest(requestId, 'MCP request aborted by client', {
        code: STATES.CANCELLED,
      }).catch(() => {});
    };

    tracker.abortSignal = signal;
    tracker.abortHandler = onAbort;

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  _scheduleTimers(req) {
    if (this._destroyed) return;
    const requestId = req.request_id;
    const tracker = this._getOrCreateTracker(requestId);
    this._clearTimers(requestId);

    const remainingMs = Math.max(0, req.expires_at - Date.now());

    // 1. Schedule 60-second wake-up ring if still in NOTIFIED
    if (req.state === STATES.NOTIFIED && this.escalationTimeoutMs > 0) {
      tracker.escalationTimer = setTimeout(async () => {
        try {
          if (this._destroyed) return;
          const current = this.store.getRequest(requestId);
          if (!current || current.state !== STATES.NOTIFIED) {
            return;
          }

          if (isWithinQuietHours(new Date(), this.quietHours)) {
            this.store.logAudit({
              requestId,
              eventType: 'ESCALATION_SUPPRESSED_QUIET_HOURS',
              fromState: current.state,
              toState: current.state,
              details: { quietHours: this.quietHours },
            });
            return;
          }

          const wakeUpAbort = new AbortController();
          tracker.wakeUpAbort = wakeUpAbort;

          await this.provider.sendText(
            `🔔 *Still waiting on [${requestId}] — ringing your phone now...*`
          );
          if (wakeUpAbort.signal.aborted || this._destroyed) return;

          await this.provider.triggerWakeUp({ requestId, signal: wakeUpAbort.signal });

          if (!this._destroyed) {
            this.store.logAudit({
              requestId,
              eventType: 'WAKEUP_RING_TRIGGERED',
              fromState: current.state,
              toState: current.state,
              details: { escalationTimeoutMs: this.escalationTimeoutMs },
            });
          }
        } catch (err) {
          if (!this._destroyed) {
            this.store.logAudit({
              requestId,
              eventType: 'WAKEUP_RING_ERROR',
              details: { error: redactSecrets(err?.message || String(err)) },
            });
          }
        }
      }, this.escalationTimeoutMs);
    }

    // 2. Schedule Fail-Closed expiration timer
    tracker.expirationTimer = setTimeout(() => {
      try {
        if (this._destroyed) return;
        const current = this.store.getRequest(requestId);
        if (!current || TERMINAL_STATES.has(current.state)) {
          return;
        }

        const { transitioned, request: expiredReq } = this.store.transitionState({
          requestId,
          toState: STATES.EXPIRED,
          decision: STATES.EXPIRED,
          humanInstructions: 'Request timed out without human decision (Fail-Closed).',
          eventType: 'REQUEST_EXPIRED',
        });

        if (transitioned && expiredReq) {
          this._resolveWaiters(requestId, expiredReq);
        }
      } catch (err) {
        console.error(`[Engine] Error expiring request ${requestId}:`, err.message);
      }
    }, remainingMs);
  }

  /**
   * Runs an optional pre-dispatch countdown while checking deadline and AbortSignal.
   */
  async _runCountdownAndCheckDeadline(req, countdownMs = this.countdownMs) {
    const requestId = req.request_id;
    const tracker = this._getOrCreateTracker(requestId);

    // Section 6: Check Date.now() >= request.expires_at BEFORE starting any countdown
    if (Date.now() >= req.expires_at) {
      const { request: expiredReq } = this.store.transitionState({
        requestId,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request expired before countdown started (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
      });
      this._resolveWaiters(requestId, expiredReq);
      return { proceed: false, result: toResultPayload(expiredReq) };
    }

    if (countdownMs > 0) {
      await new Promise((resolve) => {
        tracker.countdownTimer = setTimeout(() => {
          tracker.countdownTimer = undefined;
          resolve();
        }, countdownMs);
      });
    }

    if (this._destroyed) {
      return {
        proceed: false,
        result: {
          request_id: requestId,
          state: STATES.CANCELLED,
          final_state: STATES.CANCELLED,
          decision: STATES.CANCELLED,
          code: STATES.CANCELLED,
          reason: 'ENGINE_DESTROYED',
          human_instructions: 'ENGINE_DESTROYED',
          channel: 'none',
        },
      };
    }

    // Re-read request state in case AbortSignal or expiration settled it during countdown
    const latest = this.store.getRequest(requestId);
    if (!latest || TERMINAL_STATES.has(latest.state)) {
      return { proceed: false, result: toResultPayload(latest) };
    }

    // Section 6: Check Date.now() >= request.expires_at IMMEDIATELY BEFORE calling provider.sendPrompt()
    if (Date.now() >= latest.expires_at) {
      const { request: expiredReq } = this.store.transitionState({
        requestId,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request expired before dispatch (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
      });
      this._resolveWaiters(requestId, expiredReq);
      return { proceed: false, result: toResultPayload(expiredReq) };
    }

    return { proceed: true, request: latest };
  }

  /**
   * Section 5.2 & 6: Centralized Cancellation Path (`cancelRequest(requestId, reason)`).
   * Clears timers, transitions to CANCELLED (if non-terminal), and sends a best-effort
   * WhatsApp notification if the prompt was already dispatched.
   */
  async cancelRequest(requestId, reason = 'Cancelled by caller', extra = {}) {
    const id = String(requestId || '').toUpperCase();
    const tracker = this.activeTrackers.get(id);
    const wasPromptInFlightOrDispatched = Boolean(
      tracker?.promptInFlight || tracker?.promptDispatched
    );

    this._clearTimers(id);

    const current = this.store.getRequest(id);
    if (!current) {
      throw new Error(`Approval request "${id}" not found.`);
    }

    // Never overwrite a request that is already in a terminal state
    if (TERMINAL_STATES.has(current.state)) {
      const payload = toResultPayload(current, extra);
      this._resolveWaiters(id, current, extra);
      return payload;
    }

    const wasNotified =
      ACTIVE_WAITING_STATES.has(current.state) || wasPromptInFlightOrDispatched;
    const safeReason = redactSecrets(reason);

    const { transitioned, request: cancelledReq } = this.store.transitionState({
      requestId: id,
      toState: STATES.CANCELLED,
      decision: STATES.CANCELLED,
      humanInstructions: safeReason,
      eventType: 'REQUEST_CANCELLED',
      details: { reason: safeReason, previousState: current.state },
    });

    const targetReq = cancelledReq || this.store.getRequest(id);

    if (transitioned && wasNotified && !this._destroyed) {
      try {
        await this.provider.sendText(
          `🚫 Request [${id}] was cancelled (${safeReason}). No reply needed.`
        );
      } catch (notifyErr) {
        console.error(
          `[Engine] Best-effort cancellation notice failed for [${id}]:`,
          notifyErr.message
        );
      }
    }

    const payload = toResultPayload(targetReq, { code: STATES.CANCELLED, ...extra });
    this._resolveWaiters(id, targetReq, { code: STATES.CANCELLED, ...extra });
    return payload;
  }

  /**
   * Returns the current persisted state of `requestId` (running an expiration sweep first).
   */
  getApprovalStatus(requestId) {
    const newlyExpired = this.store.sweepExpiredRequests(Date.now());
    for (const expReq of newlyExpired) {
      this._resolveWaiters(expReq.request_id, expReq);
    }

    const req = this.store.getRequest(requestId);
    if (!req) {
      throw new Error(`Approval request "${requestId}" not found.`);
    }
    return toResultPayload(req);
  }

  /**
   * Creates, dispatches, and waits for a formal approval request.
   */
  async requestApproval({
    project,
    summary,
    commandOrDiff,
    spokenPrompt,
    riskLevel = 'HIGH',
    timeoutSeconds = 600,
    countdownMs = this.countdownMs,
    mcpWaitTimeoutMs = undefined,
    signal = undefined,
    onHeartbeat,
  }) {
    if (this._destroyed) {
      return {
        state: STATES.CANCELLED,
        final_state: STATES.CANCELLED,
        decision: STATES.CANCELLED,
        code: STATES.CANCELLED,
        reason: 'ENGINE_DESTROYED',
      };
    }

    // Section 5: Redact all fields BEFORE inserting into SQLite and BEFORE passing to provider/TTS
    const redactedProject = redactSecrets(project);
    const redactedSummary = redactSecrets(summary);
    const redactedCommandOrDiff = redactSecrets(commandOrDiff);
    const redactedSpokenPrompt = redactSecrets(spokenPrompt);

    // Section 3: Compute server-side effective risk level (`MAX(agentRisk, derivedRisk)`)
    const rawAgentRisk = String(riskLevel || 'HIGH').toUpperCase();
    const effectiveRiskLevel = computeEffectiveRisk(rawAgentRisk, {
      summary,
      commandOrDiff,
      project,
    });
    const { derivedRiskLevel, escalated } = evaluateRiskPolicy({
      agentRiskLevel: rawAgentRisk,
      commandOrDiff,
      summary,
      project,
    });

    // Section 2: Atomic One-Active-Request Lock + Creation inside a single synchronous SQLite transaction
    const { busy, activeRow, request: req, newlyExpired } = this.store.acquireAndCreateRequest({
      kind: 'APPROVAL',
      project: redactedProject,
      summary: redactedSummary,
      commandOrDiff: redactedCommandOrDiff,
      spokenPrompt: redactedSpokenPrompt,
      agentRiskLevel: rawAgentRisk,
      riskLevel: effectiveRiskLevel,
      timeoutSeconds,
    });

    for (const expReq of newlyExpired) {
      this._resolveWaiters(expReq.request_id, expReq);
    }

    if (busy && activeRow) {
      return {
        code: 'BUSY_ACTIVE_REQUEST',
        error: 'BUSY_ACTIVE_REQUEST',
        active_request_id: activeRow.id,
        request_id: activeRow.id,
        state: activeRow.state,
        final_state: 'BUSY_ACTIVE_REQUEST',
        decision: 'BUSY_ACTIVE_REQUEST',
        human_instructions: `Another request [${activeRow.id}] is currently active (${activeRow.state}). Wait for it via wait_for_approval or cancel it via cancel_approval first.`,
        channel: 'none',
      };
    }

    if (escalated) {
      this.store.logAudit({
        requestId: req.request_id,
        eventType: 'RISK_ESCALATED_BY_POLICY',
        fromState: STATES.PENDING,
        toState: STATES.PENDING,
        details: {
          agentRequestedRisk: rawAgentRisk,
          derivedRiskLevel,
          effectiveRiskLevel,
        },
      });
    }

    // Register full-lifecycle waiter & AbortSignal before countdown and sendPrompt
    const tracker = this._getOrCreateTracker(req.request_id);
    const waitPromise = this._createWaitPromise(req.request_id, {
      onHeartbeat,
      mcpWaitTimeoutMs,
    });
    this._attachLifecycleAbortSignal(req.request_id, signal);

    // Section 6: Deadline check before & after countdown
    const countdownCheck = await this._runCountdownAndCheckDeadline(req, countdownMs);
    if (!countdownCheck.proceed) {
      return waitPromise;
    }

    const formattedText = formatApprovalMessage({
      requestId: req.request_id,
      project: req.project,
      riskLevel: req.risk_level,
      timeoutSeconds: req.timeout_seconds,
      summary: req.summary,
      commandOrDiff: req.command_or_diff,
    });

    // Dispatch via NotificationProvider
    try {
      tracker.promptInFlight = true;
      const sendRes = await this.provider.sendPrompt({
        requestId: req.request_id,
        formattedText,
        spokenPrompt: req.spoken_prompt,
      });
      tracker.promptInFlight = false;
      tracker.promptDispatched = true;

      const providerMessageId =
        sendRes?.providerMessageId || sendRes?.outboundMsgId || null;

      // Check if request was cancelled or expired while sendPrompt() was in flight
      const currentAfterSend = this.store.getRequest(req.request_id);
      if (!currentAfterSend || TERMINAL_STATES.has(currentAfterSend.state)) {
        if (currentAfterSend?.state === STATES.CANCELLED && !this._destroyed) {
          try {
            await this.provider.sendText(
              `🚫 Request [${req.request_id}] was cancelled (${currentAfterSend.human_instructions || 'Cancelled'}). No reply needed.`
            );
          } catch {
            // Ignore best-effort notice error
          }
        }
        return waitPromise;
      }

      if (Date.now() >= currentAfterSend.expires_at) {
        const { request: expiredReq } = this.store.transitionState({
          requestId: req.request_id,
          toState: STATES.EXPIRED,
          decision: STATES.EXPIRED,
          providerMessageId,
          outboundMsgId: providerMessageId,
          humanInstructions: 'Request timed out during dispatch (Fail-Closed).',
          eventType: 'REQUEST_EXPIRED',
        });
        this._resolveWaiters(req.request_id, expiredReq);
        return waitPromise;
      }

      const { request: notifiedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.NOTIFIED,
        providerMessageId,
        outboundMsgId: providerMessageId,
        eventType: 'PROMPT_DISPATCHED',
      });

      this._scheduleTimers(notifiedReq);
    } catch (deliveryErr) {
      tracker.promptInFlight = false;
      const currentAfterErr = this.store.getRequest(req.request_id);
      if (currentAfterErr && !TERMINAL_STATES.has(currentAfterErr.state)) {
        const safeErrMsg = redactSecrets(deliveryErr?.message || String(deliveryErr));
        const { request: failedReq } = this.store.transitionState({
          requestId: req.request_id,
          toState: STATES.DELIVERY_FAILED,
          decision: STATES.DELIVERY_FAILED,
          humanInstructions: `Delivery failed (Fail-Closed): ${safeErrMsg}`,
          eventType: 'DELIVERY_FAILED',
          details: { error: safeErrMsg },
        });
        this._resolveWaiters(req.request_id, failedReq);
      }
      return waitPromise;
    }

    return waitPromise;
  }

  /**
   * Internal helper that registers a waiter on `requestId` with optional heartbeats and MCP wait window.
   */
  _createWaitPromise(
    requestId,
    { onHeartbeat, heartbeatIntervalMs = 15000, mcpWaitTimeoutMs = undefined } = {}
  ) {
    const startMs = Date.now();
    let heartbeatTimer;
    if (typeof onHeartbeat === 'function' && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (this._destroyed) {
          clearInterval(heartbeatTimer);
          return;
        }
        const latest = this.store.getRequest(requestId);
        if (!latest || TERMINAL_STATES.has(latest.state)) {
          clearInterval(heartbeatTimer);
          return;
        }
        const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);
        try {
          onHeartbeat({ requestId, state: latest.state, elapsedSeconds });
        } catch {
          // Ignore heartbeat callback errors
        }
      }, heartbeatIntervalMs);
    }

    let waitWindowTimer;
    const tracker = this._getOrCreateTracker(requestId);

    return new Promise((resolve) => {
      const wrappedResolve = (res) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (waitWindowTimer) clearTimeout(waitWindowTimer);
        tracker.resolvers.delete(wrappedResolve);
        resolve(res);
      };

      tracker.resolvers.add(wrappedResolve);

      // If already terminal in DB right now, settle immediately
      const current = this.store.getRequest(requestId);
      if (current && TERMINAL_STATES.has(current.state)) {
        wrappedResolve(toResultPayload(current));
        return;
      }

      if (typeof mcpWaitTimeoutMs === 'number' && mcpWaitTimeoutMs > 0) {
        waitWindowTimer = setTimeout(() => {
          tracker.resolvers.delete(wrappedResolve);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          const latest = this.store.getRequest(requestId);
          if (latest && !TERMINAL_STATES.has(latest.state)) {
            resolve({
              status: 'WAITING',
              request_id: requestId,
              state: latest.state,
              final_state: latest.state,
              decision: 'WAITING',
              human_instructions: `Still waiting for human response on [${requestId}]. Call wait_for_approval to continue waiting.`,
              channel: 'none',
            });
          } else if (latest) {
            resolve(toResultPayload(latest));
          }
        }, mcpWaitTimeoutMs);
      }
    });
  }

  /**
   * Resumes waiting on an existing `request_id` without sending duplicate messages.
   */
  async waitForApproval(
    requestId,
    { onHeartbeat, heartbeatIntervalMs = 15000, mcpWaitTimeoutMs = undefined, signal = undefined } = {}
  ) {
    const id = String(requestId || '').toUpperCase();
    const current = this.store.getRequest(id);
    if (!current) {
      throw new Error(`Approval request "${id}" not found.`);
    }

    if (TERMINAL_STATES.has(current.state)) {
      return toResultPayload(current);
    }

    if (this._destroyed) {
      return {
        request_id: id,
        state: STATES.CANCELLED,
        final_state: STATES.CANCELLED,
        decision: STATES.CANCELLED,
        code: STATES.CANCELLED,
        reason: 'ENGINE_DESTROYED',
      };
    }

    // Check if already past expiration timestamp
    if (Date.now() >= current.expires_at) {
      const { request: expiredReq } = this.store.transitionState({
        requestId: id,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request timed out without human decision (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
      });
      return toResultPayload(expiredReq);
    }

    if (!this.activeTrackers.has(id)) {
      this._scheduleTimers(current);
    }

    const waitPromise = this._createWaitPromise(id, {
      onHeartbeat,
      heartbeatIntervalMs,
      mcpWaitTimeoutMs,
    });

    if (signal) {
      this._attachLifecycleAbortSignal(id, signal);
    }

    return waitPromise;
  }

  /**
   * Asks an open-ended question via text + voice note and waits for the human's response.
   */
  async requestHumanInput({
    project,
    question,
    spokenPrompt,
    timeoutSeconds = 600,
    countdownMs = this.countdownMs,
    mcpWaitTimeoutMs = undefined,
    signal = undefined,
    onHeartbeat,
  }) {
    if (this._destroyed) {
      return {
        state: STATES.CANCELLED,
        final_state: STATES.CANCELLED,
        decision: STATES.CANCELLED,
        code: STATES.CANCELLED,
        reason: 'ENGINE_DESTROYED',
      };
    }

    // Section 5: Redact all fields before inserting into SQLite and before provider/TTS
    const redactedProject = redactSecrets(project);
    const redactedQuestion = redactSecrets(question);
    const redactedSpokenPrompt = redactSecrets(spokenPrompt);

    // Section 2: Atomic One-Active-Request Lock + Creation inside a single synchronous SQLite transaction
    const { busy, activeRow, request: req, newlyExpired } = this.store.acquireAndCreateRequest({
      kind: 'HUMAN_INPUT',
      project: redactedProject,
      summary: redactedQuestion,
      commandOrDiff: '',
      spokenPrompt: redactedSpokenPrompt,
      agentRiskLevel: 'LOW',
      riskLevel: 'LOW',
      timeoutSeconds,
    });

    for (const expReq of newlyExpired) {
      this._resolveWaiters(expReq.request_id, expReq);
    }

    if (busy && activeRow) {
      return {
        code: 'BUSY_ACTIVE_REQUEST',
        error: 'BUSY_ACTIVE_REQUEST',
        active_request_id: activeRow.id,
        request_id: activeRow.id,
        state: activeRow.state,
        final_state: 'BUSY_ACTIVE_REQUEST',
        decision: 'BUSY_ACTIVE_REQUEST',
        human_instructions: `Another request [${activeRow.id}] is currently active (${activeRow.state}). Wait for it via wait_for_approval or cancel it via cancel_approval first.`,
        channel: 'none',
      };
    }

    const tracker = this._getOrCreateTracker(req.request_id);
    const waitPromise = this._createWaitPromise(req.request_id, {
      onHeartbeat,
      mcpWaitTimeoutMs,
    });
    this._attachLifecycleAbortSignal(req.request_id, signal);

    const countdownCheck = await this._runCountdownAndCheckDeadline(req, countdownMs);
    if (!countdownCheck.proceed) {
      return waitPromise;
    }

    const formattedText = formatHumanInputMessage({
      requestId: req.request_id,
      project: req.project,
      timeoutSeconds: req.timeout_seconds,
      question: req.summary,
    });

    try {
      tracker.promptInFlight = true;
      const sendRes = await this.provider.sendPrompt({
        requestId: req.request_id,
        formattedText,
        spokenPrompt: req.spoken_prompt,
      });
      tracker.promptInFlight = false;
      tracker.promptDispatched = true;

      const providerMessageId =
        sendRes?.providerMessageId || sendRes?.outboundMsgId || null;

      const currentAfterSend = this.store.getRequest(req.request_id);
      if (!currentAfterSend || TERMINAL_STATES.has(currentAfterSend.state)) {
        if (currentAfterSend?.state === STATES.CANCELLED && !this._destroyed) {
          try {
            await this.provider.sendText(
              `🚫 Request [${req.request_id}] was cancelled (${currentAfterSend.human_instructions || 'Cancelled'}). No reply needed.`
            );
          } catch {
            // Ignore best-effort notice error
          }
        }
        return waitPromise;
      }

      if (Date.now() >= currentAfterSend.expires_at) {
        const { request: expiredReq } = this.store.transitionState({
          requestId: req.request_id,
          toState: STATES.EXPIRED,
          decision: STATES.EXPIRED,
          providerMessageId,
          outboundMsgId: providerMessageId,
          humanInstructions: 'Request timed out during dispatch (Fail-Closed).',
          eventType: 'REQUEST_EXPIRED',
        });
        this._resolveWaiters(req.request_id, expiredReq);
        return waitPromise;
      }

      const { request: notifiedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.NOTIFIED,
        providerMessageId,
        outboundMsgId: providerMessageId,
        eventType: 'PROMPT_DISPATCHED',
      });

      this._scheduleTimers(notifiedReq);
    } catch (deliveryErr) {
      tracker.promptInFlight = false;
      const currentAfterErr = this.store.getRequest(req.request_id);
      if (currentAfterErr && !TERMINAL_STATES.has(currentAfterErr.state)) {
        const safeErrMsg = redactSecrets(deliveryErr?.message || String(deliveryErr));
        const { request: failedReq } = this.store.transitionState({
          requestId: req.request_id,
          toState: STATES.DELIVERY_FAILED,
          decision: STATES.DELIVERY_FAILED,
          humanInstructions: `Delivery failed (Fail-Closed): ${safeErrMsg}`,
          eventType: 'DELIVERY_FAILED',
          details: { error: safeErrMsg },
        });
        this._resolveWaiters(req.request_id, failedReq);
      }
      return waitPromise;
    }

    return waitPromise;
  }

  /**
   * Processes an inbound message from the NotificationProvider according to Section 4.
   */
  async _handleInboundMessage(inbound) {
    if (this._destroyed) return;

    const {
      messageId,
      senderId,
      isAllowedSender,
      channel,
      text = '',
      quotedRequestId,
      quotedMessageId,
    } = inbound;

    const now = Date.now();

    // 1. Idempotency check: has this message_id already been processed?
    if (messageId && this.store.isMessageProcessed(messageId)) {
      this.store.logAudit({
        eventType: 'DUPLICATE_MESSAGE_IGNORED',
        senderId,
        details: { duplicateMessageId: messageId },
        now,
      });
      return;
    }

    // 2. Sender verification: ignore and log unauthorized senders
    if (!isAllowedSender) {
      this.store.logAudit({
        eventType: 'UNAUTHORIZED_SENDER_IGNORED',
        messageId,
        senderId,
        details: { text: text.slice(0, 200), channel },
        now,
      });
      return;
    }

    // 3. Sweep any expired active requests first
    const newlyExpired = this.store.sweepExpiredRequests(now);
    for (const expReq of newlyExpired) {
      this._resolveWaiters(expReq.request_id, expReq);
    }

    // 4. Parse inbound reply using parseReply(rawText) (Section 4)
    const { requestId: explicitRequestId, decisionText } = parseReply(text);
    const quotedRowByMsgId = quotedMessageId
      ? this.store.getRequestByProviderMsgId(quotedMessageId)
      : undefined;
    const effectiveQuotedId = quotedRequestId
      ? String(quotedRequestId).toUpperCase()
      : quotedRowByMsgId?.request_id || null;

    const activeReq = this.store.getActiveRequest();

    // If no active request is waiting in NOTIFIED or AWAITING_CONFIRMATION
    if (!activeReq || !ACTIVE_WAITING_STATES.has(activeReq.state)) {
      const targetClosedId = effectiveQuotedId || explicitRequestId;
      this.store.logAudit({
        requestId: targetClosedId || newlyExpired[0]?.request_id || null,
        eventType: 'NO_ACTIVE_REQUEST_IGNORED',
        messageId,
        senderId,
        details: { text, channel, quotedRequestId: effectiveQuotedId, explicitRequestId },
        now,
      });

      if (targetClosedId) {
        await this.provider.sendText(`⚠️ That request ([${targetClosedId}]) is already closed.`);
      } else {
        await this.provider.sendText(
          '⚠️ No active request waiting (or request already closed). Ignored.'
        );
      }
      return;
    }

    // 5. Rule 1 (Quoted Replies): Reject replies that quote an expired/terminal provider_message_id or non-active ID
    if (effectiveQuotedId && effectiveQuotedId !== activeReq.request_id) {
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'STALE_QUOTE_CORRELATION_REJECTED',
        messageId,
        senderId,
        fromState: activeReq.state,
        toState: activeReq.state,
        details: {
          quotedRequestId: effectiveQuotedId,
          activeRequestId: activeReq.request_id,
          quotedMessageId,
        },
        now,
      });
      await this.provider.sendText(`⚠️ That request ([${effectiveQuotedId}]) is already closed.`);
      return;
    }

    const activeProviderMsgId = activeReq.provider_message_id || activeReq.outbound_msg_id;
    if (
      quotedMessageId &&
      activeProviderMsgId &&
      quotedMessageId !== activeProviderMsgId &&
      !effectiveQuotedId
    ) {
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'STALE_QUOTE_MSG_ID_REJECTED',
        messageId,
        senderId,
        fromState: activeReq.state,
        toState: activeReq.state,
        details: {
          quotedMessageId,
          expectedProviderMsgId: activeProviderMsgId,
        },
        now,
      });
      await this.provider.sendText('⚠️ That request is already closed.');
      return;
    }

    // 6. Rule 2 (Explicit ID): Reject replies that explicitly name a non-active AP-XXXX ID
    if (explicitRequestId && explicitRequestId !== activeReq.request_id) {
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'MISMATCHED_EXPLICIT_ID_REJECTED',
        messageId,
        senderId,
        fromState: activeReq.state,
        toState: activeReq.state,
        details: {
          explicitRequestId,
          activeRequestId: activeReq.request_id,
        },
        now,
      });
      await this.provider.sendText(`⚠️ That request ([${explicitRequestId}]) is already closed.`);
      return;
    }

    // 7. Rule 3 (30-Second Stale-Reply Cooldown):
    // Query SQLite for the most recently EXPIRED or CANCELLED request (by updated_at DESC).
    // If `now - lastClosed.updated_at < staleReplyCooldownMs`, reject any unquoted reply
    // that does NOT include the active request's explicit AP-XXXX ID.
    const isQuotedToActive =
      effectiveQuotedId === activeReq.request_id ||
      Boolean(quotedMessageId && activeProviderMsgId && quotedMessageId === activeProviderMsgId);
    const hasExplicitActiveId = explicitRequestId === activeReq.request_id;

    if (!isQuotedToActive && !hasExplicitActiveId && this.staleReplyCooldownMs > 0) {
      const lastClosed = this.store.getRecentExpiredOrCancelled();
      if (
        lastClosed &&
        lastClosed.request_id !== activeReq.request_id &&
        typeof lastClosed.updated_at === 'number' &&
        now - lastClosed.updated_at < this.staleReplyCooldownMs
      ) {
        this.store.logAudit({
          requestId: activeReq.request_id,
          eventType: 'STALE_REPLY_COOLDOWN_BLOCKED',
          messageId,
          senderId,
          fromState: activeReq.state,
          toState: activeReq.state,
          details: {
            recentClosedId: lastClosed.request_id,
            recentClosedState: lastClosed.state,
            elapsedSinceCloseMs: now - lastClosed.updated_at,
            cooldownMs: this.staleReplyCooldownMs,
          },
          now,
        });

        await this.provider.sendText(
          '⚠️ A previous request recently closed. Please swipe-to-reply to the current message or include the ID (e.g., Y AP-XXXX).'
        );
        return;
      }
    }

    // 8. Section 4: If decisionText is empty after stripping the ID, ignore the message
    // and ask the user to include a decision (Y, N, or instructions).
    if (!decisionText) {
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'EMPTY_DECISION_TEXT_IGNORED',
        messageId,
        senderId,
        fromState: activeReq.state,
        toState: activeReq.state,
        details: { rawText: text, explicitRequestId },
        now,
      });

      await this.provider.sendText(
        `⚠️ Please include a decision (Y, N, or instructions) for [${activeReq.request_id}].`
      );
      return;
    }

    // Immediately cancel the 60s wake-up escalation timer since a valid reply arrived
    this._clearEscalationTimer(activeReq.request_id);

    const safeDecisionText = redactSecrets(decisionText);

    // 9. Handle open-ended human input requests (`request_human_input`)
    if (activeReq.kind === 'HUMAN_INPUT') {
      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 *Heard:* "${safeDecisionText}"`);
      }

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: STATES.APPROVED,
        decision: 'ANSWERED',
        humanInstructions: safeDecisionText,
        channel,
        messageId,
        senderId,
        eventType: 'HUMAN_INPUT_RECEIVED',
        now,
      });

      if (transitioned && updatedReq) {
        this._resolveWaiters(activeReq.request_id, updatedReq);
      }
      return;
    }

    // 10. Section 4: Pass ONLY `decisionText` into `classifyDecision(decisionText)`
    const intent = classifyDecision(decisionText);
    const isHighRisk =
      activeReq.risk_level === 'HIGH' || activeReq.risk_level === 'CRITICAL';

    // Case A: Request is currently in NOTIFIED
    if (activeReq.state === STATES.NOTIFIED) {
      // High-Risk Voice Confirmation (AWAITING_CONFIRMATION)
      if (channel === 'voice_note' && isHighRisk && intent === 'APPROVE') {
        this.store.transitionState({
          requestId: activeReq.request_id,
          toState: STATES.AWAITING_CONFIRMATION,
          decision: null,
          humanInstructions: safeDecisionText,
          pendingTranscript: safeDecisionText,
          channel: 'voice_note',
          messageId,
          senderId,
          eventType: 'HIGH_RISK_VOICE_AWAITING_CONFIRMATION',
          details: { transcript: safeDecisionText, riskLevel: activeReq.risk_level },
          now,
        });

        await this.provider.sendText(
          `📝 Heard: "${safeDecisionText}"\n⚠️ High-risk action [${activeReq.request_id}]: Reply Y to confirm execution or N to reject.`
        );
        return;
      }

      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 Heard: "${safeDecisionText}"`);
      }

      const targetState =
        intent === 'APPROVE'
          ? STATES.APPROVED
          : intent === 'REJECT'
            ? STATES.REJECTED
            : intent === 'NEEDS_CLARIFICATION'
              ? STATES.NEEDS_CLARIFICATION
              : STATES.MODIFICATION_REQUESTED;

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: targetState,
        decision: targetState,
        humanInstructions: safeDecisionText,
        channel,
        messageId,
        senderId,
        eventType: `DECISION_${targetState}`,
        now,
      });

      if (transitioned && updatedReq) {
        this._resolveWaiters(activeReq.request_id, updatedReq);
      }
      return;
    }

    // Case B: Request is currently in AWAITING_CONFIRMATION
    if (activeReq.state === STATES.AWAITING_CONFIRMATION) {
      if (channel === 'voice_note' && intent === 'APPROVE') {
        this.store.logAudit({
          requestId: activeReq.request_id,
          eventType: 'VOICE_CONFIRMATION_REJECTED_REQUIRES_TEXT',
          messageId,
          senderId,
          fromState: STATES.AWAITING_CONFIRMATION,
          toState: STATES.AWAITING_CONFIRMATION,
          details: { transcript: safeDecisionText },
          now,
        });
        await this.provider.sendText(
          `⚠️ High-risk action [${activeReq.request_id}]: Please send a text reply with Y to confirm execution or N to reject.`
        );
        return;
      }

      const targetState =
        intent === 'APPROVE'
          ? STATES.APPROVED
          : intent === 'REJECT'
            ? STATES.REJECTED
            : intent === 'NEEDS_CLARIFICATION'
              ? STATES.NEEDS_CLARIFICATION
              : STATES.MODIFICATION_REQUESTED;

      const preservedInstructions =
        targetState === STATES.APPROVED
          ? activeReq.pending_transcript || activeReq.human_instructions || safeDecisionText
          : safeDecisionText;

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: targetState,
        decision: targetState,
        humanInstructions: preservedInstructions,
        channel: activeReq.channel || channel,
        messageId,
        senderId,
        eventType: `CONFIRMED_${targetState}`,
        now,
      });

      if (transitioned && updatedReq) {
        this._resolveWaiters(activeReq.request_id, updatedReq);
      }
    }
  }

  /**
   * Section 6: Clean idempotent `destroy()` shutdown:
   * - Marks engine as shutting down
   * - Clears all escalation/expiration/countdown timers
   * - Resolves/settles all pending in-memory waiter promises with `{ state: 'CANCELLED', reason: 'ENGINE_DESTROYED' }`
   * - Destroys the provider and closes the SQLite database safely
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._unsubscribeActivity) {
      this._unsubscribeActivity();
      this._unsubscribeActivity = null;
    }
    if (this._unsubscribeInbound) {
      this._unsubscribeInbound();
      this._unsubscribeInbound = null;
    }

    for (const [requestId, tracker] of Array.from(this.activeTrackers.entries())) {
      this._clearTimers(requestId);
      this._detachAbortListener(tracker);

      let updatedReq = null;
      try {
        const current = this.store.getRequest(requestId);
        if (current && !TERMINAL_STATES.has(current.state)) {
          const res = this.store.transitionState({
            requestId,
            toState: STATES.CANCELLED,
            decision: STATES.CANCELLED,
            humanInstructions: 'ENGINE_DESTROYED',
            eventType: 'ENGINE_DESTROYED_CANCEL',
            details: { reason: 'ENGINE_DESTROYED' },
          });
          updatedReq = res.request;
        }
      } catch {
        // Ignore DB error if already closed
      }

      const payload = updatedReq
        ? toResultPayload(updatedReq, {
            state: STATES.CANCELLED,
            code: STATES.CANCELLED,
            reason: 'ENGINE_DESTROYED',
          })
        : {
            request_id: requestId,
            state: STATES.CANCELLED,
            final_state: STATES.CANCELLED,
            decision: STATES.CANCELLED,
            code: STATES.CANCELLED,
            reason: 'ENGINE_DESTROYED',
            human_instructions: 'ENGINE_DESTROYED',
            channel: 'none',
          };

      for (const resolve of Array.from(tracker.resolvers)) {
        resolve(payload);
      }
      tracker.resolvers.clear();
    }

    this.activeTrackers.clear();

    try {
      await this.provider.destroy();
    } catch {
      // Ignore provider shutdown error
    }

    try {
      this.store.close();
    } catch {
      // Ignore DB close error
    }
  }
}
