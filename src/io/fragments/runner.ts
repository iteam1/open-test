import type { Page } from 'playwright'
import {
  FragmentStore,
  isValidFragmentName,
  type Fragment,
  type FragmentMeta,
} from './store'
import { SessionBrowser } from './browser'

/** A fragment module is the JS extracted from its code fence — one `run(page, args)` export. */
type FragmentModule = {
  run: (page: Page, args: Record<string, unknown>) => Promise<unknown>
}

async function loadRun(jsPath: string): Promise<FragmentModule['run']> {
  // No cache-bust: the extraction path is the hash of the fully-resolved
  // code (see store.extract), so a given path always holds identical bytes.
  // A stale module cache would therefore return identical behavior anyway,
  // and per-import query strings would leak a never-GC'd module each call
  // in the long-lived main process.
  const mod = (await import(jsPath)) as FragmentModule
  if (typeof mod.run !== 'function') {
    throw new Error(`Fragment at ${jsPath} has no exported run() function`)
  }
  return mod.run
}

export type RunResult =
  { ok: true; value: unknown } | { ok: false; error: string }

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
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
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
  /**
   * Concrete URL to cold-run against. Required for a `common` fragment,
   * whose url_pattern is broad/empty and can't be navigated to — pass the
   * real page you tested on. For a `specific` fragment it's optional: the
   * url_pattern with its trailing `*` stripped is used when this is absent.
   */
  verifyUrl?: string
}

export type SaveResult =
  | { ok: true; updated: boolean; reverified: string[] }
  | { ok: false; error: string }

/** A bare `scheme://` (or empty) can't be navigated — that's the case an empty/broad url_pattern strips down to. */
function coldRunUrl(
  input: SaveFragmentInput,
  navigateUrl?: string,
): string | null {
  const candidate =
    navigateUrl ?? input.verifyUrl ?? input.url_pattern.replace(/\*/g, '')
  if (!candidate || /^[a-z][a-z0-9+.-]*:\/\/\/?$/i.test(candidate)) return null
  return candidate
}

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
  // Validate the name up front — before launching a browser — so an invalid
  // name fails cheaply and clearly instead of after the cold run
  // (advisor-found: it was only checked at write time, wasting a launch).
  if (!isValidFragmentName(input.name)) {
    return {
      ok: false,
      error: `Invalid fragment name "${input.name}" — use only letters, numbers, dot, dash, underscore.`,
    }
  }

  const url = coldRunUrl(input, navigateUrl)
  if (!url) {
    return {
      ok: false,
      error:
        'save_fragment needs a concrete URL to cold-run against. For a common fragment (broad or empty url_pattern), pass verify_url set to the page you tested on.',
    }
  }

  // 1. Cold-run verification in a throwaway isolated context.
  const context = await browser.freshContext()
  try {
    const page = await context.newPage()
    await page.goto(url)
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
      // A cold-run re-verify is a pass, so it clears the failure streak too
      // (contribute.md: "reset the counter on a pass"). Without this, a
      // fragment retired at 3 comes back with the counter still at 3 and
      // re-retires on its very next single failure (advisor-found bug).
      consecutive_failures: 0,
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
