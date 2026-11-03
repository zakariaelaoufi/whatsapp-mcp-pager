# whatsapp-mcp-pager

**Hardened Fail-Closed WhatsApp Human-in-the-Loop (HITL) MCP Server for AI Coding Agents**

Pause your AI coding agent (Antigravity, Cursor, Claude Code, Windsurf, etc.) and request human authorization, modifications, or clarification via **WhatsApp** (structured text + Opus voice notes + a 60-second wake-up flash call).

> **Fail-Closed Principle:** A missing, late, duplicated, ambiguous, or unconfirmed high-risk voice response is **never** interpreted as approval. Every error, timeout, or ambiguity defaults to rejection, expiration, or an explicit confirmation prompt.

---

## Key Features

- **Formal SQLite State Machine (`better-sqlite3` WAL):** Atomic transitions (`PENDING` → `NOTIFIED` → `AWAITING_CONFIRMATION` → `APPROVED` | `REJECTED` | `MODIFICATION_REQUESTED` | `NEEDS_CLARIFICATION` | `EXPIRED` | `CANCELLED` | `DELIVERY_FAILED`) with strict terminal-state immutability and `audit_events` idempotency.
- **Single-Active-Request Lock & 30s Stale-Reply Cooldown:** Rejects concurrent duplicate requests with `BUSY_ACTIVE_REQUEST` and blocks unquoted delayed replies for 30 seconds after a previous request expires or is cancelled unless correlated via swipe-to-reply or explicit `AP-XXXX` ID.
- **Server-Side Risk Escalation (`src/policy.js`):** Automatically upgrades under-reported risk levels (`MAX(agent_requested_risk, server_derived_risk)`) to `CRITICAL` for destructive commands (`rm -rf`, `DROP TABLE`, `git push --force`) and at least `HIGH` for migrations, publishing, or system changes.
- **High-Risk Voice Safeguard:** Voice notes on `HIGH` or `CRITICAL` risk actions never execute immediately—the server echoes the Whisper transcript, transitions to `AWAITING_CONFIRMATION`, and requires an explicit `Y` or `N` text confirmation.
- **End-to-End Secret Redaction (`src/redact.js`):** Scrubs `.env` secrets, API keys (`sk-...`, `gsk_...`, `ghp_...`, `AKIA...`), Bearer tokens, PEM private keys, and DB connection passwords from WhatsApp messages, TTS `spoken_prompt`, and SQLite audit logs.
- **Startup Recovery & Central Cancellation:** Automatically expires orphaned requests on server restart (`EXPIRED_ON_SERVER_RESTART`) and cancels active requests on MCP `AbortSignal` or `SIGINT`/`SIGTERM`.

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/<your-username>/whatsapp-mcp-pager.git
cd whatsapp-mcp-pager
npm install
```

### 2. Run Automated Tests (10 Deterministic Specs)

```bash
npm test
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

```ini
# Your WhatsApp number in international format (no '+' or spaces), ending in @c.us
MY_WHATSAPP_ID=14155552671@c.us

# Required: OpenAI API Key (for Opus TTS voice notes & Whisper STT)
OPENAI_API_KEY=sk-proj-...

# Optional: Groq API Key (uses whisper-large-v3-turbo for faster STT if set)
GROQ_API_KEY=

# "puppeteer" (WhatsApp Web 6s voice call) or "twilio" (cellular 6s flash call)
WAKEUP_MODE=puppeteer

# Escalation timeout before triggering the 6s wake-up ring (default: 60000 = 60s)
ESCALATION_TIMEOUT_MS=60000

# Optional: Quiet hours in HH:MM-HH:MM 24h local format (suppresses wake-up ring, e.g. 23:00-07:00)
QUIET_HOURS=
```

### 4. Link WhatsApp (One-Time QR Scan)

```bash
npm run login
```

Scan the QR code in your terminal from WhatsApp (**Linked Devices → Link a Device**). Session state is saved to `.wwebjs_auth/`.

### 5. Test Live WhatsApp Flow

```bash
npm run test-pager
```

---

## MCP Configuration

Add to `~/.gemini/config/mcp_config.json` (Antigravity), `.cursor/mcp.json`, or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp-hitl": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp-pager/src/index.js"]
    }
  }
}
```

---

## Exposed MCP Tools

1. **`request_approval`** — Creates the request, enforces the server-side risk floor, sends the WhatsApp text + Opus voice note (falling back to text-only if TTS fails), and waits for a terminal decision while emitting 15s MCP progress heartbeats.
2. **`wait_for_approval`** — Resumes waiting on an existing active `request_id` without sending duplicate messages.
3. **`cancel_approval`** — Explicitly cancels an active `request_id`, clears timers, and notifies the user on WhatsApp.
4. **`get_approval_status`** — Returns the current persisted state and decision of `request_id` without blocking.
5. **`request_human_input`** — Asks an open-ended question via WhatsApp text + voice note and returns the user's answer.