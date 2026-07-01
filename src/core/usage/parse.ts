import { getRates } from './pricing'

export type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

export type TurnUsage = {
  turn: number
  startedAt: string
  endedAt: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  costUsd: number
  usedFragmentTool: boolean
}

/**
 * Dedupe SessionMessage-shaped objects by message.id — 1.5 found the
 * transcript can carry the same reply twice under an identical id. Keeps
 * the first occurrence, drops the rest.
 */
export function dedupeByMessageId<T extends { message: unknown }>(
  messages: T[],
): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const m of messages) {
    const id = (m.message as { id?: string } | null)?.id
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    result.push(m)
  }
  return result
}

/**
 * Sums token counts across every usage object handed in (main transcript +
 * any subagent files folded in by the caller) and prices the total by
 * model. Caller is responsible for already having deduped and sliced to
 * exactly this turn's messages — this function just does the math.
 */
export function computeTurnUsage(
  turn: number,
  startedAt: string,
  endedAt: string,
  model: string,
  usages: RawUsage[],
  usedFragmentTool: boolean,
): TurnUsage {
  const inputTokens = usages.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0)
  const outputTokens = usages.reduce(
    (sum, u) => sum + (u.output_tokens ?? 0),
    0,
  )
  const cacheReadTokens = usages.reduce(
    (sum, u) => sum + (u.cache_read_input_tokens ?? 0),
    0,
  )
  const cacheWrite5mTokens = usages.reduce(
    (sum, u) => sum + (u.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    0,
  )
  const cacheWrite1hTokens = usages.reduce(
    (sum, u) => sum + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    0,
  )

  const rates = getRates(model)
  const costUsd =
    (inputTokens / 1_000_000) * rates.inputPerMillion +
    (outputTokens / 1_000_000) * rates.outputPerMillion +
    (cacheReadTokens / 1_000_000) * rates.cacheReadPerMillion +
    (cacheWrite5mTokens / 1_000_000) * rates.cacheWrite5mPerMillion +
    (cacheWrite1hTokens / 1_000_000) * rates.cacheWrite1hPerMillion

  return {
    turn,
    startedAt,
    endedAt,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    costUsd,
    usedFragmentTool,
  }
}
