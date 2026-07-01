import { test, expect } from 'bun:test'
import {
  startTurn,
  endTurn,
  getStatus,
  closeIfIdle,
  killSession,
  reopenSession,
  setActiveTurn,
  getClaudeSessionId,
  setClaudeSessionId,
  getChatLog,
  appendToChatLog,
} from './session'

test('startTurn sets status to running, endTurn returns it to idle', () => {
  const sessionId = 'session-a'

  expect(getStatus(sessionId)).toBeUndefined()

  const turnNumber = startTurn(sessionId)
  expect(turnNumber).toBe(1)
  expect(getStatus(sessionId)).toBe('running')

  endTurn(sessionId, 1000)
  expect(getStatus(sessionId)).toBe('idle')
})

test('a second startTurn while running is rejected, not merged', () => {
  const sessionId = 'session-b'

  const first = startTurn(sessionId)
  expect(first).toBe(1)

  const second = startTurn(sessionId)
  expect(second).toBe(false)
  expect(getStatus(sessionId)).toBe('running')

  endTurn(sessionId, 1000)
  const third = startTurn(sessionId)
  expect(third).toBe(2)
})

test('closeIfIdle only closes once the timeout has passed, and only from idle', () => {
  const sessionId = 'session-c'

  startTurn(sessionId)
  // running — a turn in progress blocks the close, no matter how long
  expect(closeIfIdle(sessionId, 1000, 999_999)).toBe(false)
  expect(getStatus(sessionId)).toBe('running')

  endTurn(sessionId, 1000)
  // idle, but not long enough yet
  expect(closeIfIdle(sessionId, 1000, 1500)).toBe(false)
  expect(getStatus(sessionId)).toBe('idle')

  // idle, and past the timeout
  expect(closeIfIdle(sessionId, 1000, 2000)).toBe(true)
  expect(getStatus(sessionId)).toBe('closed')
})

test('startTurn rejects a push to a closed session until reopenSession is called', () => {
  const sessionId = 'session-d'

  startTurn(sessionId)
  endTurn(sessionId, 1000)
  closeIfIdle(sessionId, 1000, 2000)
  expect(getStatus(sessionId)).toBe('closed')

  expect(startTurn(sessionId)).toBe(false)

  reopenSession(sessionId)
  expect(getStatus(sessionId)).toBe('idle')
  expect(startTurn(sessionId)).toBe(2) // turnCount continues, doesn't reset
})

test('killSession interrupts a running turn, swallows the interrupt error, and closes', async () => {
  const sessionId = 'session-e'
  let interruptCalled = false

  startTurn(sessionId)
  setActiveTurn(sessionId, {
    interrupt: async () => {
      interruptCalled = true
      throw new Error('Query closed before response received') // 1.4's finding
    },
  })

  await killSession(sessionId)

  expect(interruptCalled).toBe(true)
  expect(getStatus(sessionId)).toBe('closed')
})

test('killSession on an idle session just closes it, no interrupt needed', async () => {
  const sessionId = 'session-f'

  startTurn(sessionId)
  endTurn(sessionId, 1000)
  expect(getStatus(sessionId)).toBe('idle')

  await killSession(sessionId)
  expect(getStatus(sessionId)).toBe('closed')
})

test('endTurn arriving after killSession does not revert the close (advisor-found race)', async () => {
  const sessionId = 'session-h'

  startTurn(sessionId)
  setActiveTurn(sessionId, {
    interrupt: async () => {
      throw new Error('Query closed before response received')
    },
  })

  // Simulates: kill-session IPC handler runs to completion first...
  await killSession(sessionId)
  expect(getStatus(sessionId)).toBe('closed')

  // ...then the original send-message handler's `finally` still fires,
  // since the SDK's throw takes a moment to propagate up through it.
  endTurn(sessionId, 1000)

  // Must still be closed — not silently reverted to idle.
  expect(getStatus(sessionId)).toBe('closed')
})

test('claudeSessionId round-trips for use by resume', () => {
  const sessionId = 'session-g'

  expect(getClaudeSessionId(sessionId)).toBeNull()
  setClaudeSessionId(sessionId, 'claude-abc-123')
  expect(getClaudeSessionId(sessionId)).toBe('claude-abc-123')
})

test('chat log accumulates in order and starts empty for an unknown session', () => {
  const sessionId = 'session-i'

  expect(getChatLog(sessionId)).toEqual([])

  appendToChatLog(sessionId, { type: 'assistant', text: 'first' })
  appendToChatLog(sessionId, { type: 'assistant', text: 'second' })

  expect(getChatLog(sessionId)).toEqual([
    { type: 'assistant', text: 'first' },
    { type: 'assistant', text: 'second' },
  ])
})
