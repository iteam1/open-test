import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  startup,
  getSessionMessages,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  setActiveTurn,
  setClaudeSessionId,
  getClaudeSessionId,
} from '../core/session/session'
import {
  dedupeByMessageId,
  computeTurnUsage,
  RawUsage,
} from '../core/usage/parse'

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
      // not known until the SDK's first response — runTurnInFolder writes the real value in after the first turn
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
 *
 * sessionId and resumeClaudeSessionId are both optional so existing
 * one-shot callers/tests keep working unchanged. When sessionId is given,
 * the live query's interrupt() is registered with session.ts (2.5's kill
 * flow needs it), and any session_id seen on a message is recorded there
 * too (2.6's usage tracking and 2.7's resume both need the real
 * claudeSessionId once it's known). When resumeClaudeSessionId is given,
 * it's passed as options.resume so the new subprocess reloads prior
 * history instead of starting cold (2.7) — this also doubles as how every
 * turn after the first keeps context, not just an explicit post-close
 * resume.
 */
export async function runTurn(
  sessionDir: string,
  prompt: string,
  onMessage: (message: unknown) => void,
  sessionId?: string,
  resumeClaudeSessionId?: string | null,
) {
  const warmQuery = await startup({
    options: {
      cwd: sessionDir,
      ...(resumeClaudeSessionId ? { resume: resumeClaudeSessionId } : {}),
    },
  })
  const result = warmQuery.query(messages(prompt))

  if (sessionId) {
    setActiveTurn(sessionId, { interrupt: () => result.interrupt() })
  }

  for await (const message of result) {
    const withSessionId = message as { session_id?: string }
    if (sessionId && withSessionId.session_id) {
      setClaudeSessionId(sessionId, withSessionId.session_id)
    }
    onMessage(message)
  }
}

async function updateMetadataClaudeSessionId(
  sessionDir: string,
  claudeSessionId: string,
) {
  const metadataPath = path.join(sessionDir, 'metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'))
  metadata.claude_session_id = claudeSessionId
  await writeFile(metadataPath, JSON.stringify(metadata))
}

/**
 * Lists a claudeSessionId's subagent .jsonl files (per overview.md's
 * storage layout), or [] if that directory doesn't exist yet — it won't
 * until Claude has actually spawned a subagent at least once.
 */
async function listSubagentFiles(
  claudeSessionId: string,
  sessionDir: string,
): Promise<string[]> {
  const slug = sessionDir.replace(/\//g, '-')
  const subagentsDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    slug,
    claudeSessionId,
    'subagents',
  )
  if (!existsSync(subagentsDir)) return []
  const files = await readdir(subagentsDir)
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(subagentsDir, f))
}

async function readRawUsagesFromJsonl(filePath: string): Promise<RawUsage[]> {
  const content = await readFile(filePath, 'utf-8')
  const usages: RawUsage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (entry.type === 'assistant' && entry.message?.usage) {
      usages.push(entry.message.usage)
    }
  }
  return usages
}

/**
 * Reads this turn's messages back from the SDK's own transcript
 * (getSessionMessages), dedupes by message.id (1.5's finding), folds in
 * token usage from any subagentJsonlPaths spawned during this turn (per
 * overview.md), prices the total, and appends one TurnUsage entry to
 * usage.json (created empty by createSessionFolder in 2.1b).
 */
export async function recordTurnUsage(
  sessionDir: string,
  claudeSessionId: string,
  turnNumber: number,
  startedAt: string,
  subagentJsonlPaths: string[],
) {
  const allMessages = await getSessionMessages(claudeSessionId)
  const userIndices = allMessages
    .map((m, i) => (m.type === 'user' ? i : -1))
    .filter((i) => i !== -1)

  const turnStart = userIndices[turnNumber - 1] ?? 0
  const turnEnd = userIndices[turnNumber] ?? allMessages.length
  const turnMessages = dedupeByMessageId(
    allMessages.slice(turnStart, turnEnd).filter((m) => m.type === 'assistant'),
  )

  const mainUsages = turnMessages
    .map((m) => (m.message as { usage?: RawUsage }).usage)
    .filter((u): u is RawUsage => Boolean(u))

  const model =
    (turnMessages[0]?.message as { model?: string } | undefined)?.model ??
    'unknown'

  const subagentUsages: RawUsage[] = []
  for (const filePath of subagentJsonlPaths) {
    subagentUsages.push(...(await readRawUsagesFromJsonl(filePath)))
  }

  const usage = computeTurnUsage(
    turnNumber,
    startedAt,
    new Date().toISOString(),
    model,
    [...mainUsages, ...subagentUsages],
    false, // fragment tools don't exist yet (Phase 5) — always false until then
  )

  const usageJsonPath = path.join(sessionDir, 'usage.json')
  const existingUsage = JSON.parse(await readFile(usageJsonPath, 'utf-8'))
  existingUsage.push(usage)
  await writeFile(usageJsonPath, JSON.stringify(existingUsage))
}

/**
 * Creates output/turn-<n>/ for this turn, runs it (resuming prior context
 * via session.ts's stored claudeSessionId whenever one's already known),
 * then records the real claudeSessionId into metadata.json and this turn's
 * usage into usage.json. Caller must already have called session.startTurn
 * and gotten a real turn number back (not false) before calling this —
 * this function doesn't check status or reject anything itself.
 */
export async function runTurnInFolder(
  sessionDir: string,
  turnNumber: number,
  prompt: string,
  onMessage: (message: unknown) => void,
  sessionId: string,
) {
  await mkdir(path.join(sessionDir, 'output', `turn-${turnNumber}`), {
    recursive: true,
  })

  const startedAt = new Date().toISOString()
  const claudeSessionIdBefore = getClaudeSessionId(sessionId)
  const subagentFilesBefore = claudeSessionIdBefore
    ? await listSubagentFiles(claudeSessionIdBefore, sessionDir)
    : []

  await runTurn(sessionDir, prompt, onMessage, sessionId, claudeSessionIdBefore)

  const claudeSessionId = getClaudeSessionId(sessionId)
  if (!claudeSessionId) return

  await updateMetadataClaudeSessionId(sessionDir, claudeSessionId)

  const subagentFilesAfter = await listSubagentFiles(
    claudeSessionId,
    sessionDir,
  )
  const newSubagentFiles = subagentFilesAfter.filter(
    (f) => !subagentFilesBefore.includes(f),
  )

  await recordTurnUsage(
    sessionDir,
    claudeSessionId,
    turnNumber,
    startedAt,
    newSubagentFiles,
  )
}
