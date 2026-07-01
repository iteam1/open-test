import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startup, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Copies a template directory (e.g. assets/session-template/) wholesale into
 * dest. Used as the first step of createSessionFolder — on its own it does
 * nothing to build the rest of a session's folder.
 */
export async function copySessionTemplate(src: string, dest: string) {
  return cp(src, dest, { recursive: true })
}

/**
 * Builds a brand-new session's entire folder: copies templateDir into
 * sessionDir, then creates input/, output/, metadata.json, and usage.json.
 * Call this once per session, before runTurn — runTurn assumes sessionDir
 * (and its copied .claude/config) already exists.
 */
export async function createSessionFolder(
  sessionId: string,
  templateDir: string,
  sessionDir: string,
) {
  await copySessionTemplate(templateDir, sessionDir)
  await mkdir(path.join(sessionDir, 'input'), { recursive: true })
  await mkdir(path.join(sessionDir, 'output'), { recursive: true })
  await writeFile(
    path.join(sessionDir, 'metadata.json'),
    JSON.stringify({
      session_id: sessionId,
      // not known until the SDK's first response — 2.2 overwrites this once query() starts
      claude_session_id: '',
      created_at: new Date().toISOString(),
    }),
  )
  await writeFile(path.join(sessionDir, 'usage.json'), JSON.stringify([]))
}

/**
 * The message sent to Claude for this turn. Internal to runTurn — nothing
 * outside this file should call it directly.
 */
async function* messages(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  }
}

/**
 * Pre-warms a Claude Agent SDK subprocess against sessionDir (so it picks up
 * that folder's .claude/, CLAUDE.md, .mcp.json automatically per design.md),
 * then sends prompt and streams the reply, calling onMessage for every
 * message received. Call this only after createSessionFolder has already
 * built sessionDir.
 */
export async function runTurn(
  sessionDir: string,
  prompt: string,
  onMessage: (message: unknown) => void,
) {
  const warmQuery = await startup({ options: { cwd: sessionDir } })
  const result = warmQuery.query(messages(prompt))

  for await (const message of result) {
    onMessage(message)
  }
}
