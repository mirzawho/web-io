import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction } from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cache } from "../src/cache";
import { config } from "../src/helpers/config";
import type { FailureContext } from "../src/helpers/debug";
import { AppError } from "../src/helpers/error";
import { codes, messages, responseMiddleware } from "../src/helpers/response";
import type { ApiResponse } from "../src/helpers/response";
import { page, searchService } from "../src/instance";
import { app, errorHandler } from "../src/server";
import type { ExtractOptions } from "../src/services/page";
import type { SearchOptions, SearchSource } from "../src/services/search";
import { createFakeRequest, createFakeResponse, stub } from "./helpers/test-utils";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = async (path: string, status: number): Promise<ApiResponse> => {
  const response = await fetch(`${baseUrl}${path}`);

  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");

  return (await response.json()) as ApiResponse;
};

const post = async (path: string, body: unknown, status: number): Promise<ApiResponse> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");

  return (await response.json()) as ApiResponse;
};

/** Asserts the envelope every response carries, success or failure. */
const expectEnvelope = (body: ApiResponse, status: number): void => {
  expect(body.ok).toBe(status < 400);
  expect(body.status).toBe(status);
  expect(body.code).toMatch(/^[A-Z_]+$/);
  expect(body.message).toBe(messages[body.code]);
  expect(typeof body.meta.took).toBe("number");
  expect(body.meta.took).toBeGreaterThanOrEqual(0);
};

describe("GET /api/v1/health", () => {
  test("reports the service as healthy with its runtime information", async () => {
    const body = await get("/health", 200);

    expectEnvelope(body, 200);

    const data = body.data as {
      status: string;
      uptime: number;
      timestamp: string;
      runtime: { name: string; version: string };
      version: string;
    };

    expect(data.status).toBe("healthy");
    expect(data.version).toBe(config.version);
    expect(["bun", "node"]).toContain(data.runtime.name);
    expect(data.runtime.version).not.toBe("");

    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThan(0);

    // ISO-8601, and the time of the request rather than a fixed one.
    const timestamp = Date.parse(data.timestamp);
    expect(new Date(timestamp).toISOString()).toBe(data.timestamp);
    expect(Date.now() - timestamp).toBeLessThan(5_000);
  });

  test("the unversioned path is not routed", async () => {
    const body = await get("../health", 404);

    expect(body).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
  });
});

describe("POST /api/v1/website/search", () => {
  test("returns the results with the pagination metadata in the envelope", async () => {
    const results = [
      { title: "Bun", url: "https://bun.sh/", description: "A runtime.", source: ["google", "bing"], position: 1 },
    ];
    const restore = stub(searchService, "search", async () => ({
      results,
      meta: { page: 1, limit: 5, total: 1, last: 1 },
    }));

    try {
      const body = await post("/website/search", { q: "bun", limit: 5 }, 200);

      expectEnvelope(body, 200);
      expect(body.meta).toEqual({ page: 1, limit: 5, total: 1, last: 1, took: expect.any(Number) });
      expect(body.data).toEqual(results);
    } finally {
      restore();
    }
  });
});

describe("POST /api/v1/website/search validation", () => {
  /** Stubs the service so a test can tell whether the request ever reached the controller. */
  const stubbedService = () => {
    const calls: Array<{ query: string; options?: SearchOptions }> = [];
    const restore = stub(searchService, "search", async (query, options) => {
      calls.push({ query, options });
      return { results: [], meta: { page: 1, limit: 10, total: 0, last: 0 } };
    });

    return { calls, restore };
  };

  test("a valid body reaches the controller, sanitized and defaulted", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "  bun  " }, 200);

      expectEnvelope(body, 200);
      // `q` arrives trimmed, and `page`/`limit` already carry the schema's defaults.
      expect(service.calls).toEqual([
        {
          query: "bun",
          options: { page: 1, limit: 10, sources: undefined, language: undefined },
        },
      ]);
    } finally {
      service.restore();
    }
  });

  test("the engines and the language reach the controller normalized", async () => {
    const service = stubbedService();

    try {
      const body = await post(
        "/website/search",
        { q: "OpenAI", sources: ["  GOOGLE  ", "Bing"], language: "  en  " },
        200,
      );

      expectEnvelope(body, 200);
      expect(service.calls).toEqual([
        {
          query: "OpenAI",
          options: { page: 1, limit: 10, sources: ["google", "bing"], language: "en" },
        },
      ]);
    } finally {
      service.restore();
    }
  });

  test("omitting the sources leaves the choice to the search backend", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun" }, 200);

      expectEnvelope(body, 200);
      expect(service.calls[0]?.options?.sources).toBeUndefined();
      expect(service.calls[0]?.options?.language).toBeUndefined();
    } finally {
      service.restore();
    }
  });

  test("an empty engine list is accepted and passed on as it is", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", sources: [] }, 200);

      expectEnvelope(body, 200);
      // The service, not the schema, reads an empty list as "no restriction".
      expect(service.calls[0]?.options?.sources).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("a null engines or language field means nothing was chosen", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", sources: null, language: null }, 200);

      expectEnvelope(body, 200);
      expect(service.calls[0]?.options?.sources).toBeUndefined();
      expect(service.calls[0]?.options?.language).toBeUndefined();
    } finally {
      service.restore();
    }
  });

  test("a missing required field is rejected before the controller", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", {}, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.message).toBe("Request validation failed.");
      expect(body.data).toEqual([{ type: "required", message: "The 'q' field is required.", field: "q" }]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("an invalid type is rejected before the controller", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: 42 }, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        { type: "string", message: "The 'q' field must be a string.", field: "q", actual: 42 },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("an invalid value is rejected before the controller", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", page: 99 }, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        {
          type: "numberMax",
          message: "The 'page' field must be less than or equal to 20.",
          field: "page",
          expected: 20,
          actual: 99,
        },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("Fastest Validator's errors are the data, unmodified", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "", page: 1.5 }, 400);

      expect(body.data).toEqual([
        {
          type: "stringMin",
          message: "The 'q' field length must be greater than or equal to 1 characters long.",
          field: "q",
          expected: 1,
          actual: 0,
        },
        { type: "numberInteger", message: "The 'page' field must be an integer.", field: "page", actual: 1.5 },
      ]);
    } finally {
      service.restore();
    }
  });

  test("an engines value that is not an array is rejected", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", sources: "google" }, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        { type: "array", message: "The 'sources' field must be an array.", field: "sources", actual: "google" },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("an engine name that is not a string is rejected, with the item's own field", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", sources: [42] }, 400);

      expectEnvelope(body, 400);
      expect(body.data).toEqual([
        { type: "string", message: "The 'sources[0]' field must be a string.", field: "sources[0]", actual: 42 },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("a name that could not name a search source is rejected before the backend is called", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", sources: ["google", "not a name"] }, 400);

      expectEnvelope(body, 400);
      expect(body.data).toEqual([
        {
          type: "stringPattern",
          message: "The 'sources[1]' field fails to match the required pattern.",
          field: "sources[1]",
          expected: "/^[a-z0-9_.-]{1,50}$/",
          actual: "not a name",
        },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });

  test("a language that is not a string is rejected", async () => {
    const service = stubbedService();

    try {
      const body = await post("/website/search", { q: "bun", language: 42 }, 400);

      expectEnvelope(body, 400);
      expect(body.data).toEqual([
        { type: "string", message: "The 'language' field must be a string.", field: "language", actual: 42 },
      ]);
      expect(service.calls).toEqual([]);
    } finally {
      service.restore();
    }
  });
});

describe("GET /api/v1/website/search/sources", () => {
  /** Stubs the service so a test can tell whether the request ever reached the backend. */
  const stubbedSources = (sources: SearchSource[]) => {
    let calls = 0;
    const restore = stub(searchService, "sources", async () => {
      calls += 1;
      return sources;
    });

    return { calls: () => calls, restore };
  };

  test("returns the sources the search backend offers", async () => {
    const sources: SearchSource[] = [
      { name: "bing", enabled: true, categories: ["general", "web"] },
      { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
    ];
    const service = stubbedSources(sources);

    try {
      const body = await get("/website/search/sources", 200);

      expectEnvelope(body, 200);
      expect(service.calls()).toBe(1);
      // Whatever the service read from the backend is what leaves; nothing is listed here.
      expect(body.data).toEqual(sources);
    } finally {
      service.restore();
    }
  });

  test("is a route of its own, not a search carrying `sources` in the path", async () => {
    const sources: SearchSource[] = [{ name: "bing", enabled: true, categories: ["web"] }];
    // A search would 500 here: the sources route has to answer without ever searching.
    const search = stub(searchService, "search", async () => {
      throw new Error("the sources route must not search");
    });
    const stubbedSources = stub(searchService, "sources", async () => sources);

    try {
      const body = await get("/website/search/sources", 200);

      expectEnvelope(body, 200);
      expect(body).toMatchObject({ code: "OK", data: sources });
    } finally {
      stubbedSources();
      search();
    }
  });

  test("a backend failure reaches the error handler unchanged", async () => {
    const restore = stub(searchService, "sources", async () => {
      throw new AppError(503, codes.SEARCH_UNAVAILABLE);
    });

    try {
      const body = await get("/website/search/sources", 503);

      expectEnvelope(body, 503);
      expect(body).toMatchObject({ ok: false, status: 503, code: "SEARCH_UNAVAILABLE", data: null });
    } finally {
      restore();
    }
  });
});

describe("POST /api/v1/website/fetch", () => {
  test("returns the extracted page in the envelope", async () => {
    const restore = stub(page, "extract", async (url) => ({
      url: url.toString(),
      status: 200,
      title: "Example",
      metadata: { language: "en", jsonld: [] },
      links: [],
      images: [],
      videos: [],
      audios: [],
      content: "# Example",
    }));

    try {
      const body = await post("/website/fetch", { url: "https://93.184.216.34/article" }, 200);

      expectEnvelope(body, 200);
      expect(body.data).toMatchObject({ title: "Example", content: "# Example", status: 200 });
    } finally {
      restore();
    }
  });
});

describe("POST /api/v1/website/fetch driver", () => {
  /** Stubs the extractor so the driver the route chose is observable. */
  const stubbedExtractor = () => {
    const calls: Array<{ url: string; options?: ExtractOptions }> = [];
    const restore = stub(page, "extract", async (url, options) => {
      calls.push({ url: url.toString(), options });
      return {
        url: url.toString(),
        status: 200,
        metadata: { jsonld: [] },
        links: [],
        images: [],
        videos: [],
        audios: [],
        content: "",
      };
    });

    return { calls, restore };
  };

  test("omitting the driver asks the service for fetch", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "https://93.184.216.34/article" }, 200);

      expectEnvelope(body, 200);
      expect(extractor.calls).toEqual([
        { url: "https://93.184.216.34/article", options: { autoRedirect: true, driver: "fetch" } },
      ]);
    } finally {
      extractor.restore();
    }
  });

  test("driver: fetch asks the service for fetch", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "https://93.184.216.34/article", driver: "fetch" }, 200);

      expectEnvelope(body, 200);
      expect(extractor.calls[0]?.options?.driver).toBe("fetch");
    } finally {
      extractor.restore();
    }
  });

  test("driver: browser asks the service for browser", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "https://93.184.216.34/article", driver: "browser" }, 200);

      expectEnvelope(body, 200);
      expect(extractor.calls[0]?.options?.driver).toBe("browser");
    } finally {
      extractor.restore();
    }
  });

  test("an invalid driver is a validation failure and never reaches the service", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "https://93.184.216.34/article", driver: "puppeteer" }, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        {
          type: "enumValue",
          message: "The 'driver' field value 'fetch, browser' does not match any of the allowed values.",
          field: "driver",
          expected: "fetch, browser",
          actual: "puppeteer",
        },
      ]);
      expect(extractor.calls).toEqual([]);
    } finally {
      extractor.restore();
    }
  });

  test("trims the url before the domain rules run, so whitespace is not what a request fails on", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "  https://93.184.216.34/article  " }, 200);

      expectEnvelope(body, 200);
      expect(extractor.calls[0]?.url).toBe("https://93.184.216.34/article");
    } finally {
      extractor.restore();
    }
  });

  test("a url that is only whitespace is a validation failure", async () => {
    const extractor = stubbedExtractor();

    try {
      const body = await post("/website/fetch", { url: "   " }, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        {
          type: "stringMin",
          message: "The 'url' field length must be greater than or equal to 1 characters long.",
          field: "url",
          expected: 1,
          actual: 0,
        },
      ]);
      expect(extractor.calls).toEqual([]);
    } finally {
      extractor.restore();
    }
  });
});

describe("response cache on the routes", () => {
  test("a successful search is stored with the route's TTL", async () => {
    const writes: Array<{ key: string; value: string; ttl: number }> = [];
    const restoreGet = stub(cache, "get", async () => null);
    const restoreSet = stub(cache, "set", async (key, value, ttl) => {
      writes.push({ key, value, ttl });
    });
    const restoreSearch = stub(searchService, "search", async () => ({
      results: [],
      meta: { page: 1, limit: 10, total: 0, last: 0 },
    }));

    try {
      const body = await post("/website/search", { q: "bun" }, 200);

      expectEnvelope(body, 200);
      expect(writes).toHaveLength(1);
      // The key comes from the validated request: method, full path and the body, which
      // validate has already trimmed and filled in with `page`/`limit` defaults.
      expect(writes[0]!.key).toBe(
        `cache:POST:/api/v1/website/search:{"limit":${config.search.maxResults},"page":1,"q":"bun"}`,
      );
      expect(writes[0]!.ttl).toBe(120);
      expect(JSON.parse(writes[0]!.value)).toMatchObject({ ok: true, status: 200, code: "OK" });
    } finally {
      restoreSearch();
      restoreSet();
      restoreGet();
    }
  });

  test("requests that differ only in engines or language are cached apart", async () => {
    const written: string[] = [];
    const restoreGet = stub(cache, "get", async () => null);
    const restoreSet = stub(cache, "set", async (key) => {
      written.push(key);
    });
    const restoreSearch = stub(searchService, "search", async () => ({
      results: [],
      meta: { page: 1, limit: 10, total: 0, last: 0 },
    }));

    try {
      await post("/website/search", { q: "OpenAI", sources: ["google"] }, 200);
      await post("/website/search", { q: "OpenAI", sources: ["bing"] }, 200);
      await post("/website/search", { q: "OpenAI", sources: ["google"], language: "en" }, 200);
      await post("/website/search", { q: "OpenAI", sources: ["google"], language: "fa" }, 200);
      // The same request again: this is the only pair that must share an entry.
      await post("/website/search", { q: "OpenAI", sources: ["google"], language: "en" }, 200);

      expect(written).toHaveLength(5);
      expect(new Set(written).size).toBe(4);
      expect(written[0]).toBe(
        `cache:POST:/api/v1/website/search:{"limit":${config.search.maxResults},"page":1,"q":"OpenAI","sources":["google"]}`,
      );
      expect(written[2]).toBe(
        `cache:POST:/api/v1/website/search:{"language":"en","limit":${config.search.maxResults},"page":1,"q":"OpenAI","sources":["google"]}`,
      );
    } finally {
      restoreSearch();
      restoreSet();
      restoreGet();
    }
  });

  test("a cached response is replayed without reaching the search service", async () => {
    const stored = JSON.stringify({
      ok: true,
      status: 200,
      code: "OK",
      message: "Request completed successfully.",
      meta: { took: 1, page: 1, limit: 10, total: 0, last: 0 },
      data: [],
    });
    const restoreGet = stub(cache, "get", async () => stored);
    let called = 0;
    const restoreSearch = stub(searchService, "search", async () => {
      called += 1;
      return { results: [], meta: { page: 1, limit: 10, total: 0, last: 0 } };
    });

    try {
      const body = await post("/website/search", { q: "bun" }, 200);

      expect(called).toBe(0);
      expect(body).toEqual(JSON.parse(stored));
    } finally {
      restoreSearch();
      restoreGet();
    }
  });

  test("an unreachable Redis does not fail the request", async () => {
    const configuredDriver = config.cache.driver;
    const configuredUrl = config.redis.url;
    config.cache.driver = "redis";
    // Nothing listens here, so both the lookup and the write have to fail on their own.
    config.redis.url = "redis://127.0.0.1:6398";

    const restoreSearch = stub(searchService, "search", async () => ({
      results: [],
      meta: { page: 1, limit: 10, total: 0, last: 0 },
    }));
    const logged = console.error;
    console.error = () => undefined;

    try {
      const body = await post("/website/search", { q: "bun" }, 200);

      expectEnvelope(body, 200);
      // The cache write is fire-and-forget and fails here too: let it settle while the log
      // is still silenced, so the expected failure is not printed after the test.
      await Bun.sleep(150);
    } finally {
      console.error = logged;
      restoreSearch();
      config.cache.driver = configuredDriver;
      config.redis.url = configuredUrl;
      cache.close();
    }
  });

  test("CACHE_DRIVER=redis without a REDIS_URL still answers the request", async () => {
    const configuredDriver = config.cache.driver;
    const configuredUrl = config.redis.url;
    config.cache.driver = "redis";
    config.redis.url = "";

    const restoreSearch = stub(searchService, "search", async () => ({
      results: [],
      meta: { page: 1, limit: 10, total: 0, last: 0 },
    }));
    const logged = console.error;
    console.error = () => undefined;

    try {
      const body = await post("/website/search", { q: "bun" }, 200);

      expectEnvelope(body, 200);
    } finally {
      console.error = logged;
      restoreSearch();
      config.cache.driver = configuredDriver;
      config.redis.url = configuredUrl;
    }
  });

  test("CACHE_DRIVER=memory serves the second identical search from the process cache", async () => {
    const configuredDriver = config.cache.driver;
    config.cache.driver = "memory";

    let calls = 0;
    const restoreSearch = stub(searchService, "search", async () => {
      calls += 1;
      return { results: [], meta: { page: 1, limit: 10, total: 0, last: 0 } };
    });

    try {
      const first = await post("/website/search", { q: "route-memory" }, 200);
      const second = await post("/website/search", { q: "route-memory" }, 200);

      expect(calls).toBe(1);
      // The stored envelope is replayed byte for byte, meta.took included.
      expect(second).toEqual(first);
    } finally {
      restoreSearch();
      config.cache.driver = configuredDriver;
    }
  });
});

describe("failures", () => {
  test("invalid requests answer with a 400 and the standard failure envelope", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["/website/search", { q: "   " }, "VALIDATION_ERROR"],
      ["/website/search", {}, "VALIDATION_ERROR"],
      ["/website/search", { q: "bun", limit: 99 }, "VALIDATION_ERROR"],
      ["/website/fetch", {}, "VALIDATION_ERROR"],
      ["/website/fetch", { url: "file:///etc/passwd" }, "UNSUPPORTED_PROTOCOL"],
      ["/website/fetch", { url: "http://127.0.0.1:8080/admin" }, "BLOCKED_URL"],
    ];

    for (const [path, payload, code] of cases) {
      const body = await post(path, payload, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code });
      // Only a validation failure has something to hand back; the rest answer with null.
      if (code === "VALIDATION_ERROR") expect(Array.isArray(body.data)).toBe(true);
      else expect(body.data).toBeNull();
    }
  });

  test("a JSON value that is not an object is a validation failure", async () => {
    // The parser accepts arrays, so it is the schema that refuses them.
    for (const payload of [["bun"], []]) {
      const body = await post("/website/search", payload, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
      expect(body.data).toEqual([
        { type: "object", message: "The '' must be an Object.", actual: payload },
      ]);
    }
  });

  test("a body the JSON parser cannot accept answers with INVALID_BODY", async () => {
    // Scalars and null never reach the router: body-parser only accepts arrays and objects.
    for (const payload of ["bun", 42, null, true]) {
      const body = await post("/website/search", payload, 400);

      expectEnvelope(body, 400);
      expect(body).toMatchObject({ ok: false, status: 400, code: "INVALID_BODY", data: null });
    }
  });

  test("a body that is not JSON at all answers with INVALID_BODY", async () => {
    const response = await fetch(`${baseUrl}/website/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ApiResponse;
    expectEnvelope(body, 400);
    expect(body).toMatchObject({ ok: false, status: 400, code: "INVALID_BODY", data: null });
  });

  test("unknown routes answer with a 404", async () => {
    const body = await get("/nope", 404);

    expectEnvelope(body, 404);
    expect(body).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
  });

  test("the endpoints are not reachable over GET anymore", async () => {
    for (const path of ["/website/search?q=bun", "/website/fetch?url=https%3A%2F%2Fexample.com"]) {
      const body = await get(path, 404);

      expectEnvelope(body, 404);
      expect(body).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
    }
  });

  test("the old ungrouped paths are no longer routed", async () => {
    // Both endpoints moved under /website; the paths they used to live at answer with the
    // standard 404 envelope instead.
    const moved: Array<[string, Record<string, unknown>]> = [
      ["/search", { q: "bun" }],
      ["/get", { url: "https://example.com" }],
    ];

    for (const [path, payload] of moved) {
      const body = await post(path, payload, 404);

      expectEnvelope(body, 404);
      expect(body).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
    }
  });

  test("an AppError keeps its status and code", () => {
    const { res, status, body } = createFakeResponse();
    responseMiddleware(createFakeRequest({}), res, (() => undefined) as NextFunction);

    errorHandler(
      new AppError(502, codes.SEARCH_FAILED),
      createFakeRequest({}),
      res,
      (() => undefined) as NextFunction,
    );

    expect(status()).toBe(502);
    expect(body() as ApiResponse).toEqual({
      ok: false,
      status: 502,
      code: "SEARCH_FAILED",
      message: "The search request failed.",
      meta: { took: expect.any(Number) },
      data: null,
    });
  });

  test("an unexpected error becomes a generic 500 without internals", () => {
    const { res, status, body } = createFakeResponse();
    responseMiddleware(createFakeRequest({}), res, (() => undefined) as NextFunction);

    const logged = console.error;
    console.error = () => undefined;

    try {
      errorHandler(
        new Error("connection string user:password@database"),
        createFakeRequest({}),
        res,
        (() => undefined) as NextFunction,
      );
    } finally {
      console.error = logged;
    }

    expect(status()).toBe(500);
    expect(body() as ApiResponse).toMatchObject({
      ok: false,
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An internal server error occurred.",
      data: null,
    });

    const serialized = JSON.stringify(body());
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("stack");
  });
});

describe("debug logging", () => {
  let directory: string;
  let file: string;
  let enabled: boolean;
  let configuredFile: string | undefined;

  // The write is fire-and-forget, so give it a moment to reach the disk.
  const readLog = async (): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const log = await readFile(file, "utf8").catch(() => "");
      if (log !== "") return log;
      await Bun.sleep(10);
    }

    return "";
  };

  const failingSearch = (context: FailureContext) =>
    stub(searchService, "search", async () => {
      throw new AppError(503, codes.SEARCH_UNAVAILABLE, context);
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "web-io-routes-"));
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

  test("a failed request reaches debug.txt while the response stays sanitized", async () => {
    config.debug = true;

    const body = await post("/website/fetch", { url: "http://127.0.0.1:8080/admin" }, 400);

    expect(body).toMatchObject({ ok: false, code: "BLOCKED_URL", data: null });
    expect(JSON.stringify(body)).not.toContain("stack");

    const log = await readLog();
    expect(log).toContain("POST /api/v1/website/fetch");
    expect(log).toContain("BODY: url=http://127.0.0.1:8080/admin");
    expect(log).toContain("CODE: BLOCKED_URL");
    expect(log).toContain("STATUS: 400");
    expect(log).toContain("Error: BLOCKED_URL");
  });

  test("debug.txt is not created while debug mode is off", async () => {
    config.debug = false;

    await post("/website/fetch", { url: "http://127.0.0.1:8080/admin" }, 400);

    expect(await readFile(file, "utf8").catch(() => "")).toBe("");
  });

  test("a failing search reaches debug.txt with the backend context", async () => {
    config.debug = true;
    const context: FailureContext = {
      kind: "context",
      fields: {
        SEARCH_SERVICE: "searxng",
        SEARCH_URL: "http://searxng:8080/search?q=google&format=json&pageno=1",
        HTTP_STATUS: "503",
        DETAIL: "searxng is having a bad day",
      },
    };
    const restore = failingSearch(context);

    try {
      const body = await post("/website/search", { q: "google" }, 503);

      // The response stays sanitized: the backend detail only ever reaches the log.
      expect(body).toMatchObject({ ok: false, status: 503, code: "SEARCH_UNAVAILABLE", data: null });
      expect(JSON.stringify(body)).not.toContain("searxng is having a bad day");

      const log = await readLog();
      expect(log).toContain("CODE: SEARCH_UNAVAILABLE");
      expect(log).toContain("SEARCH_SERVICE:\nsearxng");
      expect(log).toContain("SEARCH_URL:\nhttp://searxng:8080/search?q=google&format=json&pageno=1");
      expect(log).toContain("HTTP_STATUS:\n503");
      expect(log).toContain("DETAIL:\nsearxng is having a bad day");
    } finally {
      restore();
    }
  })
});