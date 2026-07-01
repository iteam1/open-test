import { test, expect, afterEach } from 'bun:test'
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  mkdir,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createSessionFolder,
  runTurn,
  runTurnInFolder,
  createSession,
  listSessions,
  updateSessionDescription,
  hydrateSessionFromDisk,
  listLatestArtifacts,
} from './claudeRunner'
import {
  killSession,
  getStatus,
  reopenSession,
  startTurn,
  getClaudeSessionId,
} from '../core/session/session'

let sessionTmpDir: string

afterEach(async () => {
  if (sessionTmpDir) await rm(sessionTmpDir, { recursive: true, force: true })
})

test('createSessionFolder copies the template and creates the rest of the scaffold', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  expect(existsSync(path.join(sessionTmpDir, 'input'))).toBe(true)
  expect(existsSync(path.join(sessionTmpDir, 'output'))).toBe(true)
  expect(existsSync(path.join(sessionTmpDir, '.claude', 'skills'))).toBe(true)
  expect(existsSync(path.join(sessionTmpDir, 'CLAUDE.md'))).toBe(true)
  expect(existsSync(path.join(sessionTmpDir, '.mcp.json'))).toBe(true)

  const metadata = JSON.parse(
    await readFile(path.join(sessionTmpDir, 'metadata.json'), 'utf-8'),
  )
  expect(metadata.session_id).toBe('test-session')
  expect(metadata.claude_session_id).toBe('')
  expect(typeof metadata.created_at).toBe('string')

  const usage = JSON.parse(
    await readFile(path.join(sessionTmpDir, 'usage.json'), 'utf-8'),
  )
  expect(usage).toEqual([])
})

test('runTurn sets cwd so Claude Code mirrors the transcript under ~/.claude/projects', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  await runTurn(sessionTmpDir, 'Hello!', () => {})

  const slug = sessionTmpDir.replace(/\//g, '-')
  const projectDir = path.join(os.homedir(), '.claude', 'projects', slug)
  expect(existsSync(projectDir)).toBe(true)

  const files = await readdir(projectDir)
  expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true)
}, 60_000)

test('runTurnInFolder creates output/turn-<n>/ as soon as the turn starts, not after it finishes', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  const turnPromise = runTurnInFolder(
    sessionTmpDir,
    1,
    'Hello!',
    () => {},
    'test-session-folder-timing',
  )

  // The real API reply takes seconds; the folder should exist almost
  // immediately, well before that reply could possibly land.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(existsSync(path.join(sessionTmpDir, 'output', 'turn-1'))).toBe(true)

  await turnPromise
}, 60_000)

test('runTurnInFolder records the real claudeSessionId and appends real usage after one turn', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  await runTurnInFolder(
    sessionTmpDir,
    1,
    'Hello!',
    () => {},
    'test-session-usage-tracking',
  )

  const metadata = JSON.parse(
    await readFile(path.join(sessionTmpDir, 'metadata.json'), 'utf-8'),
  )
  expect(metadata.claude_session_id).not.toBe('')

  const usage = JSON.parse(
    await readFile(path.join(sessionTmpDir, 'usage.json'), 'utf-8'),
  )
  expect(usage).toHaveLength(1)
  expect(usage[0].turn).toBe(1)
  expect(usage[0].inputTokens).toBeGreaterThan(0)
  expect(usage[0].outputTokens).toBeGreaterThan(0)
  expect(usage[0].costUsd).toBeGreaterThan(0)
  expect(typeof usage[0].model).toBe('string')
}, 60_000)

test('2.7: a closed session resumes with full context on the next push', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)
  const sessionId = 'test-session-resume'

  await runTurnInFolder(
    sessionTmpDir,
    1,
    'Remember this secret word: pineapple. Just acknowledge, nothing else.',
    () => {},
    sessionId,
  )

  // Simulate what 2.5's idle-timeout/kill flow does: close the session
  // between turns, same as if the app had been sitting idle.
  await killSession(sessionId)
  expect(getStatus(sessionId)).toBe('closed')
  reopenSession(sessionId)

  const turnNumber = startTurn(sessionId)
  let finalReply = ''
  await runTurnInFolder(
    sessionTmpDir,
    turnNumber === false ? 0 : turnNumber,
    'What was the secret word I told you? Reply with just the word.',
    (message) => {
      const m = message as { type?: string; result?: string }
      if (m.type === 'result' && m.result) finalReply = m.result
    },
    sessionId,
  )

  expect(finalReply.toLowerCase()).toContain('pineapple')
}, 60_000)

let sessionsRootTmpDir: string

afterEach(async () => {
  if (sessionsRootTmpDir) {
    await rm(sessionsRootTmpDir, { recursive: true, force: true })
  }
})

test('listSessions combines metadata.json with in-memory status, defaulting to closed', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const untouched = await createSession(templateDir, sessionsRootTmpDir)
  const running = await createSession(templateDir, sessionsRootTmpDir)

  // Simulate: this process has an active turn for `running`, but has never
  // touched `untouched` at all (e.g. the app just started).
  startTurn(running.sessionId)

  const summaries = await listSessions(sessionsRootTmpDir)
  expect(summaries).toHaveLength(2)

  const untouchedSummary = summaries.find(
    (s) => s.sessionId === untouched.sessionId,
  )
  const runningSummary = summaries.find(
    (s) => s.sessionId === running.sessionId,
  )

  expect(untouchedSummary?.status).toBe('closed')
  expect(runningSummary?.status).toBe('running')
})

test('listSessions returns [] for a sessions root that does not exist yet', async () => {
  const summaries = await listSessions('/tmp/open-test-does-not-exist-xyz')
  expect(summaries).toEqual([])
})

test('updateSessionDescription changes the description listSessions returns', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const { sessionId } = await createSession(templateDir, sessionsRootTmpDir, {
    description: 'first label',
  })

  await updateSessionDescription(sessionsRootTmpDir, sessionId, 'edited label')

  const summaries = await listSessions(sessionsRootTmpDir)
  const summary = summaries.find((s) => s.sessionId === sessionId)
  expect(summary?.description).toBe('edited label')
})

test('createSession honors a custom sessionId and stored description', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const { sessionId } = await createSession(templateDir, sessionsRootTmpDir, {
    sessionId: 'my-custom-session',
    description: 'Checkout flow smoke test',
  })
  expect(sessionId).toBe('my-custom-session')

  const summaries = await listSessions(sessionsRootTmpDir)
  const summary = summaries.find((s) => s.sessionId === 'my-custom-session')
  expect(summary?.description).toBe('Checkout flow smoke test')
})

test('a session created with no description exposes an empty one (renderer shows the date)', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const { sessionId } = await createSession(templateDir, sessionsRootTmpDir)

  const summaries = await listSessions(sessionsRootTmpDir)
  const summary = summaries.find((s) => s.sessionId === sessionId)
  expect(summary?.description).toBe('')
})

async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let message: string | null = null
  try {
    await promise
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).not.toBeNull()
  expect(message).toMatch(pattern)
}

test('createSession rejects a duplicate sessionId', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  await createSession(templateDir, sessionsRootTmpDir, { sessionId: 'dupe' })
  await expectRejection(
    createSession(templateDir, sessionsRootTmpDir, { sessionId: 'dupe' }),
    /already exists/,
  )
})

test('createSession rejects an unsafe sessionId (path traversal / separators)', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  await expectRejection(
    createSession(templateDir, sessionsRootTmpDir, { sessionId: '../escape' }),
    /invalid session id/i,
  )
  await expectRejection(
    createSession(templateDir, sessionsRootTmpDir, { sessionId: 'a/b' }),
    /invalid session id/i,
  )
})

test('createSession with no options falls back to a generated id', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const { sessionId } = await createSession(templateDir, sessionsRootTmpDir)
  expect(sessionId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{4}$/)
})

test('listSessions skips a malformed metadata.json instead of throwing (advisor-found bug)', async () => {
  sessionsRootTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-root-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )

  const good = await createSession(templateDir, sessionsRootTmpDir)

  // A folder with genuinely broken metadata.json — the kind of thing that
  // used to take the whole listing down with it.
  const badDir = path.join(sessionsRootTmpDir, 'broken-session')
  await mkdir(badDir, { recursive: true })
  await writeFile(path.join(badDir, 'metadata.json'), '{ not valid json')

  const summaries = await listSessions(sessionsRootTmpDir)

  expect(summaries).toHaveLength(1)
  expect(summaries[0].sessionId).toBe(good.sessionId)
})

test('hydrateSessionFromDisk restores claudeSessionId and continues turnCount after a simulated restart', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  // Simulate a session that already had 2 turns and a real
  // claudeSessionId, written to disk in a previous process lifetime.
  const metadataPath = path.join(sessionTmpDir, 'metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'))
  metadata.claude_session_id = 'fake-claude-session-id'
  await writeFile(metadataPath, JSON.stringify(metadata))
  await mkdir(path.join(sessionTmpDir, 'output', 'turn-1'), {
    recursive: true,
  })
  await mkdir(path.join(sessionTmpDir, 'output', 'turn-2'), {
    recursive: true,
  })

  const sessionId = 'test-session-restart-hydrate'
  expect(getStatus(sessionId)).toBeUndefined() // never touched by this process

  await hydrateSessionFromDisk(sessionId, sessionTmpDir)

  expect(getStatus(sessionId)).toBe('closed')
  expect(getClaudeSessionId(sessionId)).toBe('fake-claude-session-id')

  reopenSession(sessionId)
  expect(startTurn(sessionId)).toBe(3) // continues from 2, not restarting at 1
})

test('4.2: a live turn drives playwright-cli via Bash and saves a real screenshot into output/turn-n/', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  let finalReply = ''
  await runTurnInFolder(
    sessionTmpDir,
    1,
    'Use the Bash tool to run these exact commands in order: ' +
      '`playwright-cli open https://example.com`, then ' +
      '`playwright-cli screenshot --filename output/turn-1/example.png`, then ' +
      '`playwright-cli close`. Reply with just the page title you saw, nothing else.',
    (message) => {
      const m = message as { type?: string; result?: string }
      if (m.type === 'result' && m.result) finalReply = m.result
    },
    'test-session-live-playwright',
  )

  expect(finalReply).toContain('Example Domain')

  const screenshotPath = path.join(
    sessionTmpDir,
    'output',
    'turn-1',
    'example.png',
  )
  expect(existsSync(screenshotPath)).toBe(true)
  const contents = await readFile(screenshotPath)
  expect(contents.length).toBeGreaterThan(0)
}, 120_000)

test('4.4: a live turn writes a readable report.md verdict into output/turn-n/', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  await runTurnInFolder(
    sessionTmpDir,
    1,
    'This is a trivial test: 2 + 2 should equal 4. Decide whether it passes, ' +
      'then use the Write tool to save your verdict as a markdown file at ' +
      'output/turn-1/report.md. Include the word PASS or FAIL in it.',
    () => {},
    'test-session-report-verdict',
  )

  const reportPath = path.join(sessionTmpDir, 'output', 'turn-1', 'report.md')
  expect(existsSync(reportPath)).toBe(true)
  const report = await readFile(reportPath, 'utf-8')
  expect(report.length).toBeGreaterThan(0)
  expect(/pass|fail/i.test(report)).toBe(true)
}, 120_000)

test('listLatestArtifacts finds the highest-numbered turn folder and lists its files', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  await mkdir(path.join(sessionTmpDir, 'output', 'turn-1'), {
    recursive: true,
  })
  await writeFile(
    path.join(sessionTmpDir, 'output', 'turn-1', 'old.png'),
    'old',
  )

  await mkdir(path.join(sessionTmpDir, 'output', 'turn-2'), {
    recursive: true,
  })
  await writeFile(
    path.join(sessionTmpDir, 'output', 'turn-2', 'screenshot.png'),
    'fake-png-bytes',
  )
  await writeFile(
    path.join(sessionTmpDir, 'output', 'turn-2', 'report.md'),
    '# verdict',
  )

  const result = await listLatestArtifacts(sessionTmpDir)

  expect(result.turn).toBe(2)
  expect(result.files.map((f) => f.name)).toEqual([
    'report.md',
    'screenshot.png',
  ])
  expect(result.files[0].path).toBe(
    path.join(sessionTmpDir, 'output', 'turn-2', 'report.md'),
  )
})

test('listLatestArtifacts returns turn 0 and no files for a session with no turns yet', async () => {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
  const templateDir = path.join(
    import.meta.dir,
    '../../assets/session-template',
  )
  await createSessionFolder('test-session', templateDir, sessionTmpDir)

  const result = await listLatestArtifacts(sessionTmpDir)
  expect(result).toEqual({ turn: 0, files: [] })
})
