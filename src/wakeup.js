import twilio from 'twilio';
import { config } from './config.js';

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isBrowserClosingError(err) {
  const msg = err?.message || String(err || '');
  return (
    msg.includes('detached Frame') ||
    msg.includes('Target closed') ||
    msg.includes('Session closed') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('Protocol error')
  );
}

/**
 * Triggers a 6-second "Ring-and-Hang-Up" (Flash Call / Bipa) to physically vibrate
 * the developer's phone without incurring call duration charges.
 *
 * @param {import('whatsapp-web.js').Client} whatsappClient
 * @param {string} chatId
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 */
export async function ringAndInterrupt(whatsappClient, chatId, { signal } = {}) {
  if (signal?.aborted) return;

  const mode = (process.env.WAKEUP_MODE || config.wakeupMode || 'puppeteer').toLowerCase();

  if (mode === 'twilio') {
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID || config.twilioAccountSid;
      const authToken = process.env.TWILIO_AUTH_TOKEN || config.twilioAuthToken;
      const fromNumber = process.env.TWILIO_FROM_NUMBER || config.twilioFromNumber;
      const toNumber = process.env.MY_PHONE_E164 || config.myPhoneE164;

      const twilioClient = twilio(accountSid, authToken);

      console.error(`[WakeUp] Initiating Twilio 6s flash call to ${toNumber}...`);
      const call = await twilioClient.calls.create({
        to: toNumber,
        from: fromNumber,
        twiml: '<Response><Pause length="10"/></Response>',
        timeout: 6,
      });

      await abortableSleep(6000, signal);

      try {
        await twilioClient.calls(call.sid).update({ status: 'completed' });
        console.error(`[WakeUp] Twilio call ${call.sid} hung up after 6s safeguard.`);
      } catch (hangupErr) {
        console.error(`[WakeUp] Twilio safeguard hangup note: ${hangupErr.message}`);
      }

      return;
    } catch (twilioErr) {
      if (signal?.aborted) return;
      console.error(
        `[WakeUp] Twilio flash call failed (${twilioErr.message}), falling back to Puppeteer/buzzer...`
      );
    }
  }

  // Default: WAKEUP_MODE === 'puppeteer'
  try {
    const page = whatsappClient?.pupPage;
    if (!page || page.isClosed?.() || !whatsappClient?.pupBrowser?.isConnected?.()) {
      return;
    }

    try {
      const context = whatsappClient.pupBrowser?.defaultBrowserContext?.();
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

    if (signal?.aborted) return;

    // Dismiss any "Continue" popup modal and open the target chat using WAWebCmd.Cmd.openChatBottom
    await page.evaluate(async (targetChatId) => {
      try {
        const continueBtn = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.innerText || '').trim() === 'Continue'
        );
        if (continueBtn) {
          continueBtn.click();
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch {
        // Ignore modal dismissal errors
      }

      try {
        const chat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
        if (chat) {
          const Cmd = window.require('WAWebCmd')?.Cmd;
          if (Cmd && typeof Cmd.openChatBottom === 'function') {
            Cmd.openChatBottom({ chat });
          } else if (Cmd && typeof Cmd.openChatAt === 'function') {
            Cmd.openChatAt({ chat });
          }
        }
      } catch {
        // Ignore internal navigation errors and try DOM selector directly
      }
    }, chatId);

    // Wait briefly for #main header to render the Voice call button
    await abortableSleep(1200, signal);
    if (signal?.aborted || page.isClosed?.() || !whatsappClient?.pupBrowser?.isConnected?.()) {
      return;
    }

    const callClicked = await page.evaluate(() => {
      const btn =
        document.querySelector(
          '#main header button[aria-label*="Voice call"], button[aria-label*="Voice call"], [data-icon="voice-call"], div[title*="Voice call"]'
        ) ||
        Array.from(document.querySelectorAll('#main header button, button')).find((b) =>
          (b.getAttribute('aria-label') || b.getAttribute('title') || '').includes('Voice call')
        );

      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!callClicked) {
      throw new Error('WhatsApp Web Voice Call button selector not found');
    }

    console.error('[WakeUp] Voice call ringing on WhatsApp Web (6s wake-up ring)...');
    await abortableSleep(6000, signal);

    if (page.isClosed?.() || !whatsappClient?.pupBrowser?.isConnected?.()) {
      return;
    }

    const hungUp = await page.evaluate(() => {
      const endBtn =
        document.querySelector(
          'button[aria-label*="End call"], [data-icon="call-end"], div[title*="End call"]'
        ) ||
        Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
          (b.getAttribute('aria-label') || b.getAttribute('title') || '').includes('End call')
        );

      if (endBtn) {
        endBtn.click();
        return true;
      }
      return false;
    });

    if (hungUp) {
      console.error('[WakeUp] Hung up WhatsApp Web call.');
    } else {
      console.error('[WakeUp] Wake-up ring finished.');
    }
  } catch (pupErr) {
    if (signal?.aborted || isBrowserClosingError(pupErr)) {
      return;
    }
    console.error(
      `[WakeUp] Puppeteer call click unavailable (${pupErr.message}). Sending 3 rapid buzzer messages...`
    );
    await sendRapidBuzzerMessages(whatsappClient, chatId, signal);
  }
}

async function sendRapidBuzzerMessages(whatsappClient, chatId, signal) {
  const buzzers = ['🚨 RING!', '🚨 WAKE UP!', '🚨 AGENT BLOCKED!'];
  for (let i = 0; i < buzzers.length; i++) {
    if (
      signal?.aborted ||
      whatsappClient?.pupPage?.isClosed?.() ||
      !whatsappClient?.pupBrowser?.isConnected?.()
    ) {
      return;
    }
    try {
      await whatsappClient.sendMessage(chatId, buzzers[i], { sendSeen: false });
      if (i < buzzers.length - 1) {
        await abortableSleep(1500, signal);
      }
    } catch (err) {
      if (isBrowserClosingError(err)) return;
      console.error(`[WakeUp] Failed to send buzzer message "${buzzers[i]}":`, err.message);
    }
  }
}
