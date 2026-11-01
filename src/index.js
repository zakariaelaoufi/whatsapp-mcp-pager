import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { askHumanWithWakeUpCall } from './whatsapp.js';

// Strict MCP stdio safety: ensure any accidental console.log from third-party libraries
// is routed to stderr so stdout remains strictly reserved for JSON-RPC messages.
console.log = (...args) => {
  console.error(...args);
};

const server = new McpServer({
  name: 'whatsapp-agent-pager',
  version: '1.0.0',
});

server.tool(
  'ask_human_on_whatsapp',
  'Pause execution and ask the human developer for approval or instructions via WhatsApp (sends formatted text + Opus voice note, and triggers a 6-second wake-up ring if unanswered after 60 seconds).',
  {
    summary: z
      .string()
      .describe('What the agent just finished and why it is blocked'),
    command_or_diff: z
      .string()
      .describe('The exact bash command, migration, or code diff awaiting approval'),
    spoken_prompt: z
      .string()
      .describe(
        'A conversational 1-2 sentence summary to be spoken aloud in the WhatsApp voice note, e.g., "Hey, I finished the database schema, should I run the migration now?"'
      ),
  },
  async ({ summary, command_or_diff, spoken_prompt }) => {
    try {
      const response = await askHumanWithWakeUpCall({
        summary,
        commandOrDiff: command_or_diff,
        spokenPrompt: spoken_prompt,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (err) {
      console.error('[MCP Tool Error] ask_human_on_whatsapp failed:', err.message);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Failed to reach human on WhatsApp: ${err.message}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] WhatsApp "Walkie-Talkie + Wake-Up Ring" MCP Server running on stdio.');
}

main().catch((err) => {
  console.error('[MCP Fatal Error]:', err);
  process.exit(1);
});

