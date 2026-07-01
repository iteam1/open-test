import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright'

/**
 * The one shared Playwright context per session (design.md/contribute.md):
 * every run_fragment call in a session shares it, so a composite's steps see
 * each other's state. save_fragment does NOT use this — its cold-run check
 * opens its own throwaway context via freshContext() below.
 */
export class SessionBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  /** Lazy — no browser process until the first fragment actually runs. */
  async getPage(): Promise<Page> {
    if (!this.browser) this.browser = await chromium.launch()
    if (!this.context) this.context = await this.browser.newContext()
    if (!this.page) this.page = await this.context.newPage()
    return this.page
  }

  /**
   * Close and reopen the shared context after a failed/discarded attempt
   * (contribute.md: "the app closes and reopens that context before the
   * next call, so stale partial state never leaks into what comes next").
   * The browser process itself stays up — only the context is replaced.
   */
  async resetContext(): Promise<void> {
    await this.context?.close().catch(() => {})
    this.context = null
    this.page = null
  }

  /**
   * A genuinely fresh, isolated context for save_fragment's cold run —
   * real CDP-level isolation (Target.createBrowserContext), sharing only
   * the browser process. Caller must close() it.
   */
  async freshContext(): Promise<BrowserContext> {
    if (!this.browser) this.browser = await chromium.launch()
    return this.browser.newContext()
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {})
    this.browser = null
    this.context = null
    this.page = null
  }
}
