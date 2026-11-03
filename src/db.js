import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { config } from './config.js';
import { redactAuditDetails, redactSecrets } from './redact.js';

export const STATES = Object.freeze({
  PENDING: 'PENDING',
  NOTIFIED: 'NOTIFIED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  MODIFICATION_REQUESTED: 'MODIFICATION_REQUESTED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
});

export const ACTIVE_STATES = new Set([
  STATES.PENDING,
  STATES.NOTIFIED,
  STATES.AWAITING_CONFIRMATION,
]);

export const ACTIVE_WAITING_STATES = new Set([
  STATES.NOTIFIED,
  STATES.AWAITING_CONFIRMATION,
]);

export const TERMINAL_STATES = new Set([
  STATES.APPROVED,
  STATES.REJECTED,
  STATES.MODIFICATION_REQUESTED,
  STATES.NEEDS_CLARIFICATION,
  STATES.EXPIRED,
  STATES.CANCELLED,
  STATES.DELIVERY_FAILED,
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.PENDING]: new Set([
    STATES.NOTIFIED,
    STATES.DELIVERY_FAILED,
    STATES.EXPIRED,
    STATES.CANCELLED,
  ]),
  [STATES.NOTIFIED]: new Set([
    STATES.APPROVED,
    STATES.REJECTED,
    STATES.MODIFICATION_REQUESTED,
    STATES.NEEDS_CLARIFICATION,
    STATES.AWAITING_CONFIRMATION,
    STATES.EXPIRED,
    STATES.CANCELLED,
  ]),
  [STATES.AWAITING_CONFIRMATION]: new Set([
    STATES.APPROVED,
    STATES.REJECTED,
    STATES.MODIFICATION_REQUESTED,
    STATES.NEEDS_CLARIFICATION,
    STATES.EXPIRED,
    STATES.CANCELLED,
  ]),
});

/**
 * Generates a short human-readable request ID like `AP-82F4`.
 */
export function generateRequestId() {
  const hex = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `AP-${hex}`;
}

/**
 * Creates and initializes a SQLite persistence store (WAL mode) for HITL requests and audit events.
 *
 * @param {string} [dbPath] Path to SQLite file, or ':memory:' for deterministic tests
 */
export function createDatabase(dbPath = config.dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      request_id TEXT PRIMARY KEY,
      internal_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'APPROVAL',
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      command_or_diff TEXT NOT NULL DEFAULT '',
      spoken_prompt TEXT NOT NULL,
      agent_risk_level TEXT NOT NULL DEFAULT 'HIGH',
      risk_level TEXT NOT NULL DEFAULT 'HIGH',
      state TEXT NOT NULL,
      decision TEXT,
      human_instructions TEXT,
      pending_transcript TEXT,
      channel TEXT,
      outbound_msg_id TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 600,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_state
      ON approval_requests(state, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      event_type TEXT NOT NULL,
      message_id TEXT,
      sender_id TEXT,
      from_state TEXT,
      to_state TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_message_id
      ON audit_events(message_id)
      WHERE message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_audit_events_request_id
      ON audit_events(request_id, created_at ASC);
  `);

  // Safe schema migration for existing SQLite databases created by earlier versions
  const existingCols = new Set(
    db
      .prepare(`PRAGMA table_info(approval_requests)`)
      .all()
      .map((c) => c.name)
  );
  if (!existingCols.has('internal_id')) {
    db.exec(`ALTER TABLE approval_requests ADD COLUMN internal_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!existingCols.has('agent_risk_level')) {
    db.exec(`ALTER TABLE approval_requests ADD COLUMN agent_risk_level TEXT NOT NULL DEFAULT 'HIGH'`);
  }
  if (!existingCols.has('pending_transcript')) {
    db.exec(`ALTER TABLE approval_requests ADD COLUMN pending_transcript TEXT`);
  }
  if (!existingCols.has('closed_at')) {
    db.exec(`ALTER TABLE approval_requests ADD COLUMN closed_at INTEGER`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_approval_requests_outbound_msg_id
      ON approval_requests(outbound_msg_id)
      WHERE outbound_msg_id IS NOT NULL;
  `);

  const insertRequestStmt = db.prepare(`
    INSERT INTO approval_requests (
      request_id, internal_id, kind, project, summary, command_or_diff, spoken_prompt,
      agent_risk_level, risk_level, state, timeout_seconds, created_at, updated_at, expires_at
    ) VALUES (
      @request_id, @internal_id, @kind, @project, @summary, @command_or_diff, @spoken_prompt,
      @agent_risk_level, @risk_level, @state, @timeout_seconds, @created_at, @updated_at, @expires_at
    )
  `);

  const getRequestStmt = db.prepare(`
    SELECT * FROM approval_requests WHERE request_id = ?
  `);

  const getRequestByOutboundMsgIdStmt = db.prepare(`
    SELECT * FROM approval_requests WHERE outbound_msg_id = ? LIMIT 1
  `);

  const getActiveWaitingRequestStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('NOTIFIED', 'AWAITING_CONFIRMATION')
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const getAnyActiveRequestStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('PENDING', 'NOTIFIED', 'AWAITING_CONFIRMATION')
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const getAllActiveRequestsStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('PENDING', 'NOTIFIED', 'AWAITING_CONFIRMATION')
    ORDER BY created_at ASC
  `);

  const getExpiredActiveRequestsStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('PENDING', 'NOTIFIED', 'AWAITING_CONFIRMATION')
      AND expires_at <= ?
    ORDER BY created_at ASC
  `);

  const getRecentExpiredOrCancelledStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('EXPIRED', 'CANCELLED')
      AND closed_at IS NOT NULL
    ORDER BY closed_at DESC
    LIMIT 1
  `);

  const updateStateStmt = db.prepare(`
    UPDATE approval_requests
    SET state = @to_state,
        decision = COALESCE(@decision, decision),
        human_instructions = COALESCE(@human_instructions, human_instructions),
        pending_transcript = COALESCE(@pending_transcript, pending_transcript),
        channel = COALESCE(@channel, channel),
        outbound_msg_id = COALESCE(@outbound_msg_id, outbound_msg_id),
        updated_at = @updated_at,
        closed_at = COALESCE(@closed_at, closed_at)
    WHERE request_id = @request_id AND state = @from_state
  `);

  const insertAuditStmt = db.prepare(`
    INSERT INTO audit_events (
      request_id, event_type, message_id, sender_id, from_state, to_state, details, created_at
    ) VALUES (
      @request_id, @event_type, @message_id, @sender_id, @from_state, @to_state, @details, @created_at
    )
  `);

  const checkMessageProcessedStmt = db.prepare(`
    SELECT id, event_type, request_id FROM audit_events WHERE message_id = ? LIMIT 1
  `);

  const getAuditEventsForRequestStmt = db.prepare(`
    SELECT * FROM audit_events WHERE request_id = ? ORDER BY id ASC
  `);

  const getAllAuditEventsStmt = db.prepare(`
    SELECT * FROM audit_events ORDER BY id ASC
  `);

  /**
   * Logs an audit event with automatic end-to-end secret redaction.
   */
  function logAudit({
    requestId = null,
    eventType,
    messageId = null,
    senderId = null,
    fromState = null,
    toState = null,
    details = null,
    now = Date.now(),
  }) {
    const safeDetails = redactAuditDetails(details);
    const detailsStr =
      safeDetails === null || safeDetails === undefined
        ? null
        : typeof safeDetails === 'string'
          ? safeDetails
          : JSON.stringify(safeDetails);

    return insertAuditStmt.run({
      request_id: requestId,
      event_type: eventType,
      message_id: messageId,
      sender_id: senderId,
      from_state: fromState,
      to_state: toState,
      details: detailsStr,
      created_at: now,
    });
  }

  /**
   * Atomically transitions a request from its current state to `toState`,
   * strictly enforcing `ALLOWED_TRANSITIONS` and the Terminal State Immutability Rule.
   */
  const transitionState = db.transaction(
    ({
      requestId,
      toState,
      decision = null,
      humanInstructions = null,
      pendingTranscript = null,
      channel = null,
      outboundMsgId = null,
      messageId = null,
      senderId = null,
      eventType = 'STATE_TRANSITION',
      details = null,
      now = Date.now(),
    }) => {
      const current = getRequestStmt.get(requestId);
      if (!current) {
        throw new Error(`Approval request "${requestId}" not found.`);
      }

      const fromState = current.state;

      // Immutability Rule: Terminal states can NEVER transition again
      if (TERMINAL_STATES.has(fromState)) {
        logAudit({
          requestId,
          eventType: 'IMMUTABILITY_REJECTED_TRANSITION',
          senderId,
          fromState,
          toState,
          details: { reason: `Request ${requestId} is already in terminal state ${fromState}` },
          now,
        });
        return { transitioned: false, reason: 'ALREADY_TERMINAL', request: current };
      }

      const allowedTargets = ALLOWED_TRANSITIONS[fromState];
      if (!allowedTargets || !allowedTargets.has(toState)) {
        logAudit({
          requestId,
          eventType: 'INVALID_STATE_TRANSITION',
          senderId,
          fromState,
          toState,
          details: { reason: `Disallowed transition from ${fromState} to ${toState}` },
          now,
        });
        throw new Error(`Invalid state transition for ${requestId}: ${fromState} -> ${toState}`);
      }

      const isTerminalTarget = TERMINAL_STATES.has(toState);
      const safeHumanInstructions =
        humanInstructions !== null && humanInstructions !== undefined
          ? redactSecrets(humanInstructions)
          : null;
      const safePendingTranscript =
        pendingTranscript !== null && pendingTranscript !== undefined
          ? redactSecrets(pendingTranscript)
          : null;

      const result = updateStateStmt.run({
        request_id: requestId,
        from_state: fromState,
        to_state: toState,
        decision,
        human_instructions: safeHumanInstructions,
        pending_transcript: safePendingTranscript,
        channel,
        outbound_msg_id: outboundMsgId,
        updated_at: now,
        closed_at: isTerminalTarget ? now : null,
      });

      if (result.changes !== 1) {
        return {
          transitioned: false,
          reason: 'CONCURRENT_MODIFICATION',
          request: getRequestStmt.get(requestId),
        };
      }

      logAudit({
        requestId,
        eventType,
        messageId,
        senderId,
        fromState,
        toState,
        details: details || {
          decision,
          humanInstructions: safeHumanInstructions,
          pendingTranscript: safePendingTranscript,
          channel,
        },
        now,
      });

      return {
        transitioned: true,
        fromState,
        toState,
        request: getRequestStmt.get(requestId),
      };
    }
  );

  /**
   * Immediately sweeps and transitions any active requests whose `expires_at <= now` to `EXPIRED`.
   */
  const sweepExpiredRequests = db.transaction((now = Date.now()) => {
    const expiredRows = getExpiredActiveRequestsStmt.all(now);
    const transitioned = [];
    for (const row of expiredRows) {
      const res = transitionState({
        requestId: row.request_id,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Request timed out without human decision (Fail-Closed).',
        eventType: 'REQUEST_EXPIRED',
        now,
      });
      if (res.transitioned) {
        transitioned.push(res.request);
      }
    }
    return transitioned;
  });

  /**
   * Section 5.1: On server start, query all rows in PENDING, NOTIFIED, or AWAITING_CONFIRMATION
   * and transition them to EXPIRED with audit reason "EXPIRED_ON_SERVER_RESTART".
   */
  const reconcileOnStartup = db.transaction((now = Date.now()) => {
    const orphanedRows = getAllActiveRequestsStmt.all();
    const reconciled = [];
    for (const row of orphanedRows) {
      const res = transitionState({
        requestId: row.request_id,
        toState: STATES.EXPIRED,
        decision: STATES.EXPIRED,
        humanInstructions: 'Expired on server restart (EXPIRED_ON_SERVER_RESTART).',
        eventType: 'EXPIRED_ON_SERVER_RESTART',
        details: { reason: 'EXPIRED_ON_SERVER_RESTART', previousState: row.state },
        now,
      });
      if (res.transitioned) {
        reconciled.push(res.request);
      }
    }
    return reconciled;
  });

  /**
   * Creates a new approval request in PENDING state inside a transaction.
   * Generates both `internal_id` (UUID v4) and short reference (`AP-XXXX`).
   */
  const createRequest = db.transaction(
    ({
      requestId,
      internalId,
      kind = 'APPROVAL',
      project,
      summary,
      commandOrDiff = '',
      spokenPrompt,
      agentRiskLevel = 'HIGH',
      riskLevel = 'HIGH',
      timeoutSeconds = 600,
      now = Date.now(),
    }) => {
      let id = requestId ? String(requestId).toUpperCase() : generateRequestId();
      while (getRequestStmt.get(id)) {
        id = generateRequestId();
      }

      const uuid = internalId || crypto.randomUUID();
      const expiresAt = now + timeoutSeconds * 1000;

      const safeSummary = redactSecrets(summary);
      const safeCommandOrDiff = redactSecrets(commandOrDiff);
      const safeSpokenPrompt = redactSecrets(spokenPrompt);

      insertRequestStmt.run({
        request_id: id,
        internal_id: uuid,
        kind,
        project: redactSecrets(project),
        summary: safeSummary,
        command_or_diff: safeCommandOrDiff,
        spoken_prompt: safeSpokenPrompt,
        agent_risk_level: agentRiskLevel,
        risk_level: riskLevel,
        state: STATES.PENDING,
        timeout_seconds: timeoutSeconds,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      });

      logAudit({
        requestId: id,
        eventType: 'REQUEST_CREATED',
        fromState: null,
        toState: STATES.PENDING,
        details: {
          internalId: uuid,
          project,
          agentRiskLevel,
          riskLevel,
          timeoutSeconds,
          kind,
        },
        now,
      });

      return getRequestStmt.get(id);
    }
  );

  /**
   * Checks whether an inbound WhatsApp message ID has already been processed.
   */
  function isMessageProcessed(messageId) {
    if (!messageId) return false;
    return Boolean(checkMessageProcessedStmt.get(messageId));
  }

  return {
    db,
    createRequest,
    transitionState,
    sweepExpiredRequests,
    reconcileOnStartup,
    logAudit,
    isMessageProcessed,
    getRequest: (id) => (id ? getRequestStmt.get(String(id).toUpperCase()) : undefined),
    getRequestByOutboundMsgId: (outboundMsgId) =>
      outboundMsgId ? getRequestByOutboundMsgIdStmt.get(outboundMsgId) : undefined,
    getActiveRequest: () => getActiveWaitingRequestStmt.get(),
    getBlockingActiveRequest: (now = Date.now()) => {
      sweepExpiredRequests(now);
      return getAnyActiveRequestStmt.get();
    },
    getAllActiveRequests: () => getAllActiveRequestsStmt.all(),
    getRecentExpiredOrCancelled: () => getRecentExpiredOrCancelledStmt.get(),
    getAuditEventsForRequest: (id) =>
      id ? getAuditEventsForRequestStmt.all(String(id).toUpperCase()) : [],
    getAllAuditEvents: () => getAllAuditEventsStmt.all(),
    close: () => db.close(),
  };
}
