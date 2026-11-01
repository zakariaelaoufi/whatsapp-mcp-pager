# whatsapp-mcp-pager

**WhatsApp Walkie-Talkie + 6-Second Wake-Up Ring MCP Server for AI Coding Agents**

Pause your AI coding agent (Cursor, Claude Code, Windsurf, etc.), get a **WhatsApp message + spoken voice note** on your phone, and reply from anywhere via **text or voice note**. If you don't reply within 60 seconds, the server rings your phone for **6 seconds** and hangs up automatically to wake your pocket up.

---

## Features

- **Text + Native Voice Note (PTT):** Sends the context and proposed command/diff in Markdown along with an Opus-encoded WhatsApp voice note explaining the blocker aloud.
- **2-Way Walkie-Talkie:** Reply with a quick **text message** or hold the mic to send a **voice note** (automatically transcribed via OpenAI Whisper or Groq Whisper).
- **6-Second Wake-Up Ring:** If no reply arrives within `60s`, triggers a 6-second WhatsApp voice call (or Twilio cellular flash call) and hangs up automatically.

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/<your-username>/whatsapp-mcp-pager.git
cd whatsapp-mcp-pager
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in `.env`:

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
```

### 3. Link WhatsApp (One-Time QR Scan)

Run the standalone login script and scan the terminal QR code from WhatsApp (**Linked Devices → Link a Device**):

```bash
npm run login
```

Your session is saved locally in `.wwebjs_auth/` and the script exits cleanly.

### 4. Test the Flow

```bash
npm run test-pager
```

- Check your WhatsApp for the formatted prompt and voice note.
- Wait 60 seconds to test the **6-second wake-up ring**, or reply immediately via **text** or **voice note**.

---

## MCP Configuration

Add `whatsapp-mcp-pager` to your MCP client config (e.g. `.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatsapp-pager": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp-pager/src/index.js"]
    }
  }
}
```

### Agent System Rule / Prompt

Add this instruction to your agent rules or prompt:

> *"Whenever you need human approval before running a destructive command, applying a migration, or resolving an architectural question, call `ask_human_on_whatsapp` and follow the returned instructions."*

---

## MCP Tool Reference

### `ask_human_on_whatsapp`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `summary` | `string` | What the agent just finished and why it needs input. |
| `command_or_diff` | `string` | The exact bash command, migration, or code diff awaiting approval. |
| `spoken_prompt` | `string` | Conversational 1–2 sentence summary spoken aloud in the WhatsApp voice note. |

**Returns:**
```json
{
  "channel": "voice_note",
  "human_response": "Yes, go ahead and run the migration."
}
```
