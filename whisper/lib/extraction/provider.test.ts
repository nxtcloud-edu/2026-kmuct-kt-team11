import { describe, it, expect } from 'vitest'
import { provider_config, ProviderConfigError, estimate_asr_cost } from './provider'

describe('provider_config', () => {
  it('throws a named error when no key is set', () => {
    expect(() => provider_config({})).toThrow(ProviderConfigError)
  })

  it('treats a blank key as unset', () => {
    expect(() => provider_config({ OPENAI_API_KEY: '   ' })).toThrow(ProviderConfigError)
  })

  it('uses the OpenAI endpoint and model name when OPENAI_API_KEY is the key', () => {
    const c = provider_config({ OPENAI_API_KEY: 'sk-proj-abc' })
    expect(c.base_url).toBe('https://api.openai.com/v1')
    expect(c.asr_model).toBe('whisper-1')
    expect(c.api_key).toBe('sk-proj-abc')
  })

  it('prefers AI_GATEWAY_API_KEY over OPENAI_API_KEY and switches endpoint and model naming', () => {
    const c = provider_config({ AI_GATEWAY_API_KEY: 'gw-key', OPENAI_API_KEY: 'sk-proj-abc' })
    expect(c.api_key).toBe('gw-key')
    expect(c.base_url).toBe('https://ai-gateway.vercel.sh/v1')
    expect(c.asr_model).toBe('openai/whisper-1')
  })

  it('lets base URL and model be overridden, so the vendor stays swappable (H8)', () => {
    const c = provider_config({
      OPENAI_API_KEY: 'sk-proj-abc',
      AI_GATEWAY_BASE_URL: 'https://example.test/v1/',
      ASR_MODEL: 'vendor/some-asr',
    })
    expect(c.base_url).toBe('https://example.test/v1')
    expect(c.asr_model).toBe('vendor/some-asr')
  })

  it('names the duplicated "sk-" prefix instead of letting it surface as a 401', () => {
    expect(() => provider_config({ OPENAI_API_KEY: 'sk-sk-proj-abc' })).toThrow(/sk-sk-/)
  })

  it('never echoes the key value in an error message', () => {
    try {
      provider_config({ OPENAI_API_KEY: 'sk-sk-SECRETVALUE' })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETVALUE')
    }
  })
})

describe('estimate_asr_cost', () => {
  it('is zero for no audio', () => {
    expect(estimate_asr_cost(0)).toBe(0)
  })

  it('bills per audio minute', () => {
    expect(estimate_asr_cost(60)).toBeCloseTo(0.006, 6)
    expect(estimate_asr_cost(30)).toBeCloseTo(0.003, 6)
  })
})
