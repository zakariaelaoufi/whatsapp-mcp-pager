---
name: Bug Report
about: Report a bug, unexpected fail-closed state, or WhatsApp connection issue
title: "[Bug]: "
labels: ["bug"]
assignees: ""
---

## Summary
A clear and concise description of what the bug is.

## Steps to Reproduce
1. Configure `.env` with `...`
2. Call MCP tool `...` (or run `npm run test-pager`)
3. Reply on WhatsApp with `...`
4. See error / unexpected state

## Expected Behavior
What you expected to happen (e.g., request transitions to `APPROVED` or wake-up ring triggers after 60s).

## Actual Behavior
What actually happened (include any error messages or terminal state returned to the IDE).

## Environment
- **OS:** (e.g., Windows 11, macOS 15, Ubuntu 24.04)
- **Node.js Version:** (run `node -v`, must be `>=20.0.0`)
- **AI IDE / Client:** (e.g., Antigravity, Cursor, Claude Code, Windsurf)
- **Wake-Up Mode:** (`puppeteer` or `twilio`)
- **Voice Notes Enabled:** (Yes with OpenAI / Yes with Groq / No - Text-only)

## Logs (`stderr`)
> ⚠️ **Security Note:** Please ensure no real phone numbers, API keys, or tokens are included in the logs below.

```text
Paste relevant MCP server stderr logs here
```
