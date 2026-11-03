import wwebjs from 'whatsapp-web.js';
import { generateOpusVoiceNote, transcribeVoiceNote } from '../audio.js';
import { AUTH_DATA_PATH, config, validateConfig } from '../config.js';
import { ringAndInterrupt } from '../wakeup.js';
import { NotificationProvider } from './interface.js';

const { Client, LocalAuth } = wwebjs;

const BOT_PREFIXES = ['🤖', '🔔', '🚨', '📝', '✅', '⚠️'];

/**
 * Extracts a reliable serialized message ID from a whatsapp-web.js Message or MsgKey.
 */
export function getSerializedMsgId(msg) {
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
 * Extracts `[AP-XXXX]` from a message or quoted message body if present.
 */
function extractRequestIdFromText(text) {
  if (!text || typeof text !== 'string') return undefined;
  const match = text.match(/\[(AP-[A-Z0-9]{4,8})\]/i);
  return match ? match[1].toUpperCase() : undefined;
}

export class WhatsAppWebProvider extends NotificationProvider {
  constructor() {
    super();
    this.client = null;
    this.readyPromise = null;
    this.isClientReady = false;
    this.sentMessageIds = new Set();
    this.sendingBotVoiceNote = false;
    this.validTargetJids = new Set();
    this.lastPromptSentTimestampSec = 0;
    this._listenerAttached = false;
  }

  get targetChatId() {
    return process.env.MY_WHATSAPP_ID?.trim() || config.myWhatsappId;
  }

  getClient() {
    if (this.client) {
      return this.client;
    }

    this.client = new Client({
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

    this.client.on('qr', () => {
      console.error(
        '[WhatsApp] QR code requested, but MCP server runs headless over stdio. Please run `npm run login` first!'
      );
    });

    this.client.on('ready', () => {
      this.isClientReady = true;
      console.error('[WhatsApp] Client is ready.');
    });

    this.client.on('disconnected', (reason) => {
      this.isClientReady = false;
      this.readyPromise = null;
      console.error('[WhatsApp] Client disconnected:', reason);
    });

    return this.client;
  }

  async _applyCompatibilityPatches() {
    const client = this.client;
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
                return (
                  this.$1 || (typeof this.toString === 'function' ? this.toString() : undefined)
                );
              },
              enumerable: true,
              configurable: true,
            });
          }
        } catch {
          // Ignore
        }

        // Patch 1b: Ensure window.WWebJS.getMessageModel preserves id._serialized
        if (
          window.WWebJS &&
          typeof window.WWebJS.getMessageModel === 'function' &&
          !window.WWebJS.__patchedGetMessageModel
        ) {
          const origGetMessageModel = window.WWebJS.getMessageModel;
          window.WWebJS.getMessageModel = function () {
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
          // Ignore
        }
      });
    } catch (err) {
      console.error('[WhatsApp] Warning: Could not apply WWeb compatibility patch:', err.message);
    }
  }

  async _resolveTargetChatJids() {
    const targetChatId = this.targetChatId;
    this.validTargetJids.add(targetChatId);

    if (!this.client?.pupPage) {
      return this.validTargetJids;
    }

    try {
      const resolved = await this.client.pupPage.evaluate(async (chatId) => {
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
        if (id) this.validTargetJids.add(id);
      }
    } catch {
      // Fallback to targetChatId
    }

    return this.validTargetJids;
  }

  _attachMessageListener() {
    if (this._listenerAttached || !this.client) return;
    this._listenerAttached = true;

    this.client.on('message_create', async (msg) => {
      try {
        const serializedId = getSerializedMsgId(msg);
        if (serializedId && this.sentMessageIds.has(serializedId)) {
          return;
        }

        if (this.sendingBotVoiceNote && msg.fromMe && (msg.type === 'ptt' || msg.type === 'audio')) {
          if (serializedId) this.sentMessageIds.add(serializedId);
          return;
        }

        // Ignore status broadcasts and group messages
        if (
          msg.isStatus ||
          (typeof msg.from === 'string' &&
            (msg.from.endsWith('@broadcast') || msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter')))
        ) {
          return;
        }

        const bodyText = (msg.body || '').trim();
        if (bodyText && BOT_PREFIXES.some((prefix) => bodyText.startsWith(prefix))) {
          return;
        }

        const isFromTarget = this.validTargetJids.has(msg.from);
        const isSelfChatToTarget = msg.fromMe && this.validTargetJids.has(msg.to);
        const isAllowedSender = isFromTarget || isSelfChatToTarget;

        // Ignore bot's own outgoing messages in two-number setups
        const isSelfChat = msg.from === msg.to;
        if (msg.fromMe && !isSelfChat) {
          return;
        }

        if (
          msg.fromMe &&
          (msg.type === 'ptt' || msg.type === 'audio') &&
          typeof msg.timestamp === 'number' &&
          msg.timestamp <= this.lastPromptSentTimestampSec
        ) {
          return;
        }

        const isVoiceNote = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
        if (!isVoiceNote && !bodyText) {
          return;
        }

        // Extract quoted request ID if the user swipe-replied to a specific message
        let quotedRequestId;
        let quotedMessageId;
        if (msg.hasQuotedMsg || msg._data?.quotedMsg) {
          const quotedBody = msg._data?.quotedMsg?.body || '';
          quotedRequestId = extractRequestIdFromText(quotedBody);
          quotedMessageId = msg._data?.quotedStanzaID || undefined;
          if (!quotedRequestId && msg.hasQuotedMsg) {
            try {
              const quoted = await msg.getQuotedMessage();
              if (quoted?.body) {
                quotedRequestId = extractRequestIdFromText(quoted.body);
              }
              quotedMessageId = quotedMessageId || getSerializedMsgId(quoted);
            } catch {
              // Ignore quote fetch failure
            }
          }
        }

        let text = bodyText;
        let channel = 'text';

        if (isVoiceNote && isAllowedSender) {
          this.emitInboundActivity({ senderId: msg.from, channel: 'voice_note' });
          console.error('[WhatsApp] Voice note reply detected. Downloading & transcribing...');
          const base64Audio = await this._downloadVoiceNoteBase64(msg);
          text = await transcribeVoiceNote(base64Audio);
          channel = 'voice_note';
          console.error(`[WhatsApp] Transcribed voice note: "${text}"`);
        }

        await this.emitInboundMessage({
          messageId: serializedId || `wa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          senderId: msg.from,
          isAllowedSender,
          channel,
          text,
          quotedRequestId,
          quotedMessageId,
          timestampMs: typeof msg.timestamp === 'number' ? msg.timestamp * 1000 : Date.now(),
        });
      } catch (err) {
        console.error('[WhatsApp] Error processing inbound message event:', err?.message || err);
      }
    });
  }

  async _downloadVoiceNoteBase64(msg) {
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

    const base64Data = await this.client.pupPage.evaluate(async (payload) => {
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

  async _sendTracked(content, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const sentMsg = await this.client.sendMessage(this.targetChatId, content, {
          sendSeen: false,
          ...options,
        });
        const idStr = getSerializedMsgId(sentMsg);
        if (idStr) {
          this.sentMessageIds.add(idStr);
        }
        return { sentMsg, outboundMsgId: idStr };
      } catch (err) {
        lastError = err;
        console.error(`[WhatsApp] Send attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    throw lastError;
  }

  async ensureReady() {
    validateConfig({ requireOpenAI: true });
    const client = this.getClient();

    if (this.isClientReady) {
      await this._applyCompatibilityPatches();
      await this._resolveTargetChatJids();
      this._attachMessageListener();
      return;
    }

    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        const onReady = async () => {
          cleanup();
          this.isClientReady = true;
          await this._applyCompatibilityPatches();
          await this._resolveTargetChatJids();
          this._attachMessageListener();
          resolve();
        };

        const onAuthFailure = (msg) => {
          cleanup();
          this.readyPromise = null;
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
          this.readyPromise = null;
          reject(err);
        });
      });
    }

    return this.readyPromise;
  }

  async sendPrompt({ requestId, formattedText, spokenPrompt }) {
    await this.ensureReady();

    console.error(`[WhatsApp] Sending prompt [${requestId}] to ${this.targetChatId}...`);
    const { outboundMsgId } = await this._sendTracked(formattedText);

    if (spokenPrompt) {
      this.sendingBotVoiceNote = true;
      try {
        console.error(`[WhatsApp] Generating Opus voice note for [${requestId}]...`);
        const voiceMedia = await generateOpusVoiceNote(spokenPrompt);
        await this._sendTracked(voiceMedia, { sendAudioAsVoice: true });
        console.error(`[WhatsApp] Sent Opus voice note for [${requestId}].`);
      } catch (ttsErr) {
        console.error(
          `[WhatsApp] TTS/Voice note failed for [${requestId}], falling back to text-only: ${ttsErr.message}`
        );
      } finally {
        this.sendingBotVoiceNote = false;
        this.lastPromptSentTimestampSec = Math.floor(Date.now() / 1000);
      }
    }

    return { outboundMsgId };
  }

  async sendText(text) {
    await this.ensureReady();
    const { outboundMsgId } = await this._sendTracked(text);
    return { outboundMsgId };
  }

  async triggerWakeUp({ requestId, signal }) {
    await this.ensureReady();
    if (signal?.aborted) return;
    console.error(`[WhatsApp] Triggering 6s wake-up ring for [${requestId}]...`);
    await ringAndInterrupt(this.client, this.targetChatId, { signal });
  }

  async destroy() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // Ignore cleanup error
      }
      this.client = null;
      this.isClientReady = false;
      this.readyPromise = null;
    }
  }
}

