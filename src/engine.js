import { config, isWithinQuietHours, redactSecrets } from './config.js';
import { ACTIVE_WAITING_STATES, STATES, TERMINAL_STATES } from './db.js';

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

  // Normalize punctuation for exact/clear intent matching
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
    /^(what|why|how|where|when|which|who|can you explain|is this|does this|will this)\b/i.test(
      trimmed
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
function toResultPayload(req) {
  return {
    request_id: req.request_id,
    final_state: req.state,
    decision: req.decision || req.state,
    human_instructions: req.human_instructions || '',
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
   * @param {string} [options.quietHours]
   * @param {number} [options.reminderCounter]
   * @param {number} [options.countdownTickMs]
   */
  constructor({
    store,
    provider,
    escalationTimeoutMs = config.escalationTimeoutMs,
    quietHours = config.quietHours,
    reminderCounter = config.reminderCounter,
    countdownTickMs = 1000,
  }) {
    this.store = store;
    this.provider = provider;
    this.escalationTimeoutMs = escalationTimeoutMs;
    this.quietHours = quietHours;
    this.reminderCounter = Math.max(0, Number(reminderCounter) || 0);
    this.countdownTickMs = Math.max(1, Number(countdownTickMs) || 1000);

    /** @type {Map<string, { escalationTimer?: NodeJS.Timeout, expirationTimer?: NodeJS.Timeout, wakeUpAbort?: AbortController, resolvers: Set<(res: object) => void> }>} */
    this.activeTrackers = new Map();

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
          // Section 4.3: A failure in the wake-up call must never crash or alter the state machine
          this.store.logAudit({
            requestId,
            eventType: 'WAKEUP_RING_ERROR',
            details: { error: err?.message || String(err) },
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
   * Runs the per-request countdown (`REMINDER_COUNTER` down to `0`) before dispatching a WhatsApp notification.
   * If the request is aborted or resolved on screen before the counter hits `0`, no WhatsApp notification is sent.
   *
   * @param {string} requestId
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {(progressInfo: { requestId: string, state: string, elapsedSeconds: number, remainingCountdown?: number }) => void} [options.onHeartbeat]
   * @returns {Promise<{ shouldNotify: boolean, request?: object }>}
   */
  async _waitForRequestCountdown(requestId, { signal, onHeartbeat } = {}) {
    if (this.reminderCounter <= 0) {
      return { shouldNotify: true };
    }

    let remaining = this.reminderCounter;
    let elapsedTicks = 0;

    while (remaining > 0) {
      if (signal?.aborted) {
        const current = this.store.getRequest(requestId);
        if (current && !TERMINAL_STATES.has(current.state)) {
          const { request: abortedReq } = this.store.transitionState({
            requestId,
            toState: STATES.REJECTED,
            decision: STATES.REJECTED,
            humanInstructions: `Cancelled on screen before countdown reached 0 (${remaining}/${this.reminderCounter} remaining).`,
            channel: 'screen',
            eventType: 'COUNTDOWN_CANCELLED_BEFORE_ZERO',
          });
          return { shouldNotify: false, request: abortedReq };
        }
        return { shouldNotify: false, request: current };
      }

      const current = this.store.getRequest(requestId);
      if (!current || TERMINAL_STATES.has(current.state)) {
        return { shouldNotify: false, request: current };
      }

      await new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, this.countdownTickMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });

      if (signal?.aborted) {
        continue;
      }

      remaining -= 1;
      elapsedTicks += 1;

      console.error(
        `[Countdown] [${requestId}] Counter=${remaining}/${this.reminderCounter} before sending WhatsApp reminder...`
      );

      if (typeof onHeartbeat === 'function') {
        try {
          onHeartbeat({
            requestId,
            state: STATES.PENDING,
            elapsedSeconds: elapsedTicks,
            remainingCountdown: remaining,
          });
        } catch {
          // Ignore heartbeat callback errors
        }
      }
    }

    const afterCountdown = this.store.getRequest(requestId);
    if (!afterCountdown || TERMINAL_STATES.has(afterCountdown.state)) {
      return { shouldNotify: false, request: afterCountdown };
    }

    this.store.logAudit({
      requestId,
      eventType: 'COUNTDOWN_REACHED_ZERO',
      fromState: STATES.PENDING,
      toState: STATES.PENDING,
      details: { reminderCounter: this.reminderCounter },
    });

    return { shouldNotify: true };
  }

  /**
   * Creates, dispatches, and waits for a formal approval request.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {string} params.summary
   * @param {string} params.commandOrDiff
   * @param {string} params.spokenPrompt
   * @param {'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'} [params.riskLevel]
   * @param {number} [params.timeoutSeconds]
   * @param {AbortSignal} [params.signal]
   * @param {(progressInfo: { requestId: string, state: string, elapsedSeconds: number, remainingCountdown?: number }) => void} [params.onHeartbeat]
   * @returns {Promise<{ request_id: string, final_state: string, decision: string, human_instructions: string, channel: string }>}
   */
  async requestApproval({
    project,
    summary,
    commandOrDiff,
    spokenPrompt,
    riskLevel = 'HIGH',
    timeoutSeconds = 600,
    signal,
    onHeartbeat,
  }) {
    const redactedCommandOrDiff = redactSecrets(commandOrDiff);
    const redactedSummary = redactSecrets(summary);

    // 1. Persist in SQLite in PENDING state before any outbound network call
    const req = this.store.createRequest({
      kind: 'APPROVAL',
      project,
      summary: redactedSummary,
      commandOrDiff: redactedCommandOrDiff,
      spokenPrompt,
      riskLevel,
      timeoutSeconds,
    });

    // 1b. Per-request countdown: decrement from REMINDER_COUNTER down to 0 before sending WhatsApp reminder
    const countdownResult = await this._waitForRequestCountdown(req.request_id, {
      signal,
      onHeartbeat,
    });
    if (!countdownResult.shouldNotify) {
      return toResultPayload(countdownResult.request || this.store.getRequest(req.request_id));
    }

    const formattedText = formatApprovalMessage({
      requestId: req.request_id,
      project: req.project,
      riskLevel: req.risk_level,
      timeoutSeconds: req.timeout_seconds,
      summary: req.summary,
      commandOrDiff: req.command_or_diff,
    });

    // 2. Dispatch via NotificationProvider
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
      const { request: failedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.DELIVERY_FAILED,
        decision: STATES.DELIVERY_FAILED,
        humanInstructions: `Delivery failed (Fail-Closed): ${deliveryErr.message}`,
        eventType: 'DELIVERY_FAILED',
        details: { error: deliveryErr.message },
      });

      return toResultPayload(failedReq);
    }

    // 3. Wait for terminal state with optional 15s progress heartbeats
    return this.waitForApproval(req.request_id, { onHeartbeat });
  }

  /**
   * Resumes waiting on an existing `request_id` without sending duplicate messages.
   *
   * @param {string} requestId
   * @param {object} [options]
   * @param {(progressInfo: { requestId: string, state: string, elapsedSeconds: number }) => void} [options.onHeartbeat]
   * @param {number} [options.heartbeatIntervalMs]
   */
  async waitForApproval(requestId, { onHeartbeat, heartbeatIntervalMs = 15000 } = {}) {
    const current = this.store.getRequest(requestId);
    if (!current) {
      throw new Error(`Approval request "${requestId}" not found.`);
    }

    if (TERMINAL_STATES.has(current.state)) {
      return toResultPayload(current);
    }

    // Check if already past expiration timestamp
    if (Date.now() >= current.expires_at) {
      const { request: expiredReq } = this.store.transitionState({
        requestId,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request timed out without human decision (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
      });
      return toResultPayload(expiredReq);
    }

    // Ensure timers are active if resuming after a reload
    if (!this.activeTrackers.has(requestId)) {
      this._scheduleTimers(current);
    }

    const startMs = Date.now();
    let heartbeatTimer;
    if (typeof onHeartbeat === 'function' && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
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

    try {
      return await new Promise((resolve) => {
        const tracker = this._getOrCreateTracker(requestId);
        tracker.resolvers.add(resolve);
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }

  /**
   * Asks an open-ended question via text + voice note and waits for the human's response.
   *
   * @param {object} params
   * @param {string} params.project
   * @param {string} params.question
   * @param {string} params.spokenPrompt
   * @param {number} [params.timeoutSeconds]
   * @param {(progressInfo: { requestId: string, state: string, elapsedSeconds: number }) => void} [params.onHeartbeat]
   */
  async requestHumanInput({
    project,
    question,
    spokenPrompt,
    timeoutSeconds = 600,
    signal,
    onHeartbeat,
  }) {
    const redactedQuestion = redactSecrets(question);

    const req = this.store.createRequest({
      kind: 'HUMAN_INPUT',
      project,
      summary: redactedQuestion,
      commandOrDiff: '',
      spokenPrompt,
      riskLevel: 'LOW',
      timeoutSeconds,
    });

    const countdownResult = await this._waitForRequestCountdown(req.request_id, {
      signal,
      onHeartbeat,
    });
    if (!countdownResult.shouldNotify) {
      return toResultPayload(countdownResult.request || this.store.getRequest(req.request_id));
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
      const { request: failedReq } = this.store.transitionState({
        requestId: req.request_id,
        toState: STATES.DELIVERY_FAILED,
        decision: STATES.DELIVERY_FAILED,
        humanInstructions: `Delivery failed (Fail-Closed): ${deliveryErr.message}`,
        eventType: 'DELIVERY_FAILED',
        details: { error: deliveryErr.message },
      });

      return toResultPayload(failedReq);
    }

    return this.waitForApproval(req.request_id, { onHeartbeat });
  }

  /**
   * Processes an inbound message from the NotificationProvider according to Section 4.2.
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

    // 1. Idempotency check: has this message_id already been processed?
    if (messageId && this.store.isMessageProcessed(messageId)) {
      this.store.logAudit({
        eventType: 'DUPLICATE_MESSAGE_IGNORED',
        senderId,
        details: { duplicateMessageId: messageId },
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
      });
      return;
    }

    // 3. Find active request in NOTIFIED or AWAITING_CONFIRMATION
    const activeReq = this.store.getActiveRequest();

    // Check if the active request has already passed its expiration deadline
    if (activeReq && Date.now() >= activeReq.expires_at) {
      const { transitioned, request: expiredReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request timed out without human decision (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
      });
      if (transitioned && expiredReq) {
        this._resolveWaiters(activeReq.request_id, expiredReq);
      }

      // Now treat the late message as arriving when no active request is waiting
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'LATE_MESSAGE_AFTER_EXPIRATION',
        messageId,
        senderId,
        fromState: STATES.EXPIRED,
        toState: STATES.EXPIRED,
        details: { text, channel },
      });
      await this.provider.sendText(
        '⚠️ No active request waiting (or request already closed). Ignored.'
      );
      return;
    }

    // If no request is currently active in NOTIFIED or AWAITING_CONFIRMATION
    if (!activeReq || !ACTIVE_WAITING_STATES.has(activeReq.state)) {
      this.store.logAudit({
        requestId: quotedRequestId || null,
        eventType: 'NO_ACTIVE_REQUEST_IGNORED',
        messageId,
        senderId,
        details: { text, channel, quotedRequestId },
      });
      await this.provider.sendText(
        '⚠️ No active request waiting (or request already closed). Ignored.'
      );
      return;
    }

    // 4. Swipe-reply / Quote Correlation Verification:
    // If the user quoted an older message whose request_id or outbound_msg_id doesn't match activeReq
    const explicitIdMatch = text.match(/\b(AP-[A-F0-9]{4})\b/i);
    const referencedRequestId =
      quotedRequestId || (explicitIdMatch ? explicitIdMatch[1].toUpperCase() : undefined);

    if (referencedRequestId && referencedRequestId !== activeReq.request_id) {
      this.store.logAudit({
        requestId: activeReq.request_id,
        eventType: 'STALE_QUOTE_CORRELATION_REJECTED',
        messageId,
        senderId,
        fromState: activeReq.state,
        toState: activeReq.state,
        details: {
          referencedRequestId,
          activeRequestId: activeReq.request_id,
          quotedMessageId,
        },
      });
      await this.provider.sendText(
        `⚠️ Quoted or referenced request [${referencedRequestId}] is already closed. Active request is [${activeReq.request_id}].`
      );
      return;
    }

    if (
      quotedMessageId &&
      activeReq.outbound_msg_id &&
      quotedMessageId !== activeReq.outbound_msg_id &&
      !referencedRequestId
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
      });
      await this.provider.sendText(
        '⚠️ No active request waiting (or request already closed). Ignored.'
      );
      return;
    }

    // 5. Handle open-ended human input requests (`request_human_input`)
    if (activeReq.kind === 'HUMAN_INPUT') {
      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 *Heard:* _${text}_`);
      }

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: STATES.APPROVED,
        decision: 'ANSWERED',
        humanInstructions: text,
        channel,
        messageId,
        senderId,
        eventType: 'HUMAN_INPUT_RECEIVED',
      });

      if (transitioned && updatedReq) {
        this._resolveWaiters(activeReq.request_id, updatedReq);
      }
      return;
    }

    // 6. Classify decision for approval requests
    const intent = classifyDecision(text);
    const isHighRisk =
      activeReq.risk_level === 'HIGH' || activeReq.risk_level === 'CRITICAL';

    // Case A: Request is currently in NOTIFIED
    if (activeReq.state === STATES.NOTIFIED) {
      // High-Risk Voice Safeguard (Section 4.2.3):
      // For HIGH and CRITICAL risk requests, a voice note with APPROVE intent NEVER executes immediately.
      if (channel === 'voice_note' && isHighRisk && intent === 'APPROVE') {
        this._clearEscalationTimer(activeReq.request_id);

        this.store.transitionState({
          requestId: activeReq.request_id,
          toState: STATES.AWAITING_CONFIRMATION,
          decision: null,
          humanInstructions: text,
          channel: 'voice_note',
          messageId,
          senderId,
          eventType: 'HIGH_RISK_VOICE_AWAITING_CONFIRMATION',
          details: { transcript: text, riskLevel: activeReq.risk_level },
        });

        await this.provider.sendText(
          `📝 *Heard:* '${text}'\n⚠️ *High-Risk Action:* Reply *Y* to confirm execution or *N* to reject.`
        );
        return;
      }

      // For LOW/MEDIUM risk voice notes or non-APPROVE voice notes, echo transcript first
      if (channel === 'voice_note') {
        await this.provider.sendText(`📝 *Heard:* _${text}_`);
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
        humanInstructions: text,
        channel,
        messageId,
        senderId,
        eventType: `DECISION_${targetState}`,
      });

      if (transitioned && updatedReq) {
        this._resolveWaiters(activeReq.request_id, updatedReq);
      }
      return;
    }

    // Case B: Request is currently in AWAITING_CONFIRMATION (waiting for explicit Y/N after high-risk voice note)
    if (activeReq.state === STATES.AWAITING_CONFIRMATION) {
      if (channel === 'voice_note' && intent === 'APPROVE') {
        this.store.logAudit({
          requestId: activeReq.request_id,
          eventType: 'VOICE_CONFIRMATION_REJECTED_REQUIRES_TEXT',
          messageId,
          senderId,
          fromState: STATES.AWAITING_CONFIRMATION,
          toState: STATES.AWAITING_CONFIRMATION,
          details: { transcript: text },
        });
        await this.provider.sendText(
          '⚠️ *High-Risk Action:* Please send a *text* reply with *Y* to confirm execution or *N* to reject.'
        );
        return;
      }

      const targetState =
        intent === 'APPROVE'
          ? STATES.APPROVED
          : intent === 'REJECT'
            ? STATES.REJECTED
            : STATES.MODIFICATION_REQUESTED;

      const preservedInstructions =
        targetState === STATES.APPROVED
          ? activeReq.human_instructions || text
          : text;

      const { transitioned, request: updatedReq } = this.store.transitionState({
        requestId: activeReq.request_id,
        toState: targetState,
        decision: targetState,
        humanInstructions: preservedInstructions,
        channel: activeReq.channel || channel,
        messageId,
        senderId,
        eventType: `CONFIRMED_${targetState}`,
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

