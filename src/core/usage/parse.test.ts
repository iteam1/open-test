import { test, expect } from 'bun:test'
import {
  dedupeByMessageId,
  computeTurnUsage,
  sliceMessagesForTurn,
} from './parse'

test('computeTurnUsage sums tokens and prices them by model', () => {
  const usage = computeTurnUsage(
    1,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:05.000Z',
    'claude-sonnet-5',
    [
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
    ],
    false,
  )

  expect(usage.inputTokens).toBe(1_000_000)
  expect(usage.outputTokens).toBe(1_000_000)
  expect(usage.cacheReadTokens).toBe(1_000_000)
  expect(usage.cacheWrite5mTokens).toBe(1_000_000)
  expect(usage.cacheWrite1hTokens).toBe(1_000_000)
  // 3 + 15 + 0.3 + 3.75 + 6 per-million rates, all at exactly 1M tokens each
  expect(usage.costUsd).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 6)
})

test('an unknown model falls back to the default rate table instead of throwing', () => {
  const usage = computeTurnUsage(
    1,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:05.000Z',
    'some-future-model[1m]',
    [{ input_tokens: 1_000_000, output_tokens: 0 }],
    false,
  )
  expect(usage.costUsd).toBeCloseTo(3, 6)
})

test("folds a subagent turn's tokens into the same turn total, not just the main transcript", () => {
  const mainTranscriptUsage = { input_tokens: 1000, output_tokens: 200 }
  const subagentUsage = { input_tokens: 500, output_tokens: 100 }

  const usage = computeTurnUsage(
    1,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:05.000Z',
    'claude-sonnet-5',
    [mainTranscriptUsage, subagentUsage],
    false,
  )

  expect(usage.inputTokens).toBe(1500)
  expect(usage.outputTokens).toBe(300)
})

test('dedupeByMessageId counts a duplicated message.id once, not twice', () => {
  const messages = [
    { message: { id: 'msg_1', usage: { input_tokens: 100 } } },
    { message: { id: 'msg_1', usage: { input_tokens: 100 } } }, // 1.5's finding: same id, appears twice
    { message: { id: 'msg_2', usage: { input_tokens: 50 } } },
  ]

  const deduped = dedupeByMessageId(messages)

  expect(deduped).toHaveLength(2)
  expect(deduped.map((m) => (m.message as { id: string }).id)).toEqual([
    'msg_1',
    'msg_2',
  ])
})

test('dedupeByMessageId leaves messages without an id untouched', () => {
  const messages = [
    { message: { role: 'user', content: 'hi' } },
    { message: { role: 'user', content: 'hi' } },
  ]
  expect(dedupeByMessageId(messages)).toHaveLength(2)
})

test('sliceMessagesForTurn does not misattribute usage when a tool is called mid-turn (advisor-found bug)', () => {
  // Turn 1 uses a tool: human message -> tool-call assistant reply ->
  // synthetic tool_result (type: 'user', array content, NOT a new turn) ->
  // final assistant reply. Turn 2 is a plain follow-up.
  const transcript = [
    { type: 'user', message: { content: 'do X' } }, // 0: real turn 1 start
    {
      type: 'assistant',
      message: { id: 'a1', usage: { input_tokens: 100 }, content: [] },
    }, // 1: turn 1's tool-call step
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    }, // 2: synthetic tool_result — NOT a turn boundary
    {
      type: 'assistant',
      message: { id: 'a2', usage: { input_tokens: 200 }, content: [] },
    }, // 3: turn 1's real final reply
    { type: 'user', message: { content: 'do Y' } }, // 4: real turn 2 start
    {
      type: 'assistant',
      message: { id: 'a3', usage: { input_tokens: 300 }, content: [] },
    }, // 5: turn 2's final reply
  ]

  const turn1Messages = sliceMessagesForTurn(transcript, 1)
  expect(turn1Messages.map((m) => (m.message as { id: string }).id)).toEqual([
    'a1',
    'a2',
  ])

  const turn2Messages = sliceMessagesForTurn(transcript, 2)
  expect(turn2Messages.map((m) => (m.message as { id: string }).id)).toEqual([
    'a3',
  ])
})
