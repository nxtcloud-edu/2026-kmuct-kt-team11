import { z } from 'zod';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { ProblemError } from '@/lib/problem';

/**
 * Text-to-speech. Give it text, get back audio.
 *
 * This is the server half of the TTS module: the ElevenLabs key is a secret and
 * can never ship in the browser bundle, so synthesis has to happen here. The
 * browser calls this route (see lib/speech/elevenlabs-synthesizer.ts), the route
 * calls ElevenLabs, and the audio bytes stream straight back.
 *
 * The model's answer is not wired yet — but this route does not care where the
 * text comes from. A teammate points model output at it later with zero change
 * here: POST { text } and play the response.
 */

export const runtime = 'nodejs';

const Body = z.object({
  text: z.string().trim().min(1, 'Required.').max(5000, 'Too long (max 5000 chars).'),
  /** Override the default voice per request if a caller wants to. */
  voice_id: z.string().min(1).optional(),
  /** ElevenLabs model. Multilingual v2 reads Korean; keep it the default. */
  model_id: z.string().min(1).optional(),
});

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export const POST = withRoute(async (req: Request) => {
  // Authenticated only: the key is billable quota, not an open endpoint.
  await requireUser();

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const defaultVoice = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !defaultVoice) {
    // No provider configured — the clean, documented failure, not a 500.
    throw new ProblemError('tts-unavailable');
  }

  const { text, voice_id, model_id } = Body.parse(await req.json());
  const voiceId = voice_id ?? defaultVoice;
  const modelId = model_id ?? 'eleven_multilingual_v2';

  let upstream: Response;
  try {
    upstream = await fetch(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch {
    // Network/transport failure reaching ElevenLabs.
    throw new ProblemError('tts-failed');
  }

  if (!upstream.ok || !upstream.body) {
    // Surface the upstream status in detail for debugging, without leaking the key.
    const detail = `ElevenLabs responded ${upstream.status}.`;
    console.error('[tts] upstream error', upstream.status);
    throw new ProblemError('tts-failed', { detail });
  }

  // Stream the audio straight through — no buffering the whole clip in memory.
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
});
