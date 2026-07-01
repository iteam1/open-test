import { test, expect, afterEach } from 'bun:test'
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  mkdir,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSessionFolder, runTurnInFolder } from './claudeRunner'
import { startTurn, endTurn, getClaudeSessionId } from '../core/session/session'

// Real API turns proving Phase 6's config/extensibility wiring: that a
// session's own .claude/skills and .claude/agents are actually discovered
// and used by Claude Code (via cwd), which only a live turn can show.

let sessionTmpDir: string
const templateDir = path.join(import.meta.dir, '../../assets/session-template')

afterEach(async () => {
  if (sessionTmpDir) await rm(sessionTmpDir, { recursive: true, force: true })
})

async function freshSession(id: string) {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'config-live-'))
  await createSessionFolder(id, templateDir, sessionTmpDir)
  return sessionTmpDir
}

test('6.2/6.5: an arbitrary skill dropped in a session is used, and writes to the output folder it defines', async () => {
  const sessionId = 'config-skill-test'
  const dir = await freshSession(sessionId)

  // Drop a skill that isn't one of the shipped ones — proving generic
  // pickup (6.2) — and whose own definition names a custom output folder
  // (6.5).
  const skillDir = path.join(dir, '.claude', 'skills', 'marker-check')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: marker-check
description: Diagnostic. When asked to run the marker check, write the exact text MARKER-OK into output/marker-check/result.txt (creating that folder), then reply DONE.
---

# marker-check

When asked to run the marker check:
1. Create the folder \`output/marker-check/\` if needed.
2. Write exactly \`MARKER-OK\` into \`output/marker-check/result.txt\`.
3. Reply with just \`DONE\`.
`,
  )

  startTurn(sessionId)
  await runTurnInFolder(dir, 1, 'Run the marker check.', () => {}, sessionId)
  endTurn(sessionId, Date.now())

  // 6.5: the artifact landed in the folder the skill's own definition named.
  const resultPath = path.join(dir, 'output', 'marker-check', 'result.txt')
  expect(existsSync(resultPath)).toBe(true)
  // 6.2: the skill was actually followed (its marker is there).
  const contents = await readFile(resultPath, 'utf-8')
  expect(contents).toContain('MARKER-OK')
}, 90_000)

test('6.3/6.4: dispatches to the a11y-reader subagent, which runs on the cheap (haiku) model', async () => {
  const sessionId = 'config-subagent-test'
  const dir = await freshSession(sessionId)

  // Something for the read-only subagent to read.
  await writeFile(
    path.join(dir, 'input', 'note.txt'),
    'The secret inspection code is BLUEBIRD-42.',
  )

  startTurn(sessionId)
  let reply = ''
  await runTurnInFolder(
    dir,
    1,
    'Use the a11y-reader subagent to read input/note.txt and report the secret inspection code it contains. Reply with just that code.',
    (m) => {
      const msg = m as { type?: string; result?: string }
      if (msg.type === 'result' && msg.result) reply = msg.result
    },
    sessionId,
  )
  endTurn(sessionId, Date.now())

  // 6.3: the subagent actually did the read and reported back.
  expect(reply).toContain('BLUEBIRD-42')

  // 6.4: a subagent transcript exists and shows the cheap model — usage.json
  // can't show this (its model field is per-turn, not per-subagent-call).
  const claudeSessionId = getClaudeSessionId(sessionId)
  expect(claudeSessionId).not.toBeNull()
  const slug = dir.replace(/\//g, '-')
  const subagentsDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    slug,
    claudeSessionId!,
    'subagents',
  )
  expect(existsSync(subagentsDir)).toBe(true)
  const files = (await readdir(subagentsDir)).filter((f) =>
    f.endsWith('.jsonl'),
  )
  expect(files.length).toBeGreaterThan(0)

  // Parse each transcript and inspect the actual assistant-message `model`
  // field — not a raw substring search, which could match "haiku" appearing
  // anywhere (a prompt, a tool description). Only a real model id counts.
  const models: string[] = []
  for (const f of files) {
    const raw = await readFile(path.join(subagentsDir, f), 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const model = entry?.message?.model ?? entry?.model
        if (typeof model === 'string') models.push(model)
      } catch {
        continue
      }
    }
  }
  expect(models.length).toBeGreaterThan(0)
  expect(models.some((m) => m.includes('haiku'))).toBe(true)
}, 120_000)
