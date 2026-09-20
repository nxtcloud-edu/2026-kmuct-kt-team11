/**
 * The ASR vendor seam.
 *
 * H8: Korean ASR quality is a bet, not a known, so the vendor must be an eval
 * variable. Base URL and model are configuration and nothing else hardcodes
 * either. The request shape is OpenAI's `/audio/transcriptions`, which the
 * OpenAI API and OpenAI-compatible gateways share.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

export type ProviderConfig = {
  base_url: string
  api_key: string
  asr_model: string
}

const OPENAI_BASE = 'https://api.openai.com/v1'
const GATEWAY_BASE = 'https://ai-gateway.vercel.sh/v1'

type Env = Record<string, string | undefined>

/**
 * `AI_GATEWAY_API_KEY` wins over `OPENAI_API_KEY` when both are set. Which one is
 * in play also decides the defaults: OpenAI names the model `whisper-1`, a
 * gateway names it `openai/whisper-1`.
 *
 * `env` is a parameter so tests do not have to mutate the process environment.
 */
export function provider_config(env: Env = process.env): ProviderConfig {
  const gateway_key = env.AI_GATEWAY_API_KEY?.trim()
  const openai_key = env.OPENAI_API_KEY?.trim()
  const api_key = gateway_key || openai_key

  if (!api_key) {
    throw new ProviderConfigError(
      'No ASR key configured. Set OPENAI_API_KEY (or AI_GATEWAY_API_KEY) in .env.local — see .env.example.',
    )
  }

  // A system env var shadows .env.local, and a doubled prefix is the classic
  // symptom of pasting "sk-..." after a variable that already held "sk-". Say so
  // here rather than letting it surface as a bare 401 from the provider. The key
  // value itself is never put in the message.
  if (api_key.startsWith('sk-sk-')) {
    throw new ProviderConfigError(
      'The API key starts with "sk-sk-" — the "sk-" prefix is duplicated. ' +
        'A system environment variable may be overriding .env.local; check both.',
    )
  }

  const via_gateway = Boolean(gateway_key)
  return {
    api_key,
    base_url: (env.AI_GATEWAY_BASE_URL?.trim() || (via_gateway ? GATEWAY_BASE : OPENAI_BASE)).replace(/\/+$/, ''),
    asr_model: env.ASR_MODEL?.trim() || (via_gateway ? 'openai/whisper-1' : 'whisper-1'),
  }
}

/**
 * Speech models bill by audio minute, not by token, so cost comes from duration.
 * A rough figure — the harness compares rungs against each other, so relative
 * cost is the point. Adjust the rate when the vendor is settled.
 */
const USD_PER_AUDIO_MINUTE = 0.006

export function estimate_asr_cost(duration_s: number): number {
  return (Math.max(0, duration_s) / 60) * USD_PER_AUDIO_MINUTE
}
