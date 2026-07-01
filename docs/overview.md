# Idea

## Scope

Inspired by [open-design](https://github.com/nexu-io/open-design)'s architecture — a local daemon/app orchestrating an AI agent, with session-based workspaces and plain-file artifact storage (no database) — but intentionally **simpler**:

- **Single-agent focus**: the Claude Code agent only. No multi-CLI-adapter layer for Codex/Gemini/Cursor/etc. like open-design supports.
- **Plain-file artifacts**: every session's input/output lives as real files under its session folder (mirrors open-design's normal-artifact-as-file pattern), not rows in a database.
- **Decided: use the Claude Agent SDK's `query()`.** Verified against the SDK's own source/CHANGELOG: both raw CLI and the SDK spawn the same native `claude` binary as a subprocess — there's no in-process, no-subprocess option. The real difference is who manages that subprocess: raw CLI means we parse stdout ourselves; `query()` means the SDK manages the subprocess and hands back typed events, plus `resume`, `permissionMode`, and JS-callback `hooks` as real options. A prior "session class" (`SDKSession`) existed but was removed — `query()` alone now handles multi-turn (`options.resume`, or an `AsyncIterable` of messages).

## Targets

- Local, cross-OS, agent-powered application for testing (like Claude Desktop but optimized for testing)
- Use the Claude Agent SDK, the Playwright Test Framework, Playwright Library (scripts), Playwright Agent CLI (live agent-driven execution — see Optimization), Playwright CLI (setup/codegen), and Electron under the hood
- Able to use custom environment variables like `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`
- Able to use an external MCP server for drawing annotations, hosted on the same machine
- Able to run on the Chromium and WebKit engines, including Microsoft Edge (must, via Playwright's `msedge` channel — Edge runs on Chromium, not a separate engine); WebKit support is optional
- Able to manage working sessions in a central place, `./sessions/`, with each session kept as a separate folder. Sessions can be force-killed or resumed, etc. Each session stores test artifacts, a `metadata.json` file (just `session_id` — stable, defaults to a year-month-day-time format, never itself renamed —, `claude_session_id`, `created_at`), and a `usage.json` file (a list of usage entries, one per turn). The display name shown to the user _is_ renamable, but that's a separate thing layered on top, not the `session_id` itself
- Able to upload test artifact inputs (`.md`, `.txt`, `.xlsx`, `.json`, `.yml`, `.yaml`), single or multiple files, up to 1 MB each
- Able to leverage existing agent capabilities: skills, multi-agent patterns, subagents, and MCP servers (`.mcp.json`)
- Must be able to capture screenshot evidence in headless (no address bar) or headed mode, and use the [mcp-server-paint](https://github.com/iteam1/mcp-server-paint) MCP server to draw annotations
- Able to customize the output folder based on the skill's definition
- Able to run multi-turn tests and manage each turn's test output artifacts
- Support orchestration-agnostic testing: the user can upload a test plan and ask the agent to follow it, ask the agent to execute tests via prompt only, or upload a test plan first and then adjust test conditions/requirements via prompt (e.g. selecting which tests to run)
- Support agent skills (`.claude/skills/*`) and be able to inject a new skill folder into a session
- Support subagents (`.claude/agents/*`)
- The agent must do its best to execute tests, but if there's a gap, it should stop and verify with the user
- Support output: screenshots (required), video (optional), and — in the future — Playwright `trace.zip` files, finishing with a test verdict `report.md`
- Support guardrails via `CLAUDE.md`, reinforced with hooks, to prevent harmful or malicious actions such as exhausting system resources, memory, or disk space

## Prerequisites

- bun, TypeScript
- uv
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — the CLI binary is still the engine underneath; the SDK just spawns and talks to it for us, so we don't install or invoke it by hand.

## Orchestration

- In the local app, the user creates a session
- The session renders a UI with a chat box on the right side to interact with Claude via the Claude Agent SDK under the hood (configurable with custom `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`), and shows test input and output artifacts
- Upload test artifacts (optional), or use a prompt to clarify requirements
- The agent will inspect, study, and confirm with the user to clarify requirements
- After that, it executes the tests — using skills, subagents, Playwright scripts, etc.
- Write down test output and return a test verdict
- Main components inside each session folder: one shared `input/` (test artifacts uploaded for the session — re-read by every turn, not duplicated per turn), `output/turn-<n>/` (each turn gets its own output subfolder — screenshots/video/report.md — so re-running or adjusting the test doesn't clobber a prior turn's results), `metadata.json` (just `session_id`, `claude_session_id`, `created_at`), `usage.json` (one entry per turn), `.claude/*`, `CLAUDE.md`. The Claude Agent SDK's `query()` is invoked with **`cwd` set to this session folder**, not the app's root — so project-local skills/subagents/settings under `<session>/.claude/*` and `<session>/CLAUDE.md` are picked up automatically by Claude Code's own discovery, no custom path wiring needed.
- Turn boundaries are derived from the session's own transcript rather than a separately invented counter: turn _n_ = the *n*th user message in `<claude_session_id>.jsonl` (see below).
- **Bonus, for free**: because `cwd` is the session folder, Claude Code mirrors a matching directory at `~/.claude/projects/<slugified-session-folder-path>/` (slug = the absolute path with every `/` → `-`). That directory holds `<claude_session_id>.jsonl` (the full resumable transcript), `<claude_session_id>/subagents/agent-*.jsonl`+`.meta.json` (per-subagent transcript + metadata), and `<claude_session_id>/tool-results/*.txt` (large tool outputs spilled off the main transcript). The app can read this directly — keyed by the `claude_session_id` already stored in `metadata.json` — to power resume (`options.resume`, same `cwd`) and to surface subagent runs in the UI, without building its own transcript/subagent logger.
- Note the two distinct `.claude` locations are not the same thing: `<session>/.claude/*` (project-local skills/agents/config, lives **inside** the session folder) vs. `~/.claude/projects/<slug>/` (Claude Code's own transcript store, lives in the **user's home directory**, merely keyed by the session folder's path).
- Loop additional test turns if the user requires it
- MUST be able to chat with the agent if there's a gap, to clarify

## Usage & Cost Tracking

Each `assistant` message in `<claude_session_id>.jsonl` already has a `usage` object: input tokens, output tokens, cache read tokens, cache write tokens (split into 5-minute and 1-hour), and which model made it.

There's no dollar cost in the persisted transcript itself — we checked several real `.jsonl` files, no cost field on any line. But the streamed `result` event that ends each turn carries a real `total_cost_usd` (a standard, non-experimental field on `SDKResultMessage`), so the app captures that during the turn and uses it directly. We deliberately do **not** hardcode a per-model rate table and multiply it out — that would silently go stale every time a model or its pricing changes, and the SDK already computes the real figure. (An earlier cut did price it manually from a rate table; that was replaced.) The per-category token counts in `usage.json` still come from summing the transcript's `usage` objects (every assistant message in the turn, plus any subagent files used in that turn), for the breakdown display.

Save the result in `usage.json`, one entry per turn — tokens, cache numbers, cost, model — so the UI just reads it instead of recalculating every time.

## Custom Layers

- Define cross-session configuration such as `CLAUDE.md` and `.mcp.json`
- Support defining skills for specific testing scenarios (UI component testing, API testing, E2E testing, etc.) — meaning behavior and output artifacts can be specific to each skill
- Able to chat with the user to run a specific requirement that differs from the original plan, etc.

## Limitation

A draft prototype — Claude Agent SDK + Playwright MCP, hosted on a server — already proved the idea works, but surfaced four real limitations:

1. **Too slow.** The agent reads the page and calls Playwright MCP step by step — one LLM round-trip per click/read — so every test action pays a full reasoning cost.
2. **Too expensive.** Each MCP call adds to the context, and a test flow is many calls, so cost climbs with every step.
   - Fix, layer 1: stop using Playwright MCP at all for execution. Since Claude Code has shell access, use the **Playwright Agent CLI** (`playwright-cli`) instead — same underlying tools, but it writes browser state to disk instead of inlining it into context. Real-world numbers: ~114K tokens per task via MCP vs. ~27K via Agent CLI, about 4x cheaper, before any caching. MCP is only the right call for agents _without_ shell access (Claude Desktop, a sandboxed chat UI) — not our case.
   - Fix, layer 2 (on top of layer 1): fewer round-trips. Run one pre-written Playwright script that does several actions in a single call, instead of one LLM decision per click. See Optimization below, and the [2026 PreAct paper](#related-to) — same idea, validated.
3. **Too resource-heavy.** One session used 2 CPU cores and 1 GB of memory.
   - No longer a server problem: since the fix for #4 is running locally, there's no shared server piling up sessions from many users. It's now just "how many sessions can one local machine run at once" — already covered by the guardrail bullet in Targets (prevent a session from exhausting CPU/memory/disk).
4. **Test environment was locked to the server.** Hosted remotely, the agent could only reach what that server's network could reach — no testing against a custom/private environment (e.g. behind an AWS SSM tunnel).
   - Fix: run locally instead. This is the actual reason this project is local-first, not just a style choice — it's required to reach arbitrary or private test environments.

## Optimization

- Never use Playwright MCP for execution — Claude Code has shell access, so the **Playwright Agent CLI** does the same job for ~4x less cost (state goes to disk, not into context). MCP is for agents without shell access; that's not us.
- On top of that: use pre-written Playwright scripts (the Playwright Library) instead of live Agent CLI step-by-step driving, whenever a matching reusable script already exists — see `contribute.md`
- When the agent needs to inspect a page live (no reusable script yet), read the accessibility tree, not raw DOM/HTML — smaller and cheaper per read (both Playwright MCP and Agent CLI's `snapshot` command do this by default)
- Use a lower-cost agent (e.g. Haiku) for those accessibility-tree reads, saving the expensive model for judgment calls
- Write Playwright scripts and reuse them
- Consider centrally defining parametrized Playwright scripts for cross-requirement testing, with a selector to choose, reuse, or combine scripts for execution — instead of spending agent tokens directly on each action

## Related to

- [Pre-Act: Multi-Step Planning and Reasoning Improves Acting in LLM Agents](https://arxiv.org/abs/2505.09970)
- [PreAct: Prediction Enhances Agent's Planning Ability](https://arxiv.org/abs/2402.11534)
- [PreAct: Computer-Using Agents that Get Faster on Repeated Tasks](https://arxiv.org/abs/2606.17929)
