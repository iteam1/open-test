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
  getStatus,
  hydrateSession,
} from '../core/session/session'
import {
  sliceMessagesForTurn,
  computeTurnUsage,
  RawUsage,
} from '../core/usage/parse'
import { FragmentStore } from './fragments/store'
import { SessionBrowser } from './fragments/browser'
import { createFragmentServer } from './fragments/server'

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
  description = '',
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
      // optional human-set label given at creation; used as the display name
      // until the SDK has a customTitle/summary of its own (after a turn).
      description,
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
 * A session id becomes a real folder name under sessions/, so a
 * user-supplied one has to be a plain safe slug — no path separators, no
 * "..", nothing that could escape sessionsRootDir or collide with the OS.
 */
function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..'
}

/**
 * Allocates a session folder under sessionsRootDir. This is the one place a
 * new session comes into existence — the Dashboard's "New session" action
 * calls this.
 *
 * opts.sessionId: optional user-chosen id. If given, it's validated as a
 * safe slug and rejected (throws) if a folder with that id already exists —
 * the duplicate check the Dashboard relies on. If omitted, a timestamped id
 * is generated. opts.description: optional human label stored in
 * metadata.json, shown as the display name until the SDK has its own title.
 */
export async function createSession(
  templateDir: string,
  sessionsRootDir: string,
  opts: { sessionId?: string; description?: string } = {},
) {
  const requested = opts.sessionId?.trim()

  let sessionId: string
  if (requested) {
    if (!isValidSessionId(requested)) {
      throw new Error(
        `Invalid session id "${requested}" — use only letters, numbers, dot, dash, underscore.`,
      )
    }
    if (existsSync(path.join(sessionsRootDir, requested))) {
      throw new Error(`A session named "${requested}" already exists.`)
    }
    sessionId = requested
  } else {
    sessionId = generateSessionId()
  }

  const sessionDir = path.join(sessionsRootDir, sessionId)
  await createSessionFolder(
    sessionId,
    templateDir,
    sessionDir,
    opts.description?.trim() || '',
  )
  return { sessionId, sessionDir }
}

export type SessionSummary = {
  sessionId: string
  claudeSessionId: string
  createdAt: string
  status: 'idle' | 'running' | 'closed'
  path: string
  // Free-text label from the new-session modal (or edited later). The
  // renderer shows the sessionId as the card's identity and this — or the
  // created date, when it's empty — as the secondary line.
  description: string
}

/**
 * Reads every session folder under sessionsRootDir and combines each one's
 * metadata.json with its in-memory status (3.1) — a session this process
 * never touched reads as 'closed', regardless of what a stale metadata.json
 * might imply (design.md's invariant: no live connection in memory means
 * closed, always). The renderer identifies each card by its sessionId and
 * shows the description (or the created date, when empty) beneath it.
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

      summaries.push({
        sessionId: metadata.session_id,
        claudeSessionId: (metadata.claude_session_id as string) || '',
        createdAt: metadata.created_at,
        status: getStatus(metadata.session_id) ?? 'closed',
        path: sessionDir,
        description:
          typeof metadata.description === 'string' ? metadata.description : '',
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

/**
 * Sets a session's description in its metadata.json — the editable label
 * the Dashboard shows under the session id. Works at any time (unlike the
 * SDK's renameSession, this needs no claudeSessionId, so it's available
 * before a session has ever run a turn).
 */
export async function updateSessionDescription(
  sessionsRootDir: string,
  sessionId: string,
  description: string,
) {
  const metadataPath = path.join(sessionsRootDir, sessionId, 'metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'))
  metadata.description = description
  await writeFile(metadataPath, JSON.stringify(metadata))
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
/** What runTurn observes about the turn — the SDK's own real cost, captured from the streamed `result` event (null if the turn ended before one arrived, e.g. an interrupt). */
export type TurnResult = { costUsd: number | null }

export async function runTurn(
  sessionDir: string,
  prompt: string,
  onMessage: (message: unknown) => void,
  sessionId?: string,
  resumeClaudeSessionId?: string | null,
  fragmentsRootDir?: string | null,
): Promise<TurnResult> {
  // Fragment tools (Phase 5) attach only when a fragments root is passed —
  // that's the config flag from contribute.md. Off, the app is a fully
  // working baseline; the SDK just drives tests live. We do NOT set
  // strictMcpConfig, so the session's copied .mcp.json (e.g. the screenshot
  // server) is still discovered from cwd alongside this in-process server.
  const browser = fragmentsRootDir ? new SessionBrowser() : null
  const mcpServers = fragmentsRootDir
    ? {
        fragments: createFragmentServer(
          new FragmentStore(fragmentsRootDir),
          browser!,
        ),
      }
    : undefined

  let costUsd: number | null = null

  try {
    const warmQuery = await startup({
      options: {
        cwd: sessionDir,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(resumeClaudeSessionId ? { resume: resumeClaudeSessionId } : {}),
        ...(mcpServers ? { mcpServers } : {}),
      },
    })
    const result = warmQuery.query(messages(prompt))

    if (sessionId) {
      setActiveTurn(sessionId, { interrupt: () => result.interrupt() })
    }

    for await (const message of result) {
      const m = message as {
        session_id?: string
        type?: string
        total_cost_usd?: number
      }
      if (sessionId && m.session_id) {
        setClaudeSessionId(sessionId, m.session_id)
      }
      // The SDK's own real turn cost — no rate table to go stale.
      if (m.type === 'result' && typeof m.total_cost_usd === 'number') {
        costUsd = m.total_cost_usd
      }
      onMessage(message)
    }
  } finally {
    // One browser process per turn (our per-turn-resume architecture already
    // spawns a fresh subprocess each turn); within a turn all run_fragment
    // calls share its context. Always closed so no browser leaks.
    await browser?.close()
  }

  return { costUsd }
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
/**
 * Did this turn call run_fragment or save_fragment (2.6/5.10)? MCP tool
 * calls surface in the transcript as tool_use blocks named
 * mcp__fragments__<tool>. Cheap to derive here while we already have the
 * turn's messages; otherwise unrecoverable later without re-scanning.
 */
function turnUsedFragmentTool(turnMessages: { message: unknown }[]): boolean {
  return turnMessages.some((m) => {
    const content = (m.message as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.some((block) => {
      const name = block as { type?: string; name?: string }
      return (
        name.type === 'tool_use' &&
        typeof name.name === 'string' &&
        (name.name.includes('run_fragment') ||
          name.name.includes('save_fragment'))
      )
    })
  })
}

export async function recordTurnUsage(
  sessionDir: string,
  claudeSessionId: string,
  turnNumber: number,
  startedAt: string,
  subagentJsonlPaths: string[],
  costUsd: number,
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
    turnUsedFragmentTool(turnMessages), // 5.10 / 2.6
    costUsd, // the SDK's real total_cost_usd, captured from the result event
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
  fragmentsRootDir?: string | null,
) {
  await mkdir(path.join(sessionDir, 'output', `turn-${turnNumber}`), {
    recursive: true,
  })

  const startedAt = new Date().toISOString()
  const claudeSessionIdBefore = getClaudeSessionId(sessionId)
  const subagentFilesBefore = claudeSessionIdBefore
    ? await listSubagentFiles(claudeSessionIdBefore, sessionDir)
    : []

  let turnResult: TurnResult = { costUsd: null }
  try {
    turnResult = await runTurn(
      sessionDir,
      prompt,
      onMessage,
      sessionId,
      claudeSessionIdBefore,
      fragmentsRootDir,
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
        turnResult.costUsd ?? 0, // SDK's real turn cost; 0 if the turn ended before a result event
      )
    }
  }
}
