# Contribute

## Idea

*Re-build some Playwright artifacts (script + semantics) that are flexible (allow arguments, ...), reusable, and assemblable.*

*We can assemble them to become a bigger script.*

*Only fall back to the agent + Playwright Agent CLI (not MCP — Claude Code has shell access, Agent CLI does the same job for ~4x less cost) when there's nothing to reuse.*

*Before accumulating a script into the reusable store, confirm it actually worked — not just that it ran once. A flaky or lucky single run shouldn't pollute the library.*

*After manual work + experiments, do the lesson-learned step: generate something reusable for the next test, and accumulate it in a central place. At minimum, it must be reusable for the next turn of the same test.*

*Use scripts instead of manual work — it reduces cost and speeds things up.*

*The `./sessions/` folder, with all its previous executions, is a gold mine. We must find a way to reuse its history — the intermediate outputs, the lessons learned, the generated scripts, etc.*

## Questions

- What is the reusable thing, and in what form?
- How do we accumulate them?
- How do we avoid fragment overhead while still keeping it reusable?
- How do we deal with tribal knowledge, task-specific requirements, and app scope?
- For regression tests, how (and whether) do we assemble fragments into a larger, full test script?

## Suggestions

One markdown file per fragment: YAML frontmatter (matching + params), prose (intent), one JS code fence (execution).

````markdown
---
name: login-flow
description: Logs into example.com
scope: specific
url_pattern: "https://example.com/login*"
tags: [auth]
params:
  - name: username
    type: string
    required: true
    description: Login email or username
  - name: password
    type: string
    required: true
    description: Account password
  - name: remember_me
    type: boolean
    required: false
    default: false
    description: Whether to check "remember me"
verified_at: 2026-07-01
use_count: 0
last_used_at: null
consecutive_failures: 0
---

Use this when a test needs to be logged in first.

```js
export async function run(page, { username, password, remember_me = false }) {
  await expect(page).toHaveURL(/login/)   // precondition — fails fast if stale
  await page.fill('#username', username)
  await page.fill('#password', password)
  if (remember_me) await page.check('#remember-me')
  await page.click('#submit')
}
```
````

- Frontmatter → filter, no LLM. Also the param contract.
- Prose → agent picks among the shortlist.
- Code → extracted to a real `.js` file on demand, cached by content hash.

**Accumulate:**
- Store: central `./fragments/`, not tied to any session.
- Write: after a live run passes the verify gate.
- Read: pre-filter → shortlist (~10) → agent picks → extract → run.

**Avoid overhead:**
- Only fragment recurring steps, not one-offs.
- Track `consecutive_failures`; retire after 3 until re-verified.
- Rank shortlist by `use_count`/`last_used_at`, hard-cap it — this is what keeps per-turn cost flat as the library grows.
- Before writing, check for an existing near-match and update it instead of piling up duplicates.

**App scope:**
- `scope: specific` — precise `url_pattern`, one app, can use brittle CSS selectors.
- `scope: common` — broad/no `url_pattern`, matched by tags, must use role-based selectors to generalize.
- Specific always outranks common on a match.

**Assembling for regression:**
- Glue script imports fragments by name, calls them in sequence.
- Save the composite as its own fragment too.
- Frequently-run composites graduate to `@playwright/test` — free trace.zip, retries, parallel runs.

## Self-review

- Turn 1 costs ~2x (live run + verify re-run). Breaks even on the 2nd reuse.
- Fix: ship a pre-verified starter pack of `common` fragments (cookie banners, pagination, etc.) so turn 1 isn't 100% live. Committed to the repo — product content, not user data.
- Gap: no clean-state/test-data reset yet. Deferred; a partial stopgap is letting precondition checks assert broader state, not just the URL.
- Gap: a composite silently trusts a changed dependency. Fix: mark it `needs_reverification` when a fragment's content hash changes.
- Gap: concurrent writes can corrupt a fragment file. Fix: write to a temp file, then rename it in.
- Gap: `consecutive_failures` can't tell "app changed" from "flaked once." Fix: same `needs_reverification` recheck — reset on pass, retire on repeat fail.
- Pre-filter runs in app code, not as an agent tool call — free.
- A fragment that fails at run time falls back to live execution in the same turn.
- `common` fragments will fail more than `specific` ones. Acceptable — failures are caught, not silent, and self-correct via retirement.
