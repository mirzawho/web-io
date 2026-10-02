import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { config } from "../../src/helpers/config";
import { AppError } from "../../src/helpers/error";
import type { FailureContext } from "../../src/helpers/debug";
import { Search } from "../../src/services/search";

const testConfig = { ...config, search: { ...config.search, timeout: 50, maxResults: 10 } };
const service = new Search(testConfig);

const realFetch = globalThis.fetch;
let requests: URL[] = [];

/** Replaces the global fetch for one test: no search backend, no network. */
const respondWith = (answer: (url: URL, init?: RequestInit) => Response | Promise<Response>) => {
  globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return answer(url, init);
  }) as typeof fetch;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const contextOf = (error: unknown): FailureContext => {
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).cause as FailureContext;
};

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Search", () => {
  test("asks the search backend for JSON and normalizes the results", async () => {
    respondWith(() =>
      json({
        number_of_results: 42,
        results: [
          { title: "Bun", url: "https://bun.sh/", content: "Bun is a fast JavaScript runtime.", engine: "Bing" },
          { title: "  Bun docs  ", url: "https://bun.sh/docs", content: "Installation and API.", engines: ["bing"] },
          { title: "Duplicate", url: "https://bun.sh/", content: "Same URL as the first result.", engine: "bing" },
          { title: "", url: "https://ignored.example/", content: "No title.", engine: "bing" },
        ],
      }),
    );

    const { results, meta } = await service.search("bun", { page: 2, limit: 5 });

    expect(requests).toHaveLength(1);
    const requested = requests[0] as URL;
    expect(requested.origin + requested.pathname).toBe(`${testConfig.search.url}/search`);
    expect(requested.searchParams.get("q")).toBe("bun");
    expect(requested.searchParams.get("format")).toBe("json");
    expect(requested.searchParams.get("pageno")).toBe("2");

    expect(results).toEqual([
      {
        title: "Bun",
        url: "https://bun.sh/",
        description: "Bun is a fast JavaScript runtime.",
        source: "bing",
        position: 1,
      },
      { title: "Bun docs", url: "https://bun.sh/docs", description: "Installation and API.", source: "bing", position: 2 },
    ]);
    expect(meta).toEqual({ page: 2, limit: 5, total: 42, last: 9 });
  });

  test("caps the result list at the configured limit", async () => {
    respondWith(() =>
      json({
        results: Array.from({ length: 30 }, (_value, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.com/${index + 1}`,
          content: "Body",
          engine: "duckduckgo",
        })),
      }),
    );

    const { results, meta } = await service.search("bun", { limit: 100 });

    expect(results).toHaveLength(testConfig.search.maxResults);
    expect(meta.limit).toBe(testConfig.search.maxResults);
  });

  test("omits the total when the search backend does not report one", async () => {
    respondWith(() => json({ results: [{ title: "Bun", url: "https://bun.sh/", content: "A runtime." }] }));

    const first = await service.search("bun");

    expect(first.meta).toEqual({ page: 1, limit: 10 });

    respondWith(() => json({ number_of_results: 0, results: [] }));
    expect((await service.search("bun")).meta).toEqual({ page: 1, limit: 10 });
  });

  test("returns an empty result set successfully when nothing matches", async () => {
    respondWith(() => json({ results: [] }));

    expect(await service.search("nothing matches this")).toEqual({
      results: [],
      meta: { page: 1, limit: 10 },
    });
  });

  test("reports a failing backend as unavailable", async () => {
    respondWith(() => new Response("searxng is having a bad day", { status: 503 }));

    const error = await service.search("bun").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "SEARCH_UNAVAILABLE" });
    expect(contextOf(error).fields).toMatchObject({
      SEARCH_SERVICE: "searxng",
      HTTP_STATUS: "503",
      DETAIL: "searxng is having a bad day",
    });
  });

  test("reports a backend it cannot reach as unavailable", async () => {
    respondWith(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });

    const error = await service.search("bun").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "SEARCH_UNAVAILABLE" });
    expect(contextOf(error).fields.DETAIL).toContain("Unable to connect");
    expect(contextOf(error).fields.SEARCH_URL).toContain("format=json");
  });

  test("reports a slow backend as a timeout", async () => {
    respondWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // A real fetch rejects when the request's signal fires, and this one never answers.
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out.", "TimeoutError")),
          );
        }),
    );

    const error = await service.search("bun").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 504, code: "TIMEOUT" });
    expect(contextOf(error).fields.DETAIL).toBe("The request timed out.");
  });

  test("reports a malformed answer as a search failure", async () => {
    respondWith(() => new Response("<html>not json</html>", { status: 200 }));

    const error = await service.search("bun").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "SEARCH_FAILED" });
    expect(contextOf(error).fields.DETAIL).toContain("not json");
  });

  test("reports a rejected request as a search failure", async () => {
    respondWith(() => new Response("bad request", { status: 400 }));

    const error = await service.search("bun").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "SEARCH_FAILED" });
    expect(contextOf(error).fields.HTTP_STATUS).toBe("400");
  });
});

describe("Search sources and language", () => {
  const AGGREGATED = {
    results: [
      { title: "Bun", url: "https://bun.sh/", content: "A runtime.", engine: "bing" },
      { title: "Bun docs", url: "https://bun.com/docs", content: "Docs.", engine: "duckduckgo" },
    ],
  };

  /** A backend answer whose results come from exactly these engines. */
  const answering = (engines: string[]) =>
    json({
      results: engines.map((engine, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example.com/${engine}`,
        content: "Body",
        engine,
      })),
    });

  const requested = (): URL => requests[0] as URL;

  test("asks the backend for the chosen source and reports it back in the meta", async () => {
    respondWith(() => answering(["bing"]));

    const { results, meta } = await service.search("bun", { sources: ["bing"] });

    expect(requested().searchParams.get("engines")).toBe("bing");
    expect(meta.sources).toEqual(["bing"]);
    expect(results[0]?.source).toBe("bing");
  });

  test("asks for several engines as one comma-separated list", async () => {
    respondWith(() => answering(["google", "bing"]));

    const { results, meta } = await service.search("bun", { sources: ["google", "bing"] });

    expect(requested().searchParams.get("engines")).toBe("google,bing");
    expect(meta.sources).toEqual(["google", "bing"]);
    expect(results.map((result) => result.source)).toEqual(["google", "bing"]);
  });

  test("passes any well-formed engine name straight through", async () => {
    respondWith(() => answering(["google_cse"]));

    await service.search("bun", { sources: ["google_cse"] });

    expect(requested().searchParams.get("engines")).toBe("google_cse");
  });

  test("asks for each engine once, however often it was listed", async () => {
    respondWith(() => answering(["bing"]));

    const { meta } = await service.search("bun", { sources: ["bing", "bing"] });

    expect(requested().searchParams.get("engines")).toBe("bing");
    expect(meta.sources).toEqual(["bing"]);
  });

  test("does not force an engine when none was asked for", async () => {
    respondWith(() => json(AGGREGATED));

    const { results, meta } = await service.search("bun");

    expect(requested().searchParams.has("engines")).toBe(false);
    expect(requested().searchParams.get("format")).toBe("json");
    expect(meta.sources).toBeUndefined();
    expect(results.map((result) => result.source)).toEqual(["bing", "duckduckgo"]);
  });

  test("reads an empty list as no engine restriction", async () => {
    respondWith(() => json(AGGREGATED));

    const { meta } = await service.search("bun", { sources: [] });

    expect(requested().searchParams.has("engines")).toBe(false);
    expect(meta.sources).toBeUndefined();
  });

  test("sends the language as the backend's own language parameter", async () => {
    respondWith(() => answering(["bing"]));

    const { meta } = await service.search("bun", { language: "fa" });

    expect(requested().searchParams.get("language")).toBe("fa");
    expect(meta.language).toBe("fa");
  });

  test("leaves the language out when none was chosen", async () => {
    respondWith(() => answering(["bing"]));

    const { meta } = await service.search("bun");

    expect(requested().searchParams.has("language")).toBe(false);
    expect(meta.language).toBeUndefined();
  });

  test("reads a blank language as no language at all", async () => {
    // The route's schema accepts an empty string and the MCP tool does too, so both
    // interfaces have to treat it as "nothing was chosen" rather than an empty parameter.
    respondWith(() => answering(["bing"]));

    for (const language of ["", "   "]) {
      const { meta } = await service.search("bun", { language });

      expect(requested().searchParams.has("language")).toBe(false);
      expect(meta.language).toBeUndefined();
    }
  });

  test("sends engines, page and language in one request", async () => {
    respondWith(() => answering(["google", "bing"]));

    const { meta } = await service.search("OpenAI", { sources: ["google", "bing"], language: "en", page: 2 });

    expect(requested().searchParams.get("q")).toBe("OpenAI");
    expect(requested().searchParams.get("pageno")).toBe("2");
    expect(requested().searchParams.get("engines")).toBe("google,bing");
    expect(requested().searchParams.get("language")).toBe("en");
    expect(meta).toMatchObject({ sources: ["google", "bing"], language: "en" });
  });

  test("keeps every engine that found a merged result", async () => {
    respondWith(() =>
      json({
        results: [
          {
            title: "Bun",
            url: "https://bun.sh/",
            content: "A runtime.",
            engine: "google",
            engines: ["google", "Bing"],
          },
        ],
      }),
    );

    const { results } = await service.search("bun");

    expect(results[0]?.source).toEqual(["google", "bing"]);
  });

  test("names engines the way the backend does, so the value can be sent back", async () => {
    respondWith(() => json({ results: [{ title: "Bun", url: "https://bun.sh/", content: "A runtime.", engine: "google cse" }] }));

    const { results } = await service.search("bun");

    expect(results[0]?.source).toBe("google_cse");
  });

  test("leaves out the source when the backend reports none", async () => {
    respondWith(() => json({ results: [{ title: "Bun", url: "https://bun.sh/", content: "A runtime." }] }));

    const { results } = await service.search("bun");

    expect(results[0]).not.toHaveProperty("source");
  });

  test("reports an engine that failed instead of returning an empty result set", async () => {
    respondWith(() => json({ results: [], unresponsive_engines: [["google", "CAPTCHA"]] }));

    const error = await service.search("bun", { sources: ["google"] }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "SEARCH_UNAVAILABLE" });
    expect(contextOf(error).fields.DETAIL).toBe('The "google" engine did not answer: CAPTCHA');
  });

  test("reports an engine this instance does not serve instead of falling back", async () => {
    // The backend ignores unknown engine names and answers with its default set: that answer
    // must not be passed off as the caller's engines.
    respondWith(() => json(AGGREGATED));

    const error = await service.search("bun", { sources: ["not-real"] }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 400, code: "INVALID_PARAMETER" });
    expect(contextOf(error).fields.DETAIL).toBe('No engine named "not-real" answered this instance.');
  });

  test("accounts for every engine that was asked for, not only the ones that answered", async () => {
    // One engine answered and another did not exist: the answer must not pass as the pair.
    respondWith(() => answering(["google"]));

    const error = await service
      .search("bun", { sources: ["google", "not-real"] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 400, code: "INVALID_PARAMETER" });
    expect(contextOf(error).fields.DETAIL).toBe('No engine named "not-real" answered this instance.');
  });
});

describe("Search.sources", () => {
  const configOf = (engines: unknown) => json({ engines });
  const names = async (): Promise<string[]> => (await service.sources()).map((source) => source.name);

  test("reads the sources from the search backend's own config endpoint", async () => {
    respondWith(() =>
      configOf([
        { name: "bing", enabled: true, categories: ["general", "web"] },
        { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
      ]),
    );

    const sources = await service.sources();

    const only = requests[0] as URL;
    expect(only.origin + only.pathname).toBe(`${testConfig.search.url}/config`);
    expect(sources).toEqual([
      { name: "bing", enabled: true, categories: ["general", "web"] },
      { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
    ]);
  });

  test("returns only the pure general website search sources", async () => {
    // The filtering rule itself, over metadata that mixes every category in the task: only
    // enabled engines categorised as general website search and nothing else get through.
    respondWith(() =>
      configOf([
        { name: "google", enabled: true, categories: ["general", "web"] },
        { name: "bing", enabled: true, categories: ["general", "web"] },
        { name: "general_only", enabled: true, categories: ["general"] },
        { name: "web_only", enabled: true, categories: ["web"] },
        { name: "google_cse_images", enabled: true, categories: ["images", "web"] },
        { name: "news_engine", enabled: true, categories: ["news", "web"] },
        { name: "video_engine", enabled: true, categories: ["videos"] },
        { name: "map_engine", enabled: true, categories: ["map", "web"] },
        { name: "academic_engine", enabled: true, categories: ["science", "scientific publications"] },
        { name: "file_engine", enabled: true, categories: ["files"] },
        { name: "translate_engine", enabled: true, categories: ["general", "translate"] },
        { name: "disabled_web_engine", enabled: false, categories: ["web"] },
        { name: "disabled_general_engine", enabled: false, categories: ["general", "web"] },
        { name: "uncategorised", enabled: true },
        { name: "categoryless", enabled: true, categories: [] },
      ]),
    );

    expect(await names()).toEqual(["bing", "general_only", "google", "web_only"]);
  });

  test("excludes a specialized source even when it also declares a web category", async () => {
    // The backend registers an image engine as `["images","web"]`: it contains `web`, and it is
    // still not a website search source.
    respondWith(() =>
      configOf([
        { name: "google cse images", enabled: true, categories: ["images", "web"] },
        { name: "bing videos", enabled: true, categories: ["videos", "web"] },
        { name: "bing news", enabled: true, categories: ["news"] },
      ]),
    );

    expect(await names()).toEqual([]);
  });

  test("lists every source as enabled, because a disabled one is never offered", async () => {
    respondWith(() =>
      configOf([
        { name: "alpha", enabled: true, categories: ["web"] },
        { name: "beta", enabled: false, categories: ["web"] },
        { name: "gamma", enabled: true, categories: ["general"] },
      ]),
    );

    expect(await service.sources()).toEqual([
      { name: "alpha", enabled: true, categories: ["web"] },
      { name: "gamma", enabled: true, categories: ["general"] },
    ]);
  });

  test("leaves out an engine the backend does not mark enabled", async () => {
    // No `enabled` field at all is how the backend reports an engine it has switched off.
    respondWith(() => configOf([{ name: "alpha", categories: ["web"] }, { name: "beta", enabled: true, categories: ["web"] }]));

    expect(await names()).toEqual(["beta"]);
  });

  test("reads the categories the backend reports, normalized", async () => {
    respondWith(() => configOf([{ name: "bing", enabled: true, categories: ["General", " WEB "] }]));

    expect(await service.sources()).toEqual([{ name: "bing", enabled: true, categories: ["general", "web"] }]);
  });

  test("decides from the categories alone, never from the source name", async () => {
    // A name that reads like a news engine is not disqualifying, and a name that reads like a
    // general web engine is not qualifying: `news` is a category, `google_news` is a name.
    respondWith(() =>
      configOf([
        { name: "google news", enabled: true, categories: ["web"] },
        { name: "news google", enabled: true, categories: ["news"] },
      ]),
    );

    expect(await names()).toEqual(["google_news"]);
  });

  test("names sources the way a search accepts them", async () => {
    respondWith(() => configOf([{ name: "google cse", enabled: true, categories: ["general", "web"] }]));

    expect(await service.sources()).toEqual([{ name: "google_cse", enabled: true, categories: ["general", "web"] }]);
  });

  test("returns them sorted by name, so the order does not depend on the config file", async () => {
    respondWith(() =>
      configOf([
        { name: "zebra", enabled: true, categories: ["web"] },
        { name: "alpha", enabled: true, categories: ["web"] },
        { name: "middle", enabled: true, categories: ["web"] },
      ]),
    );

    expect(await names()).toEqual(["alpha", "middle", "zebra"]);
  });

  test("skips an entry that carries no usable name", async () => {
    respondWith(() =>
      configOf([
        { enabled: true, categories: ["web"] },
        { name: "  ", enabled: true, categories: ["web"] },
        { name: "bing", enabled: true, categories: ["web"] },
      ]),
    );

    expect(await names()).toEqual(["bing"]);
  });

  test("is an empty list when the instance serves no website search source", async () => {
    respondWith(() => configOf([]));

    expect(await service.sources()).toEqual([]);
  });

  test("tolerates a config without an engine list", async () => {
    respondWith(() => json({ version: "2026.10.2" }));

    expect(await service.sources()).toEqual([]);
  });

  test("reports a failing backend as unavailable", async () => {
    respondWith(() => new Response("searxng is having a bad day", { status: 503 }));

    const error = await service.sources().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "SEARCH_UNAVAILABLE" });
    expect(contextOf(error).fields.SEARCH_URL).toContain("/config");
  });

  test("reports a malformed answer as a search failure", async () => {
    respondWith(() => new Response("<html>not json</html>", { status: 200 }));

    const error = await service.sources().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "SEARCH_FAILED" });
  });
});
