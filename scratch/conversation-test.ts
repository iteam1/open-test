import {
  query,
  SDKUserMessage,
  getSessionMessages,
} from '@anthropic-ai/claude-agent-sdk'

async function* messages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: 'Reply with exactly the word: ONE' },
    parent_tool_use_id: null,
  }

  yield {
    type: 'user',
    message: { role: 'user', content: 'Reply with exactly the word: TWO' },
    parent_tool_use_id: null,
  }

  yield {
    type: 'user',
    message: { role: 'user', content: 'Reply with exactly the word: THREE' },
    parent_tool_use_id: null,
  }
}

const result = query({ prompt: messages() })

let session_id: string | undefined

try {
  for await (const message of result) {
    if (message.type === 'system' && message.subtype === 'init') {
      session_id = message.session_id
    }
  }
} catch (err) {
  console.log(err)
}

if (!session_id) {
  throw new Error('Never received a session_id from the init message')
}

const history = await getSessionMessages(session_id)
console.log(history)
