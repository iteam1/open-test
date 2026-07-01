import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSessionFolder, runTurn } from './claudeRunner'

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

test(
  'runTurn sets cwd so Claude Code mirrors the transcript under ~/.claude/projects',
  async () => {
    sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'open-test-'))
    const templateDir = path.join(
      import.meta.dir,
      '../../assets/session-template',
    )
    await createSessionFolder('test-session', templateDir, sessionTmpDir)

    await runTurn(sessionTmpDir)

    const slug = sessionTmpDir.replace(/\//g, '-')
    const projectDir = path.join(os.homedir(), '.claude', 'projects', slug)
    expect(existsSync(projectDir)).toBe(true)

    const files = await readdir(projectDir)
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true)
  },
  30_000,
)
