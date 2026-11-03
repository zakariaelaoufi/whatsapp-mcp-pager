import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config, redactSecrets } from './config.js';
import { createDatabase, STATES } from './db.js';
import { ApprovalEngine } from './engine.js';
import { WhatsAppWebProvider } from './providers/whatsapp.js';

// Strict MCP stdio safety: redirect any accidental console.log from third-party libraries to stderr
console.log = (...args) => {
  console.error(...args);
};

const store = createDatabase(config.dbPath);
const provider = new WhatsAppWebProvider();
const engine = new ApprovalEngine({
  store,
  provider,
  escalationTimeoutMs: config.escalationTimeoutMs,
  staleReplyCooldownMs: config.staleReplyCooldownMs,
  countdownMs: config.countdownMs,
  quietHours: config.quietHours,
  reconcileOnInit: true, // Section 5.1: Mark orphaned active requests as EXPIRED_ON_SERVER_RESTART
});

const server = new McpServer({
  name: 'whatsapp-mcp-pager',
  version: '2.1.0',
});

/**
 * Helper to create a 15-second MCP progress notification emitter for long-running HITL waits.
 */
function createProgressHeartbeatHandler(extra, totalSeconds = 600) {
  return async ({ requestId, state, elapsedSeconds }) => {
    console.error(`[MCP Heartbeat] Waiting on [${requestId}] (state=${state}, elapsed=${elapsedSeconds}s)`);
    const progressToken = extra?._meta?.progressToken;
    if (progressToken !== undefined && typeof extra?.sendNotification === 'function') {
      try {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: elapsedSeconds,
            total: totalSeconds,
            message: `Waiting for WhatsApp response on [${requestId}] (${state}, ${elapsedSeconds}s elapsed)...`,
          },
        });
      } catch (err) {
        console.error('[MCP Heartbeat] Progress notification error:', err.message);
      }
    }
  };
}

// 1. Tool: request_approval
server.tool(
  'request_approval',
  'Pause execution and request fail-closed human authorization via WhatsApp (formatted text + Opus voice note + 60s wake-up ring). Automatically redacts secrets, enforces server-side risk floor, and requires text confirmation for high-risk voice approvals.',
  {
    project: z.string().describe('Project or repository name (e.g., "inventory-service")'),
    summary: z.string().describe('Concise summary of what was completed and what needs approval'),
    command_or_diff: z
      .string()
      .describe('Exact bash command, SQL migration, or code diff awaiting authorization'),
    spoken_prompt: z
      .string()
      .describe('Conversational 1-2 sentence summary spoken aloud in the WhatsApp voice note'),
    risk_level: z
      .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
      .default('HIGH')
      .describe('Requested risk level (server enforces MAX(agent_requested_risk, server_derived_risk))'),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .default(600)
      .describe('Expiration deadline in seconds before failing closed as EXPIRED (default: 600)'),
  },
  async (
    {
      project,
      summary,
      command_or_diff,
      spoken_prompt,
      risk_level = 'HIGH',
      timeout_seconds = 600,
    },
    extra
  ) => {
    try {
      const result = await engine.requestApproval({
        project,
        summary,
        commandOrDiff: command_or_diff,
        spokenPrompt: spoken_prompt,
        riskLevel: risk_level,
        timeoutSeconds: timeout_seconds,
        signal: extra?.signal,
        onHeartbeat: createProgressHeartbeatHandler(extra, timeout_seconds),
      });

      const isBusy = result?.code === 'BUSY_ACTIVE_REQUEST';
      return {
        isError: isBusy,
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const safeErr = redactSecrets(err?.message || String(err));
      console.error('[MCP Tool Error] request_approval failed:', safeErr);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                request_id: null,
                final_state: STATES.DELIVERY_FAILED,
                decision: STATES.DELIVERY_FAILED,
                human_instructions: `Fail-Closed error: ${safeErr}`,
                channel: 'none',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// 2. Tool: wait_for_approval
server.tool(
  'wait_for_approval',
  'Resume waiting on an existing active approval request_id without sending duplicate WhatsApp messages.',
  {
    request_id: z.string().describe('The short request ID (e.g., "AP-82F4") to resume waiting on'),
  },
  async ({ request_id }, extra) => {
    try {
      const existing = store.getRequest(request_id);
      const totalSeconds = existing?.timeout_seconds || 600;
      const result = await engine.waitForApproval(request_id, {
        signal: extra?.signal,
        onHeartbeat: createProgressHeartbeatHandler(extra, totalSeconds),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const safeErr = redactSecrets(err?.message || String(err));
      console.error('[MCP Tool Error] wait_for_approval failed:', safeErr);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                request_id,
                final_state: STATES.EXPIRED,
                decision: STATES.EXPIRED,
                human_instructions: `Fail-Closed error: ${safeErr}`,
                channel: 'none',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// 3. Tool: cancel_approval
server.tool(
  'cancel_approval',
  'Explicitly cancel an active approval request_id, clear its timers, and notify the human on WhatsApp that no reply is needed.',
  {
    request_id: z.string().describe('The short request ID (e.g., "AP-82F4") to cancel'),
    reason: z
      .string()
      .default('Cancelled by coding agent')
      .describe('Reason for cancelling the request'),
  },
  async ({ request_id, reason = 'Cancelled by coding agent' }) => {
    try {
      const result = await engine.cancelRequest(request_id, reason);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const safeErr = redactSecrets(err?.message || String(err));
      console.error('[MCP Tool Error] cancel_approval failed:', safeErr);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: safeErr, request_id }, null, 2),
          },
        ],
      };
    }
  }
);

// 4. Tool: get_approval_status
server.tool(
  'get_approval_status',
  'Return the current persisted state and decision details of an approval request_id without blocking.',
  {
    request_id: z.string().describe('The short request ID (e.g., "AP-82F4") to inspect'),
  },
  async ({ request_id }) => {
    try {
      const result = engine.getApprovalStatus(request_id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const safeErr = redactSecrets(err?.message || String(err));
      console.error('[MCP Tool Error] get_approval_status failed:', safeErr);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: safeErr, request_id }, null, 2),
          },
        ],
      };
    }
  }
);

// 5. Tool: request_human_input
server.tool(
  'request_human_input',
  'Ask the human developer an open-ended question on WhatsApp via text + Opus voice note and wait for their text or transcribed voice response.',
  {
    project: z.string().describe('Project or repository name'),
    question: z.string().describe('Open-ended question or clarification needed from the human'),
    spoken_prompt: z
      .string()
      .describe('Conversational 1-2 sentence question spoken aloud in the WhatsApp voice note'),
  },
  async ({ project, question, spoken_prompt }, extra) => {
    try {
      const result = await engine.requestHumanInput({
        project,
        question,
        spokenPrompt: spoken_prompt,
        timeoutSeconds: 600,
        signal: extra?.signal,
        onHeartbeat: createProgressHeartbeatHandler(extra, 600),
      });

      const isBusy = result?.code === 'BUSY_ACTIVE_REQUEST';
      return {
        isError: isBusy,
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const safeErr = redactSecrets(err?.message || String(err));
      console.error('[MCP Tool Error] request_human_input failed:', safeErr);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                request_id: null,
                final_state: STATES.DELIVERY_FAILED,
                decision: STATES.DELIVERY_FAILED,
                human_instructions: `Fail-Closed error: ${safeErr}`,
                channel: 'none',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// Graceful shutdown on SIGINT / SIGTERM: cancel any active request before exiting
let shuttingDown = false;
async function handleShutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[MCP] Received ${signalName}, cancelling active requests and shutting down...`);
  try {
    const activeRows = store.getAllActiveRequests();
    for (const row of activeRows) {
      await engine.cancelRequest(row.request_id, `Server received ${signalName}`);
    }
    await engine.destroy();
    store.close();
  } catch (err) {
    console.error('[MCP] Shutdown cleanup error:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Fail-Closed WhatsApp HITL MCP Server (whatsapp-mcp-pager) running on stdio.');
}

main().catch((err) => {
  console.error('[MCP Fatal Error]:', err);
  process.exit(1);
});
