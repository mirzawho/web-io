import { describe, expect, test } from "bun:test";
import type { LaunchOptions } from "puppeteer";

import { config } from "../../src/helpers/config";
import { Browser } from "../../src/services/browser";
import type { BrowserLauncher } from "../../src/services/browser";
import { createFakeBrowser, createFakePage } from "../helpers/test-utils";

const testConfig = { ...config, browser: { ...config.browser, timeout: 1_000 } };

describe("Browser", () => {
  test("launches Chromium once and reuses it for concurrent requests", async () => {
    const harness = createFakeBrowser([createFakePage(), createFakePage(), createFakePage()]);
    const service = new Browser(testConfig, harness.launcher);

    const pages = await Promise.all([service.getPage(), service.getPage(), service.getPage()]);

    expect(harness.launches()).toBe(1);
    expect(new Set(pages).size).toBe(3);

    await service.close();
    expect(harness.isClosed()).toBe(true);
  });

  test("launches with the configured Chromium profile so the session survives restarts", async () => {
    const harness = createFakeBrowser([createFakePage()]);
    const service = new Browser(testConfig, harness.launcher);

    await service.getPage();

    expect(harness.options()[0]?.userDataDir).toBe(testConfig.google.profileDir);
    await service.close();
  });

  test("maps the headless setting onto the launch and keeps a fixed desktop viewport", async () => {
    for (const headless of [true, false]) {
      const page = createFakePage();
      const harness = createFakeBrowser([page]);
      const service = new Browser(
        { ...testConfig, browser: { ...testConfig.browser, headless } },
        harness.launcher,
      );

      await service.getPage();

      expect(harness.options()[0]?.headless).toBe(headless);
      expect(page.viewport()).toEqual({ width: 1366, height: 768 });
      expect(harness.options()[0]?.args).toContain(`--lang=${testConfig.google.locale}`);
      expect(page.headers).toEqual([{ "accept-language": testConfig.google.locale }]);
      await service.close();
    }
  });

  test("prefers the installed Chrome in headful mode and falls back to the bundled browser", async () => {
    const page = createFakePage();
    const harness = createFakeBrowser([page]);
    const attempts: LaunchOptions[] = [];
    const launcher: BrowserLauncher = async (options) => {
      attempts.push(options);
      if (attempts.length === 1) throw new Error('Could not find a Chrome installation (channel: "chrome")');
      return harness.launcher(options);
    };
    const logged = console.error;
    console.error = () => undefined;

    try {
      const service = new Browser({ ...testConfig, browser: { ...testConfig.browser, headless: false } }, launcher);
      await service.getPage();

      expect(attempts[0]?.channel).toBe("chrome");
      expect(attempts[1]?.channel).toBeUndefined();
      expect(attempts[1]?.userDataDir).toBe(testConfig.google.profileDir);
      await service.close();
    } finally {
      console.error = logged;
    }
  });

  test("uses the browser's own User-Agent unless one is configured", async () => {
    const plain = createFakePage();
    const configured = createFakePage();
    const harness = createFakeBrowser([plain, configured]);

    await new Browser(testConfig, harness.launcher).getPage();
    await new Browser(
      { ...testConfig, google: { ...testConfig.google, userAgent: "MyAgent/1.0" } },
      harness.launcher,
    ).getPage();

    expect(plain.userAgents).toEqual([]);
    expect(configured.userAgents).toEqual(["MyAgent/1.0"]);
  });

  test("closes the page after withPage completes", async () => {
    const fake = createFakePage();
    const service = new Browser(testConfig, createFakeBrowser([fake]).launcher);

    const result = await service.withPage({ blockAssets: true }, async () => "done");

    expect(result).toBe("done");
    expect(fake.isClosed()).toBe(true);
  });

  test("closes the page when the callback throws", async () => {
    const fake = createFakePage();
    const service = new Browser(testConfig, createFakeBrowser([fake]).launcher);

    await expect(
      service.withPage({}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(fake.isClosed()).toBe(true);
  });

  test("starts a new process after Chromium disconnects", async () => {
    const harness = createFakeBrowser([createFakePage(), createFakePage()]);
    const service = new Browser(testConfig, harness.launcher);

    await service.getPage();
    harness.disconnect();
    await service.getPage();

    expect(harness.launches()).toBe(2);
  });

  test("starts a new process after close()", async () => {
    const harness = createFakeBrowser([createFakePage(), createFakePage()]);
    const service = new Browser(testConfig, harness.launcher);

    await service.getPage();
    await service.close();
    await service.getPage();

    expect(harness.launches()).toBe(2);
  });

  test("closing an untouched browser is a no-op", async () => {
    const harness = createFakeBrowser();
    const service = new Browser(testConfig, harness.launcher);

    await expect(service.close()).resolves.toBeUndefined();
    expect(harness.launches()).toBe(0);
  });

  test("reports a launch failure as an upstream error without leaking internals", async () => {
    const service = new Browser(testConfig, async () => {
      throw new Error("spawn /usr/bin/chromium ENOENT");
    });

    const logged = console.error;
    console.error = () => undefined;

    try {
      await expect(service.getPage()).rejects.toMatchObject({ status: 502, code: "BROWSER_FAILED" });
    } finally {
      console.error = logged;
    }
  });
});
