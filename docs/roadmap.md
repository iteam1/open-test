# Roadmap

Implements `design.md` toward `overview.md`, applying `contribute.md`. Every task: one small change, one concrete test, checked off when done — this file is the live record of what's actually built, not just a plan.

Verified against real source before writing this: `/home/locch/Works/claude-agent-sdk-typescript` (docs/examples only — no implementation there; verified against the actual published `@anthropic-ai/claude-agent-sdk` package instead), `/home/locch/Works/playwright` (the real monorepo), `/home/locch/Works/open-design`, `/home/locch/Works/mcp-server-paint`. Findings that changed how this roadmap is sequenced:

- **No reference implementation exists anywhere for streaming-input `query()`** (constructing the `AsyncIterable<SDKUserMessage>`) or for **IPC-streaming a reply to a renderer** (open-design's equivalent runs over HTTP/SSE between a webpage and a separate daemon, not Electron IPC at all). Both are genuinely novel here — Phase 1 proves each in isolation, with fake/minimal data, before anything else is built on top of them.
- open-design is SQLite-backed and spawns ~20 CLI adapters directly — it is not a plain-file, Agent-SDK precedent for this app despite `overview.md`'s comparison. Session status held in-memory-only, never persisted, _does_ match its pattern (`apps/daemon/src/runs.ts`) — that part is validated, not just assumed.
- `@playwright/cli` (Agent CLI) is real and has a working implementation in-tree (`packages/playwright-core/src/tools/cli-client/`), but the published npm package is hosted outside this monorepo — install it from npm, don't try to build it locally.
- `mcp-server-paint` holds one open document as a bare module-level global (`store.py`) — `new_document`/`open_image` must happen before any `draw_*` call.
- **After a round of adversarial review**, the session-template copy mechanism was moved from Phase 5 into Phase 2 (it was previously introduced _after_ three phases already depended on a hand-built folder instead), `usage.json`/`output/` creation was pulled forward to where they're first needed, and three uncovered mechanisms (fragment near-match dedup, `scope` ranking precedence, cheap-model read tiering) got tasks. A precursor task (1.1) now installs the real SDK and checks its types before anything is built against them, instead of trusting research citations alone.

## Phase 0 — Scaffold (done)

- **0.1** [x] `package.json`, `tsconfig.json`, Bun+Electron dev script
  Test: `bun install` succeeds

- **0.2** [x] `src/main/index.ts` + `window.ts`, bare `BrowserWindow`
  Test: `bun run dev` opens a window (verified — process tree confirmed a real GPU-accelerated Electron window)

- **0.3** [x] Fix: mark `electron` external in the build step
  Test: without it, `bun build` inlines `electron`'s own module and `app` comes back `undefined` at runtime — confirmed by reproducing the crash, then fixing it with `--external electron` and re-verifying a clean run

## Phase 1 — Prove the two novel mechanisms in isolation (bare scripts, no Electron yet)

Tasks 1.2-1.6 are throwaway scripts in `scratch/`, not app code — the goal is derisking, not shipping. Delete `scratch/` once Phase 2 wires the real versions in.

- **1.1** [x] `bun add @anthropic-ai/claude-agent-sdk`; confirm against the installed package's real `sdk.d.ts` (not CHANGELOG prose) that `query()`'s `prompt` accepts `string | AsyncIterable<SDKUserMessage>`, `tool()` takes a Zod raw shape, `createSdkMcpServer()` exists, `interrupt()`/`setPermissionMode()` are documented streaming-only, and `getSessionMessages()`/`listSessions()`/`renameSession()`/`startup()` are standalone exports
  Test: grep the installed `sdk.d.ts` for each symbol, confirm signatures match what this roadmap assumes — fix this doc if any don't

- **1.2** [x] Bare script: build an `AsyncIterable<SDKUserMessage>` as an async generator fed by a manually-pushed queue (no existing example to copy — confirmed by 1.1 that the type exists, but nobody's shipped a reference construction). Call `query()` with it once.
  Test: push one message, print Claude's reply, confirm the process stays alive afterward (check it's still in the process list) instead of exiting

- **1.3** [x] Push a second message into the same still-open iterable
  Test: see a second reply, and confirm via `ps` that only ONE `claude` subprocess exists the whole time — never two

- **1.4** [ ] Call `interrupt()` mid-reply
  Test: the streamed reply visibly stops short, compared to letting an identical prompt finish normally
  Finding: it does stop short, but not cleanly. Calling `interrupt()` while the first assistant chunk is streaming crashes the read loop with "Query closed before response received" (thrown from `sdk.mjs`'s cleanup path), instead of returning a graceful stopped result. Confirmed with `ps --ppid <script pid>` snapshots taken right before `interrupt()` and right after the crash is caught: the CLI subprocess (visible by PID before) is gone from the list after. So `interrupt()` stops the reply by taking the subprocess down with it, not by leaving it running for a next turn. Left unchecked — this isn't the safe "stop and keep going" primitive Phase 2 needs; revisit before relying on it.
  Context: the SDK's own `Query.interrupt()` doc comment promises a graceful stop-and-return-control, but that doesn't hold here. GitHub issue #120 (`anthropics/claude-agent-sdk-typescript`, open, unanswered) shows the newer V2 API has the same gap — no interrupt-without-closing at all, only `close()`, which kills the session outright. This is a known, SDK-wide limitation, not a bug specific to this test.
  Solution: wrap `interrupt()` in try/catch and design Phase 2 around the subprocess dying, not surviving — 2.5's kill flow and 2.7's resume-based recovery already assume this.

- **1.5** [ ] Call `getSessionMessages()` after 3 pushed turns
  Test: returned message count matches — proves this can read state independent of whether `query()` is still running
  Finding: `getSessionMessages()` itself works fine — it read the transcript after the live `query()` loop had already exited, independent of whether the process was still running. But the count didn't match: pushing 3 messages (ONE/TWO/THREE) back-to-back with no delay between yields returned 5 entries, not 6. The second and third pushed messages got merged into a single user turn (`"...TWO\n...THREE"`) instead of landing as two separate turns, because they were pulled from the generator faster than the subprocess dispatched the previous one — unlike 1.2/1.3, which paced pushes with a delay. Separately, the final assistant reply appeared twice as distinct array entries sharing the identical `message.id`, 4ms apart — a duplicate in the transcript, not two different replies. Left unchecked — pushed-message count and transcript-turn count aren't guaranteed 1:1 without pacing, and 2.6's usage tracker (which folds `getSessionMessages()` output into per-turn token totals) needs to dedupe by `message.id` or it'll double-count a turn's usage.
  Context: the SDK's own canonical streaming-input example (official docs) paces pushed messages with a 2-second `setTimeout` between yields — this test skipped that pacing, unlike 1.2/1.3. That's the likely root cause of the merge, not an SDK bug. (A `shouldQuery` field exists on `SDKUserMessage`, but its docs make no mention of message-merging — not confirmed as the mechanism, don't rely on it as the explanation.)
  Solution: pace pushed messages with a delay, same as 1.2/1.3. That won't fix the duplicate `message.id` on its own though — 2.6's usage tracker still needs to dedupe by `message.id` regardless of pacing.

- **1.6** [x] Bare Electron test, separate from 1.2-1.5: `contextBridge` exposes one function; renderer calls it; main process replies with 3 fake chunks via `setInterval`, no real Claude involved
  Test: see all 3 chunks logged in the renderer's devtools console, in order, with visible delay between them

## Phase 2 — Combine: real session + real streaming + real IPC

- **2.1a** [ ] Create `assets/session-template/` once, at the app level — near-empty scaffold: empty `.claude/skills/`, empty `.claude/commands/`, a minimal placeholder `CLAUDE.md`, an empty `.mcp.json` (`{}`)
  Test: the template folder exists at the app root with exactly these four things, nothing else yet

- **2.1b** [ ] Session manager copies `assets/session-template/` (from 2.1a) wholesale into every new session folder, plus creates `input/`, an empty `output/`, `metadata.json` (`session_id`, `claude_session_id`, `created_at`), and an empty `usage.json` (`[]`)
  Test: a new session's folder has all of the above, correctly copied/created

- **2.2** [ ] Wire 1.2-1.5's mechanism with `cwd` set to the session folder; `startup()` pre-warms it
  Test: after running, `~/.claude/projects/<slugified-path>/` exists with a matching `.jsonl` — confirms the "bonus for free" claim from `overview.md` for real

- **2.3** [ ] Wire 1.6's fake-chunk IPC channel to real streamed reply chunks from 2.2
  Test: type a prompt in a minimal chat input, see Claude's real reply stream in live

- **2.4** [ ] Session status in memory: `idle` → `running` on push — also creates `output/turn-<n>/` for the new turn (`n` = count of user messages pushed so far, including this one) before the message goes in — back to `idle` on reply completion; status exposed to renderer over the same IPC channel. A push arriving while status is `running` is rejected, not queued or forwarded — the design (`design.md`'s state diagram) already assumes pushes only happen from `idle`, and 1.5 found what goes wrong when that's not enforced: unpaced pushes into an already-running stream merge into one turn instead of landing as two
  Test: unit test asserts status mid-turn vs. after, and that `output/turn-<n>/` exists as soon as the turn starts, not just once something's written into it; a second test pushes twice in quick succession and confirms the second push while `running` is rejected, not silently merged into the first turn; manual UI check shows the status transition

- **2.5** [ ] Idle timeout (fake clock in tests) closes the stream only from `idle`; explicit kill calls `interrupt()` first if running, then closes. Per 1.4's finding, that `interrupt()` call throws instead of returning cleanly (it takes the subprocess down with it) — the kill flow must catch that error internally, not let it propagate
  Test: idle past N minutes closes it; a turn in progress blocks the close. Manual: kill mid-turn, confirm the session reaches `closed` AND the app process itself stays up — not just that the reply stops

- **2.6** [ ] Usage tracker: after each turn, `getSessionMessages()` since the last one, dedupe by `message.id` before parsing (1.5 found the transcript can carry the same reply twice under the identical id), hand-parse `usage`, fold in token counts from any subagent `.jsonl` files spawned during that turn (per `overview.md`'s "any subagent files used in that turn"), append one `TurnUsage` to the `usage.json` created in 2.1b
  Test: unit test against a fixture transcript for the token/cost math, including a fixture turn that spawned a subagent — confirm the subagent's own tokens are folded into that turn's total, not just the main transcript's; a second fixture with a duplicated `message.id` entry confirms it's counted once, not twice; integration test after one real turn

- **2.7** [ ] Resume: a `closed` session gets a fresh streaming connection via `options.resume`, same `claudeSessionId`
  Test: close, reopen, ask what you said before closing

## Phase 3 — Dashboard and navigation

- **3.1** [ ] Dashboard reads `sessions/` directly (no database, no index file) via the Session manager; combines each folder's `metadata.json` with in-memory status; groups by status
  Test: sessions in different states appear in the correct column

- **3.2** [ ] Card actions: kill, resume, rename (`renameSession()`/`customTitle` — display name is never a field on `Session` itself)
  Test: kill moves a card to Closed; rename updates the shown name

- **3.3** [ ] Chat state lives in main process keyed by `sessionId`, independent of which screen is mounted
  Test: start a turn, navigate to Dashboard mid-stream, come back — the reply is there, not lost

## Phase 4 — Live testing (Playwright Agent CLI, no fragments yet)

- **4.1** [ ] Install `@playwright/cli` from npm (confirmed: real implementation exists in the Playwright monorepo at `packages/playwright-core/src/tools/cli-client/`, but the published package itself is hosted outside it — install normally, don't try to vendor it from a local checkout)
  Test: `playwright-cli --version` via Bash

- **4.2** [ ] First live test: ask Claude to check a public page's title via Agent CLI, screenshot to `output/turn-n/`
  Test: screenshot file exists, non-empty

- **4.3** [ ] Artifact panel auto-refreshes as files land in `output/turn-n/`
  Test: watch it update live during a run

- **4.4** [ ] Claude writes `report.md` verdict
  Test: file present, readable

- **4.5** [ ] Write real guardrail content into `assets/session-template/CLAUDE.md` (placeholder since 2.1a) against destructive actions, including stopping to ask when there's a gap
  Test: a risky/ambiguous prompt gets declined or questioned

## Phase 5 — In-process fragment tools

- **5.1** [ ] Scaffold `io/fragments/server.ts`: `createSdkMcpServer({name: 'fragments', tools: []})` with zero tools yet, merged into `options.mcpServers` alongside whatever's in the copied `.mcp.json` (confirmed: `McpServerConfig` is a union of stdio/SSE/HTTP/in-process types, so mixing them in one `query()` call is supported)
  Test: session still runs fine with this attached, no regression from Phase 2

- **5.2** [ ] `match_fragments(url, tags?)` against fixture frontmatter (no code needed yet) — filters, ranks by `use_count`/`last_used_at`, hard-caps the shortlist, and `scope: specific` always outranks `scope: common` on a match
  Test: fixture fragments + a URL → correct shortlist ranking; a dedicated case where a `common` and a `specific` fragment both match the same URL and `specific` wins

- **5.3** [ ] Extraction: markdown → cached `.js`, keyed by content hash
  Test: fixture `.md` → correct `.js`, cache hit on 2nd call

- **5.4** [ ] `run_fragment(name, args)`: extract + execute via real Playwright Library (confirmed real chain: `chromium.launch()` → `Browser.newContext()` → `BrowserContext.newPage()` → `Page`, importable straight from `playwright` with no wrapper) against a local fixture HTML page
  Test: integration test — assert success + `use_count`/`last_used_at` updated

- **5.5** [ ] `save_fragment(...)`: its own fresh `BrowserContext` (confirmed: real CDP-level isolation, `Target.createBrowserContext` — not just app-layer convention), navigate to `url_pattern`, run `code` once cold
  Test: integration test — a good fragment saves; a broken one (or one secretly depending on prior state) is rejected

- **5.6** [ ] `save_fragment` checks for an existing near-match before writing (same `url_pattern` + overlapping `tags`); if found, updates that fragment's code/params instead of creating a duplicate — an in-place update changes the content hash, so it must trigger the same `needs_reverification` cascade as any other dependency change (see 5.7)
  Test: integration test — saving a near-duplicate updates it in place, file count doesn't grow; a second test where a composite imports the fragment being updated confirms the composite gets marked `needs_reverification` too

- **5.7** [ ] `needs_reverification` cascade on a dependency's hash change; `consecutive_failures` retirement at 3
  Test: unit tests, one per state transition

- **5.8** [ ] Atomic temp-file + rename writes for fragment `.md` files
  Test: two concurrent writers, assert no corruption

- **5.9** [ ] Add `fragment-lookup`/`fragment-learn`/`fragment-combine` `SKILL.md` files into `assets/session-template/.claude/skills/` (empty since 2.1a)
  Test: test the same page twice in one session; confirm the 2nd attempt calls `match_fragments`/`run_fragment`

- **5.10** [ ] Cost proof: same test twice, compare `usage.json` turn 1 vs. turn 2 (`usedFragmentTool` flag)
  Test: assert turn 2's total tokens are at least 50% lower than turn 1's — turn 1 pays for both the live run and `save_fragment`'s cold re-run, so turn 2 alone should already be well under half

- **5.11** [ ] `fragment-combine` + `fragment:<name>` import convention for composites
  Test: a 2-step flow saves and reuses a composite

## Phase 6 — Configuration and extensibility

- **6.1** [ ] `.env` (gitignored) holds `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_API_KEY`; a committed `.env.example` documents them with empty/placeholder values. Bun auto-loads `.env` with no extra package (confirmed empirically — `process.env` picks it up with zero config); the app reads `process.env` and passes it explicitly via `query()`'s own `options.env` field (confirmed: a real, typed field on `Options`), rather than relying on implicit subprocess inheritance
  Test: set a different value in `.env`, confirm `query()` actually uses it — e.g. point `ANTHROPIC_BASE_URL` at a different endpoint and confirm requests go there

- **6.2** [ ] Generic skill support: anything dropped into a session's `.claude/skills/` beyond the fragment ones is picked up
  Test: add a test skill, confirm Claude uses it

- **6.3** [ ] Subagent support: `.claude/agents/*`
  Test: add a subagent, confirm Claude can dispatch to it

- **6.4** [ ] A lower-cost model (e.g. Haiku) subagent for accessibility-tree reads during live Agent CLI driving, keeping the primary model for judgment calls (depends on 6.3)
  Test: during a live test with a read-heavy inspection step, check the subagent transcript at `~/.claude/projects/<slug>/<claude_session_id>/subagents/agent-*.jsonl` (per `overview.md`'s subagent storage) for the cheap model — `usage.json`'s `model` field is per-turn, not per-subagent-call, so it can't show this

- **6.5** [ ] Custom output folder based on a skill's own definition
  Test: confirm artifacts land where that skill specifies

## Phase 7 — Input, engines, artifacts, guardrails

- **7.1** [ ] File upload: `.md`/`.txt`/`.json`/`.yml`/`.yaml`, up to 1MB each
  Test: upload each format under 1MB, confirm Claude can read it; upload one file over 1MB, confirm it's rejected, not silently accepted

- **7.2** [ ] `.xlsx` upload: vendor the official [xlsx skill](https://github.com/anthropics/skills/tree/main/skills/xlsx)'s reading path only, run via `uv run --with pandas` (no project-local `.venv` — confirmed empirically, `uv` caches ephemeral environments globally, not per-project)
  Test: upload a real `.xlsx`, confirm Claude reads its contents

- **7.3** [ ] Orchestration-agnostic testing: upload a plan, prompt-only, or upload-then-adjust-via-prompt
  Test: all three paths work

- **7.4** [ ] Headless/headed screenshot toggle
  Test: both modes produce screenshots

- **7.5** [ ] Engine selection: Chromium, WebKit, Edge (`msedge` channel)
  Test: same test against each engine

- **7.6** [ ] Add the `mcp-server-paint` entry into `assets/session-template/.mcp.json` (empty since 2.1a) using the confirmed exact shape: `{"command": "uv", "args": ["run", "--directory", "<path>", "mcp-server-paint"]}`, no env vars needed
  Test: ask Claude to annotate a screenshot — must open the image first (server holds one document as a module-level global; confirm Claude does this naturally, or add a line to the guardrail `CLAUDE.md` if it doesn't)

- **7.7** [ ] Wire `assets/starter-pack/` into `store.ts`'s search path as a second, read-only source — never copied into `fragments/`
  Test: empty `fragments/`, a starter-pack fragment still matches

- **7.8** [ ] Video capture alongside screenshots
  Test: confirm a video file lands next to the screenshot

- **7.9** [ ] Resource-exhaustion guardrail hooks beyond the baseline `CLAUDE.md`
  Test: a runaway prompt gets stopped

`trace.zip` has no task — deliberately deferred, no concrete path without a graduation/regression-suite feature to hang it on yet.
