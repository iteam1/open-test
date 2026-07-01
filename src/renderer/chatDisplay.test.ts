import { test, expect } from 'bun:test'
import { toDisplayMessage } from './chatDisplay'

test('a real user push (plain string content) displays as a user message', () => {
  const result = toDisplayMessage(
    { type: 'user', message: { role: 'user', content: 'hello there' } },
    'k1',
  )
  expect(result).toEqual({ role: 'user', text: 'hello there', key: 'k1' })
})

test('a tool_result (array content, also type:user) is not a real chat message', () => {
  const result = toDisplayMessage(
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    },
    'k2',
  )
  expect(result).toBeNull()
})

test('an assistant reply with string content displays as an assistant message', () => {
  const result = toDisplayMessage(
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'Hi! How can I help?' },
    },
    'k3',
  )
  expect(result).toEqual({
    role: 'assistant',
    text: 'Hi! How can I help?',
    key: 'k3',
  })
})

test('an assistant reply with block-array content joins the text blocks', () => {
  const result = toDisplayMessage(
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'tool_use', name: 'Bash' }, // no text — should be skipped, not throw
          { type: 'text', text: 'Part two.' },
        ],
      },
    },
    'k4',
  )
  expect(result).toEqual({
    role: 'assistant',
    text: 'Part one. Part two.',
    key: 'k4',
  })
})

test('an assistant message with only a tool call and no text block is skipped', () => {
  const result = toDisplayMessage(
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    },
    'k5',
  )
  expect(result).toBeNull()
})

test('system/init and result-summary messages are skipped', () => {
  expect(toDisplayMessage({ type: 'system', subtype: 'init' }, 'k6')).toBeNull()
  expect(
    toDisplayMessage(
      { type: 'result', subtype: 'success', result: 'Hi!' },
      'k7',
    ),
  ).toBeNull()
})
