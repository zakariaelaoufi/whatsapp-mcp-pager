import { config, isWithinQuietHours, STALE_REPLY_COOLDOWN_MS } from './config.js';
import { ACTIVE_WAITING_STATES, STATES, TERMINAL_STATES } from './db.js';
import { evaluateRiskPolicy } from './policy.js';
import { redactSecrets } from './redact.js';

const AFFIRMATIVE_PATTERNS = new Set([
  'y',
  'yes',
  'yep',
  'yeah',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'go ahead',
  'sure',
  'lgtm',
  'proceed',
  'do it',
  'run it',
  'yes run it',
  'yes go ahead',
  'okay go go',
  'ok go ahead',
  'ok run it',
]);

const NEGATIVE_PATTERNS = new Set([
  'n',
  'no',
  'nope',
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

/**
 * Classifies a human response string into one of four intents:
 * - 'APPROVE'
 * - 'REJECT'
 * - 'NEEDS_CLARIFICATION'
 * - 'MODIFICATION_REQUESTED'
 *
 * @param {string} rawText
 * @returns {'APPROVE' | 'REJECT' | 'NEEDS_CLARIFICATION' | 'MODIFICATION_REQUESTED'}
 */
export function classifyDecision(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return 'REJECT';
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    return 'REJECT';
  }

  // Strip an explicit AP-XXXX prefix/suffix when checking affirmative/negative intent
  const withoutId = trimmed.replace(/\[?AP-[A-F0-9]{4}\]?/gi, '').trim();
  const targetForIntent = withoutId || trimmed;

  const normalized = targetForIntent
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
      targetForIntent
    )
  ) {
    return 'NEEDS_CLARIFICATION';
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
export function toResultPayload(req) {
  if (!req) return null;
  return {
    request_id: req.request_id,
    internal_id: req.internal_id,
    risk_level: req.risk_level,
    final_state: req.state,
    decision: req.decision || req.state,
    human_instructions: req.human_instructions || '',
    pending_transcript: req.pending_transcript || null,
    channel: req.channel || 'none',
  };
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
   * @param {string} [options.quietHours]
   * @param {boolean} [options.reconcileOnInit]
   */
  constructor({
    store,
    provider,
    escalationTimeoutMs = config.escalationTimeoutMs,
    staleReplyCooldownMs = config.staleReplyCooldownMs ?? STALE_REPLY_COOLDOWN_MS,
    quietHours = config.quietHours,
    reconcileOnInit = false,
  }) {
    this.store = store;
    this.provider = provider;
    this.escalationTimeoutMs = escalationTimeoutMs;
    this.staleReplyCooldownMs = staleReplyCooldownMs;
    this.quietHours = quietHours;

    /** @type {Map<string, { escalationTimer?: NodeJS.Timeout, expirationTimer?: NodeJS.Timeout, wakeUpAbort?: AbortController, resolvers: Set<(res: object) => void> }>} */
    this.activeTrackers = new Map();

    if (reconcileOnInit) {
      this.reconcileOnStartup();
    }

    this._unsubscribeActivity =
      typeof this.provider.onInboundActivity === 'function'
        ? this.provider.onInboundActivity(() => {
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
        escalationTimer: undefined,
        expirationTimer: undefined,
        wakeUpAbort: undefined,
        resolvers: new Set(),
      };
      this.activeTrackers.set(requestId, tracker);
    }
    return tracker;
  }

  _clearTimers(requestId) {
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

  _resolveWaiters(requestId, updatedReq) {
    this._clearTimers(requestId);
    const tracker = this.activeTrackers.get(requestId);
    if (!tracker) return;

    const payload = toResultPayload(updatedReq);
    for (const resolve of tracker.resolvers) {
      resolve(payload);
    }
    tracker.resolvers.clear();
    this.activeTrackers.delete(requestId);
  }

  _scheduleTimers(req) {
    const requestId = req.request_id;
    const tracker = this._getOrCreateTracker(requestId);
    this._clearTimers(requestId);

    const remainingMs = Math.max(0, req.expires_at - Date.now());

    // 1. Schedule 60-second wake-up ring if still in NOTIFIED
    if (req.state === STATES.NOTIFIED && this.escalationTimeoutMs > 0) {
      tracker.escalationTimer = setTimeout(async () => {
        try {
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
          if (wakeUpAbort.signal.aborted) return;

          await this.provider.triggerWakeUp({ requestId, signal: wakeUpAbort.signal });

          this.store.logAudit({
            requestId,
            eventType: 'WAKEUP_RING_TRIGGERED',
            fromState: current.state,
            toState: current.state,
            details: { escalationTimeoutMs: this.escalationTimeoutMs },
          });
        } catch (err) {
          this.store.logAudit({
            requestId,
            eventType: 'WAKEUP_RING_ERROR',
            details: { error: redactSecrets(err?.message || String(err)) },
          });
        }
      }, this.escalationTimeoutMs);
    }

    // 2. Schedule Fail-Closed expiration timer
    tracker.expirationTimer = setTimeout(() => {
      try {
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
   * Sweeps any expired requests and resolves their in-memory waiters before checking for active locks.
   */
  _sweepAndCheckActiveLock() {
    const newlyExpired = this.store.sweepExpiredRequests(Date.now());
    for (const expReq of newlyExpired) {
      this._resolveWaiters(expReq.request_id, expReq);
    }

    const active = this.store.getBlockingActiveRequest(Date.now());
    if (active) {
      this.store.logAudit({
        requestId: active.request_id,
        eventType: 'BUSY_ACTIVE_REQUEST_REJECTED',
        fromState: active.state,
        toState: active.state,
        details: { activeRequestId: active.request_id, state: active.state },
      });

      return {
        error: 'BUSY_ACTIVE_REQUEST',
        code: 'BUSY_ACTIVE_REQUEST',
        request_id: active.request_id,
        active_request_id: active.request_id,
        final_state: 'BUSY_ACTIVE_REQUEST',
        decision: 'BUSY_ACTIVE_REQUEST',
        human_instructions: `Another request [${active.request_id}] is currently active (${active.state}). Wait for it via wait_for_approval or cancel it via cancel_approval first.`,
        channel: 'none',
      };
    }

    return null;
  }

  /**
   * Section 5.2: Centralized Cancellation Path (`cancelRequest(requestId, reason)`).
   * Clears timers, transitions to CANCELLED (if non-terminal), and sends a best-effort
   * WhatsApp notification if the user was already notified.
   */
  async cancelRequest(requestId, reason = 'Cancelled by caller') {
    const id = String(requestId || '').toUpperCase();
    const current = this.store.getRequest(id);
    if (!current) {
      throw new Error(`Approval request "${id}" not found.`);
    }

    this._clearTimers(id);

    // Never overwrite a request that is already in a terminal state
    if (TERMINAL_STATES.has(current.state)) {
      return toResultPayload(current);
    }

    const wasNotified = ACTIVE_WAITING_STATES.has(current.state);
    const safeReason = redactSecrets(reason);

    const { transitioned, request: cancelledReq } = this.store.transitionState({
      requestId: id,
      toState: STATES.CANCELLED,
      decision: STATES.CANCELLED,
      humanInstructions: safeReason,
      eventType: 'REQUEST_CANCELLED',
      details: { reason: safeReason, previousState: current.state },
    });

    if (transitioned && cancelledReq) {
      this._resolveWaiters(id, cancelledReq);

      if (wasNotified) {
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

      return toResultPayload(cancelledReq);
    }

    return toResultPayload(this.store.getRequest(id));
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
    mcpWaitTimeoutMs = undefined,
    signal = undefined,
    onHeartbeat,
  }) {
    // 1. One-Active-Request Policy Lock
    const busyLock = this._sweepAndCheckActiveLock();
    if (busyLock) {
      return busyLock;
    }

    // 2. Server-Side Risk Escalation Policy (`MAX(agentRiskLevel, serverDerivedRisk)`)
    const { effectiveRiskLevel, derivedRiskLevel, escalated } = evaluateRiskPolicy({
      agentRiskLevel: riskLevel,
      commandOrDiff,
      summary,
    });

    // 3. End-to-End Secret Redaction across all fields (including spokenPrompt before TTS!)
    const redactedProject = redactSecrets(project);
    const redactedSummary = redactSecrets(summary);
    const redactedCommandOrDiff = redactSecrets(commandOrDiff);
    const redactedSpokenPrompt = redactSecrets(spokenPrompt);

    // 4. Persist in SQLite in PENDING state
    const req = this.store.createRequest({
      kind: 'APPROVAL',
      project: redactedProject,
      summary: redactedSummary,
      commandOrDiff: redactedCommandOrDiff,
      spokenPrompt: redactedSpokenPrompt,
      agentRiskLevel: String(riskLevel || 'HIGH').toUpperCase(),
      riskLevel: effectiveRiskLevel,
      timeoutSeconds,
    });

    if (escalated) {
      this.store.logAudit({
        requestId: req.request_id,
        eventType: 'RISK_ESCALATED_BY_POLICY',
        fromState: STATES.PENDING,
        toState: STATES.PENDING,
        details: {
          agentRequestedRisk: riskLevel,
          derivedRiskLevel,
          effectiveRiskLevel,
        },
      });
    }

    if (signal?.aborted) {
      return this.cancelRequest(req.request_id, 'MCP request aborted before dispatch');
    }

    const formattedText = formatApprovalMessage({
      requestId: req.request_id,
      project: req.project,
      riskLevel: req.risk_level,
      timeoutSeconds: req.timeout_seconds,
      summary: req.summary,
      commandOrDiff: req.command_or_diff,
    });

    // 5. Dispatch via NotificationProvider
    try {
      const { outboundMsgId } = await this.provider.sendPrompt({
        requestId: req.request_id,
        formattedText,
        spokenPrompt: req.spoken_prompt,
      });

      const { request: notifiedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.NOTIFIED,
        outboundMsgId: outboundMsgId || null,
        eventType: 'PROMPT_DISPATCHED',
      });

      this._scheduleTimers(notifiedReq);
    } catch (deliveryErr) {
      const safeErrMsg = redactSecrets(deliveryErr?.message || String(deliveryErr));
      const { request: failedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.DELIVERY_FAILED,
        decision: STATES.DELIVERY_FAILED,
        humanInstructions: `Delivery failed (Fail-Closed): ${safeErrMsg}`,
        eventType: 'DELIVERY_FAILED',
        details: { error: safeErrMsg },
      });

      return toResultPayload(failedReq);
    }

    // 6. Wait for terminal state with 15s progress heartbeats and AbortSignal support
    return this.waitForApproval(req.request_id, {
      onHeartbeat,
      mcpWaitTimeoutMs,
      signal,
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

    if (signal?.aborted) {
      return this.cancelRequest(id, 'MCP request aborted by client');
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

    const startMs = Date.now();
    let heartbeatTimer;
    if (typeof onHeartbeat === 'function' && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        const latest = this.store.getRequest(id);
        if (!latest || TERMINAL_STATES.has(latest.state)) {
          clearInterval(heartbeatTimer);
          return;
        }
        const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);
        try {
          onHeartbeat({ requestId: id, state: latest.state, elapsedSeconds });
        } catch {
          // Ignore heartbeat callback errors
        }
      }, heartbeatIntervalMs);
    }

    let onAbort;
    let waitWindowTimer;

    try {
      return await new Promise((resolve) => {
        const tracker = this._getOrCreateTracker(id);

        const wrappedResolve = (res) => {
          tracker.resolvers.delete(wrappedResolve);
          resolve(res);
        };
        tracker.resolvers.add(wrappedResolve);

        if (signal) {
          onAbort = () => {
            tracker.resolvers.delete(wrappedResolve);
            this.cancelRequest(id, 'MCP request aborted by client')
              .then(resolve)
              .catch(() => resolve(toResultPayload(this.store.getRequest(id))));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        if (typeof mcpWaitTimeoutMs === 'number' && mcpWaitTimeoutMs > 0) {
          waitWindowTimer = setTimeout(() => {
            tracker.resolvers.delete(wrappedResolve);
            const latest = this.store.getRequest(id);
            if (latest && !TERMINAL_STATES.has(latest.state)) {
              resolve({
                status: 'WAITING',
                request_id: id,
                final_state: latest.state,
                decision: 'WAITING',
                human_instructions: `Still waiting for human response on [${id}]. Call wait_for_approval to continue waiting.`,
                channel: 'none',
              });
            }
          }, mcpWaitTimeoutMs);
        }
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (waitWindowTimer) clearTimeout(waitWindowTimer);
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * Asks an open-ended question via text + voice note and waits for the human's response.
   */
  async requestHumanInput({
    project,
    question,
    spokenPrompt,
    timeoutSeconds = 600,
    mcpWaitTimeoutMs = undefined,
    signal = undefined,
    onHeartbeat,
  }) {
    const busyLock = this._sweepAndCheckActiveLock();
    if (busyLock) {
      return busyLock;
    }

    const redactedProject = redactSecrets(project);
    const redactedQuestion = redactSecrets(question);
    const redactedSpokenPrompt = redactSecrets(spokenPrompt);

    const req = this.store.createRequest({
      kind: 'HUMAN_INPUT',
      project: redactedProject,
      summary: redactedQuestion,
      commandOrDiff: '',
      spokenPrompt: redactedSpokenPrompt,
      agentRiskLevel: 'LOW',
      riskLevel: 'LOW',
      timeoutSeconds,
    });

    if (signal?.aborted) {
      return this.cancelRequest(req.request_id, 'MCP request aborted before dispatch');
    }

    const formattedText = formatHumanInputMessage({
      requestId: req.request_id,
      project: req.project,
      timeoutSeconds: req.timeout_seconds,
      question: req.summary,
    });

    try {
      const { outboundMsgId } = await this.provider.sendPrompt({
        requestId: req.request_id,
        formattedText,
        spokenPrompt: req.spoken_prompt,
      });

      const { request: notifiedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.NOTIFIED,
        outboundMsgId: outboundMsgId || null,
        eventType: 'PROMPT_DISPATCHED',
      });

      this._scheduleTimers(notifiedReq);
    } catch (deliveryErr) {
      const safeErrMsg = redactSecrets(deliveryErr?.message || String(deliveryErr));
      const { request: failedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.DELIVERY_FAILED,
        decision: STATES.DELIVERY_FAILED,
        humanInstructions: `Delivery failed (Fail-Closed): ${safeErrMsg}`,
        eventType: 'DELIVERY_FAILED',
        details: { error: safeErrMsg },
      });

      return toResultPayload(failedReq);
    }

    return this.waitForApproval(req.request_id, {
      onHeartbeat,
      mcpWaitTimeoutMs,
      signal,
    });
  }

  /**
   * Processes an inbound message from the NotificationProvider according to Sections 2.2, 3.3, and 4.
   */
  async _handleInboundMessage(inbound) {
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

    // Extract explicit AP-XXXX from message body or quoted message
    const explicitIdMatch = text.match(/\b(AP-[A-F0-9]{4})\b/i);
    const explicitRequestId = explicitIdMatch ? explicitIdMatch[1].toUpperCase() : undefined;
    const quotedRowByMsgId = quotedMessageId
      ? this.store.getRequestByOutboundMsgId(quotedMessageId)
      : undefined;
    const effectiveQuotedId = quotedRequestId
      ? String(quotedRequestId).toUpperCase()
      : quotedRowByMsgId?.request_id;

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

    // 4. Rule 1 (Quoted Replies): Verify quoted message matches the currently active request
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

    if (
      quotedMessageId &&
      activeReq.outbound_msg_id &&
      quotedMessageId !== activeReq.outbound_msg_id &&
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
          expectedOutboundMsgId: activeReq.outbound_msg_id,
        },
        now,
      });
      await this.provider.sendText('⚠️ That request is already closed.');
      return;
    }

    // 5. Rule 2 (Explicit ID): If message contains AP-XXXX, verify it matches the active request
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

    // 6. Rule 3 (Hands-Free Unquoted Text / Voice Note + 30s Stale-Reply Cooldown):
    // Allow plain "Y", "N", modifications, or voice notes without AP-XXXX ONLY IF
    // no other request expired or was cancelled within the last STALE_REPLY_COOLDOWN_MS (30s).
    const isExplicitlyCorrelated =
      effectiveQuotedId === activeReq.request_id ||
      explicitRequestId === activeReq.request_id ||
      (quotedMessageId && quotedMessageId === activeReq.outbound_msg_id);

    if (!isExplicitlyCorrelated && this.staleReplyCooldownMs > 0) {
      const recentClosed = this.store.getRecentExpiredOrCancelled();
      if (
        recentClosed &&
        recentClosed.request_id !== activeReq.request_id &&
        typeof recentClosed.closed_at === 'number' &&
        now - recentClosed.closed_at < this.staleReplyCooldownMs
      ) {
        this.store.logAudit({
          requestId: activeReq.request_id,
          eventType: 'STALE_REPLY_COOLDOWN_BLOCKED',
          messageId,
          senderId,
          fromState: activeReq.state,
          toState: activeReq.state,
          details: {
            recentClosedId: recentClosed.request_id,
            recentClosedState: recentClosed.state,
            elapsedSinceCloseMs: now - recentClosed.closed_at,
            cooldownMs: this.staleReplyCooldownMs,
          },
          now,
        });

        await this.provider.sendText(
          `⚠️ Request [${recentClosed.request_id}] just closed. To reply to [${activeReq.request_id}], please include [${activeReq.request_id}] or swipe-to-reply.`
        );
        return;
      }
    }

    // Immediately cancel the 60s wake-up escalation timer since a valid reply arrived
    this._clearEscalationTimer(activeReq.request_id);

    const safeText = redactSecrets(text);

    // 7. Handle open-ended human input requests (`request_human_input`)
    if (activeReq.kind === 'HUMAN_INPUT') {
      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 *Heard:* "${safeText}"`);
      }

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: STATES.APPROVED,
        decision: 'ANSWERED',
        humanInstructions: safeText,
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

    // 8. Classify decision for approval requests
    const intent = classifyDecision(text);
    const isHighRisk =
      activeReq.risk_level === 'HIGH' || activeReq.risk_level === 'CRITICAL';

    // Case A: Request is currently in NOTIFIED
    if (activeReq.state === STATES.NOTIFIED) {
      // Section 3.3: High-Risk Voice Confirmation (AWAITING_CONFIRMATION)
      if (channel === 'voice_note' && isHighRisk && intent === 'APPROVE') {
        this.store.transitionState({
          requestId: activeReq.request_id,
          toState: STATES.AWAITING_CONFIRMATION,
          decision: null,
          humanInstructions: safeText,
          pendingTranscript: safeText,
          channel: 'voice_note',
          messageId,
          senderId,
          eventType: 'HIGH_RISK_VOICE_AWAITING_CONFIRMATION',
          details: { transcript: safeText, riskLevel: activeReq.risk_level },
          now,
        });

        await this.provider.sendText(
          `📝 Heard: "${safeText}"\n⚠️ High-risk action [${activeReq.request_id}]: Reply Y to confirm execution or N to reject.`
        );
        return;
      }

      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 Heard: "${safeText}"`);
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
        humanInstructions: safeText,
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
          details: { transcript: safeText },
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
          ? activeReq.pending_transcript || activeReq.human_instructions || safeText
          : safeText;

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

  async destroy() {
    if (this._unsubscribeActivity) {
      this._unsubscribeActivity();
      this._unsubscribeActivity = null;
    }
    if (this._unsubscribeInbound) {
      this._unsubscribeInbound();
      this._unsubscribeInbound = null;
    }
    for (const requestId of Array.from(this.activeTrackers.keys())) {
      this._clearTimers(requestId);
    }
    this.activeTrackers.clear();
    await this.provider.destroy();
  }
}
