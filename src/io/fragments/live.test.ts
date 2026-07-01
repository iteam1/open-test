import { test, expect, afterEach, beforeAll } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createSessionFolder, runTurnInFolder } from '../claudeRunner'
import { startTurn, endTurn } from '../../core/session/session'

// These make real API calls AND drive a real browser via the in-process
// fragment tools. They prove Phase 5's end-to-end wiring (5.1, 5.9, 5.10),
// which the unit/integration tests above can't: that the tools are actually
// reachable from a live session and that using them is recorded.

let sessionTmpDir: string
let fragmentsTmpDir: string
let fixtureUrl: string
const templateDir = path.join(
  import.meta.dir,
  '../../../assets/session-template',
)

beforeAll(async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'live-fixture-'))
  const fixturePath = path.join(fixtureDir, 'page.html')
  await writeFile(
    fixturePath,
    `<!doctype html><html><body><h1 id="title">Fragment Fixture Page</h1></body></html>`,
  )
  fixtureUrl = `file://${fixturePath}`
})

afterEach(async () => {
  if (sessionTmpDir) await rm(sessionTmpDir, { recursive: true, force: true })
  if (fragmentsTmpDir)
    await rm(fragmentsTmpDir, { recursive: true, force: true })
})

async function freshSession(): Promise<{
  sessionDir: string
  sessionId: string
}> {
  sessionTmpDir = await mkdtemp(path.join(os.tmpdir(), 'live-session-'))
  fragmentsTmpDir = await mkdtemp(path.join(os.tmpdir(), 'live-fragments-'))
  const sessionId = `live-${Math.random().toString(16).slice(2, 8)}`
  await createSessionFolder(sessionId, templateDir, sessionTmpDir)
  return { sessionDir: sessionTmpDir, sessionId }
}

test('5.1: a turn runs fine with the fragment server attached (no regression)', async () => {
  const { sessionDir, sessionId } = await freshSession()
  startTurn(sessionId)
  let reply = ''
  await runTurnInFolder(
    sessionDir,
    1,
    'Reply with exactly the word READY and nothing else.',
    (m) => {
      const msg = m as { type?: string; result?: string }
      if (msg.type === 'result' && msg.result) reply = msg.result
    },
    sessionId,
    fragmentsTmpDir,
  )
  endTurn(sessionId, Date.now())
  expect(reply.toUpperCase()).toContain('READY')

  const usage = JSON.parse(
    await readFile(path.join(sessionDir, 'usage.json'), 'utf-8'),
  )
  expect(usage).toHaveLength(1)
  expect(usage[0].usedFragmentTool).toBe(false) // no fragment tool used this turn
}, 60_000)

test('5.9/5.10: save_fragment then run_fragment across two turns — tools reachable, usedFragmentTool set, reuse cheaper', async () => {
  const { sessionDir, sessionId } = await freshSession()

  // Turn 1: save a fragment via the save_fragment tool. It cold-runs the
  // code against url_pattern in a fresh browser before persisting.
  startTurn(sessionId)
  await runTurnInFolder(
    sessionDir,
    1,
    `Call the save_fragment tool with exactly these arguments and nothing else afterward: ` +
      `name "read-fixture-title", description "Reads the fixture page title", ` +
      `scope "specific", url_pattern "${fixtureUrl}", tags ["fixture"], params [], ` +
      `code "export async function run(page) { await page.goto('${fixtureUrl}'); return await page.textContent('#title') }". ` +
      `Then reply with just DONE.`,
    () => {},
    sessionId,
    fragmentsTmpDir,
  )
  endTurn(sessionId, Date.now())

  // The fragment must have been written by the tool.
  const files = (await readdir(fragmentsTmpDir)).filter((f) =>
    f.endsWith('.md'),
  )
  expect(files).toContain('read-fixture-title.md')

  const usageAfter1 = JSON.parse(
    await readFile(path.join(sessionDir, 'usage.json'), 'utf-8'),
  )
  expect(usageAfter1[0].usedFragmentTool).toBe(true) // 5.10: derived from a real transcript

  // Turn 2: find and run it via match_fragments + run_fragment.
  const turn2 = startTurn(sessionId)
  let reply = ''
  await runTurnInFolder(
    sessionDir,
    turn2 === false ? 2 : turn2,
    `Call match_fragments with url "${fixtureUrl}". Then call run_fragment on the ` +
      `fragment it returns (no args). Reply with just the value run_fragment returned.`,
    (m) => {
      const msg = m as { type?: string; result?: string }
      if (msg.type === 'result' && msg.result) reply = msg.result
    },
    sessionId,
    fragmentsTmpDir,
  )
  endTurn(sessionId, Date.now())

  expect(reply).toContain('Fragment Fixture Page') // the fragment actually executed

  const usageAfter2 = JSON.parse(
    await readFile(path.join(sessionDir, 'usage.json'), 'utf-8'),
  )
  expect(usageAfter2).toHaveLength(2)
  expect(usageAfter2[1].usedFragmentTool).toBe(true)

  // run_fragment recorded a successful use on the fragment.
  const rawMd = await readFile(
    path.join(fragmentsTmpDir, 'read-fixture-title.md'),
    'utf-8',
  )
  expect(rawMd).toContain('use_count: 1')
}, 120_000)
