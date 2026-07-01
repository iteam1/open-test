import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  parseFragment,
  serializeFragment,
  contentHash,
  FragmentStore,
  MAX_CONSECUTIVE_FAILURES,
  type Fragment,
} from './store'
import { matchFragments, urlMatches, SHORTLIST_CAP } from './match'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function makeStore(): Promise<FragmentStore> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fragments-'))
  return new FragmentStore(tmpDir)
}

function fixture(
  overrides: Partial<Fragment['meta']> = {},
  code?: string,
): Fragment {
  return {
    meta: {
      name: 'login-flow',
      description: 'Logs into example.com',
      scope: 'specific',
      url_pattern: 'https://example.com/login*',
      tags: ['auth'],
      params: [
        {
          name: 'username',
          type: 'string',
          required: true,
          description: 'Login email',
        },
      ],
      verified_at: '2026-07-01',
      use_count: 0,
      last_used_at: null,
      consecutive_failures: 0,
      needs_reverification: false,
      ...overrides,
    },
    prose: 'Use this when a test needs to be logged in first.',
    code:
      code ??
      `export async function run(page, { username }) {\n  await page.fill('#username', username)\n}`,
  }
}

// The exact file shape from contribute.md, verbatim-ish — parse must handle it.
const CONTRIBUTE_MD_EXAMPLE = `---
name: login-flow
description: Logs into example.com
scope: specific
url_pattern: 'https://example.com/login*'
tags: [auth]
params:
  - name: username
    type: string
    required: true
    description: Login email or username
verified_at: 2026-07-01
use_count: 0
last_used_at: null
consecutive_failures: 0
needs_reverification: false
---

Use this when a test needs to be logged in first.

\`\`\`js
export async function run(page, { username }) {
  await page.fill('#username', username)
}
\`\`\`
`

test('parseFragment handles the contribute.md file format', () => {
  const fragment = parseFragment(CONTRIBUTE_MD_EXAMPLE)
  expect(fragment.meta.name).toBe('login-flow')
  expect(fragment.meta.scope).toBe('specific')
  expect(fragment.meta.tags).toEqual(['auth'])
  expect(fragment.meta.params[0].name).toBe('username')
  expect(fragment.meta.verified_at).toBe('2026-07-01') // unquoted YAML date normalized back to a string
  expect(fragment.meta.last_used_at).toBeNull()
  expect(fragment.prose).toContain('logged in first')
  expect(fragment.code).toContain("page.fill('#username', username)")
})

test('serializeFragment round-trips through parseFragment', () => {
  const original = fixture({
    use_count: 7,
    last_used_at: '2026-07-02T00:00:00.000Z',
  })
  const roundTripped = parseFragment(serializeFragment(original))
  expect(roundTripped).toEqual(original)
})

test('parseFragment rejects files missing frontmatter or the code fence', () => {
  expect(() => parseFragment('no frontmatter here')).toThrow(/frontmatter/)
  expect(() =>
    parseFragment(
      '---\nname: x\ndescription: d\nscope: common\nurl_pattern: ""\n---\nprose only',
    ),
  ).toThrow(/code fence/)
})

test('store.write + store.get round-trip; write is atomic (no partial/temp files left)', async () => {
  const store = await makeStore()
  await store.write(fixture())

  const loaded = await store.get('login-flow')
  expect(loaded?.meta.name).toBe('login-flow')

  const leftovers = (await readdir(tmpDir)).filter((f) => f.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test('5.8: two concurrent writers to the same fragment leave a valid, parseable file', async () => {
  const store = await makeStore()
  const a = fixture({ use_count: 100 })
  const b = fixture({ use_count: 200 })

  // Interleave many concurrent writes — under non-atomic writes this tears.
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => store.write(i % 2 === 0 ? a : b)),
  )

  const raw = await readFile(path.join(tmpDir, 'login-flow.md'), 'utf-8')
  const parsed = parseFragment(raw) // throws if torn
  expect([100, 200]).toContain(parsed.meta.use_count)
})

test('5.3: extract writes a .js keyed by content hash, and the 2nd call is a cache hit', async () => {
  const store = await makeStore()
  const fragment = fixture()
  await store.write(fragment)

  const jsPath = await store.extract(fragment)
  expect(jsPath).toContain(contentHash(fragment.code))
  const js = await readFile(jsPath, 'utf-8')
  expect(js).toBe(fragment.code)

  const mtimeBefore = statSync(jsPath).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  const jsPath2 = await store.extract(fragment)
  expect(jsPath2).toBe(jsPath)
  expect(statSync(jsPath).mtimeMs).toBe(mtimeBefore) // untouched — real cache hit

  // Different code, different cache entry.
  const changed = fixture(
    {},
    'export async function run(page) { /* changed */ }',
  )
  const jsPath3 = await store.extract(changed)
  expect(jsPath3).not.toBe(jsPath)
})

test('5.11: extract resolves fragment:<name> imports to the dependency extraction path', async () => {
  const store = await makeStore()
  const dep = fixture({ name: 'login-flow' })
  await store.write(dep)

  const composite = fixture(
    {
      name: 'checkout-composite',
      url_pattern: 'https://example.com/*',
      tags: ['checkout'],
    },
    `import { run as login } from 'fragment:login-flow'\nexport async function run(page, args) {\n  await login(page, args)\n}`,
  )
  await store.write(composite)

  const jsPath = await store.extract(composite)
  const js = await readFile(jsPath, 'utf-8')
  const depPath = await store.extract(dep)
  expect(js).toContain(JSON.stringify(depPath))
  expect(js).not.toContain('fragment:login-flow')
})

test('advisor #1: a composite re-extracts against a dependency whose code changed (no stale cache)', async () => {
  const store = await makeStore()
  await store.write(
    fixture({ name: 'dep' }, `export async function run(page) { return 'V1' }`),
  )
  const composite = fixture(
    {
      name: 'composite',
      url_pattern: 'https://example.com/*',
      tags: ['combo'],
    },
    `import { run as dep } from 'fragment:dep'\nexport async function run(page) { return dep(page) }`,
  )
  await store.write(composite)

  const pathBefore = await store.extract(composite)
  const jsBefore = await readFile(pathBefore, 'utf-8')

  // Change the dependency's code. The composite's own text is unchanged.
  await store.write(
    fixture(
      { name: 'dep' },
      `export async function run(page) { return 'V2-CHANGED' }`,
    ),
  )

  const pathAfter = await store.extract(composite)
  // The composite must get a NEW extraction keyed on the changed dep, and
  // its new file must import the dep's new extraction (not the old one).
  expect(pathAfter).not.toBe(pathBefore)
  const depPathAfter = await store.extract(
    await store.get('dep').then((f) => f!),
  )
  const jsAfter = await readFile(pathAfter, 'utf-8')
  expect(jsAfter).toContain(JSON.stringify(depPathAfter))
  expect(jsAfter).not.toBe(jsBefore)
})

test('extract throws a named error for a fragment: import that does not exist', async () => {
  const store = await makeStore()
  const broken = fixture(
    { name: 'broken-composite' },
    `import { run } from 'fragment:no-such-fragment'`,
  )
  let message = ''
  try {
    await store.extract(broken)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toContain('fragment:no-such-fragment')
})

test('5.7: recordRunSuccess bumps use_count/last_used_at and resets consecutive_failures', async () => {
  const store = await makeStore()
  await store.write(fixture({ consecutive_failures: 2, use_count: 5 }))

  await store.recordRunSuccess('login-flow')

  const updated = await store.get('login-flow')
  expect(updated?.meta.use_count).toBe(6)
  expect(updated?.meta.consecutive_failures).toBe(0)
  expect(updated?.meta.last_used_at).not.toBeNull()
})

test('5.7: the 3rd consecutive failure retires the fragment (needs_reverification)', async () => {
  const store = await makeStore()
  await store.write(fixture())

  for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
    await store.recordRunFailure('login-flow')
    const current = await store.get('login-flow')
    expect(current?.meta.consecutive_failures).toBe(i)
    expect(current?.meta.needs_reverification).toBe(
      i >= MAX_CONSECUTIVE_FAILURES,
    )
  }
})

test('5.6/5.7: markImportersForReverification cascades to fragments importing by fragment: name', async () => {
  const store = await makeStore()
  await store.write(fixture({ name: 'login-flow' }))
  await store.write(
    fixture(
      { name: 'checkout-composite' },
      `import { run as login } from 'fragment:login-flow'\nexport async function run() {}`,
    ),
  )
  await store.write(fixture({ name: 'unrelated', url_pattern: '' }))

  const cascaded = await store.markImportersForReverification('login-flow')

  expect(cascaded).toEqual(['checkout-composite'])
  expect(
    (await store.get('checkout-composite'))?.meta.needs_reverification,
  ).toBe(true)
  expect((await store.get('unrelated'))?.meta.needs_reverification).toBe(false)
})

test('one malformed .md file does not take down list()', async () => {
  const store = await makeStore()
  await store.write(fixture())
  const badPath = path.join(tmpDir, 'broken.md')
  await Bun.write(badPath, 'not a fragment at all')
  expect(existsSync(badPath)).toBe(true)

  const all = await store.list()
  expect(all.map((f) => f.meta.name)).toEqual(['login-flow'])
})

// ---- match.ts (5.2) ----

test('urlMatches: glob star, exact, and empty-pattern-matches-all', () => {
  expect(
    urlMatches(
      'https://example.com/login*',
      'https://example.com/login?next=/',
    ),
  ).toBe(true)
  expect(
    urlMatches('https://example.com/login*', 'https://example.com/cart'),
  ).toBe(false)
  expect(urlMatches('', 'https://anything.example')).toBe(true)
  // Regex metacharacters in the pattern are literal, not regex.
  expect(
    urlMatches('https://example.com/a?b=c', 'https://example.com/a?b=c'),
  ).toBe(true)
  expect(
    urlMatches('https://example.com/a?b=c', 'https://example.com/aXb=c'),
  ).toBe(false)
})

test('5.2: filters by URL and tags, skips needs_reverification, ranks by use_count then recency', () => {
  const fragments = [
    fixture({ name: 'retired', use_count: 99, needs_reverification: true }),
    fixture({
      name: 'popular',
      use_count: 10,
      last_used_at: '2026-01-01T00:00:00Z',
    }),
    fixture({
      name: 'recent',
      use_count: 3,
      last_used_at: '2026-07-01T00:00:00Z',
    }),
    fixture({
      name: 'tie-recent',
      use_count: 3,
      last_used_at: '2026-07-02T00:00:00Z',
    }),
    fixture({ name: 'wrong-url', url_pattern: 'https://other.example/*' }),
    fixture({ name: 'wrong-tag', tags: ['payments'] }),
  ]

  const result = matchFragments(fragments, 'https://example.com/login', [
    'auth',
  ])
  expect(result.map((f) => f.meta.name)).toEqual([
    'popular',
    'tie-recent',
    'recent',
  ])
})

test('5.2: scope specific always outranks common when both match, regardless of usage', () => {
  const fragments = [
    fixture({
      name: 'common-heavy',
      scope: 'common',
      url_pattern: '',
      use_count: 1000,
    }),
    fixture({ name: 'specific-fresh', use_count: 0 }),
  ]

  const result = matchFragments(fragments, 'https://example.com/login', [
    'auth',
  ])
  expect(result.map((f) => f.meta.name)).toEqual([
    'specific-fresh',
    'common-heavy',
  ])
})

test('5.2: shortlist is hard-capped', () => {
  const fragments = Array.from({ length: SHORTLIST_CAP + 5 }, (_, i) =>
    fixture({ name: `f${i}`, use_count: i }),
  )
  const result = matchFragments(fragments, 'https://example.com/login')
  expect(result).toHaveLength(SHORTLIST_CAP)
  expect(result[0].meta.name).toBe(`f${SHORTLIST_CAP + 4}`) // highest use_count first
})
