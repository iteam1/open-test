import { query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'child_process'

function listChildProcesses(): string {
  try {
    return (
      execSync(`ps --ppid ${process.pid} -o pid,cmd --no-headers`)
        .toString()
        .trim() || '(none)'
    )
  } catch {
    return '(none)'
  }
}

async function* messages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: 'Count from 1 to 5000, one number per line',
    },
    parent_tool_use_id: null,
  }

  await new Promise((resolve) => setTimeout(resolve, 3000))

  yield {
    type: 'user',
    message: { role: 'user', content: 'Now say goodbye in one sentence.' },
    parent_tool_use_id: null,
  }
}

const result = query({ prompt: messages() })

let interrupted = false

try {
  for await (const message of result) {
    console.log(message)
    if (message.type === 'assistant' && !interrupted) {
      interrupted = true
      console.log('--- child processes right before interrupt() ---')
      console.log(listChildProcesses())
      await result.interrupt()
    }
  }
} catch (err) {
  console.error('--- loop crashed ---')
  console.error(err)
}

console.log('--- child processes after the crash ---')
console.log(listChildProcesses())
