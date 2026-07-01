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
 * True only for a genuine human-sent turn boundary, not a tool-result entry
 * — getSessionMessages()'s reconstructed transcript emits type: 'user' for
 * both a real pushed message and a tool_result. This app only ever pushes
 * plain-string content (see claudeRunner.ts's messages() generator);
 * tool_result entries always carry an array of content blocks instead, so
 * that's a safe discriminator without guessing at undocumented fields.
 */
function isHumanTurnStart(message: {
  type: string
  message: unknown
}): boolean {
  if (message.type !== 'user') return false
  const content = (message.message as { content?: unknown } | null)?.content
  return typeof content === 'string'
}

/**
 * Slices a full getSessionMessages() transcript down to exactly this turn's
 * assistant messages, deduped by message.id (1.5's finding). Turn n = the
 * messages between the nth and (n+1)th human turn boundary (or the end, if
 * this is the latest turn) — not the nth type:'user' entry, since a tool
 * call mid-turn also produces a type:'user' entry (its tool_result) that
 * isn't a new turn; slicing on that would misattribute usage across turns
 * for any turn that uses a tool.
 */
export function sliceMessagesForTurn<
  T extends { type: string; message: unknown },
>(allMessages: T[], turnNumber: number): T[] {
  const turnBoundaries = allMessages
    .map((m, i) => (isHumanTurnStart(m) ? i : -1))
    .filter((i) => i !== -1)

  const turnStart = turnBoundaries[turnNumber - 1] ?? 0
  const turnEnd = turnBoundaries[turnNumber] ?? allMessages.length

  return dedupeByMessageId(
    allMessages.slice(turnStart, turnEnd).filter((m) => m.type === 'assistant'),
  )
}

/**
 * Sums token counts across every usage object handed in (main transcript +
 * any subagent files folded in by the caller) for the per-category
 * breakdown. costUsd is NOT computed here from a rate table — it's the
 * SDK's own real `total_cost_usd` for the turn, passed in by the caller
 * (captured from the streamed `result` event). That means no hardcoded
 * prices to go stale as models/pricing change. Caller is responsible for
 * having deduped and sliced to exactly this turn's messages.
 */
export function computeTurnUsage(
  turn: number,
  startedAt: string,
  endedAt: string,
  model: string,
  usages: RawUsage[],
  usedFragmentTool: boolean,
  costUsd: number,
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
