import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import YAML from 'yaml'

/**
 * Parsed shape of a fragment's YAML frontmatter (see contribute.md's file
 * format). Field names stay snake_case, matching the on-disk YAML directly —
 * no mapping layer, since Claude reads/writes that frontmatter as-is
 * (design.md).
 */
export type FragmentParam = {
  name: string
  type: 'string' | 'boolean' | 'number'
  required: boolean
  default?: string | boolean | number
  description: string
}

export type FragmentMeta = {
  name: string
  description: string
  scope: 'specific' | 'common'
  url_pattern: string
  tags: string[]
  params: FragmentParam[]
  verified_at: string
  use_count: number
  last_used_at: string | null
  consecutive_failures: number
  needs_reverification: boolean
}

export type Fragment = {
  meta: FragmentMeta
  /** Prose between the frontmatter and the code fence — what Claude reads to pick from a shortlist. */
  prose: string
  /** The JS inside the fragment's one code fence — what actually executes. */
  code: string
}

/** Retirement threshold (contribute.md: "retire a fragment after 3 in a row, until it's re-verified"). */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * One fragment .md file: `---` frontmatter, prose, one ```js fence.
 * Throws with a specific message on any structural problem — these surface
 * to Claude as failed tool calls, so they need to say what's wrong.
 */
export function parseFragment(raw: string): Fragment {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fm) throw new Error('Fragment file has no YAML frontmatter block')

  const meta = YAML.parse(fm[1]) as FragmentMeta
  for (const field of ['name', 'description', 'scope', 'url_pattern'] as const) {
    if (typeof meta?.[field] !== 'string') {
      throw new Error(`Fragment frontmatter is missing "${field}"`)
    }
  }
  if (meta.scope !== 'specific' && meta.scope !== 'common') {
    throw new Error(`Fragment scope must be "specific" or "common", got "${meta.scope}"`)
  }
  meta.tags = Array.isArray(meta.tags) ? meta.tags : []
  meta.params = Array.isArray(meta.params) ? meta.params : []
  meta.use_count = typeof meta.use_count === 'number' ? meta.use_count : 0
  meta.last_used_at = meta.last_used_at ?? null
  meta.consecutive_failures =
    typeof meta.consecutive_failures === 'number' ? meta.consecutive_failures : 0
  meta.needs_reverification = Boolean(meta.needs_reverification)
  // YAML parses an unquoted date (e.g. `verified_at: 2026-07-01`) as a Date.
  const verifiedAt: unknown = meta.verified_at
  if (verifiedAt instanceof Date) {
    meta.verified_at = verifiedAt.toISOString().slice(0, 10)
  }

  const rest = raw.slice(fm[0].length)
  const fence = rest.match(/```(?:js|javascript)\r?\n([\s\S]*?)\r?\n```/)
  if (!fence) throw new Error('Fragment file has no ```js code fence')

  return {
    meta,
    prose: rest.slice(0, fence.index).trim(),
    code: fence[1].trim(),
  }
}

/** Inverse of parseFragment — used for every write so files stay in the canonical shape. */
export function serializeFragment(fragment: Fragment): string {
  const frontmatter = YAML.stringify(fragment.meta).trimEnd()
  const prose = fragment.prose.trim()
  return `---\n${frontmatter}\n---\n\n${prose ? prose + '\n\n' : ''}\`\`\`js\n${fragment.code}\n\`\`\`\n`
}

export function contentHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16)
}

/**
 * On-disk store for the app-wide fragment library (design.md: the top-level
 * fragments/ dir, app-root path, independent of any session's cwd) plus the
 * content-hash .js extraction cache under <root>/.cache/.
 */
export class FragmentStore {
  constructor(readonly rootDir: string) {}

  private fragmentPath(name: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid fragment name "${name}"`)
    }
    return path.join(this.rootDir, `${name}.md`)
  }

  async list(): Promise<Fragment[]> {
    if (!existsSync(this.rootDir)) return []
    const entries = await readdir(this.rootDir)
    const fragments: Fragment[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      try {
        fragments.push(
          parseFragment(await readFile(path.join(this.rootDir, entry), 'utf-8')),
        )
      } catch {
        continue // one bad file must not take down every lookup
      }
    }
    return fragments
  }

  async get(name: string): Promise<Fragment | null> {
    const filePath = this.fragmentPath(name)
    if (!existsSync(filePath)) return null
    return parseFragment(await readFile(filePath, 'utf-8'))
  }

  /**
   * Atomic write: temp file in the same directory, then rename — rename
   * within one filesystem is atomic, so a concurrent reader sees either the
   * old file or the new one, never a torn mix (5.8, contribute.md's
   * concurrent-corruption fix).
   */
  async write(fragment: Fragment): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const finalPath = this.fragmentPath(fragment.meta.name)
    const tempPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tempPath, serializeFragment(fragment))
    await rename(tempPath, finalPath)
  }

  /**
   * Extracts a fragment's code into a real .js file keyed by content hash
   * (5.3) — same hash, same file, so the second call is a cache hit and
   * doesn't rewrite. `fragment:<name>` imports (5.11) resolve to the named
   * fragment's current extraction, so composites always import their
   * dependency's latest code.
   */
  async extract(fragment: Fragment): Promise<string> {
    const cacheDir = path.join(this.rootDir, '.cache')
    const jsPath = path.join(cacheDir, `${contentHash(fragment.code)}.js`)
    if (existsSync(jsPath)) return jsPath

    await mkdir(cacheDir, { recursive: true })
    let code = fragment.code
    // Rewrite fragment:<name> specifiers to the dependency's own extracted
    // file. Serial await is fine — imports per fragment are few.
    const importRe = /(['"])fragment:([A-Za-z0-9._-]+)\1/g
    for (const match of [...code.matchAll(importRe)]) {
      const dep = await this.get(match[2])
      if (!dep) throw new Error(`fragment:${match[2]} does not exist`)
      const depPath = await this.extract(dep)
      code = code.replace(match[0], JSON.stringify(depPath))
    }

    const tempPath = `${jsPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tempPath, code)
    await rename(tempPath, jsPath)
    return jsPath
  }

  /** Names of fragments whose code imports `fragment:<name>` — the dependents to cascade onto when <name> changes. */
  async findImporters(name: string): Promise<Fragment[]> {
    const needle = `fragment:${name}`
    return (await this.list()).filter(
      (f) =>
        f.code.includes(`'${needle}'`) || f.code.includes(`"${needle}"`),
    )
  }

  /**
   * The needs_reverification cascade (5.6/5.7): when a fragment's code
   * changes (new content hash), every fragment that imports it can no
   * longer trust its own last verification.
   */
  async markImportersForReverification(name: string): Promise<string[]> {
    const importers = await this.findImporters(name)
    for (const importer of importers) {
      importer.meta.needs_reverification = true
      await this.write(importer)
    }
    return importers.map((f) => f.meta.name)
  }

  /** A pass resets the failure counter and bumps usage (contribute.md's run_fragment postcondition). */
  async recordRunSuccess(name: string): Promise<void> {
    const fragment = await this.get(name)
    if (!fragment) return
    fragment.meta.use_count += 1
    fragment.meta.last_used_at = new Date().toISOString()
    fragment.meta.consecutive_failures = 0
    await this.write(fragment)
  }

  /**
   * A failure increments consecutive_failures; the 3rd in a row retires the
   * fragment (needs_reverification: true) until a passing save_fragment
   * re-run clears it (5.7).
   */
  async recordRunFailure(name: string): Promise<void> {
    const fragment = await this.get(name)
    if (!fragment) return
    fragment.meta.consecutive_failures += 1
    if (fragment.meta.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
      fragment.meta.needs_reverification = true
    }
    await this.write(fragment)
  }

  /** Drop a stale extraction so tests can prove cache behavior; harmless if absent. */
  async clearCache(): Promise<void> {
    await rm(path.join(this.rootDir, '.cache'), { recursive: true, force: true })
  }
}
