# Project Specification: WhatsApp "Walkie-Talkie + Wake-Up Ring" MCP Server

## 1. Objective
Build a local **Model Context Protocol (MCP) server** in Node.js that lets an AI coding agent pause execution and ask the human developer for approval or instructions via **WhatsApp**.

### Core Workflow
1. When the coding agent needs approval (e.g., before running a destructive command, architectural change, or resolving ambiguity), it calls the MCP tool `ask_human_on_whatsapp`.
2. The server sends a formatted text message (containing the task summary and command/diff) plus a synthesized **WhatsApp Voice Note (PTT)** explaining the blocker out loud.
3. The server starts a **60-second timer** while listening for a reply from the human's whitelisted WhatsApp number:
   - If the human replies within 60 seconds (via **text** OR by recording a **voice note**), the timer is canceled. Voice notes are automatically transcribed via Whisper.
   - If 60 seconds pass with no reply, the server sends a reminder message and triggers a **6-second "Ring-and-Hang-Up" (Flash Call / Bipa)** to physically vibrate the human's phone in their pocket without incurring call duration charges, then continues waiting for the WhatsApp reply.
4. Once the human replies, the tool resolves and returns the human's exact instructions back to the coding agent.

---

## 2. Critical Architectural Constraints (MUST FOLLOW)
1. **MCP `stdio` Safety:** MCP servers communicate over `stdout` using JSON-RPC. **NEVER use `console.log()` in any file imported by the MCP server.** Route all operational logs to `console.error()`.
2. **Two-Step WhatsApp Authentication:** Because `qrcode-terminal` prints to `stdout`, do not run initial QR pairing inside the live MCP stdio loop. Create a dedicated `src/login.js` script (`npm run login`) that launches `whatsapp-web.js` with `LocalAuth`, prints the QR code in the terminal, verifies the session is saved to `.wwebjs_auth/`, and exits cleanly.
3. **Native WhatsApp Voice Notes (`sendAudioAsVoice: true`):** WhatsApp Web requires outgoing voice notes to be encoded in `audio/ogg; codecs=opus`. Generate audio in Opus format directly (via OpenAI TTS `response_format: "opus"`) or convert via `ffmpeg` so it renders as a native green waveform voice note on mobile.
4. **WSL / Headless Linux Compatibility:** Configure Puppeteer inside `whatsapp-web.js` with `args: ['--no-sandbox', '--disable-setuid-sandbox']` so headless Chromium launches reliably on both Windows and Linux/WSL environments.

---

## 3. Directory Structure & Dependencies

Initialize an ES Module Node.js project (`"type": "module"` in `package.json`) with the following structure:

```text
whatsapp-agent-pager/
├── .env.example
├── package.json
└── src/
    ├── config.js       # Environment variable validation
    ├── login.js        # Standalone CLI script for one-time WhatsApp QR pairing
    ├── audio.js        # TTS (Opus generation) + STT (Whisper voice note transcription)
    ├── wakeup.js       # 6-second Ring-and-Interrupt (Twilio Flash Call + Puppeteer fallback)
    ├── whatsapp.js     # whatsapp-web.js client singleton & Walkie-Talkie approval loop
    ├── test-flow.js    # Standalone end-to-end test script before wiring into MCP
    └── index.js        # MCP Server entry point (@modelcontextprotocol/sdk)
```

### Required Packages
Run the following installation commands:
```bash
npm init -y
npm pkg set type="module"
npm pkg set scripts.login="node src/login.js"
npm pkg set scripts.test-pager="node src/test-flow.js"
npm pkg set scripts.start="node src/index.js"
npm install @modelcontextprotocol/sdk whatsapp-web.js qrcode-terminal openai twilio dotenv zod
```

---

## 4. Environment Configuration (`.env.example`)

Create `.env.example` (and copy to `.env` if not present):

```ini
# Your personal WhatsApp number in international format WITHOUT '+' or spaces, followed by @c.us
# Example for Morocco (+212 6XX-XXXXXX): 2126XXXXXXXX@c.us
MY_WHATSAPP_ID=2126XXXXXXXX@c.us

# Your personal phone number in E.164 format for the 6-second cellular wake-up ring
MY_PHONE_E164=+2126XXXXXXXX

# OpenAI API Key (Used for Whisper STT transcription and Opus TTS voice notes)
OPENAI_API_KEY=sk-proj-...

# Optional: Groq API Key (If set, use Groq's whisper-large-v3-turbo for ultra-fast free STT)
GROQ_API_KEY=

# Wake-up Call Mode: "puppeteer" (clicks WhatsApp Web call button) or "twilio" (cellular flash call)
WAKEUP_MODE=puppeteer

# Optional: Twilio Credentials (Only needed if WAKEUP_MODE=twilio)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

# Escalation timeout in milliseconds (default: 60000 = 60 seconds)
ESCALATION_TIMEOUT_MS=60000
```

---

## 5. Module Implementation Specs

### A. `src/audio.js` (Opus TTS & Whisper STT)
Implement two exported functions using the `openai` SDK:
1. `generateOpusVoiceNote(spokenText)`:
   - Calls `openai.audio.speech.create({ model: "tts-1", voice: "onyx", input: spokenText, response_format: "opus" })`.
   - Converts the response ArrayBuffer to a base64 string and returns a `whatsapp-web.js` `MessageMedia` instance: `new MessageMedia('audio/ogg; codecs=opus', base64Audio, 'voice.ogg')`.
2. `transcribeVoiceNote(base64OggData)`:
   - Writes the incoming base64 buffer to a temporary `.ogg` file in `os.tmpdir()`.
   - If `process.env.GROQ_API_KEY` is provided, uses the OpenAI client pointed at `https://api.groq.com/openai/v1` with model `whisper-large-v3-turbo`; otherwise uses OpenAI `whisper-1`.
   - Deletes the temp file in a `finally` block and returns the transcribed text string.

### B. `src/wakeup.js` (The 6-Second Ring-and-Interrupt)
Export `async function ringAndInterrupt(whatsappClient, chatId)`:
- **If `WAKEUP_MODE === 'twilio'`:**
  - Uses the `twilio` client to create an outbound call to `MY_PHONE_E164` from `TWILIO_FROM_NUMBER` with inline TwiML `<Response><Pause length="10"/></Response>` and `timeout: 6` (rings for 6 seconds and drops automatically before connecting, costing $0.00).
  - As a double safeguard, wrap a `setTimeout` of `6000ms` that calls `twilioClient.calls(call.sid).update({ status: 'completed' })`.
- **If `WAKEUP_MODE === 'puppeteer'` (Default, Zero External Accounts):**
  - Uses `whatsappClient.pupPage` to open the chat with `chatId`, attempts to click the WhatsApp Web Voice Call button selector (`[data-icon="voice-call"]` or `div[title*="Voice call"]`), waits `6000ms` via `setTimeout`, and clicks the Hang Up button (`[data-icon="call-end"]` or `button[aria-label*="End call"]`).
  - Wrap Puppeteer DOM actions in a `try/catch` block so selector changes in WhatsApp Web never crash the MCP server; if the DOM click fails, send three rapid buzzer messages (`🚨 RING!`, `🚨 WAKE UP!`, `🚨 AGENT BLOCKED!`) spaced 1.5 seconds apart to trigger persistent phone vibrations.

### C. `src/login.js` (One-Time Interactive QR Pairing)
- Instantiates `Client` from `whatsapp-web.js` with `authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' })` and Puppeteer args `['--no-sandbox', '--disable-setuid-sandbox']`.
- On `'qr'`, renders the QR code in the terminal using `qrcode-terminal.generate(qr, { small: true })`.
- On `'ready'`, sends a test message to `process.env.MY_WHATSAPP_ID` saying `"✅ Coding Agent Pager linked and ready!"`, waits 2 seconds, calls `await client.destroy()`, and exits (`process.exit(0)`).

### D. `src/whatsapp.js` (Walkie-Talkie Loop)
- Initializes the `whatsapp-web.js` `Client` singleton using the same `./.wwebjs_auth` directory.
- Exports `ensureReady()` which returns a Promise that resolves once the `'ready'` event fires.
- Exports `askHumanWithWakeUpCall({ summary, commandOrDiff, spokenPrompt })`:
  1. Calls `await ensureReady()`.
  2. Sends a structured Markdown message to `MY_WHATSAPP_ID`:
     ```text
     🤖 *Coding Agent Needs Approval*

     📋 *Context:* ${summary}
     💻 *Proposed Action:*
     ```
     ${commandOrDiff}
     ```
     🎙️ _Reply with text or hold the mic to send a voice note._
     ```
  3. Generates the Opus voice note from `spokenPrompt` via `generateOpusVoiceNote()` and sends it with `{ sendAudioAsVoice: true }`. (Record the sent message timestamps so the listener only processes *new* incoming messages).
  4. Starts a timer for `ESCALATION_TIMEOUT_MS` (60s). When triggered:
     - Sends `"🔔 *No reply after 60s — triggering wake-up ring...*"`
     - Calls `await ringAndInterrupt(whatsappClient, MY_WHATSAPP_ID)`.
  5. Listens on `'message_create'` (to support both single-number self-chat and two-number setups: check `msg.from === MY_WHATSAPP_ID && !msg.fromMe` OR if testing with a single number, allow user replies that don't start with bot prefixes `🤖`/`🔔`/`🚨`).
  6. When a valid reply arrives:
     - Clears the escalation timer and removes the listener.
     - If `msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')`, downloads media, transcribes via `transcribeVoiceNote(media.data)`, echoes `"📝 *Heard:* _${transcript}_"` back to WhatsApp for confirmation, and resolves `{ channel: 'voice_note', human_response: transcript }`.
     - Otherwise, resolves `{ channel: 'text', human_response: msg.body }`.

### E. `src/index.js` (MCP Server Entry Point)
- Uses `McpServer` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js`.
- Registers the tool `ask_human_on_whatsapp` with `zod` schema:
  - `summary`: string (What the agent just finished and why it is blocked)
  - `command_or_diff`: string (The exact bash command, migration, or code diff awaiting approval)
  - `spoken_prompt`: string (A conversational 1-2 sentence summary to be spoken aloud in the WhatsApp voice note, e.g., *"Hey, I finished the database schema, should I run the migration now?"*)
- Connects the server to `StdioServerTransport`.

---

## 6. Execution & Verification Steps for the Coding Agent

1. **Scaffold & Install:** Create all files and install dependencies.
2. **Syntax Check:** Run `node --check src/index.js` and `node --check src/login.js` to ensure zero syntax or import errors.
3. **Output Setup Instructions:** Print the exact commands for the user to:
   - Fill in `.env`
   - Run `npm run login` once to scan the WhatsApp QR code
   - Run `npm run test-pager` to verify text + voice note + 60s ring interrupt
   - Add the MCP server block to `.cursor/mcp.json`:
     ```json
     {
       "mcpServers": {
         "whatsapp-pager": {
           "command": "node",
           "args": ["/ABSOLUTE/PATH/TO/whatsapp-agent-pager/src/index.js"]
         }
       }
     }
     ```