import wwebjs from 'whatsapp-web.js';
import { generateOpusVoiceNote, transcribeVoiceNote } from './audio.js';
import { AUTH_DATA_PATH, config, validateConfig } from './config.js';
import { ringAndInterrupt } from './wakeup.js';

const { Client, LocalAuth } = wwebjs;

const BOT_PREFIXES = ['🤖', '🔔', '🚨', '📝', '✅'];
const sentMessageIds = new Set();

let whatsappClient = null;
let readyPromise = null;
let isClientReady = false;

/**
 * Extracts a reliable serialized message ID from a whatsapp-web.js Message or MsgKey.
 */
function getSerializedMsgId(msg) {
  const idObj = msg?.id;
  if (!idObj) return undefined;
  if (typeof idObj === 'string') return idObj;
  if (idObj._serialized) return idObj._serialized;
  if (idObj.$1) return idObj.$1;
  if (idObj.id && idObj.remote) {
    const remoteStr = typeof idObj.remote === 'object' ? idObj.remote._serialized : idObj.remote;
    if (remoteStr) {
      return `${Boolean(idObj.fromMe)}_${remoteStr}_${idObj.id}`;
    }
  }
  return idObj.id;
}

/**
 * Applies compatibility patches inside the WhatsApp Web page context for recent
 * WhatsApp Web updates:
 * 1. Strips internal BaseModel `__x_id: undefined` from `processMediaData` so
 *    sending Opus voice notes (`sendAudioAsVoice: true`) doesn't clobber `message.id`
 *    and hang with `Promise was collected`.
 * 2. Ensures `WAWebMsgKey.prototype._serialized` and `getMessageModel` always populate `_serialized`.
 * 3. Patches `WAWebDownloadManager.downloadManager.downloadAndMaybeDecrypt` to always
 *    include `mimetype` so voice note (`ptt`/`audio`) downloads never fail with
 *    `InvalidMediaFileType` (minified `r`).
 */
async function applyWWebCompatibilityPatches(client) {
  if (!client?.pupPage) return;

  try {
    const context = client.pupBrowser?.defaultBrowserContext?.();
    if (context) {
      await context.overridePermissions('https://web.whatsapp.com', [
        'microphone',
        'camera',
        'notifications',
      ]);
    }
  } catch {
    // Ignore permission override errors
  }

  try {
    await client.pupPage.evaluate(() => {
      // Patch 1: Ensure WAWebMsgKey instances always expose `_serialized`
      try {
        const MsgKey = window.require('WAWebMsgKey');
        if (
          MsgKey &&
          MsgKey.prototype &&
          !Object.getOwnPropertyDescriptor(MsgKey.prototype, '_serialized')
        ) {
          Object.defineProperty(MsgKey.prototype, '_serialized', {
            get() {
              return this.$1 || (typeof this.toString === 'function' ? this.toString() : undefined);
            },
            enumerable: true,
            configurable: true,
          });
        }
      } catch {
        // Ignore if WAWebMsgKey is unchanged
      }

      // Patch 1b: Ensure window.WWebJS.getMessageModel preserves id._serialized
      if (
        window.WWebJS &&
        typeof window.WWebJS.getMessageModel === 'function' &&
        !window.WWebJS.__patchedGetMessageModel
      ) {
        const origGetMessageModel = window.WWebJS.getMessageModel;
        window.WWebJS.getMessageModel = function (message) {
          const model = origGetMessageModel.apply(this, arguments);
          if (model && model.id && !model.id._serialized) {
            model.id._serialized =
              model.id.$1 ||
              (model.id.remote && model.id.id
                ? `${Boolean(model.id.fromMe)}_${model.id.remote}_${model.id.id}`
                : undefined);
          }
          return model;
        };
        window.WWebJS.__patchedGetMessageModel = true;
      }

      // Patch 2: Clean BaseModel internal properties (__x_id: undefined) from processMediaData
      if (
        window.WWebJS &&
        typeof window.WWebJS.processMediaData === 'function' &&
        !window.WWebJS.__patchedProcessMediaData
      ) {
        const origProcessMediaData = window.WWebJS.processMediaData;
        window.WWebJS.processMediaData = async function (...args) {
          const mediaData = await origProcessMediaData.apply(this, args);
          if (!mediaData) return mediaData;
          const plain =
            typeof mediaData.toJSON === 'function' ? mediaData.toJSON() : { ...mediaData };
          delete plain.id;
          delete plain.__x_id;
          return {
            ...plain,
            clientUrl: mediaData.clientUrl,
            deprecatedMms3Url: mediaData.deprecatedMms3Url,
            uploadhash: mediaData.uploadhash,
            mediaHandle: mediaData.mediaHandle,
          };
        };
        window.WWebJS.__patchedProcessMediaData = true;
      }

      // Patch 3: Ensure downloadAndMaybeDecrypt always receives a valid mimetype for ptt/audio
      try {
        const dm = window.require('WAWebDownloadManager')?.downloadManager;
        if (
          dm &&
          typeof dm.downloadAndMaybeDecrypt === 'function' &&
          !dm.__patchedDownloadAndMaybeDecrypt
        ) {
          const origDownload = dm.downloadAndMaybeDecrypt.bind(dm);
          dm.downloadAndMaybeDecrypt = function (params, ...rest) {
            if (params && typeof params === 'object' && !params.mimetype) {
              if (params.type === 'ptt' || params.type === 'audio') {
                params = { ...params, mimetype: 'audio/ogg; codecs=opus' };
              }
            }
            return origDownload(params, ...rest);
          };
          dm.__patchedDownloadAndMaybeDecrypt = true;
        }
      } catch {
        // Ignore if WAWebDownloadManager is unchanged
      }
    });
  } catch (err) {
    console.error('[WhatsApp] Warning: Could not apply WWeb compatibility patch:', err.message);
  }
}

/**
 * Downloads and decrypts an incoming WhatsApp voice note / audio message directly
 * via WAWebDownloadManager, using `msg._data` metadata directly (or falling back to
 * Msg collection lookup) and passing `mimetype` explicitly.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} msg
 * @returns {Promise<string>} Base64-encoded audio payload
 */
async function downloadVoiceNoteBase64(client, msg) {
  const serializedId = getSerializedMsgId(msg);
  const rawData = msg._data || {};

  const mediaPayload = {
    serializedId,
    directPath: rawData.directPath,
    encFilehash: rawData.encFilehash,
    filehash: rawData.filehash,
    mediaKey: rawData.mediaKey || msg.mediaKey,
    mediaKeyTimestamp: rawData.mediaKeyTimestamp,
    mimetype: rawData.mimetype || 'audio/ogg; codecs=opus',
    type: rawData.type || msg.type || 'ptt',
  };

  const base64Data = await client.pupPage.evaluate(async (payload) => {
    let target = payload;

    if (!target.directPath && payload.serializedId) {
      const MsgCollection = window.require('WAWebCollections').Msg;
      const found =
        MsgCollection.get(payload.serializedId) ||
        (await MsgCollection.getMessagesById([payload.serializedId]))?.messages?.[0];
      if (found) {
        target = {
          directPath: found.directPath,
          encFilehash: found.encFilehash,
          filehash: found.filehash,
          mediaKey: found.mediaKey,
          mediaKeyTimestamp: found.mediaKeyTimestamp,
          mimetype: found.mimetype || 'audio/ogg; codecs=opus',
          type: found.type || 'ptt',
        };
      }
    }

    if (!target.directPath) {
      return null;
    }

    const mockQpl = {
      addAnnotations() {
        return this;
      },
      addPoint() {
        return this;
      },
    };

    const dm = window.require('WAWebDownloadManager').downloadManager;
    const decryptedMedia = await dm.downloadAndMaybeDecrypt({
      directPath: target.directPath,
      encFilehash: target.encFilehash,
      filehash: target.filehash,
      mediaKey: target.mediaKey,
      mediaKeyTimestamp: target.mediaKeyTimestamp,
      mimetype: target.mimetype || 'audio/ogg; codecs=opus',
      type: target.type || 'ptt',
      signal: new AbortController().signal,
      downloadQpl: mockQpl,
    });

    return await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
  }, mediaPayload);

  if (!base64Data) {
    throw new Error('Failed to download voice note media from WhatsApp.');
  }

  return base64Data;
}

/**
 * Resolves all valid JIDs (both @c.us phone JID and @lid Linked Identity JID)
 * for the target WhatsApp user so replies match regardless of WhatsApp's LID routing.
 */
async function resolveTargetChatJids(client, targetChatId) {
  const validJids = new Set([targetChatId]);

  if (!client?.pupPage) {
    return validJids;
  }

  try {
    const resolved = await client.pupPage.evaluate(async (chatId) => {
      const ids = [chatId];
      try {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (chat?.id?._serialized) {
          ids.push(chat.id._serialized);
        }
      } catch {
        // Ignore
      }
      try {
        if (window.WWebJS?.enforceLidAndPnRetrieval) {
          const { lid, phone } = await window.WWebJS.enforceLidAndPnRetrieval(chatId);
          if (lid?._serialized) ids.push(lid._serialized);
          if (phone?._serialized) ids.push(phone._serialized);
        }
      } catch {
        // Ignore
      }
      return ids;
    }, targetChatId);

    for (const id of resolved) {
      if (id) validJids.add(id);
    }
  } catch {
    // Fallback to targetChatId only
  }

  return validJids;
}

/**
 * Returns or initializes the singleton whatsapp-web.js Client.
 */
export function getWhatsAppClient() {
  if (whatsappClient) {
    return whatsappClient;
  }

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  });

  whatsappClient.on('qr', () => {
    console.error(
      '[WhatsApp] QR code requested, but MCP server runs headless over stdio. Please run `npm run login` first!'
    );
  });

  whatsappClient.on('ready', () => {
    isClientReady = true;
    console.error('[WhatsApp] Client is ready.');
  });

  whatsappClient.on('disconnected', (reason) => {
    isClientReady = false;
    readyPromise = null;
    console.error('[WhatsApp] Client disconnected:', reason);
  });

  return whatsappClient;
}

/**
 * Ensures the WhatsApp client singleton is initialized and ready.
 * @returns {Promise<import('whatsapp-web.js').Client>}
 */
export function ensureReady() {
  const client = getWhatsAppClient();

  if (isClientReady) {
    return applyWWebCompatibilityPatches(client).then(() => client);
  }

  if (!readyPromise) {
    readyPromise = new Promise((resolve, reject) => {
      const onReady = async () => {
        cleanup();
        isClientReady = true;
        await applyWWebCompatibilityPatches(client);
        resolve(client);
      };

      const onAuthFailure = (msg) => {
        cleanup();
        readyPromise = null;
        reject(new Error(`WhatsApp auth failure: ${msg}. Run "npm run login" to re-authenticate.`));
      };

      const cleanup = () => {
        client.off('ready', onReady);
        client.off('auth_failure', onAuthFailure);
      };

      client.on('ready', onReady);
      client.on('auth_failure', onAuthFailure);

      console.error('[WhatsApp] Initializing client with saved session from .wwebjs_auth...');
      client.initialize().catch((err) => {
        cleanup();
        readyPromise = null;
        reject(err);
      });
    });
  }

  return readyPromise;
}

/**
 * Helper to send a WhatsApp message and track its serialized ID so our
 * 'message_create' listener never mistakes bot messages for human replies.
 */
async function sendTrackedMessage(client, chatId, content, options = {}) {
  const sentMsg = await client.sendMessage(chatId, content, {
    sendSeen: false,
    ...options,
  });
  const idStr = getSerializedMsgId(sentMsg);
  if (idStr) {
    sentMessageIds.add(idStr);
  }
  return sentMsg;
}

/**
 * Sends a text + Opus voice note approval request to WhatsApp, starts a 60s
 * escalation timer (which triggers a 6s wake-up ring), and waits for a text or
 * voice note response from the human developer.
 *
 * @param {object} params
 * @param {string} params.summary
 * @param {string} params.commandOrDiff
 * @param {string} params.spokenPrompt
 * @returns {Promise<{ channel: 'text' | 'voice_note', human_response: string }>}
 */
export async function askHumanWithWakeUpCall({ summary, commandOrDiff, spokenPrompt }) {
  validateConfig({ requireOpenAI: true });

  const client = await ensureReady();
  const targetChatId = process.env.MY_WHATSAPP_ID?.trim() || config.myWhatsappId;
  const validTargetJids = await resolveTargetChatJids(client, targetChatId);
  const timeoutMs =
    Number.parseInt(process.env.ESCALATION_TIMEOUT_MS || '', 10) || config.escalationTimeoutMs;

  // Record timestamp (in seconds, matching WhatsApp msg.timestamp) before sending
  const requestStartTimestampSec = Math.floor(Date.now() / 1000);

  const formattedMessage = [
    '🤖 *Coding Agent Needs Approval*',
    '',
    `📋 *Context:* ${summary}`,
    '💻 *Proposed Action:*',
    '```',
    commandOrDiff,
    '```',
    '🎙️ _Reply with text or hold the mic to send a voice note._',
  ].join('\n');

  console.error(`[WhatsApp] Sending approval request to ${targetChatId}...`);
  await sendTrackedMessage(client, targetChatId, formattedMessage);

  // Generate and send the Opus voice note (PTT)
  let sendingBotVoiceNote = true;
  try {
    console.error('[WhatsApp] Generating Opus voice note via OpenAI TTS...');
    const voiceMedia = await generateOpusVoiceNote(spokenPrompt);
    const sentVoiceMsg = await sendTrackedMessage(client, targetChatId, voiceMedia, {
      sendAudioAsVoice: true,
    });
    const voiceIdStr = getSerializedMsgId(sentVoiceMsg);
    if (voiceIdStr) {
      sentMessageIds.add(voiceIdStr);
    }
    console.error('[WhatsApp] Sent Opus voice note (PTT).');
  } finally {
    sendingBotVoiceNote = false;
  }

  const afterBotPromptTimestampSec = Math.floor(Date.now() / 1000);
  console.error(
    `[WhatsApp] Waiting for reply from ${Array.from(validTargetJids).join(' / ')} (escalation ring in ${timeoutMs / 1000}s)...`
  );

  return new Promise((resolve, reject) => {
    let settled = false;

    const escalationTimer = setTimeout(async () => {
      if (settled) return;
      try {
        console.error(
          `[WhatsApp] No reply after ${timeoutMs / 1000}s — sending reminder & triggering wake-up ring...`
        );
        await sendTrackedMessage(
          client,
          targetChatId,
          '🔔 *No reply after 60s — triggering wake-up ring...*'
        );
        await ringAndInterrupt(client, targetChatId);
      } catch (err) {
        console.error('[WhatsApp] Error during escalation wake-up ring:', err.message);
      }
    }, timeoutMs);

    const onMessageCreate = async (msg) => {
      try {
        if (settled) return;

        // Ignore messages already tracked as sent by the bot
        const serializedId = getSerializedMsgId(msg);
        if (serializedId && sentMessageIds.has(serializedId)) {
          return;
        }

        // Ignore messages while the bot's own voice note is in-flight
        if (sendingBotVoiceNote && msg.fromMe && (msg.type === 'ptt' || msg.type === 'audio')) {
          if (serializedId) sentMessageIds.add(serializedId);
          return;
        }

        // Ignore older messages created before our prompt was sent
        if (typeof msg.timestamp === 'number' && msg.timestamp < requestStartTimestampSec) {
          return;
        }

        // Verify the message belongs to the whitelisted chat (matches both @c.us and @lid JIDs)
        const isFromTarget = validTargetJids.has(msg.from);
        const isSelfChatToTarget = msg.fromMe && validTargetJids.has(msg.to);
        if (!isFromTarget && !isSelfChatToTarget) {
          return;
        }

        const bodyText = (msg.body || '').trim();

        // Filter out bot-generated messages by prefix
        if (bodyText && BOT_PREFIXES.some((prefix) => bodyText.startsWith(prefix))) {
          return;
        }

        // In two-number mode (where bot is a separate WhatsApp account), ignore msg.fromMe
        // In self-chat mode (msg.from === msg.to), allow human messages that aren't bot-generated
        const isSelfChat = msg.from === msg.to;
        if (msg.fromMe && !isSelfChat) {
          return;
        }

        // If self-chat and a voice note arrives right as the bot sent its own voice note, guard against echo
        if (
          msg.fromMe &&
          (msg.type === 'ptt' || msg.type === 'audio') &&
          typeof msg.timestamp === 'number' &&
          msg.timestamp <= afterBotPromptTimestampSec
        ) {
          return;
        }

        const isVoiceNote = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
        if (!isVoiceNote && !bodyText) {
          return;
        }

        // Valid human reply received!
        settled = true;
        clearTimeout(escalationTimer);
        client.off('message_create', onMessageCreate);

        if (isVoiceNote) {
          console.error('[WhatsApp] Voice note reply detected. Downloading & transcribing...');
          const base64Audio = await downloadVoiceNoteBase64(client, msg);

          const transcript = await transcribeVoiceNote(base64Audio);
          console.error(`[WhatsApp] Transcribed voice note: "${transcript}"`);

          await sendTrackedMessage(client, targetChatId, `📝 *Heard:* _${transcript}_`);
          resolve({
            channel: 'voice_note',
            human_response: transcript,
          });
        } else {
          console.error(`[WhatsApp] Text reply received: "${bodyText}"`);
          resolve({
            channel: 'text',
            human_response: bodyText,
          });
        }
      } catch (err) {
        settled = true;
        clearTimeout(escalationTimer);
        client.off('message_create', onMessageCreate);
        console.error(
          '[WhatsApp] Error handling incoming reply:',
          err?.message || String(err)
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    client.on('message_create', onMessageCreate);
  });
}
