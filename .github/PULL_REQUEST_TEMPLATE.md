## Summary
<!-- Briefly describe what this PR changes and why. Link any related issue: e.g., Closes #12 -->

## Type of Change
- [ ] 🐛 **Bug Fix** (non-breaking change that fixes an issue)
- [ ] 🚀 **New Feature** (non-breaking change that adds functionality)
- [ ] 🔒 **Security / Policy Hardening** (updates to `policy.js`, `redact.js`, or fail-closed state machine)
- [ ] ♻️ **Refactoring** (code structure improvement with no behavioral change)
- [ ] 📖 **Documentation** (updates to `README.md`, `CONTRIBUTING.md`, or comments)

## Fail-Closed & Architectural Checklist
- [ ] **Fail-Closed Preserved:** Timeouts, delivery errors, or ambiguous inputs never auto-approve an action.
- [ ] **MCP `stdio` Safe:** No `console.log()` calls were introduced in runtime code (`console.error()` only).
- [ ] **Secret Redaction:** All new user/agent-supplied strings pass through `redactSecrets()` before persistence or network dispatch.
- [ ] **Provider Isolation:** `src/engine.js` remains decoupled from direct `whatsapp-web.js`, `openai`, or `twilio` imports.

## Verification
- [ ] `npm test` passes 100% deterministically (added/updated unit tests in `src/test-engine.js` if applicable).
- [ ] Tested live WhatsApp flow via `npm run test-pager` *(if modifying `whatsapp.js`, `audio.js`, or `wakeup.js`)*.

