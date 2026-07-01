import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSessionFolder, runTurn, runTurnInFolder } from './claudeRunner'
import {
  killSession,
  getStatus,
  reopenSession,
  startTurn,
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
}, 30_000)

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
}, 30_000)

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
}, 30_000)

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
