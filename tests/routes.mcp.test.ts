import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { config, toBool } from "../src/helpers/config";
import { AppError } from "../src/helpers/error";
import { codes } from "../src/helpers/response";
import { page, searchService } from "../src/instance";
import { MAX_PAGE, SOURCE_PATTERN } from "../src/routes.api";
import { createApp } from "../src/server";
import type { ExtractOptions } from "../src/services/page";
import type { SearchOptions } from "../src/services/search";
import { stub } from "./helpers/test-utils";

/**
 * Boots an app on an ephemeral port with the given MCP setting. The setting is read when the app
 * is built, so changing it and calling createApp() is what "enabled" means here - the same shape
 * the Swagger tests use.
 */
async function withApp<T>(enabled: boolean, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const configured = config.mcp.enabled;
  config.mcp.enabled = enabled;

  const server: Server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.mcp.enabled = configured;
  }
}

/** An MCP client connected to /mcp on that app, disconnected on the way out. */
async function withClient<T>(baseUrl: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "web-io-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

/**
 * The single text block a tool answers with. The SDK's tool result is a union that also allows
 * a task result, so the shape is narrowed here rather than asserted.
 */
function toolText(result: unknown): string {
  const [first] = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("The tool answered without a text content block.");
  }

  return first.text;
}

const searchPayload = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("MCP configuration", () => {
  test("the default is off", () => {
    expect(config.mcp.enabled).toBe(false);
  });

  test("only the truthy spellings enable it; a missing or misspelled value leaves it off", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " On "]) expect(toBool(raw, false)).toBe(true);

    // A missing value, an empty one, an explicit false, and anything that is not one of the
    // four spellings. The rule is the one every other boolean setting already uses.
    for (const raw of [undefined, "", "0", "false", "no", "off", "enabled", "treu"]) {
      expect(toBool(raw, false)).toBe(false);
    }
  });
});

describe("MCP disabled", () => {
  test("/mcp is not exposed, and answers with the API's 404 envelope", async () => {
    await withApp(false, async (baseUrl) => {
      const response = await searchPayload(`${baseUrl}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
    });
  });

  test("an MCP client cannot connect", async () => {
    await withApp(false, async (baseUrl) => {
      const client = new Client({ name: "web-io-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

      try {
        await expect(client.connect(transport)).rejects.toThrow();
      } finally {
        await client.close();
      }
    });
  });
});

describe("MCP enabled", () => {
  test("/mcp is registered and reaches an MCP client", async () => {
    await withApp(true, (baseUrl) =>
      withClient(baseUrl, async (client) => {
        // The handshake answered with this application's own identity.
        expect(client.getServerVersion()).toMatchObject({ name: "web-io", version: config.version });
      }),
    );
  });

  test("the methods that need a session are refused", async () => {
    await withApp(true, async (baseUrl) => {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${baseUrl}/mcp`, { method });

        expect(response.status).toBe(405);
        expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
      }
    });
  });

  test("the REST API is untouched while MCP is enabled", async () => {
    const restore = stub(searchService, "search", async () => ({
      results: [],
      meta: { page: 1, limit: 10, total: 0, last: 0 },
    }));

    try {
      await withApp(true, async (baseUrl) => {
        const health = await fetch(`${baseUrl}/api/v1/health`);
        expect(health.status).toBe(200);

        const search = await searchPayload(`${baseUrl}/api/v1/website/search`, { q: "bun" });
        expect(search.status).toBe(200);
        // The standard envelope, not a JSON-RPC message.
        expect(await search.json()).toMatchObject({ ok: true, status: 200, code: "OK" });
      });
    } finally {
      restore();
    }
  });
});

describe("MCP tools", () => {
  /** The two tools the enabled app advertises, listed once per test. */
  const listTools = () => withApp(true, (baseUrl) => withClient(baseUrl, (client) => client.listTools()));

  test("exactly the two website tools are exposed", async () => {
    const { tools } = await listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["website_fetch", "website_search"]);
  });

  test("each tool carries a description written for a model", async () => {
    const { tools } = await listTools();

    for (const tool of tools) {
      expect(tool.description).toBeString();
      expect((tool.description ?? "").length).toBeGreaterThan(100);
    }

    // The two are told apart in both directions, which is what keeps a model from picking the
    // wrong one.
    const search = tools.find((tool) => tool.name === "website_search")!;
    const fetchTool = tools.find((tool) => tool.name === "website_fetch")!;

    expect(search.description).toContain("website_fetch");
    expect(fetchTool.description).toContain("website_search");
  });

  test("website_search exposes the route's parameters and bounds", async () => {
    const { tools } = await listTools();

    expect(tools.find((tool) => tool.name === "website_search")!.inputSchema).toMatchObject({
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", minLength: 1 },
        page: { type: "integer", minimum: 1, maximum: MAX_PAGE, default: 1 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: config.search.maxResults,
          default: config.search.maxResults,
        },
        sources: { type: "array", items: { type: "string", pattern: SOURCE_PATTERN.source } },
        language: { type: "string" },
      },
    });
  });

  test("website_fetch exposes the url and the driver enum, defaulting to fetch", async () => {
    const { tools } = await listTools();

    expect(tools.find((tool) => tool.name === "website_fetch")!.inputSchema).toMatchObject({
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1 },
        driver: { type: "string", enum: ["fetch", "browser"], default: "fetch" },
      },
    });
  });

  test("no tool exposes an untyped schema", async () => {
    const { tools } = await listTools();

    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.inputSchema.required?.length).toBeGreaterThan(0);
    }
  });
});

describe("website_search", () => {
  /** Replaces the search service so a test can see what the tool asked it for. */
  const stubbedSearch = () => {
    const calls: Array<{ query: string; options?: SearchOptions }> = [];
    const restore = stub(searchService, "search", async (query, options) => {
      calls.push({ query, options });
      return {
        results: [{ title: "Bun", url: "https://bun.sh/", description: "A runtime.", position: 1 }],
        meta: { page: options?.page ?? 1, limit: options?.limit ?? 10, total: 1, last: 1 },
      };
    });

    return { calls, restore };
  };

  test("calls the existing search service and returns what it answered", async () => {
    const service = stubbedSearch();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({ name: "website_search", arguments: { q: "  bun  " } });

          expect(result.isError).toBeFalsy();
          // The query arrived trimmed and the schema's defaults were filled in, exactly as the
          // route's validator does, and the same service instance answered.
          expect(service.calls).toEqual([
            { query: "bun", options: { page: 1, limit: config.search.maxResults, sources: undefined } },
          ]);
          expect(JSON.parse(toolText(result))).toEqual({
            results: [{ title: "Bun", url: "https://bun.sh/", description: "A runtime.", position: 1 }],
            meta: { page: 1, limit: config.search.maxResults, total: 1, last: 1 },
          });
        }),
      );
    } finally {
      service.restore();
    }
  });

  test("passes page, limit, sources and language through", async () => {
    const service = stubbedSearch();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          await client.callTool({
            name: "website_search",
            arguments: { q: "bun", page: 2, limit: 5, sources: ["  BiNg  ", "google"], language: "  en  " },
          });

          // Each engine name is trimmed and lower-cased and the language is trimmed: the
          // sanitizers the route declares, applied to the same fields.
          expect(service.calls).toEqual([
            { query: "bun", options: { page: 2, limit: 5, sources: ["bing", "google"], language: "en" } },
          ]);
        }),
      );
    } finally {
      service.restore();
    }
  });

  test("an argument the schema refuses is a tool error and never reaches the service", async () => {
    const service = stubbedSearch();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const cases: Array<Record<string, unknown>> = [
            {},
            { q: "" },
            { q: "bun", page: 0 },
            { q: "bun", page: MAX_PAGE + 1 },
            { q: "bun", limit: config.search.maxResults + 1 },
            { q: "bun", sources: ["GOOGLE CSE"] },
            { q: "bun", sources: "bing" },
          ];

          for (const arguments_ of cases) {
            const result = await client.callTool({ name: "website_search", arguments: arguments_ });

            expect(result.isError).toBe(true);
            expect(toolText(result)).toContain("Input validation error");
          }
        }),
      );

      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });
});

describe("website_fetch", () => {
  /** Replaces the page service so a test can see what the tool asked it for. */
  const stubbedPage = () => {
    const calls: Array<{ url: string; options?: ExtractOptions }> = [];
    const restore = stub(page, "extract", async (url, options) => {
      calls.push({ url: url.toString(), options });
      return {
        url: url.toString(),
        status: 200,
        title: "Example",
        metadata: { language: "en", jsonld: [] },
        links: [],
        images: [],
        videos: [],
        audios: [],
        content: "# Example",
      };
    });

    return { calls, restore };
  };

  test("calls the existing page service and returns what it answered", async () => {
    const service = stubbedPage();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({
            name: "website_fetch",
            arguments: { url: "https://93.184.216.34/article" },
          });

          expect(result.isError).toBeFalsy();
          // No driver asked for means `fetch`, the same default the route applies.
          expect(service.calls).toEqual([
            { url: "https://93.184.216.34/article", options: { driver: "fetch" } },
          ]);
          expect(JSON.parse(toolText(result))).toMatchObject({ title: "Example", content: "# Example", status: 200 });
        }),
      );
    } finally {
      service.restore();
    }
  });

  test("driver: browser is passed through to the service", async () => {
    const service = stubbedPage();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          await client.callTool({
            name: "website_fetch",
            arguments: { url: "https://93.184.216.34/article", driver: "browser" },
          });

          expect(service.calls).toEqual([
            { url: "https://93.184.216.34/article", options: { driver: "browser" } },
          ]);
        }),
      );
    } finally {
      service.restore();
    }
  });

  test("an unsupported driver is a tool error and never reaches the service", async () => {
    const service = stubbedPage();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({
            name: "website_fetch",
            arguments: { url: "https://93.184.216.34/article", driver: "puppeteer" },
          });

          expect(result.isError).toBe(true);
          expect(toolText(result)).toContain("Input validation error");
        }),
      );

      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("the route's URL rules are applied before the service is called", async () => {
    const service = stubbedPage();

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          // parseHttpUrl, the same helper the controller uses, refuses these.
          const cases: Array<[string, string]> = [
            ["file:///etc/passwd", codes.UNSUPPORTED_PROTOCOL],
            ["not a url", codes.INVALID_URL],
          ];

          for (const [url, code] of cases) {
            const result = await client.callTool({ name: "website_fetch", arguments: { url } });

            expect(result.isError).toBe(true);
            expect(toolText(result)).toContain(code);
          }
        }),
      );

      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });
});

describe("MCP tool errors", () => {
  test("a search failure is surfaced as a tool error, not a successful result", async () => {
    const restore = stub(searchService, "search", async () => {
      throw new AppError(503, codes.SEARCH_UNAVAILABLE);
    });

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({ name: "website_search", arguments: { q: "bun" } });

          expect(result.isError).toBe(true);
          expect(toolText(result)).toContain(codes.SEARCH_UNAVAILABLE);
          // The failure is reported as an error, so nothing is handed over as data.
          expect(result.structuredContent).toBeUndefined();
        }),
      );
    } finally {
      restore();
    }
  });

  test("a page failure is surfaced as a tool error", async () => {
    const restore = stub(page, "extract", async () => {
      throw new AppError(502, codes.PAGE_FETCH_FAILED);
    });

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({
            name: "website_fetch",
            arguments: { url: "https://93.184.216.34/article" },
          });

          expect(result.isError).toBe(true);
          expect(toolText(result)).toContain(codes.PAGE_FETCH_FAILED);
        }),
      );
    } finally {
      restore();
    }
  });

  test("an unexpected error is not swallowed either", async () => {
    const restore = stub(searchService, "search", async () => {
      throw new Error("the search backend exploded");
    });

    try {
      await withApp(true, (baseUrl) =>
        withClient(baseUrl, async (client) => {
          const result = await client.callTool({ name: "website_search", arguments: { q: "bun" } });

          expect(result.isError).toBe(true);
          expect(toolText(result)).toContain("the search backend exploded");
        }),
      );
    } finally {
      restore();
    }
  });
});
