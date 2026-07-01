import type { Fragment } from './store'

/** Cap per contribute.md ("about 5-10") — what keeps per-turn cost flat as the library grows. */
export const SHORTLIST_CAP = 8

/**
 * url_pattern is a glob-ish pattern where `*` matches anything (contribute.md
 * uses 'https://example.com/login*'). An empty pattern matches any URL —
 * that's what a broad `common` fragment has.
 */
export function urlMatches(pattern: string, url: string): boolean {
  if (!pattern) return true
  const regex = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  )
  return regex.test(url)
}

/**
 * The deterministic, no-LLM shortlist (5.2, contribute.md's match_fragments
 * row): filter by URL and tags, skip anything marked needs_reverification,
 * rank by use_count then last_used_at recency — except scope:'specific'
 * always outranks scope:'common' when both match, regardless of usage
 * counts. Capped so Claude reads a bounded list no matter how large the
 * library grows.
 */
export function matchFragments(
  fragments: Fragment[],
  url: string,
  tags?: string[],
): Fragment[] {
  const candidates = fragments.filter((f) => {
    if (f.meta.needs_reverification) return false
    if (!urlMatches(f.meta.url_pattern, url)) return false
    if (tags && tags.length > 0) {
      const fragmentTags = new Set(f.meta.tags)
      if (!tags.some((t) => fragmentTags.has(t))) return false
    }
    return true
  })

  candidates.sort((a, b) => {
    if (a.meta.scope !== b.meta.scope) {
      return a.meta.scope === 'specific' ? -1 : 1
    }
    if (a.meta.use_count !== b.meta.use_count) {
      return b.meta.use_count - a.meta.use_count
    }
    const aUsed = a.meta.last_used_at ?? ''
    const bUsed = b.meta.last_used_at ?? ''
    return bUsed.localeCompare(aUsed)
  })

  return candidates.slice(0, SHORTLIST_CAP)
}
