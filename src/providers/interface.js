/**
 * Base contract for HITL Notification Providers (`WhatsAppWebProvider` and `MockProvider`).
 *
 * Inbound message event payload shape passed to `onInboundMessage(callback)`:
 * {
 *   messageId: string,           // Unique serialized message ID (e.g., msg.id._serialized)
 *   senderId: string,            // Sender JID / phone ID
 *   isAllowedSender: boolean,    // True if sender matches allowlisted MY_WHATSAPP_ID / LID
 *   channel: 'text' | 'voice_note',
 *   text: string,                // Raw text body or Whisper-transcribed voice note text
 *   quotedRequestId?: string,    // Optional AP-XXXX extracted if the user swipe-replied to an earlier prompt
 *   quotedMessageId?: string,    // Optional serialized ID of quoted message
 *   timestampMs: number
 * }
 */
export class NotificationProvider {
  constructor() {
    this._inboundListeners = new Set();
  }

  /**
   * Initializes the underlying transport.
   * @returns {Promise<void>}
   */
  async ensureReady() {
    throw new Error('NotificationProvider.ensureReady() must be implemented by subclass');
  }

  /**
   * Sends an approval or human-input prompt (formatted text + Opus voice note).
   * @param {object} params
   * @param {string} params.requestId
   * @param {string} params.formattedText
   * @param {string} params.spokenPrompt
   * @returns {Promise<{ outboundMsgId?: string }>}
   */
  async sendPrompt(_params) {
    throw new Error('NotificationProvider.sendPrompt() must be implemented by subclass');
  }

  /**
   * Sends a plain/Markdown text reply or notification to the allowlisted user.
   * @param {string} _text
   * @returns {Promise<{ outboundMsgId?: string }>}
   */
  async sendText(_text) {
    throw new Error('NotificationProvider.sendText() must be implemented by subclass');
  }

  /**
   * Triggers the 6-second wake-up ring (flash call / WhatsApp Web voice call).
   * @param {object} _params
   * @param {string} _params.requestId
   * @returns {Promise<void>}
   */
  async triggerWakeUp(_params) {
    throw new Error('NotificationProvider.triggerWakeUp() must be implemented by subclass');
  }

  /**
   * Registers an inbound message handler.
   * @param {(msg: object) => Promise<void> | void} listener
   * @returns {() => void} Unsubscribe function
   */
  onInboundMessage(listener) {
    this._inboundListeners.add(listener);
    return () => this._inboundListeners.delete(listener);
  }

  /**
   * Emits a normalized inbound message to all registered listeners.
   * @param {object} inboundMsg
   */
  async emitInboundMessage(inboundMsg) {
    for (const listener of Array.from(this._inboundListeners)) {
      await listener(inboundMsg);
    }
  }

  /**
   * Cleanly shuts down the provider.
   * @returns {Promise<void>}
   */
  async destroy() {}
}

