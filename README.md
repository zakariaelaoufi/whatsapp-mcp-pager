# whatsapp-mcp-pager

**Walk away from your desk. Control your AI coding agent from WhatsApp.**

`whatsapp-mcp-pager` is a Human-in-the-Loop (HITL) MCP server for AI coding agents (Antigravity, Cursor, Claude Code, Windsurf).

When your agent wants to run a risky command or needs your input, it pauses and pings you on WhatsApp. You can reply with a quick text (`Y` / `N`) or send a **voice note** while on the go.

---

## How It Works

1. **Agent Pauses:** Your AI hits a risky task (e.g., database migration, deploy, `rm -rf`) or has a question.
2. **WhatsApp Ping:** It sends you a formatted text message + a spoken **voice note** explaining what it needs.
3. **Wake-Up Ring:** If you don't reply within 60 seconds, it rings your WhatsApp for **6 seconds** to grab your attention.
4. **You Decide:** Reply with text (`Y`, `N`, or new instructions) or record a **voice note**. Your agent transcribes it and continues.

---

## Prerequisites

You need **two WhatsApp accounts (two phone numbers)**:

1. **Agent Number (Bot):** A spare phone number or secondary WhatsApp account. You will link this account via QR code (`npm run login`). The AI uses this number to message and call you.
2. **Your Personal Number:** Your main WhatsApp on your phone (`MY_WHATSAPP_ID`). This is where you receive alerts and reply to your agent.

> **Why two numbers?** WhatsApp does not let an account place a voice call to itself. Using a dedicated number for the agent lets it ring your phone and keeps the chat thread clean.

You also need:
- **Node.js 20+**
- **OpenAI API Key** (for voice notes and Whisper transcription)
- **Groq API Key** *(optional, for faster Whisper transcription)*

---

## Safety First (Fail-Closed)

- **Never Assumes Yes:** Timeouts, errors, or unclear replies always block execution.
- **High-Risk Voice Check:** Voice notes on `HIGH` or `CRITICAL` actions never run immediately. The bot replies with what it heard and asks for a `Y` text to confirm.
- **Auto Risk Upgrade:** Even if the agent labels `rm -rf` or `DROP TABLE` as `LOW` risk, the server upgrades it to `CRITICAL`.
- **Secret Redaction:** API keys, tokens, and database passwords are automatically scrubbed before leaving your machine.

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/zakariaelaoufi/whatsapp-mcp-pager.git
cd whatsapp-mcp-pager
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` with your details:

```ini
# Your personal WhatsApp number (international format, no '+' or spaces, ending in @c.us)
MY_WHATSAPP_ID=14155552671@c.us

# Required: OpenAI API Key (for Opus voice notes & Whisper STT)
OPENAI_API_KEY=sk-proj-...

# Optional: Groq API Key (for faster STT transcription)
GROQ_API_KEY=

# Wake-up mode: "puppeteer" (WhatsApp Web 6s call) or "twilio" (cellular 6s call)
WAKEUP_MODE=puppeteer

# Ring my phone if I don't reply within 60 seconds (60000 ms)
ESCALATION_TIMEOUT_MS=60000

# Optional: Disable wake-up calls during sleep hours (24h format, e.g. 23:00-07:00)
QUIET_HOURS=

# Optional: Pre-notification countdown in seconds (default: 0)
REMINDER_COUNTER=0

# Optional: Stale-reply cooldown in ms (default: 30000)
STALE_REPLY_COOLDOWN_MS=30000

# Optional: SQLite database path (default: ./.hitl.sqlite)
DB_PATH=./.hitl.sqlite

# Optional: Only needed if WAKEUP_MODE=twilio
MY_PHONE_E164=+14155552671
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

### 3. Link the Agent's WhatsApp (One-Time QR Scan)

```bash
npm run login
```

Open WhatsApp on the **Agent's phone account** → **Linked Devices** → **Link a Device**, and scan the QR code in your terminal.

### 4. Test the Flow

Run the live test to receive a real message, voice note, and wake-up call on your main phone:

```bash
npm run test-pager
```

Run the offline unit test suite anytime with:

```bash
npm test
```

---

## Connect to Your AI IDE (MCP)

Add this to your MCP config (`~/.gemini/config/mcp_config.json` for Antigravity, `.cursor/mcp.json` for Cursor, or `claude_desktop_config.json`):

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

## Available MCP Tools

- **`request_approval`** (`project`, `summary`, `command_or_diff`, `spoken_prompt`, `risk_level`, `timeout_seconds`) — Pauses the agent, sends text + voice note, and waits for your decision.
- **`request_human_input`** (`project`, `question`, `spoken_prompt`) — Asks you an open-ended question on WhatsApp and returns your reply.
- **`wait_for_approval`** (`request_id`) — Resumes waiting on an active request without sending duplicate alerts.
- **`cancel_approval`** (`request_id`, `reason`) — Cancels an active request and lets you know on WhatsApp.
- **`get_approval_status`** (`request_id`) — Checks the current status of a request without blocking.
