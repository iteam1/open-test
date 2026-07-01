import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  startup,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  setActiveTurn,
  setClaudeSessionId,
  getClaudeSessionId,
  getStatus,
  hydrateSession,
} from '../core/session/session'
import {
  sliceMessagesForTurn,
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

/** e.g. "2026-07-02-091530-a1b2" — sortable, matches overview.md's "year-month-day-time" description; the random suffix guards two sessions created in the same second. */
function generateSessionId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.random().toString(16).slice(2, 6)
  return `${stamp}-${suffix}`
}

/**
 * Allocates a new sessionId and builds its folder under sessionsRootDir
 * (via createSessionFolder). This is the one place a new session comes
 * into existence — the Dashboard's "New session" action calls this.
 */
export async function createSession(
  templateDir: string,
  sessionsRootDir: string,
) {
  const sessionId = generateSessionId()
  const sessionDir = path.join(sessionsRootDir, sessionId)
  await createSessionFolder(sessionId, templateDir, sessionDir)
  return { sessionId, sessionDir }
}

export type SessionSummary = {
  sessionId: string
  claudeSessionId: string
  createdAt: string
  status: 'idle' | 'running' | 'closed'
  path: string
  displayName: string
}

/**
 * Reads every session folder under sessionsRootDir and combines each one's
 * metadata.json with its in-memory status (3.1) — a session this process
 * never touched reads as 'closed', regardless of what a stale metadata.json
 * might imply (design.md's invariant: no live connection in memory means
 * closed, always). displayName comes from the SDK's own customTitle/
 * summary (design.md: not a field on Session itself), falling back to the
 * sessionId when there's no claudeSessionId yet (a session with no turns).
 *
 * A single malformed/partial metadata.json is skipped, not fatal — this
 * runs on every Dashboard refresh and every idle-timeout tick (advisor-
 * found bug: previously one bad folder threw and broke both).
 */
export async function listSessions(
  sessionsRootDir: string,
): Promise<SessionSummary[]> {
  if (!existsSync(sessionsRootDir)) return []

  const entries = await readdir(sessionsRootDir, { withFileTypes: true })
  const summaries: SessionSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    try {
      const sessionDir = path.join(sessionsRootDir, entry.name)
      const metadataPath = path.join(sessionDir, 'metadata.json')
      if (!existsSync(metadataPath)) continue

      const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'))
      if (typeof metadata.session_id !== 'string') continue

      const claudeSessionId = (metadata.claude_session_id as string) || ''

      let displayName = metadata.session_id as string
      if (claudeSessionId) {
        const info = await getSessionInfo(claudeSessionId)
        displayName = info?.customTitle ?? info?.summary ?? displayName
      }

      summaries.push({
        sessionId: metadata.session_id,
        claudeSessionId,
        createdAt: metadata.created_at,
        status: getStatus(metadata.session_id) ?? 'closed',
        path: sessionDir,
        displayName,
      })
    } catch {
      continue
    }
  }

  return summaries
}

export type ArtifactList = {
  turn: number
  files: { name: string; path: string }[]
}

/**
 * Finds the highest-numbered output/turn-<n>/ folder and lists its files
 * (3.3's artifact panel shows "what's happening now," not a per-turn
 * browser — good enough for what 4.3 asks: watch it update live during a
 * run). turn 0 / files [] if the session has no turns yet.
 */
export async function listLatestArtifacts(
  sessionDir: string,
): Promise<ArtifactList> {
  const outputDir = path.join(sessionDir, 'output')
  if (!existsSync(outputDir)) return { turn: 0, files: [] }

  const entries = await readdir(outputDir)
  let latestTurn = 0
  for (const entry of entries) {
    const match = entry.match(/^turn-(\d+)$/)
    if (match) latestTurn = Math.max(latestTurn, Number(match[1]))
  }
  if (latestTurn === 0) return { turn: 0, files: [] }

  const turnDir = path.join(outputDir, `turn-${latestTurn}`)
  const names = (await readdir(turnDir)).sort()
  return {
    turn: latestTurn,
    files: names.map((name) => ({ name, path: path.join(turnDir, name) })),
  }
}

/**
 * Loads a session's persisted claudeSessionId/turnCount into session.ts as
 * 'closed' the first time this process encounters it — call this before
 * startTurn whenever getStatus(sessionId) is undefined. Without it, a
 * session from a previous app run looks brand new: the next push starts a
 * fresh claudeSessionId (losing all prior context) and restarts turn
 * numbering at 1, colliding with output/turn-1/ already on disk
 * (advisor-found bug). No-ops harmlessly if metadata.json doesn't exist.
 */
export async function hydrateSessionFromDisk(
  sessionId: string,
  sessionDir: string,
): Promise<void> {
  const metadataPath = path.join(sessionDir, 'metadata.json')
  if (!existsSync(metadataPath)) return

  const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'))
  const claudeSessionId = (metadata.claude_session_id as string) || null

  const outputDir = path.join(sessionDir, 'output')
  let turnCount = 0
  if (existsSync(outputDir)) {
    const entries = await readdir(outputDir)
    for (const entry of entries) {
      const match = entry.match(/^turn-(\d+)$/)
      if (match) turnCount = Math.max(turnCount, Number(match[1]))
    }
  }

  hydrateSession(sessionId, claudeSessionId, turnCount)
}

/** Thin wrapper so ipc.ts doesn't need its own direct SDK import for one call (3.2's rename). */
export async function renameSessionTitle(
  claudeSessionId: string,
  title: string,
) {
  await renameSession(claudeSessionId, title)
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
 *
 * permissionMode: 'bypassPermissions' — there's no human present to
 * approve tool calls mid-turn (confirmed live: without it, Claude
 * correctly refuses to run Bash/playwright-cli at all rather than
 * fabricate a result). This removes per-call approval for every session
 * the app spawns, so the CLAUDE.md guardrails (assets/session-template/,
 * copied into every session) are the only safety net. Enabled after an
 * explicit, informed authorization from the user that named exactly this
 * tradeoff — it was deliberately NOT enabled on two earlier terse
 * approvals, and a code-review advisor had flagged the escalation risk,
 * so the bar for turning it on here was a specific acknowledgment, which
 * has now been given.
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
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
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
 * (getSessionMessages), slices out exactly this turn's assistant messages
 * (sliceMessagesForTurn — correctly skips tool_result entries, which are
 * also type:'user' but aren't a new turn), folds in token usage from any
 * subagentJsonlPaths spawned during this turn (per overview.md), prices the
 * total, and appends one TurnUsage entry to usage.json (created empty by
 * createSessionFolder in 2.1b).
 */
export async function recordTurnUsage(
  sessionDir: string,
  claudeSessionId: string,
  turnNumber: number,
  startedAt: string,
  subagentJsonlPaths: string[],
) {
  const allMessages = await getSessionMessages(claudeSessionId)
  const turnMessages = sliceMessagesForTurn(allMessages, turnNumber)

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
 * usage into usage.json. This bookkeeping runs in a finally block — even a
 * turn that throws (e.g. an interrupt, per 1.4's finding) may have already
 * spent real tokens, and those still need to land in usage.json instead of
 * silently vanishing. Re-throws the original error afterward so the caller
 * (ipc.ts) still sees the failure. Caller must already have called
 * session.startTurn and gotten a real turn number back (not false) before
 * calling this — this function doesn't check status or reject anything
 * itself.
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

  try {
    await runTurn(
      sessionDir,
      prompt,
      onMessage,
      sessionId,
      claudeSessionIdBefore,
    )
  } finally {
    // Narrow edge case, not fixable here: if a kill lands before the SDK
    // ever echoes a session_id (only possible in the brief window right
    // after a session's very first turn starts), claudeSessionId is still
    // null and this block is skipped — any tokens already spent go
    // unrecorded, since there's no claudeSessionId to read a transcript
    // back from at all.
    const claudeSessionId = getClaudeSessionId(sessionId)
    if (claudeSessionId) {
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
  }
}
