/**
 * Base contract for HITL Notification Providers (`WhatsAppWebProvider` and `MockProvider`).
 */
export class NotificationProvider {
  constructor() {
    this._inboundListeners = new Set();
    this._activityListeners = new Set();
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
   * @param {AbortSignal} [_params.signal]
   * @returns {Promise<void>}
   */
  async triggerWakeUp(_params) {
    throw new Error('NotificationProvider.triggerWakeUp() must be implemented by subclass');
  }

  /**
   * Registers an inbound activity listener (fired immediately when a voice note starts
   * downloading/transcribing so escalation timers are canceled right away).
   * @param {(info: object) => void} listener
   * @returns {() => void}
   */
  onInboundActivity(listener) {
    this._activityListeners.add(listener);
    return () => this._activityListeners.delete(listener);
  }

  /**
   * Emits an inbound activity signal (e.g. voice note download/transcription started).
   * @param {object} info
   */
  emitInboundActivity(info = {}) {
    for (const listener of Array.from(this._activityListeners)) {
      try {
        listener(info);
      } catch {
        // Ignore activity listener errors
      }
    }
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
