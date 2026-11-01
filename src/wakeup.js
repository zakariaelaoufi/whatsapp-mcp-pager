import twilio from 'twilio';
import { config } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Triggers a 6-second "Ring-and-Hang-Up" (Flash Call / Bipa) to physically vibrate
 * the developer's phone without incurring call duration charges.
 *
 * @param {import('whatsapp-web.js').Client} whatsappClient
 * @param {string} chatId
 */
export async function ringAndInterrupt(whatsappClient, chatId) {
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

      // Double safeguard: force hangup after 6000ms
      setTimeout(async () => {
        try {
          await twilioClient.calls(call.sid).update({ status: 'completed' });
          console.error(`[WakeUp] Twilio call ${call.sid} hung up after 6s safeguard.`);
        } catch (hangupErr) {
          console.error(`[WakeUp] Twilio safeguard hangup note: ${hangupErr.message}`);
        }
      }, 6000);

      return;
    } catch (twilioErr) {
      console.error(
        `[WakeUp] Twilio flash call failed (${twilioErr.message}), falling back to Puppeteer/buzzer...`
      );
    }
  }

  // Default: WAKEUP_MODE === 'puppeteer'
  try {
    const page = whatsappClient?.pupPage;
    if (!page) {
      throw new Error('whatsappClient.pupPage is not available');
    }

    // Ensure microphone/camera permissions are granted so WebRTC voice call starts cleanly
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
      // Ignore permission override errors if unsupported
    }

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
            // Do not await openChatBottom directly as its internal UI promise may not settle
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
    await sleep(1200);

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
    await sleep(6000);

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
      console.error('[WakeUp] Hung up WhatsApp Web call after 6s.');
    } else {
      console.error('[WakeUp] 6s elapsed (call already ended or End call button not visible).');
    }
  } catch (pupErr) {
    console.error(
      `[WakeUp] Puppeteer call click unavailable (${pupErr.message}). Sending 3 rapid buzzer messages...`
    );
    await sendRapidBuzzerMessages(whatsappClient, chatId);
  }
}

async function sendRapidBuzzerMessages(whatsappClient, chatId) {
  const buzzers = ['🚨 RING!', '🚨 WAKE UP!', '🚨 AGENT BLOCKED!'];
  for (let i = 0; i < buzzers.length; i++) {
    try {
      await whatsappClient.sendMessage(chatId, buzzers[i], { sendSeen: false });
      if (i < buzzers.length - 1) {
        await sleep(1500);
      }
    } catch (err) {
      console.error(`[WakeUp] Failed to send buzzer message "${buzzers[i]}":`, err.message);
    }
  }
}
