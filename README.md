# WhatsApp MCP PAGER

A **WhatsApp MCP PAGER Server** for AI coding agents (Antigravity, Cursor, Claude Code, Windsurf).

When your agent needs approval for a risky command, database migration, or deployment—and you're away from your screen. it messages you on **WhatsApp** with a formatted summary, an **Opus voice note**, and a **6-second wake-up call** if you don't reply in time.

---

## How It Works

1. **On-Screen Countdown (`REMINDER_COUNTER`):** Waits a configurable countdown (e.g. `60s`) before notifying WhatsApp so your phone doesn't buzz while you're already at your computer.
2. **Text + Voice Note:** Sends the proposed command/diff (with API keys and secrets automatically redacted) plus a spoken summary via OpenAI TTS.
3. **Reply by Text or Voice:**
   - Reply `Y` / `N` by text, or send a **voice note** (transcribed via Whisper) to approve, reject, ask for clarification, or request changes.
   - **High-Risk Safeguard:** Voice approvals on `HIGH` or `CRITICAL` actions require a final `Y` text confirmation before executing.
4. **Wake-Up Ring:** If you don't respond within `ESCALATION_TIMEOUT_MS` (default `60s`), it rings your phone for 6 seconds to get your attention.
5. **SQLite Audit Log:** Every request and state transition is logged in `.hitl.sqlite`.

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/<your-username>/whatsapp-hitl-mcp.git
cd whatsapp-hitl-mcp
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

```ini
# Your WhatsApp number in international format (no '+' or spaces), ending in @c.us
MY_WHATSAPP_ID=14155552671@c.us

# OpenAI API Key (for Opus voice notes & Whisper transcription)
OPENAI_API_KEY=sk-proj-...

# Optional: Groq API Key (faster Whisper transcription if set)
GROQ_API_KEY=

# Countdown in seconds before sending a WhatsApp reminder (0 = immediate)
REMINDER_COUNTER=60

# Time in ms before triggering the 6-second wake-up ring (default: 60000 = 60s)
ESCALATION_TIMEOUT_MS=60000

# "puppeteer" (WhatsApp Web call) or "twilio" (cellular flash call)
WAKEUP_MODE=puppeteer

# Optional: Suppress wake-up calls during sleep hours (24h format, e.g. 23:00-07:00)
QUIET_HOURS=
```

### 3. Link WhatsApp (One-Time)

```bash
npm run login
```

Scan the QR code in your terminal using WhatsApp (**Linked Devices → Link a Device**). Your session is saved locally in `.wwebjs_auth/`.

### 4. Add to Your MCP Client

Add this to your IDE's `mcp_config.json` / `.cursor/mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp-hitl": {
      "command": "node",
      "args": ["/absolute/path/to/my-whatsapp-ai-reminder/src/index.js"]
    }
  }
}
```

### 5. Add Agent Rule (Recommended)

Add this rule to your agent's global instructions (`AGENTS.md` / `.cursorrules` / `CLAUDE.md`):

```markdown
# WhatsApp Human-in-the-Loop Rule
- Before running any destructive command, database migration, production deployment, or irreversible change, call the `whatsapp-hitl` MCP tool `request_approval` with the appropriate `risk_level` (`LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`).
- If `final_state` is `MODIFICATION_REQUESTED` or `NEEDS_CLARIFICATION`, follow `human_instructions` and re-request approval before proceeding.
- If `final_state` is `REJECTED`, `EXPIRED`, or `DELIVERY_FAILED`, stop immediately and do not execute the action.
- When blocked on an architectural question while the user is away, call `request_human_input`.
```

---

## MCP Tools

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| `request_approval` | Pause execution and request approval via WhatsApp text + voice note. | `project`, `summary`, `command_or_diff`, `spoken_prompt`, `risk_level`, `timeout_seconds` |
| `wait_for_approval` | Resume waiting on an existing `request_id` without resending messages. | `request_id` (e.g. `AP-82F4`) |
| `request_human_input` | Ask an open-ended question on WhatsApp and wait for a text/voice reply. | `project`, `question`, `spoken_prompt` |

---

## Testing

```bash
# Run offline unit tests (state machine, redaction, countdown, timeouts)
npm test

# Send a live test approval to your WhatsApp
npm run test-pager