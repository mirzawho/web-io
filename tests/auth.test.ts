import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../src/helpers/config";
import { messages } from "../src/helpers/response";
import { hashToken } from "../src/helpers/token";
import { searchService } from "../src/instance";
import { createApp } from "../src/server";
import { stub } from "./helpers/test-utils";

/**
 * The access token gate, driven through the real app on an ephemeral port, because what is being
 * tested is a property of the request path rather than of a function: which requests are
 * answered, and which are refused with `401 UNAUTHORIZED`.
 *
 * The suite's own default is guest mode (`tests/preload.ts` leaves AUTH_TOKEN empty and points
 * AUTH_TOKEN_FILE at a path that does not exist), and every test here sets one of the two
 * sources explicitly.
 */
let directory: string;
let server: Server;
let baseUrl: string;

const TOKEN = "a-token-the-suite-generated";

const configured = {
  token: "",
  tokenFile: "",
};

// The search service is stubbed for the whole file: an accepted request has to reach a 200
// without a search backend, and only the gate is under test here.
let restoreSearch: () => void;

async function listen(): Promise<string> {
  server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${port}/api/v1`;
}

const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

/** The one request every test makes: a search, which is authenticated on both edges. */
const search = (headers: Record<string, string> = {}, base = baseUrl) =>
  fetch(`${base}/website/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ q: "bun" }),
  });

const health = (base = baseUrl) => fetch(`${base}/health`);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "web-io-auth-"));
  configured.token = config.auth.token;
  configured.tokenFile = config.auth.tokenFile;

  config.auth.token = "";
  config.auth.tokenFile = join(directory, "token");

  restoreSearch = stub(searchService, "search", async () => ({
    results: [],
    meta: { page: 1, limit: 10, total: 0, last: 0 },
  }));
});

afterEach(async () => {
  restoreSearch();
  await close();
  config.auth.token = configured.token;
  config.auth.tokenFile = configured.tokenFile;
  await rm(directory, { recursive: true, force: true });
});

describe("guest mode", () => {
  test("with no token configured, every request is answered without one", async () => {
    baseUrl = await listen();

    const response = await search();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "OK" });
  });

  test("a token file that does not exist is guest mode, not a refusal", async () => {
    // The directory exists but the file in it does not, which is the state a fresh deployment
    // is in before anyone runs bin/generate-token.
    baseUrl = await listen();

    expect((await search()).status).toBe(200);
  });

  test("an empty token file is guest mode too", async () => {
    await writeFile(config.auth.tokenFile, "\n");
    baseUrl = await listen();

    expect((await search()).status).toBe(200);
  });

  test("an unreadable token file leaves the instance answering as a guest", async () => {
    // A directory where the token file should be: readable as a path, not as a token.
    config.auth.tokenFile = directory;
    baseUrl = await listen();

    expect((await search()).status).toBe(200);
  });
});

describe("with a token configured", () => {
  beforeEach(async () => {
    config.auth.token = TOKEN;
  });

  test("the token is required, and a request without one is refused", async () => {
    baseUrl = await listen();

    const response = await search();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: messages.UNAUTHORIZED,
      meta: { took: expect.any(Number) },
      data: null,
    });
  });

  test("Authorization: Bearer is accepted", async () => {
    baseUrl = await listen();

    const response = await search({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(200);
  });

  test("X-API-Key is accepted", async () => {
    baseUrl = await listen();

    const response = await search({ "x-api-key": TOKEN });

    expect(response.status).toBe(200);
  });

  test("the scheme is case-insensitive and the value is trimmed", async () => {
    baseUrl = await listen();

    expect((await search({ authorization: `bearer   ${TOKEN}  ` })).status).toBe(200);
  });

  test("a wrong token is refused, however it is sent", async () => {
    baseUrl = await listen();

    const cases: Array<Record<string, string>> = [
      { authorization: "Bearer not-the-token" },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: TOKEN }, // no scheme at all
      { "x-api-key": "not-the-token" },
      { "x-api-key": "" },
      { authorization: "" },
    ];

    for (const headers of cases) {
      const response = await search(headers);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, code: "UNAUTHORIZED", data: null });
    }
  });

  test("every /website endpoint requires it, not just the one route", async () => {
    baseUrl = await listen();

    const requests = [
      fetch(`${baseUrl}/website/search/sources`),
      fetch(`${baseUrl}/website/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    }
  });

  test("/health stays open, so a probe never needs the token", async () => {
    baseUrl = await listen();

    const response = await health();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "OK", data: { status: "healthy" } });
  });

  test("the token is checked before the body, so a bad token never reaches the schema", async () => {
    baseUrl = await listen();

    // A body the schema would refuse with VALIDATION_ERROR: the 401 is what comes back, which
    // is what makes the gate the first thing a request meets.
    const response = await fetch(`${baseUrl}/website/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("the token file", () => {
  test("is read on every request, so generating a token takes effect without a restart", async () => {
    baseUrl = await listen();

    // Guest to start with: the file does not exist yet.
    expect((await search()).status).toBe(200);

    // bin/generate-token writes the hash of the token it printed.
    await writeFile(config.auth.tokenFile, `${hashToken(TOKEN)}\n`);

    // The same instance, no restart: the requirement is on now.
    expect((await search()).status).toBe(401);
    expect((await search({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  test("deleting it lifts the requirement again, without a restart", async () => {
    await writeFile(config.auth.tokenFile, hashToken(TOKEN));
    baseUrl = await listen();

    expect((await search()).status).toBe(401);

    await rm(config.auth.tokenFile);

    expect((await search()).status).toBe(200);
  });

  test("AUTH_TOKEN wins over the file, so a deployment can keep it in a secret store", async () => {
    await writeFile(config.auth.tokenFile, hashToken("the-file-token"));
    config.auth.token = TOKEN;
    baseUrl = await listen();

    expect((await search({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    // The file is ignored while AUTH_TOKEN is set, so the token in it is not accepted.
    expect((await search({ authorization: "Bearer the-file-token" })).status).toBe(401);
  });
});

describe("the MCP endpoint", () => {
  /** The same app, with MCP mounted and the given token configured. */
  const mcpApp = async (token: string): Promise<string> => {
    config.auth.token = token;
    config.mcp.enabled = true;

    server = createApp().listen(0);
    const { port } = server.address() as AddressInfo;

    return `http://127.0.0.1:${port}`;
  };

  const mcpCall = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  const configuredMcp = config.mcp.enabled;

  afterEach(() => {
    config.mcp.enabled = configuredMcp;
  });

  test("is open in guest mode, like every other endpoint", async () => {
    const base = await mcpApp("");

    expect((await mcpCall(base)).status).toBe(200);
  });

  test("requires the token once one is configured, and answers in JSON-RPC", async () => {
    const base = await mcpApp(TOKEN);

    const refused = await mcpCall(base);

    expect(refused.status).toBe(401);
    // MCP's own vocabulary rather than the REST envelope, and a client is told what to send.
    expect(refused.headers.get("www-authenticate")).toContain("Bearer");
    expect(await refused.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "A valid access token is required." },
      id: null,
    });

    expect((await mcpCall(base, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await mcpCall(base, { "x-api-key": TOKEN })).status).toBe(200);
    expect((await mcpCall(base, { authorization: "Bearer nope" })).status).toBe(401);
  });
});
