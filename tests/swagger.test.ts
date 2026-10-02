import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { config } from "../src/helpers/config";
import { messages } from "../src/helpers/response";
import { MAX_PAGE, SOURCE_PATTERN } from "../src/routes.api";
import { openApiDocument } from "../src/routes.swagger";
import { createApp } from "../src/server";

/**
 * Boots an app built with the given Swagger setting on an ephemeral port. The setting is read
 * when the app is built, so changing it and calling createApp() is what "enabled" means here.
 */
async function withSwaggerApp<T>(enabled: boolean, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const configured = config.swagger.enabled;
  config.swagger.enabled = enabled;

  const server: Server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.swagger.enabled = configured;
  }
}

describe("Swagger disabled", () => {
  test("the default is off", () => {
    expect(config.swagger.enabled).toBe(false);
  });

  test("no docs path is exposed, and every one answers with the API's 404 envelope", async () => {
    await withSwaggerApp(false, async (baseUrl) => {
      for (const path of ["/docs", "/docs/", "/docs/openapi.json", "/docs/swagger-ui.css"]) {
        const response = await fetch(`${baseUrl}${path}`);

        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND", data: null });
      }
    });
  });
});

describe("Swagger enabled", () => {
  test("GET /docs serves the Swagger UI", async () => {
    await withSwaggerApp(true, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/docs`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("swagger-ui");
      // The mount path is redirected to its trailing-slash form, so the UI's relative asset
      // URLs resolve against /docs/ instead of one level up.
      expect(response.url).toBe(`${baseUrl}/docs/`);
    });
  });

  test("the UI's assets are served, and its init script is valid JavaScript pointing at the document", async () => {
    await withSwaggerApp(true, async (baseUrl) => {
      const stylesheet = await fetch(`${baseUrl}/docs/swagger-ui.css`);
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get("content-type")).toContain("text/css");

      const init = await fetch(`${baseUrl}/docs/swagger-ui-init.js`);
      expect(init.status).toBe(200);
      expect(init.headers.get("content-type")).toContain("javascript");

      // The init script has to be valid JavaScript and has to point the UI at the JSON
      // document. swagger-ui-express embeds an inline document through String.replace, where a
      // `$` in the document is read as a replacement pattern and corrupts the script, so the
      // document must stay out of it.
      const script = await init.text();
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain('"swaggerUrl": "/docs/openapi.json"');
      expect(script).not.toContain("swaggerDoc\": {");
    });
  });

  test("the OpenAPI document is available as JSON", async () => {
    await withSwaggerApp(true, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/docs/openapi.json`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const document = (await response.json()) as typeof openApiDocument;
      expect(Object.keys(document.paths).sort()).toEqual([
        "/health",
        "/website/fetch",
        "/website/search",
        "/website/search/sources",
      ]);
    });
  });

  test("an unknown path under the docs mount is still a 404, not the UI", async () => {
    await withSwaggerApp(true, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/docs/not-a-real-asset`);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });
});

describe("the OpenAPI document", () => {
  test("documents every endpoint the API serves, and only those", () => {
    expect(Object.keys(openApiDocument.paths).sort()).toEqual([
      "/health",
      "/website/fetch",
      "/website/search",
      "/website/search/sources",
    ]);
    // The methods the routes actually declare.
    expect(openApiDocument.paths["/health"].get).toBeDefined();
    expect(openApiDocument.paths["/website/search"].post).toBeDefined();
    expect(openApiDocument.paths["/website/search/sources"].get).toBeDefined();
    expect(openApiDocument.paths["/website/fetch"].post).toBeDefined();
  });

  test("carries API metadata a developer can start from", () => {
    expect(openApiDocument.openapi).toMatch(/^3\.0\./);
    expect(openApiDocument.info.title).toBe("web-io API");
    expect(openApiDocument.info.version).toBe(config.version);
    // The description has to say what this API does, not restate the title or document the
    // backend it happens to use. The backend stays a named implementation detail.
    expect(openApiDocument.info.description).toContain("website search");
    expect(openApiDocument.info.description).toContain("ApiResponse");
    expect(openApiDocument.info.description).toContain("search backend");
    expect(openApiDocument.info.description.length).toBeGreaterThan(300);
  });

  test("groups the operations under described tags, and every operation carries one", () => {
    expect(openApiDocument.tags.map((tag) => tag.name)).toEqual(["Health", "Website Search", "Website Fetch"]);

    for (const tag of openApiDocument.tags) {
      expect(tag.description).toBeString();
      expect(tag.description.length).toBeGreaterThan(40);
    }

    const operations = [
      openApiDocument.paths["/health"].get,
      openApiDocument.paths["/website/search"].post,
      openApiDocument.paths["/website/search/sources"].get,
      openApiDocument.paths["/website/fetch"].post,
    ];
    const tagNames = openApiDocument.tags.map((tag) => tag.name);

    for (const operation of operations) {
      expect(operation.summary).toBeString();
      // A real description of the behaviour, not "Search API" or "Get data".
      expect(operation.description.length).toBeGreaterThan(200);
      // Exactly one of the tags declared above, so every operation is grouped and named.
      expect(operation.tags).toHaveLength(1);
      const [tag = ""] = operation.tags;
      expect(tagNames.includes(tag)).toBe(true);
    }
  });

  test("documents the /website/fetch body the route accepts", () => {
    const schema = openApiDocument.components.schemas.WebsiteFetchRequest;

    expect(schema.required).toEqual(["url"]);
    expect(Object.keys(schema.properties)).toEqual(["url", "driver", "autoRedirect"]);
    expect(schema.properties.driver.enum).toEqual(["fetch", "browser"]);
    expect(schema.properties.driver.default).toBe("fetch");
    expect(schema.properties.autoRedirect.default).toBe(true);
  });

  test("documents the /website/search body from the rules the route enforces", () => {
    const schema = openApiDocument.components.schemas.SearchRequest;

    expect(schema.required).toEqual(["q"]);
    expect(schema.properties.q.minLength).toBe(1);
    // These come from the same constants the fastest-validator schema is built from, so the
    // document cannot state a bound the route does not enforce.
    expect(schema.properties.page.maximum).toBe(MAX_PAGE);
    expect(schema.properties.page.default).toBe(1);
    expect(schema.properties.limit.maximum).toBe(config.search.maxResults);
    expect(schema.properties.limit.default).toBe(config.search.maxResults);
    expect(schema.properties.sources.items.pattern).toBe(SOURCE_PATTERN.source);
    expect(schema.properties.language.type).toBe("string");
    // Neither is required: omitting them is what leaves the choice to the backend.
    expect(schema.required).not.toContain("sources");
    expect(schema.required).not.toContain("language");
  });

  test("documents the website search sources the sources endpoint returns", () => {
    const schema = openApiDocument.components.schemas.SearchSource;
    const operation = openApiDocument.paths["/website/search/sources"].get;

    expect(schema.required).toEqual(["name", "enabled", "categories"]);
    expect(operation.summary).toBe("List available website search sources");
    // The eligibility rule has to be stated where a client reads it, so a client knows why a
    // specialized engine never appears here.
    expect(operation.description).toContain("Only general web search engines are returned");
    expect(operation.description).toContain("excluded");
    // `enabled` is still part of the contract, and the document says what it can be.
    expect(schema.properties.enabled.enum).toEqual([true]);
    expect(openApiDocument.paths["/website/search/sources"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/SearchSourcesResponse",
    });
    expect(openApiDocument.components.schemas.SearchSourcesResponse.allOf[1]?.properties?.data?.items).toEqual({
      $ref: "#/components/schemas/SearchSource",
    });
  });

  test("documents the standard envelope and the validation error format", () => {
    const envelope = openApiDocument.components.schemas.ApiResponse;
    expect(envelope.required).toEqual(["ok", "status", "code", "message", "meta", "data"]);
    expect(envelope.properties.code.enum).toContain("OK");
    expect(envelope.properties.code.enum).toContain("VALIDATION_ERROR");

    // Failures use the same envelope, with the validator's errors inside `data`.
    const validation = openApiDocument.components.schemas.ValidationErrorResponse;
    expect(validation.allOf[0]).toEqual({ $ref: "#/components/schemas/ApiResponse" });
    expect(validation.allOf[1]?.properties?.data?.items).toEqual({
      $ref: "#/components/schemas/ValidationError",
    });

    const timeout = openApiDocument.components.responses.GatewayTimeout;
    expect(timeout.content["application/json"].example).toEqual({
      ok: false,
      status: 504,
      code: "TIMEOUT",
      message: messages.TIMEOUT,
      meta: { took: expect.any(Number) },
      data: null,
    });
  });

  test("documents the pagination, engines and language the search meta carries", () => {
    const meta = openApiDocument.components.schemas.Meta;

    expect(meta.required).toEqual(["took"]);
    expect(Object.keys(meta.properties)).toEqual(["took", "page", "limit", "total", "last", "sources", "language"]);
    expect(meta.properties.sources.items.type).toBe("string");
    expect(meta.properties.total.description).toContain("Absent");
  });

  test("describes the failure that carries nothing, separately from the success shape", () => {
    const error = openApiDocument.components.schemas.ApiError;

    expect(error.allOf[0]).toEqual({ $ref: "#/components/schemas/ApiResponse" });
    expect(error.allOf[1]?.properties?.ok?.enum).toEqual([false]);
  });

  test("every example is a valid instance of the schema it illustrates", () => {
    const search = openApiDocument.paths["/website/search"].post.responses["200"].content["application/json"].example;
    const fetch = openApiDocument.paths["/website/fetch"].post.responses["200"].content["application/json"].examples;
    const sources = openApiDocument.paths["/website/search/sources"].get.responses["200"].content["application/json"].example;

    // The search example shows both the single-engine and the merged-engine form of `source`.
    expect(search.data[0]?.source).toEqual(["google", "bing"]);
    expect(search.data[1]?.source).toBe("bing");
    expect(search.meta).toMatchObject({ page: 1, limit: 5, sources: ["google", "bing"], language: "en" });

    // The fetch examples cover both shapes the endpoint can answer with.
    expect(Object.keys(fetch)).toEqual(["page", "reportedRedirect"]);
    expect(fetch.page.value.data.content).toContain("```bash");
    expect(fetch.reportedRedirect.value.data).toEqual({
      url: "http://github.com/",
      status: 301,
      location: "https://github.com/",
    });

    expect(sources.data).toEqual([
      { name: "bing", enabled: true, categories: ["general", "web"] },
      { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
      { name: "google", enabled: true, categories: ["general", "web"] },
    ]);
    // The example cannot show a disabled source: the endpoint never returns one.
    expect(sources.data.every((source: { enabled: boolean }) => source.enabled)).toBe(true);
  });

  test("points at a relative server, so no host name is baked in", () => {
    expect(openApiDocument.servers.map((server) => server.url)).toEqual(["/api/v1"]);
  });
});

describe("the docs do not affect the API", () => {
  const expectHealth = async (baseUrl: string): Promise<void> => {
    const response = await fetch(`${baseUrl}/api/v1/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: 200,
      code: "OK",
      message: messages.OK,
      meta: { took: expect.any(Number) },
      data: {
        status: "healthy",
        uptime: expect.any(Number),
        timestamp: expect.any(String),
        runtime: config.runtime,
        version: config.version,
      },
    });
  };

  const expectValidationError = async (baseUrl: string): Promise<void> => {
    const response = await fetch(`${baseUrl}/api/v1/website/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  };

  test("with the docs on, the API routes answer exactly as before", async () => {
    await withSwaggerApp(true, async (baseUrl) => {
      await expectHealth(baseUrl);
      await expectValidationError(baseUrl);
    });
  });

  test("with the docs off, the API routes answer exactly as before", async () => {
    await withSwaggerApp(false, async (baseUrl) => {
      await expectHealth(baseUrl);
      await expectValidationError(baseUrl);
    });
  });
});
