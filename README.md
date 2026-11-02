# Whatsapp MCP Pager

**Fail-Closed WhatsApp Human-in-the-Loop (HITL) MCP Server for AI Coding Agents**

Pause your AI coding agent (Cursor, Claude Code, Windsurf, etc.) and request human authorization, modifications, or clarification via **WhatsApp** (structured text + Opus voice notes + a 60-second wake-up flash call).

> **Fail-Closed Principle:** A missing, late, duplicated, ambiguous, or unconfirmed high-risk voice response is **never** interpreted as approval. Every error, timeout, or ambiguity defaults to rejection, expiration, or an explicit confirmation prompt.

---

## Key Features

- **Formal SQLite State Machine (`better-sqlite3` WAL):** Atomic transitions (`PENDING` → `NOTIFIED` → `AWAITING_CONFIRMATION` → `APPROVED` / `REJECTED` / `MODIFICATION_REQUESTED` / `NEEDS_CLARIFICATION` / `EXPIRED` / `DELIVERY_FAILED`) with strict terminal-state immutability and `audit_events` idempotency.
- **High-Risk Voice Safeguard:** Voice notes on `HIGH` or `CRITICAL` risk actions never execute immediately—the server echoes the Whisper transcript, transitions to `AWAITING_CONFIRMATION`, and requires an explicit `Y` or `N` text confirmation.
- **Automatic Secret Redaction:** Strips `.env` secrets, API keys (`sk-...`, `gsk_...`, `ghp_...`), Bearer tokens, and inline passwords from commands/diffs before storing or sending to WhatsApp.
- **6-Second Wake-Up Ring:** If no reply arrives within 60 seconds (outside optional `QUIET_HOURS`), triggers a 6-second WhatsApp voice call (or Twilio flash call) and hangs up automatically.
- **15-Second MCP Progress Heartbeats:** Keeps IDE clients alive during long human wait times, plus `wait_for_approval` to resume waiting on an existing `request_id` without duplicate messages.

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/<your-username>/whatsapp-hitl-mcp.git
cd whatsapp-hitl-mcp
npm install
```

### 2. Run Automated Tests (No WhatsApp Needed)

Verify the state machine, risk rules, secret redaction, idempotency, and expiration timers using `MockProvider`:

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

Add to `.cursor/mcp.json` or `claude_desktop_config.json`:

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

### 1. `request_approval`
Request formal human approval before executing a command, migration, or code change.
- **Arguments:**
  - `project` (`string`): Project name (e.g., `"inventory-service"`).
  - `summary` (`string`): What the agent finished and why approval is needed.
  - `command_or_diff` (`string`): Command, SQL migration, or diff (secrets are auto-redacted).
  - `spoken_prompt` (`string`): 1–2 sentence spoken summary for the Opus voice note.
  - `risk_level` (`"LOW" | "MEDIUM" | "HIGH" | "CRITICAL"`): Risk level.
  - `timeout_seconds` (`number`, default `600`): Deadline before failing closed as `EXPIRED`.
- **Returns:** `{ request_id, final_state, decision, human_instructions, channel }`

### 2. `wait_for_approval`
Resume waiting on an existing `request_id` without sending duplicate WhatsApp messages if the IDE client timed out early.
- **Arguments:** `request_id` (`string`, e.g. `"AP-82F4"`)

### 3. `request_human_input`
Ask an open-ended question via WhatsApp text + voice note and wait for the human's answer.
- **Arguments:** `project` (`string`), `question` (`string`), `spoken_prompt` (`string`)