export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  key: string
}

type ContentBlock = { type?: string; text?: string }

/**
 * Turns a raw SDK/transcript message into something displayable, or null
 * to skip it (system/init noise, tool_result entries, the "result" summary
 * event — its text already streamed via the assistant message above it).
 * type:'user' with array content is a tool_result, not a real chat
 * message — same discriminator as core/usage/parse.ts's isHumanTurnStart,
 * since this app only ever pushes plain-string user content.
 */
export function toDisplayMessage(
  raw: unknown,
  key: string,
): ChatMessage | null {
  const message = raw as {
    type?: string
    message?: { role?: string; content?: unknown }
  }

  if (message.type === 'user' && typeof message.message?.content === 'string') {
    return { role: 'user', text: message.message.content, key }
  }

  if (message.type === 'assistant' && message.message) {
    const content = message.message.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = (content as ContentBlock[])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('')
    }
    if (!text) return null
    return { role: 'assistant', text, key }
  }

  return null
}
