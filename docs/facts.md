# Facts

Reference glossary for terms researched while shaping `overview.md`. Format: `[term](link) - summary`.

## Agent planning research

- [Pre-Act](https://arxiv.org/abs/2505.09970) - Agent writes a full multi-step plan (thought + action + expected result per step) before acting, then patches the remaining plan after each real tool result instead of re-planning from scratch. Measures Action Recall (did the action match the plan) and Goal Completion Rate (% of milestones hit). Big reported gains came from fine-tuning small models — not usable with Claude directly, but the "plan up front, patch after each step" prompting pattern is.

- [PreAct](https://arxiv.org/abs/2402.11534) - Agent predicts the expected result before acting, then compares the real result to that prediction; a mismatch is the signal to stop and reconsider instead of plowing ahead. Pure prompting technique, no fine-tuning needed. Tested on ALFWorld, WebShop, HotpotQA; beats plain ReAct.

- [PreAct (2026, unrelated paper — same name, different authors/idea)](https://arxiv.org/abs/2606.17929) - "Computer-Using Agents that Get Faster on Repeated Tasks." First successful run of a task is compiled into a deterministic state-machine program (states = expected screen conditions, transitions = actions). On repeat, it replays the program directly — no LLM calls — 8.5-13x faster. Before each replayed step, it checks the real screen still matches what's expected; if not, control returns to the full agent. A program only gets saved for reuse if an independent evaluator confirms it actually completed the task from a clean run. This is exactly overview.md's "reuse Playwright scripts instead of agent tokens" idea, plus the two missing pieces: a state-check fallback, and a don't-cache-it-unless-verified gate.

## Playwright (five distinct things, same name — easy to conflate)

- [Playwright Test Framework](https://playwright.dev/docs/intro) - `@playwright/test` package. Full test runner: `test()`/`expect()`, fixtures, parallel workers, `playwright.config.ts`, trace viewer, reporters. Includes UI Mode (`playwright test --ui`) - interactive run/debug/watch with time-travel and a locator picker. UI Mode needs real test files + config; it does not work against plain Playwright Library scripts. For writing and running automated test suites.

- [Playwright Library](https://playwright.dev/docs/library) - the bare `playwright` package, no test runner. `chromium.launch()`, `page.goto()`, etc. run with plain `node`/`bun script.js`. For one-off automation, not test suites — what open-test's reusable scripts should be built on.

- [Playwright CLI](https://playwright.dev/docs/test-cli) - `npx playwright <cmd>`. Terminal utility: `install` (download browser binaries), `codegen` (record a session, generate code), `show-report`, `show-trace`, `merge-reports`. Setup/inspection, not execution logic. Not the same thing as the Agent CLI below — easy to confuse, very different purpose.

- [Playwright Agent CLI](https://playwright.dev/agent-cli/quick-start) - separate package `@playwright/cli`, binary `playwright-cli`. Same underlying browser tools as Playwright MCP (open, click, type, snapshot, screenshot) but invoked as a plain shell command instead of through the MCP protocol. The key difference: MCP keeps browser state (snapshots, screenshots) inline in the model's context; Agent CLI writes it to disk and returns a file path, so the agent only reads what it actually needs. Microsoft's own numbers: ~114K tokens for a typical task via MCP vs. ~27K via Agent CLI (~4x cheaper, sometimes more). Use it when the agent has shell/filesystem access (Claude Code does) — this is what open-test's fallback path (no reusable script yet) should use, not MCP.

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) - `@playwright/mcp`. MCP server exposing browser control as tools (`browser_navigate`, `browser_click`, `browser_snapshot`, ...) for an AI agent to drive interactively. Works off the accessibility tree, not pixels. The right tool only when the agent has *no* shell access (Claude Desktop, a sandboxed chat UI) — for Claude Code, which has shell access, the Agent CLI above does the same job for ~4x less cost. open-test should use MCP nowhere in its main flow; it's a fallback-of-a-fallback at best.

## Claude

- [Claude Code](https://claude.com/product/claude-code) - terminal agentic coding CLI. Embedded by spawning it as a subprocess (`claude -p "..." --output-format stream-json`). Has its own session/transcript storage, skills (`.claude/skills/`), subagents (`.claude/agents/`), hooks, MCP support.

- [Claude Agent SDK (TypeScript)](https://github.com/anthropics/claude-agent-sdk-typescript) - `for await (m of query({...}))`. Verified in the SDK's own CHANGELOG: it spawns the same native `claude` binary as a subprocess (`options.pathToClaudeCodeExecutable`, `startup()` to pre-warm it) — not in-process. The win over raw CLI isn't "no subprocess," it's that the SDK manages that subprocess and hands back typed events instead of raw stdout to parse yourself, plus `permissionMode`, JS-callback `hooks`, and `resume` as real options. A former session class (`SDKSession`, via `unstable_v2_createSession`) was removed — `query()` alone now covers multi-turn, two ways: `options.resume` per call (simple, but a fresh subprocess each time, no mid-turn control), or a persistent streaming-input connection (`prompt` as an `AsyncIterable`, one subprocess for the whole session) — only the streaming form unlocks `interrupt()`/`setPermissionMode()`/`setModel()`. `createSdkMcpServer()`/`tool()` define custom MCP tools that run in-process, no separate server needed. Still respects `CLAUDE.md`/`.claude/skills` on disk. open-test's chosen integration (see overview.md Scope, design.md).

- [Anthropic SDK (raw)](https://github.com/anthropics/anthropic-sdk-typescript) - `@anthropic-ai/sdk`. Just the Messages API HTTP client (`client.messages.create()`). No agent loop, no tool execution, no permissions — you build all of that yourself. Not what open-test uses, since Claude Code/Agent SDK already provide the loop.

- [Claude Code session storage](https://code.claude.com/docs/en/overview) - not documented on this page directly; confirmed by inspecting this machine's `~/.claude/projects/<slugified-cwd>/`. Holds `<claude_session_id>.jsonl` (full transcript; each `assistant` line has a token-usage object, no dollar cost), plus a same-named folder with `subagents/agent-<id>.jsonl`+`.meta.json` and `tool-results/*.txt`. open-test sets its session folder as Claude Code's `cwd`, so this storage comes for free, joined via `claude_session_id`.

## Runtime & tooling

- [Electron](https://www.electronjs.org/docs/latest/) - cross-platform desktop shell (Chromium + Node in one binary). Main process (Node, owns windows/lifecycle) vs. renderer process (sandboxed, no direct Node access), bridged via `contextBridge`. `loadURL('http://localhost:<port>')` is how it points at a local daemon/web UI — open-test's planned pattern.

- [Bun](https://bun.com/docs) - single-binary JS/TS runtime (JavaScriptCore, not V8) + package manager + bundler + test runner. `bun install` is much faster than npm/pnpm; runs `.ts` directly (transpiles, doesn't type-check). Risk: node-gyp-compiled native addons don't work under Bun's engine — fine for tooling/daemon use, risky if relied on inside Electron's own (Node-based) process.

- [uv](https://github.com/astral-sh/uv) - fast (10-100x) Python package/project manager, written in Rust; replaces pip/pipx/poetry/pyenv/virtualenv. In open-test, this is the prerequisite needed specifically to run `mcp-server-paint` (a Python MCP server) via `uv run`.

## MCP servers

- [mcp-server-paint](https://github.com/iteam1/mcp-server-paint) - MCP server giving an agent MS-Paint-like image editing: `new_document`, `open_image`, `draw_rectangle`, `draw_ellipse`, `draw_line`, `draw_polygon`, `draw_text`, `measure_text`, `save_document`, `get_document_info`. Headless, stdio-based, runs via `uv run --directory path/to/mcp-server-paint mcp-server-paint` (or `claude mcp add paint -- uv run ...`). This is what open-test uses to annotate test screenshots.

## Reference architecture

- [open-design](https://github.com/nexu-io/open-design) - local-first, open-source design workspace: Electron + Next.js web UI + daemon, orchestrating 21+ agent CLIs through skills + design-systems + design-templates, plain-file artifacts per session/project. Apache-2.0, 73k+ stars. open-test's architectural inspiration, intentionally narrowed to one agent (Claude Code) and no database.