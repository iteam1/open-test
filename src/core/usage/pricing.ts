export type ModelRates = {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheWrite5mPerMillion: number
  cacheWrite1hPerMillion: number
}

// USD per million tokens. Flat per model — doesn't account for the
// >200K-token tiered pricing some 1M-context models have; fine for now,
// revisit if a real turn's context ever grows that large.
const RATES: Record<string, ModelRates> = {
  'claude-sonnet-5': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWrite5mPerMillion: 3.75,
    cacheWrite1hPerMillion: 6,
  },
  'claude-opus-4-8': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWrite5mPerMillion: 18.75,
    cacheWrite1hPerMillion: 30,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWrite5mPerMillion: 1.25,
    cacheWrite1hPerMillion: 2,
  },
}

const DEFAULT_RATES = RATES['claude-sonnet-5']

/** model comes over the wire as e.g. "claude-sonnet-5[1m]" — the [..] suffix names a context-window variant, not a different rate tier here. */
export function getRates(model: string): ModelRates {
  const baseModel = model.replace(/\[.*\]$/, '')
  return RATES[baseModel] ?? DEFAULT_RATES
}
