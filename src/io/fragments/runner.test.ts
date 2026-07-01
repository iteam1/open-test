import { test, expect, afterEach, beforeAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FragmentStore, type Fragment } from './store'
import { SessionBrowser } from './browser'
import { runFragment, saveFragment } from './runner'

let tmpDir: string
let fixtureUrl: string
const browser = new SessionBrowser()

beforeAll(async () => {
  // A local fixture page (design.md 5.4: "against a local fixture HTML
  // page"). file:// avoids standing up a server in the test.
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'fixture-'))
  const fixturePath = path.join(fixtureDir, 'page.html')
  await writeFile(
    fixturePath,
    `<!doctype html><html><body>
       <h1 id="title">Fixture</h1>
       <input id="field" />
       <button id="go" onclick="document.getElementById('title').textContent='clicked'">Go</button>
     </body></html>`,
  )
  fixtureUrl = `file://${fixturePath}`
})

afterEach(async () => {
  await browser.resetContext()
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function makeStore(): Promise<FragmentStore> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fragments-'))
  return new FragmentStore(tmpDir)
}

function fragment(overrides: Partial<Fragment['meta']> = {}, code?: string): Fragment {
  return {
    meta: {
      name: 'read-title',
      description: 'Reads the page title text',
      scope: 'specific',
      url_pattern: 'file://*',
      tags: ['read'],
      params: [],
      verified_at: '2026-07-01',
      use_count: 0,
      last_used_at: null,
      consecutive_failures: 0,
      needs_reverification: false,
      ...overrides,
    },
    prose: 'Reads #title.',
    code:
      code ??
      `export async function run(page) {\n  return await page.textContent('#title')\n}`,
  }
}

test('5.4: run_fragment executes against the shared page and bumps use_count/last_used_at', async () => {
  const store = await makeStore()
  await store.write(fragment())

  const page = await browser.getPage()
  await page.goto(fixtureUrl)

  const result = await runFragment(store, browser, 'read-title', {})
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toBe('Fixture')

  const updated = await store.get('read-title')
  expect(updated?.meta.use_count).toBe(1)
  expect(updated?.meta.last_used_at).not.toBeNull()
  expect(updated?.meta.consecutive_failures).toBe(0)
}, 30_000)

test('5.4: a failing run increments consecutive_failures and returns ok:false (no throw)', async () => {
  const store = await makeStore()
  await store.write(
    fragment(
      { name: 'bad-selector' },
      `export async function run(page) {\n  await page.click('#does-not-exist', { timeout: 1000 })\n}`,
    ),
  )

  const page = await browser.getPage()
  await page.goto(fixtureUrl)

  const result = await runFragment(store, browser, 'bad-selector', {})
  expect(result.ok).toBe(false)

  const updated = await store.get('bad-selector')
  expect(updated?.meta.consecutive_failures).toBe(1)
  expect(updated?.meta.use_count).toBe(0)
}, 30_000)

test('5.5: save_fragment cold-run gate accepts a working fragment', async () => {
  const store = await makeStore()

  const result = await saveFragment(
    store,
    browser,
    {
      name: 'read-title',
      description: 'Reads the title',
      scope: 'specific',
      url_pattern: 'file://*',
      tags: ['read'],
      params: [],
      code: `export async function run(page) {\n  return await page.textContent('#title')\n}`,
    },
    fixtureUrl,
  )

  expect(result.ok).toBe(true)
  if (result.ok) expect(result.updated).toBe(false)
  expect((await store.get('read-title'))?.meta.name).toBe('read-title')
}, 30_000)

test('5.5: save_fragment rejects a fragment whose cold run fails, and writes nothing', async () => {
  const store = await makeStore()

  const result = await saveFragment(
    store,
    browser,
    {
      name: 'broken',
      description: 'Clicks a missing element',
      scope: 'specific',
      url_pattern: 'file://*',
      tags: ['read'],
      params: [],
      code: `export async function run(page) {\n  await page.click('#missing', { timeout: 1000 })\n}`,
    },
    fixtureUrl,
  )

  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('Cold-run verification failed')
  expect(await store.get('broken')).toBeNull()
}, 30_000)

test('5.6: saving a near-match (same url_pattern + overlapping tags) updates in place, no new file', async () => {
  const store = await makeStore()
  await store.write(fragment({ name: 'read-title', use_count: 9 }))

  const result = await saveFragment(
    store,
    browser,
    {
      // Different name, but same url_pattern + overlapping tag → near-match.
      name: 'read-heading',
      description: 'Reads the heading (updated)',
      scope: 'specific',
      url_pattern: 'file://*',
      tags: ['read'],
      params: [],
      code: `export async function run(page) {\n  return await page.textContent('#title')\n}`,
    },
    fixtureUrl,
  )

  expect(result.ok).toBe(true)
  if (result.ok) expect(result.updated).toBe(true)

  const all = await store.list()
  expect(all).toHaveLength(1) // updated in place, not duplicated
  expect(all[0].meta.name).toBe('read-title') // kept the existing identity
  expect(all[0].meta.description).toBe('Reads the heading (updated)')
  expect(all[0].meta.use_count).toBe(9) // usage history preserved through the update
}, 30_000)

test('5.6: an in-place update that changes code cascades needs_reverification to importers', async () => {
  const store = await makeStore()
  await store.write(fragment({ name: 'read-title', use_count: 1 }))
  await store.write(
    fragment(
      { name: 'composite', url_pattern: 'file://*', tags: ['combo'] },
      `import { run as read } from 'fragment:read-title'\nexport async function run(page) {\n  return await read(page)\n}`,
    ),
  )

  const result = await saveFragment(
    store,
    browser,
    {
      name: 'read-title',
      description: 'Reads the title, revised',
      scope: 'specific',
      url_pattern: 'file://*',
      tags: ['read'],
      params: [],
      // Changed code → new content hash → importers must re-verify.
      code: `export async function run(page) {\n  const t = await page.textContent('#title')\n  return t.trim()\n}`,
    },
    fixtureUrl,
  )

  expect(result.ok).toBe(true)
  if (result.ok) expect(result.reverified).toContain('composite')
  expect((await store.get('composite'))?.meta.needs_reverification).toBe(true)
}, 30_000)

test('5.11: a composite runs via fragment: import, reusing the dependency', async () => {
  const store = await makeStore()
  await store.write(fragment({ name: 'read-title' }))
  await store.write(
    fragment(
      { name: 'composite', tags: ['combo'] },
      `import { run as read } from 'fragment:read-title'\nexport async function run(page) {\n  const t = await read(page)\n  return 'composite saw: ' + t\n}`,
    ),
  )

  const page = await browser.getPage()
  await page.goto(fixtureUrl)

  const result = await runFragment(store, browser, 'composite', {})
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toBe('composite saw: Fixture')
}, 30_000)
