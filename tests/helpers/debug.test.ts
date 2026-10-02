import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../../src/helpers/config";
import { debug } from "../../src/helpers/debug";
import { AppError } from "../../src/helpers/error";
import { codes } from "../../src/helpers/response";
import { createFakeRequest } from "./test-utils";

let directory: string;
let file: string;
let enabled: boolean;
let configuredFile: string | undefined;

const readLog = async (): Promise<string> => readFile(file, "utf8").catch(() => "");

const writeError = (error: unknown, body: Record<string, unknown> = { q: "google" }) =>
  debug.error({ request: createFakeRequest(body), code: codes.SEARCH_FAILED, status: 502, error });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "web-io-debug-"));
  file = join(directory, "debug.txt");
  enabled = config.debug;
  configuredFile = process.env.DEBUG_FILE;
  process.env.DEBUG_FILE = file;
});

afterEach(async () => {
  config.debug = enabled;
  if (configuredFile === undefined) delete process.env.DEBUG_FILE;
  else process.env.DEBUG_FILE = configuredFile;

  await rm(directory, { recursive: true, force: true });
});

describe("debug.error", () => {
  test("writes nothing while debug mode is off", async () => {
    config.debug = false;

    await writeError(new Error("net::ERR_NAME_NOT_RESOLVED"));

    expect(await readLog()).toBe("");
  });

  test("writes the request, the code, the status and the original error", async () => {
    config.debug = true;

    await writeError(new Error("Navigation timeout of 30000 ms exceeded"), { q: "google", page: 2 });

    const log = await readLog();
    expect(log).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // timestamp
    expect(log).toContain("POST /api/v1/website/search");
    expect(log).toContain("BODY: q=google&page=2");
    expect(log).toContain("CODE: SEARCH_FAILED");
    expect(log).toContain("STATUS: 502");
    expect(log).toContain("Error: Navigation timeout of 30000 ms exceeded");
    expect(log).toContain("STACK:");
    expect(log).toContain("debug.test.ts"); // the stack points at the throwing frame
    expect(log.trimEnd().endsWith("=".repeat(80))).toBe(true);
  });

  test("keeps the underlying error of an application error", async () => {
    config.debug = true;
    const cause = new Error("net::ERR_CONNECTION_REFUSED at https://www.google.com/search");

    await writeError(new AppError(502, codes.SEARCH_FAILED, cause));

    const log = await readLog();
    expect(log).toContain("CODE: SEARCH_FAILED");
    expect(log).toContain("CAUSE:");
    expect(log).toContain("net::ERR_CONNECTION_REFUSED");
    expect(log).toContain("at "); // the cause carries its own stack
  });

  test("appends instead of overwriting", async () => {
    config.debug = true;

    await writeError(new Error("first failure"));
    await writeError(new Error("second failure"));

    const log = await readLog();
    expect(log).toContain("first failure");
    expect(log).toContain("second failure");
    expect(log.indexOf("first failure")).toBeLessThan(log.indexOf("second failure"));
  });

  test("redacts credential-like body fields", async () => {
    config.debug = true;

    await writeError(new Error("nope"), { q: "google", api_key: "super-secret", token: "abc123" });

    const log = await readLog();
    expect(log).toContain("q=google");
    expect(log).toContain("api_key=[redacted]");
    expect(log).toContain("token=[redacted]");
    expect(log).not.toContain("super-secret");
    expect(log).not.toContain("abc123");
  });

  test("resolves without throwing when the log cannot be written", async () => {
    config.debug = true;
    // The parent "directory" is a file, so the append can only fail.
    process.env.DEBUG_FILE = join(file, "nested", "debug.txt");

    const logged = console.error;
    const messages: unknown[] = [];
    console.error = (...args: unknown[]) => messages.push(...args);

    try {
      await expect(writeError(new Error("still reported"))).resolves.toBeUndefined();
    } finally {
      console.error = logged;
    }

    expect(messages.length).toBeGreaterThan(0);
  });
});
