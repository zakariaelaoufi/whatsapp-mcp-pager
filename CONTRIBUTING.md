# Contributing to `whatsapp-mcp-pager`

Thank you for your interest in contributing to **`whatsapp-mcp-pager`**! This project is a Fail-Closed Human-in-the-Loop (HITL) MCP server for AI coding agents, so **safety, determinism, and stdio hygiene** are our top priorities.

---

## Core Design Principles

Before submitting a pull request, please make sure your changes adhere to these four invariants:

1. **Fail-Closed by Default:** Timeouts, network failures, ambiguous replies, or crashes must **never** authorize an action. Only an explicit affirmative human decision (and a follow-up `Y` text confirmation for `HIGH`/`CRITICAL` voice approvals) can transition a request to `APPROVED`.
2. **Strict MCP `stdio` Safety:** Because the MCP server communicates over JSON-RPC on `stdout`, **never call `console.log()`** in runtime code. Always log diagnostics to `console.error()`.
3. **End-to-End Secret Redaction:** Any user/agent string (`project`, `summary`, `command_or_diff`, `spoken_prompt`, `question`, or error messages) must pass through `redactSecrets()` before being persisted to SQLite or sent to WhatsApp/TTS.
4. **Provider Decoupling:** Keep `src/engine.js` free of direct `whatsapp-web.js`, `openai`, or `twilio` imports. All external I/O belongs behind the `NotificationProvider` interface (`src/providers/`).

---

## Development Setup

1. **Prerequisites:** Node.js `>=20.0.0`
2. **Fork & Clone:**
   ```bash
   git clone https://github.com/<your-username>/whatsapp-mcp-pager.git
   cd whatsapp-mcp-pager
   npm install
   ```
3. **Run the Deterministic Unit Test Suite:**
   The unit test suite uses an in-memory SQLite database (`:memory:`) and `MockProvider`, so it runs in seconds without needing a WhatsApp account or API keys:
   ```bash
   npm test
   ```
4. **Run the Live End-to-End Test *(Optional)*:**
   If you are modifying `src/providers/whatsapp.js`, `src/wakeup.js`, or `src/audio.js`, configure `.env`, link a test WhatsApp session via `npm run login`, and run:
   ```bash
   npm run test-pager
   ```

---

## Project Structure

- `src/index.js` — MCP server entrypoint (`stdio` transport) and tool definitions.
- `src/engine.js` — Formal Fail-Closed state machine (`ApprovalEngine`), reply parser, and intent classifier.
- `src/db.js` — WAL-mode SQLite store, atomic transactions, schema migrations, and redacted audit log.
- `src/policy.js` — Server-side risk escalation rules (`computeEffectiveRisk`).
- `src/redact.js` — Secret, token, PEM key, and DB password redaction utilities.
- `src/config.js` — Environment variable parsing and Zod validation.
- `src/audio.js` — Optional OpenAI Opus TTS generation and Groq/OpenAI Whisper STT transcription.
- `src/wakeup.js` — 6-second wake-up call escalation (Puppeteer WhatsApp Web call, Twilio flash call, and buzzer fallback).
- `src/providers/` — `NotificationProvider` interface, `WhatsAppWebProvider`, and `MockProvider`.
- `src/test-engine.js` — Deterministic specification test suite (`npm test`).

---

## Submitting a Pull Request

1. Create a descriptive branch (e.g., `feat/telegram-provider` or `fix/voice-note-mime`).
2. Add or update unit tests in `src/test-engine.js` covering your changes.
3. Ensure `npm test` passes 100%.
4. Use clear, scoped commit messages (e.g., `feat(policy): escalate helm uninstall to CRITICAL` or `fix(whatsapp): handle LID chat resolution`).
5. Open a Pull Request referencing any related issue.
