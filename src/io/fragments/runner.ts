import type { Page } from 'playwright'
import { FragmentStore, type Fragment, type FragmentMeta } from './store'
import { SessionBrowser } from './browser'

/** A fragment module is the JS extracted from its code fence — one `run(page, args)` export. */
type FragmentModule = {
  run: (page: Page, args: Record<string, unknown>) => Promise<unknown>
}

async function loadRun(jsPath: string): Promise<FragmentModule['run']> {
  // Cache-bust so an updated fragment (same name, new hash → new path) is
  // never served from a stale module cache. Paths already differ by hash,
  // but a re-extraction to the same path after clearCache still needs this.
  const mod = (await import(`${jsPath}?t=${Date.now()}`)) as FragmentModule
  if (typeof mod.run !== 'function') {
    throw new Error(`Fragment at ${jsPath} has no exported run() function`)
  }
  return mod.run
}

export type RunResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * run_fragment (5.4): extract the cached .js by content hash, execute its
 * run() against the session's shared page, and update metadata. A pass
 * bumps use_count/last_used_at and resets consecutive_failures; a failure
 * increments consecutive_failures (retiring at 3) AND resets the shared
 * context so stale partial state doesn't leak into the next call
 * (contribute.md). The failure is returned, not thrown — a failed fragment
 * falls back to live execution in the same turn.
 */
export async function runFragment(
  store: FragmentStore,
  browser: SessionBrowser,
  name: string,
  args: Record<string, unknown>,
): Promise<RunResult> {
  const fragment = await store.get(name)
  if (!fragment) return { ok: false, error: `Fragment "${name}" not found` }

  try {
    const jsPath = await store.extract(fragment)
    const run = await loadRun(jsPath)
    const page = await browser.getPage()
    const value = await run(page, args)
    await store.recordRunSuccess(name)
    return { ok: true, value }
  } catch (err) {
    await store.recordRunFailure(name)
    await browser.resetContext()
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type SaveFragmentInput = {
  name: string
  description: string
  scope: 'specific' | 'common'
  url_pattern: string
  tags: string[]
  params: FragmentMeta['params']
  code: string
}

export type SaveResult =
  | { ok: true; updated: boolean; reverified: string[] }
  | { ok: false; error: string }

/** A near-match is the same url_pattern with at least one overlapping tag (contribute.md's 5.6 dedupe rule). */
function findNearMatch(
  existing: Fragment[],
  input: SaveFragmentInput,
): Fragment | null {
  const inputTags = new Set(input.tags)
  return (
    existing.find(
      (f) =>
        f.meta.name !== input.name &&
        f.meta.url_pattern === input.url_pattern &&
        f.meta.tags.some((t) => inputTags.has(t)),
    ) ?? null
  )
}

/**
 * save_fragment (5.5, 5.6): run the proposed code once from a genuinely cold,
 * isolated context (its own fresh BrowserContext, navigate to url_pattern),
 * and only persist if that cold run passes — this mechanically rejects a
 * fragment that only worked because of leftover state from whatever Claude
 * was doing, or an undeclared dependency. On a pass:
 *  - if a near-match exists (same url_pattern + overlapping tags), update it
 *    in place instead of writing a duplicate; an in-place code change is a
 *    new content hash, so every importer is marked needs_reverification.
 *  - otherwise write a new fragment.
 * navigateUrl lets a test point the cold run at a local fixture instead of
 * the real url_pattern; production passes url_pattern itself.
 */
export async function saveFragment(
  store: FragmentStore,
  browser: SessionBrowser,
  input: SaveFragmentInput,
  navigateUrl?: string,
): Promise<SaveResult> {
  // 1. Cold-run verification in a throwaway isolated context.
  const context = await browser.freshContext()
  try {
    const page = await context.newPage()
    await page.goto(navigateUrl ?? input.url_pattern.replace(/\*/g, ''))
    const tempFragment: Fragment = {
      meta: freshMeta(input),
      prose: '',
      code: input.code,
    }
    const jsPath = await store.extract(tempFragment)
    const run = await loadRun(jsPath)
    await run(page, defaultArgs(input.params))
  } catch (err) {
    return {
      ok: false,
      error: `Cold-run verification failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    await context.close().catch(() => {})
  }

  // 2. Persist. The target is: an existing fragment with the same name (a
  // straight re-save/re-verify), else a near-match by url_pattern+tags (the
  // dedup case — update it instead of writing a duplicate under a new name),
  // else nothing (create new). In every update case, a changed content hash
  // cascades needs_reverification to importers — that must fire on ANY
  // in-place code change, not only the tag-based near-match (5.6/5.7).
  const existing = await store.list()
  const target =
    existing.find((f) => f.meta.name === input.name) ??
    findNearMatch(existing, input)

  if (target) {
    const codeChanged = target.code !== input.code
    target.meta = {
      ...target.meta,
      description: input.description,
      scope: input.scope,
      url_pattern: input.url_pattern,
      tags: input.tags,
      params: input.params,
      verified_at: today(),
      needs_reverification: false, // this fragment was just cold-verified
    }
    target.code = input.code
    await store.write(target)
    const reverified = codeChanged
      ? await store.markImportersForReverification(target.meta.name)
      : []
    return { ok: true, updated: true, reverified }
  }

  await store.write({ meta: freshMeta(input), prose: '', code: input.code })
  return { ok: true, updated: false, reverified: [] }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function freshMeta(input: SaveFragmentInput): FragmentMeta {
  return {
    name: input.name,
    description: input.description,
    scope: input.scope,
    url_pattern: input.url_pattern,
    tags: input.tags,
    params: input.params,
    verified_at: today(),
    use_count: 0,
    last_used_at: null,
    consecutive_failures: 0,
    needs_reverification: false,
  }
}

/** Cold-run args: each param's default, or a type-appropriate placeholder. The cold run proves the code executes, not that a specific input works. */
function defaultArgs(params: FragmentMeta['params']): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const p of params) {
    if (p.default !== undefined) args[p.name] = p.default
    else if (p.type === 'boolean') args[p.name] = false
    else if (p.type === 'number') args[p.name] = 0
    else args[p.name] = ''
  }
  return args
}
