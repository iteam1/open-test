import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import { FragmentStore } from './store'
import { SessionBrowser } from './browser'
import { matchFragments } from './match'
import { runFragment, saveFragment, type SaveFragmentInput } from './runner'

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
})

const paramShape = z.object({
  name: z.string(),
  type: z.enum(['string', 'boolean', 'number']),
  required: z.boolean(),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  description: z.string(),
})

/**
 * The three in-process fragment tools bundled into one SDK MCP server
 * (5.1, contribute.md). Returns an McpServerConfig to merge into
 * options.mcpServers. Both the store and browser are per-session state
 * closed over here: the browser holds the shared context run_fragment
 * reuses across a session; the store is the app-wide fragment library.
 */
export function createFragmentServer(
  store: FragmentStore,
  browser: SessionBrowser,
): McpServerConfig {
  const matchTool = tool(
    'match_fragments',
    "Find reusable Playwright fragments matching a URL (and optional tags). Returns a ranked, capped shortlist with each candidate's description and code so you can pick one to run_fragment. Deterministic — no guessing; call this before driving a test live.",
    {
      url: z.string(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const shortlist = matchFragments(await store.list(), args.url, args.tags)
      const view = shortlist.map((f) => ({
        name: f.meta.name,
        description: f.meta.description,
        scope: f.meta.scope,
        url_pattern: f.meta.url_pattern,
        tags: f.meta.tags,
        params: f.meta.params,
        code: f.code,
      }))
      return textResult(JSON.stringify(view, null, 2))
    },
  )

  const runTool = tool(
    'run_fragment',
    'Execute a saved fragment by name against the current page, passing its params as args. On failure it returns an error (fall back to driving the step live in this same turn).',
    {
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      const result = await runFragment(
        store,
        browser,
        args.name,
        (args.args as Record<string, unknown>) ?? {},
      )
      if (!result.ok)
        return textResult(`run_fragment failed: ${result.error}`, true)
      return textResult(JSON.stringify({ ok: true, value: result.value }))
    },
  )

  const saveTool = tool(
    'save_fragment',
    'Persist a Playwright flow as a reusable fragment. It is cold-run verified in a fresh isolated browser before being written — a fragment that only worked due to leftover state is rejected. Saving a near-duplicate (same url_pattern + overlapping tags) updates it in place instead of creating a copy.',
    {
      name: z.string(),
      description: z.string(),
      scope: z.enum(['specific', 'common']),
      url_pattern: z.string(),
      tags: z.array(z.string()),
      params: z.array(paramShape),
      code: z.string(),
      verify_url: z
        .string()
        .optional()
        .describe(
          'Concrete URL to cold-run against. Required for a common fragment (broad/empty url_pattern); the page you just tested on. Optional for a specific fragment.',
        ),
    },
    async (args) => {
      const input: SaveFragmentInput = {
        name: args.name,
        description: args.description,
        scope: args.scope,
        url_pattern: args.url_pattern,
        tags: args.tags,
        params: args.params,
        code: args.code,
        verifyUrl: args.verify_url,
      }
      const result = await saveFragment(store, browser, input)
      if (!result.ok)
        return textResult(`save_fragment rejected: ${result.error}`, true)
      const note = result.updated
        ? `Updated existing fragment in place.${result.reverified.length ? ` Marked for re-verification: ${result.reverified.join(', ')}.` : ''}`
        : 'Saved as a new fragment.'
      return textResult(note)
    },
  )

  return createSdkMcpServer({
    name: 'fragments',
    tools: [matchTool, runTool, saveTool],
  })
}
