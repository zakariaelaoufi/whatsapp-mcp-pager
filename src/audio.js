import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import wwebjs from 'whatsapp-web.js';
import { config, hasOpenAIKey, hasSTTKey } from './config.js';
import { redactSecrets } from './redact.js';

const { MessageMedia } = wwebjs;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim() || config.openaiApiKey;
  return new OpenAI({ apiKey });
}

function getSTTClientAndModel() {
  const groqKey = process.env.GROQ_API_KEY?.trim() || config.groqApiKey;
  if (groqKey && groqKey.length >= 10 && !groqKey.includes('...')) {
    return {
      client: new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      model: 'whisper-large-v3-turbo',
    };
  }

  return {
    client: getOpenAIClient(),
    model: 'whisper-1',
  };
}

/**
 * Generates an Opus-encoded WhatsApp Voice Note (PTT) from spoken text.
 * Returns `null` if `OPENAI_API_KEY` is not configured.
 * @param {string} spokenText
 * @returns {Promise<InstanceType<typeof MessageMedia> | null>}
 */
export async function generateOpusVoiceNote(spokenText) {
  if (!hasOpenAIKey()) {
    return null;
  }
  const openai = getOpenAIClient();
  const safeSpokenText = redactSecrets(spokenText);

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'onyx',
    input: safeSpokenText,
    response_format: 'opus',
  });

  const arrayBuffer = await response.arrayBuffer();
  const base64Audio = Buffer.from(arrayBuffer).toString('base64');

  return new MessageMedia('audio/ogg; codecs=opus', base64Audio, 'voice.ogg');
}

/**
 * Transcribes a base64-encoded Ogg/Opus voice note via Groq Whisper or OpenAI Whisper.
 * @param {string} base64OggData
 * @returns {Promise<string>}
 */
export async function transcribeVoiceNote(base64OggData) {
  if (!hasSTTKey()) {
    throw new Error('No OPENAI_API_KEY or GROQ_API_KEY configured for voice note transcription.');
  }
  const tempFilePath = path.join(
    os.tmpdir(),
    `whatsapp-ptt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`
  );

  try {
    const buffer = Buffer.from(base64OggData, 'base64');
    await fs.promises.writeFile(tempFilePath, buffer);

    const { client, model } = getSTTClientAndModel();
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model,
    });

    return (transcription.text || '').trim();
  } finally {
    try {
      if (fs.existsSync(tempFilePath)) {
        await fs.promises.unlink(tempFilePath);
      }
    } catch (cleanupErr) {
      console.error('[Audio] Failed to delete temp file:', cleanupErr.message);
    }
  }
}

