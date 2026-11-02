import { NotificationProvider } from './interface.js';

/**
 * Deterministic in-memory NotificationProvider for automated tests (`npm test`).
 * Simulates WhatsApp text, Opus voice note, wake-up rings, and inbound replies
 * without launching Chromium or hitting external APIs.
 */
export class MockProvider extends NotificationProvider {
  constructor({ allowedSenderId = '14155552671@c.us', shouldFailDelivery = false } = {}) {
    super();
    this.allowedSenderId = allowedSenderId;
    this.shouldFailDelivery = shouldFailDelivery;
    this.sentPrompts = [];
    this.sentTexts = [];
    this.wakeUpCalls = [];
    this._msgCounter = 0;
  }

  async ensureReady() {
    if (this.shouldFailDelivery) {
      throw new Error('MockProvider simulated connection failure');
    }
  }

  async sendPrompt({ requestId, formattedText, spokenPrompt }) {
    if (this.shouldFailDelivery) {
      throw new Error('MockProvider simulated delivery failure');
    }
    const outboundMsgId = `mock_out_${++this._msgCounter}_${requestId}`;
    this.sentPrompts.push({
      requestId,
      formattedText,
      spokenPrompt,
      outboundMsgId,
      timestampMs: Date.now(),
    });
    return { outboundMsgId };
  }

  async sendText(text) {
    const outboundMsgId = `mock_txt_${++this._msgCounter}`;
    this.sentTexts.push({
      text,
      outboundMsgId,
      timestampMs: Date.now(),
    });
    return { outboundMsgId };
  }

  async triggerWakeUp({ requestId }) {
    this.wakeUpCalls.push({
      requestId,
      timestampMs: Date.now(),
    });
  }

  /**
   * Simulates an incoming WhatsApp message from a human or unauthorized sender.
   * @param {object} params
   * @param {string} [params.messageId]
   * @param {string} [params.senderId]
   * @param {'text' | 'voice_note'} [params.channel]
   * @param {string} params.text
   * @param {string} [params.quotedRequestId]
   * @param {string} [params.quotedMessageId]
   */
  async simulateInbound({
    messageId,
    senderId = this.allowedSenderId,
    channel = 'text',
    text,
    quotedRequestId = undefined,
    quotedMessageId = undefined,
  }) {
    const id = messageId || `mock_in_${++this._msgCounter}`;
    const isAllowedSender = senderId === this.allowedSenderId;

    await this.emitInboundMessage({
      messageId: id,
      senderId,
      isAllowedSender,
      channel,
      text,
      quotedRequestId,
      quotedMessageId,
      timestampMs: Date.now(),
    });
  }
}

