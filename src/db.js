import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { config } from './config.js';

export const STATES = Object.freeze({
  PENDING: 'PENDING',
  NOTIFIED: 'NOTIFIED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  MODIFICATION_REQUESTED: 'MODIFICATION_REQUESTED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  EXPIRED: 'EXPIRED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
});

export const TERMINAL_STATES = new Set([
  STATES.APPROVED,
  STATES.REJECTED,
  STATES.MODIFICATION_REQUESTED,
  STATES.NEEDS_CLARIFICATION,
  STATES.EXPIRED,
  STATES.DELIVERY_FAILED,
]);

export const ACTIVE_WAITING_STATES = new Set([
  STATES.NOTIFIED,
  STATES.AWAITING_CONFIRMATION,
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.PENDING]: new Set([
    STATES.NOTIFIED,
    STATES.APPROVED,
    STATES.REJECTED,
    STATES.DELIVERY_FAILED,
    STATES.EXPIRED,
  ]),
  [STATES.NOTIFIED]: new Set([
    STATES.APPROVED,
    STATES.REJECTED,
    STATES.MODIFICATION_REQUESTED,
    STATES.NEEDS_CLARIFICATION,
    STATES.AWAITING_CONFIRMATION,
    STATES.EXPIRED,
  ]),
  [STATES.AWAITING_CONFIRMATION]: new Set([
    STATES.APPROVED,
    STATES.REJECTED,
    STATES.MODIFICATION_REQUESTED,
    STATES.EXPIRED,
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
 * Formats a Unix millisecond timestamp as a human-readable `YYYY-MM-DD HH:MM:SS` string in local time.
 */
export function formatTimestamp(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
      kind TEXT NOT NULL DEFAULT 'APPROVAL',
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      command_or_diff TEXT NOT NULL DEFAULT '',
      spoken_prompt TEXT NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'HIGH',
      state TEXT NOT NULL,
      decision TEXT,
      human_instructions TEXT,
      channel TEXT,
      outbound_msg_id TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 600,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_message_id
      ON audit_events(message_id)
      WHERE message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_audit_events_request_id
      ON audit_events(request_id, created_at ASC);

    UPDATE approval_requests
    SET created_at = strftime('%Y-%m-%d %H:%M:%S', created_at / 1000, 'unixepoch', 'localtime'),
        updated_at = strftime('%Y-%m-%d %H:%M:%S', updated_at / 1000, 'unixepoch', 'localtime')
    WHERE typeof(created_at) = 'integer';

    UPDATE audit_events
    SET created_at = strftime('%Y-%m-%d %H:%M:%S', created_at / 1000, 'unixepoch', 'localtime')
    WHERE typeof(created_at) = 'integer';
  `);

  function checkpointWal() {
    if (dbPath !== ':memory:') {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Ignore if another connection holds a read lock
      }
    }
  }

  checkpointWal();

  const insertRequestStmt = db.prepare(`
    INSERT INTO approval_requests (
      request_id, kind, project, summary, command_or_diff, spoken_prompt,
      risk_level, state, timeout_seconds, created_at, updated_at, expires_at
    ) VALUES (
      @request_id, @kind, @project, @summary, @command_or_diff, @spoken_prompt,
      @risk_level, @state, @timeout_seconds, @created_at, @updated_at, @expires_at
    )
  `);

  const getRequestStmt = db.prepare(`
    SELECT * FROM approval_requests WHERE request_id = ?
  `);

  const getActiveRequestStmt = db.prepare(`
    SELECT * FROM approval_requests
    WHERE state IN ('NOTIFIED', 'AWAITING_CONFIRMATION')
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `);

  const updateStateStmt = db.prepare(`
    UPDATE approval_requests
    SET state = @to_state,
        decision = COALESCE(@decision, decision),
        human_instructions = COALESCE(@human_instructions, human_instructions),
        channel = COALESCE(@channel, channel),
        outbound_msg_id = COALESCE(@outbound_msg_id, outbound_msg_id),
        updated_at = @updated_at
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
   * Logs an audit event.
   */
  function logAudit({
    requestId = null,
    eventType,
    messageId = null,
    senderId = null,
    fromState = null,
    toState = null,
    details = null,
  }) {
    const detailsStr =
      details === null || details === undefined
        ? null
        : typeof details === 'string'
          ? details
          : JSON.stringify(details);

    return insertAuditStmt.run({
      request_id: requestId,
      event_type: eventType,
      message_id: messageId,
      sender_id: senderId,
      from_state: fromState,
      to_state: toState,
      details: detailsStr,
      created_at: formatTimestamp(),
    });
  }

  /**
   * Creates a new approval request in PENDING state inside a transaction.
   */
  const createRequest = db.transaction(
    ({
      requestId,
      kind = 'APPROVAL',
      project,
      summary,
      commandOrDiff = '',
      spokenPrompt,
      riskLevel = 'HIGH',
      timeoutSeconds = 600,
    }) => {
      let id = requestId || generateRequestId();
      while (getRequestStmt.get(id)) {
        id = generateRequestId();
      }

      const now = Date.now();
      const nowFormatted = formatTimestamp(now);
      const expiresAt = now + timeoutSeconds * 1000;

      insertRequestStmt.run({
        request_id: id,
        kind,
        project,
        summary,
        command_or_diff: commandOrDiff,
        spoken_prompt: spokenPrompt,
        risk_level: riskLevel,
        state: STATES.PENDING,
        timeout_seconds: timeoutSeconds,
        created_at: nowFormatted,
        updated_at: nowFormatted,
        expires_at: expiresAt,
      });

      logAudit({
        requestId: id,
        eventType: 'REQUEST_CREATED',
        fromState: null,
        toState: STATES.PENDING,
        details: { project, riskLevel, timeoutSeconds, kind },
      });

      return getRequestStmt.get(id);
    }
  );

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
      channel = null,
      outboundMsgId = null,
      messageId = null,
      senderId = null,
      eventType = 'STATE_TRANSITION',
      details = null,
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
        });
        throw new Error(`Invalid state transition for ${requestId}: ${fromState} -> ${toState}`);
      }

      const nowFormatted = formatTimestamp();
      const result = updateStateStmt.run({
        request_id: requestId,
        from_state: fromState,
        to_state: toState,
        decision,
        human_instructions: humanInstructions,
        channel,
        outbound_msg_id: outboundMsgId,
        updated_at: nowFormatted,
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
        details: details || { decision, humanInstructions, channel },
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
   * Checks whether an inbound WhatsApp message ID has already been processed.
   */
  function isMessageProcessed(messageId) {
    if (!messageId) return false;
    return Boolean(checkMessageProcessedStmt.get(messageId));
  }

  return {
    db,
    createRequest: (params) => {
      const res = createRequest(params);
      checkpointWal();
      return res;
    },
    transitionState: (params) => {
      const res = transitionState(params);
      checkpointWal();
      return res;
    },
    logAudit: (params) => {
      const res = logAudit(params);
      checkpointWal();
      return res;
    },
    isMessageProcessed,
    getRequest: (id) => getRequestStmt.get(id),
    getActiveRequest: () => getActiveRequestStmt.get(),
    getAuditEventsForRequest: (id) => getAuditEventsForRequestStmt.all(id),
    getAllAuditEvents: () => getAllAuditEventsStmt.all(),
    close: () => {
      checkpointWal();
      db.close();
    },
  };
}

