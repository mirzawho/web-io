import puppeteer from "puppeteer";
import type { Browser as PuppeteerBrowser, LaunchOptions, Page } from "puppeteer";

import type { Config } from "../helpers/config";
import { AppError } from "../helpers/error";
import { codes } from "../helpers/response";
import { isBlockedHost } from "../helpers/url";

export type BrowserLauncher = (options: LaunchOptions) => Promise<PuppeteerBrowser>;

export interface PageOptions {
  /**
   * Abort images, fonts and other binary payloads. Pages we only ever read as text
   * do not need them, and skipping them keeps memory and bandwidth predictable.
   * Requests to blocked hosts and non-HTTP schemes are always aborted.
   */
  blockAssets?: boolean;
}

// A normal desktop size, fixed for every page: no randomisation, no per-request change.
const VIEWPORT = { width: 1366, height: 768 };

// Flags that keep Chromium stable in containers and in headless mode. None of them hide
// automation or touch the profile: no --disable-blink-features, no user-agent patches.
const BASE_ARGS = ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"];

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);

/**
 * Single owner of the Chromium process. Launching a browser costs hundreds of
 * milliseconds and tens of megabytes, so one instance is reused for every request
 * while each request still gets - and closes - its own page.
 */
export class Browser {
  private browser: PuppeteerBrowser | null = null;
  private launching: Promise<PuppeteerBrowser> | null = null;

  constructor(
    private readonly config: Config,
    private readonly launch: BrowserLauncher = (options) => puppeteer.launch(options),
  ) {}

  /** Opens a page. The caller owns it and must close it. */
  async getPage(options: PageOptions = {}): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport(VIEWPORT);
      await page.setExtraHTTPHeaders({ "accept-language": this.config.google.locale });
      // The browser's own User-Agent is used unless one is configured explicitly.
      if (this.config.google.userAgent !== "") await page.setUserAgent(this.config.google.userAgent);
      page.setDefaultTimeout(this.config.browser.timeout);
      page.setDefaultNavigationTimeout(this.config.browser.timeout);
      if (options.blockAssets === true) await this.guardRequests(page);
      return page;
    } catch (error) {
      // Never leak a half-configured page when the setup itself fails.
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  /** Runs `run` with a fresh page and closes it afterwards, even on failure. */
  async withPage<T>(options: PageOptions, run: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.getPage(options);
    try {
      return await run(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    if (browser !== null) await browser.close().catch(() => undefined);
  }

  private async getBrowser(): Promise<PuppeteerBrowser> {
    if (this.browser !== null && this.browser.connected) return this.browser;

    // Concurrent requests must not each start a Chromium: the first caller creates
    // the promise, everybody else awaits the same one.
    this.launching ??= this.launchOnce()
      .then((browser) => {
        this.browser = browser;
        browser.on("disconnected", () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      })
      .catch((error: unknown) => {
        // The cause goes to the log, not to the response: it names paths and binaries.
        console.error("[web-io] browser launch failed:", error);
        throw new AppError(502, codes.BROWSER_FAILED, error);
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  /**
   * Launches the one browser for this process. In headful mode the installed Chrome is
   * preferred - that is the local debugging mode, where the browser a person actually uses
   * is the most useful thing to see - while containers and headless runs let Puppeteer
   * resolve the browser itself: the Chromium it downloaded, or the package its
   * `PUPPETEER_EXECUTABLE_PATH` names, which is what an image without a download has.
   */
  private async launchOnce(): Promise<PuppeteerBrowser> {
    const installedChrome = this.config.browser.headless === false;

    try {
      return await this.launch(this.launchOptions(installedChrome));
    } catch (error) {
      if (!installedChrome) throw error;

      console.error("[web-io] installed Chrome is unavailable, using the resolved browser:", error);
      return this.launch(this.launchOptions(false));
    }
  }

  private launchOptions(installedChrome: boolean): LaunchOptions {
    const args = [...BASE_ARGS, `--lang=${this.config.google.locale}`];
    if (this.config.browser.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");

    return {
      headless: this.config.browser.headless,
      args,
      timeout: this.config.browser.timeout,
      // The persistent profile keeps cookies and local storage between requests and between
      // runs, instead of discarding the session every time.
      userDataDir: this.config.google.profileDir,
      ...(installedChrome ? { channel: "chrome" as const } : {}),
    };
  }

  private async guardRequests(page: Page): Promise<void> {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      // These checks must stay synchronous: an intercepted request blocks the
      // pipeline until it is continued or aborted.
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        void request.abort().catch(() => undefined);
        return;
      }

      if (!/^https?:/i.test(request.url())) {
        void request.abort().catch(() => undefined);
        return;
      }

      // Blocks redirects (and subresources) that point back into private networks
      // after the initial URL was validated.
      if (isBlockedHost(new URL(request.url()).hostname)) {
        void request.abort().catch(() => undefined);
        return;
      }

      void request.continue().catch(() => undefined);
    });
  }
}
