import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { config } from "./helpers/config";
import { codes, messages } from "./helpers/response";
import type { Code } from "./helpers/response";
import { MAX_PAGE, SOURCE_PATTERN } from "./routes.api";

const API_RESPONSE = "#/components/schemas/ApiResponse";
const VALIDATION_ERROR_RESPONSE = "#/components/schemas/ValidationErrorResponse";

/** The failure envelope the response middleware builds: `ok` is false and `data` stays null. */
const failureExample = (code: Code, status: number) => ({
  ok: false,
  status,
  code,
  message: messages[code],
  meta: { took: 3 },
  data: null,
});

/**
 * The OpenAPI 3 description of the API that routes.api.ts serves. It is hand-written rather
 * than generated, but it mirrors the routes: the request rules are read from the same
 * constants (MAX_PAGE, SOURCE_PATTERN, config.search.maxResults) and the same `codes` map
 * that the validator schemas and the response middleware use, so the document cannot
 * describe something the API does not do.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "web-io API",
    version: config.version,
    description: `A website search and web content API: **website search** across the search
sources this deployment serves, and **webpage extraction** that turns a page into AI-readable
Markdown.

Every answer — success, validation failure, upstream failure — is the same JSON envelope, described
by [ApiResponse](#/components/schemas/ApiResponse): \`ok\`, \`status\`, a stable uppercase \`code\`, a
\`message\` derived from that code, a \`meta\` object carrying the elapsed time, and \`data\`.

Three things worth knowing before reading the operations:

- **Search and extraction never touch each other.** Search is one HTTP request to the search
  backend and one JSON mapper; extraction fetches or renders one page and reads it with Cheerio.
  Neither needs the other, and only extraction can start Chromium.
- **Everything under \`/website\` is grouped by domain.** A later domain (\`/news\`, \`/images\`) is
  added beside it, so paths are stable.
- **Successful responses may be cached** for 120 seconds when the deployment sets \`CACHE_DRIVER\`,
  so an identical repeat request can be answered without reaching the search backend or the page at
  all. The cache never changes the response shape, and errors are never cached.

The current implementation uses [SearXNG](https://docs.searxng.org) as its search backend, so the
sources [GET /website/search/sources](#/Website%20Search/getWebsiteSearchSources) reports are the
general web search engines that instance serves. Nothing in the API surface above depends on that
choice.

The same two capabilities are also exposed as MCP tools at \`/mcp\` when \`MCP_ENABLED=true\`. MCP
speaks JSON-RPC rather than this envelope, so it is deliberately not described here; see the
project README for its tool schemas.`,
  },
  servers: [
    {
      url: "/api/v1",
      description:
        "The API is mounted here, relative to the origin that serves this page — the same " +
        "document is correct for a local run (http://localhost:3000) and for a container " +
        "behind a mapped port, with no host name baked in.",
    },
  ],
  tags: [
    {
      name: "Health",
      description:
        "Liveness and runtime identity. Uses no dependency, so it stays a 200 while the search " +
        "backend or the browser is unavailable — which is what makes it usable as a probe.",
    },
    {
      name: "Website Search",
      description:
        "Search the web through the website search sources this deployment serves, and discover " +
        "which sources are currently available.",
    },
    {
      name: "Website Fetch",
      description:
        "Fetch one page by URL and return it as title, metadata, asset URLs and the main " +
        "article as Markdown, with a choice of two drivers.",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Report service status, uptime and runtime information",
        description:
          "Answers as soon as the process is up, and reports what it is running on. It touches " +
          "no dependency, so it stays a 200 while the search backend or the browser is down — " +
          "the endpoint to use as a liveness or readiness probe.\n\n" +
          "The payload is per-process state (uptime, the current server time, the runtime and " +
          "the application version), so it is never cached.",
        responses: {
          "200": {
            description: "The service is up.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
                example: {
                  ok: true,
                  status: 200,
                  code: "OK",
                  message: messages.OK,
                  meta: { took: 1 },
                  data: {
                    status: "healthy",
                    uptime: 12.34,
                    timestamp: "2026-10-02T12:00:00.000Z",
                    runtime: { name: "bun", version: "1.4.2" },
                    version: config.version,
                  },
                },
              },
            },
          },
        },
      },
    },
    "/website/search": {
      post: {
        tags: ["Website Search"],
        summary: "Search the web using one or more website search sources",
        description: `Searches websites and web pages for a query and returns one page of results. It
is one HTTP request to the configured search backend and one JSON answer back: no browser, no HTML
parsing, and no knowledge of which source answered. This is the cheap path.

- \`q\` is the query.
- \`sources\` restricts the search to named website search sources, named exactly as
  [GET /website/search/sources](#/Website%20Search/getWebsiteSearchSources) reports them
  (\`google\`, \`bing\`, \`google_cse\`). **Omitted or empty means the backend's own source
  selection**. Each name is trimmed and lower-cased first; a value that could not name a source
  (anything outside \`${SOURCE_PATTERN.source}\`) is refused with \`400 VALIDATION_ERROR\` before the
  backend is called. A source that exists but did not answer is never passed off as an empty result
  set: a name this instance does not serve answers \`400 INVALID_PARAMETER\`, and one that reported a
  failure (CAPTCHA, timeout) answers \`503 SEARCH_UNAVAILABLE\`. An empty \`data\` array therefore
  always means "no matches".
- \`language\` is the language to search in, e.g. \`en\` or \`fa\`. Omitted or blank means the
  backend's default.
- \`page\` is the page of results to ask for (1–${MAX_PAGE}); \`limit\` caps the list that comes back
  (1–${config.search.maxResults}) — the backend may answer with more, the surplus is dropped.

Each result carries the page \`title\`, its \`url\`, the \`description\` snippet the source returned
(an empty string when it sent none), the \`source\` that found it, and its 1-based \`position\` on that
page. Duplicate URLs, backend internals and tracking fields are dropped.

\`meta\` always echoes \`page\` and \`limit\`, echoes \`sources\` and \`language\` only when they were
chosen, and adds \`total\` and \`last\` only when the search backend reports a non-zero result count —
engines provide one often enough to be worth passing on, and never reliably enough to be invented.

The body is validated before the controller and before the cache, so a request the schema refuses
never reaches the search backend and never costs a cache round-trip. A successful answer is cached
for 120 seconds.`,
        requestBody: {
          required: true,
          description: "The query and, optionally, which sources to use, in which language, and which page to read.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SearchRequest" },
              examples: {
                minimal: {
                  summary: "Just a query",
                  value: { q: "bun javascript runtime" },
                },
                enginesAndLanguage: {
                  summary: "Restricted to two search sources, in one language",
                  value: { q: "OpenAI", sources: ["google", "bing"], language: "en" },
                },
                paged: {
                  summary: "A deeper page with a smaller page size",
                  value: { q: "bun javascript runtime", page: 2, limit: 5 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "The page of results. An empty `data` array is a search that genuinely had no " +
              "matches, not a search source that failed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchResponse" },
                example: {
                  ok: true,
                  status: 200,
                  code: "OK",
                  message: messages.OK,
                  meta: { took: 842, page: 1, limit: 5, sources: ["google", "bing"], language: "en", total: 2, last: 1 },
                  data: [
                    {
                      title: "Bun — A fast JavaScript runtime",
                      url: "https://bun.sh/",
                      description: "Bun is a fast all-in-one JavaScript toolkit.",
                      source: ["google", "bing"],
                      position: 1,
                    },
                    {
                      title: "Bun documentation",
                      url: "https://bun.sh/docs",
                      description: "Installation, runtime and API reference.",
                      source: "bing",
                      position: 2,
                    },
                  ],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "502": { $ref: "#/components/responses/BadGateway" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
          "504": { $ref: "#/components/responses/GatewayTimeout" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/website/search/sources": {
      get: {
        tags: ["Website Search"],
        summary: "List available website search sources",
        description:
          "Returns the enabled search engines that are currently available for website/web " +
          "searches, i.e. the values the `sources` parameter of " +
          "[POST /website/search](#/Website%20Search/postWebsiteSearch) accepts.\n\n" +
          "Only general web search engines are returned. Specialized engines — image, news, " +
          "video, map, academic, file and other non-website search engines — are excluded, " +
          "including engines that list a web category alongside a specialized one. The list is " +
          "derived from the search backend's own configuration, so this API keeps no list of " +
          "its own and a deployment that changes the backend's engines is reflected here " +
          "without a code change.\n\n" +
          "Each entry carries `name` and the backend `categories` that make it eligible. The " +
          "list is sorted by name, and it is empty when the deployment serves no website search " +
          "source at all.\n\n" +
          "Takes no parameters — it is a literal path, so it can never be read as a search " +
          "whose `sources` came from the URL. A successful answer is cached for 120 seconds.",
        responses: {
          "200": {
            description: "Every available website search source, sorted by name.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchSourcesResponse" },
                example: {
                  ok: true,
                  status: 200,
                  code: "OK",
                  message: messages.OK,
                  meta: { took: 12 },
                  data: [
                    { name: "bing", enabled: true, categories: ["general", "web"] },
                    { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
                    { name: "google", enabled: true, categories: ["general", "web"] },
                  ],
                },
              },
            },
          },
          "502": { $ref: "#/components/responses/BadGateway" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
          "504": { $ref: "#/components/responses/GatewayTimeout" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/website/fetch": {
      post: {
        tags: ["Website Fetch"],
        summary: "Fetch one page as title, metadata, links and Markdown",
        description: `Fetches one page's HTML and reads it once. \`driver\` decides **only** how the HTML is
obtained; both drivers run the same extraction, so the response shape never changes with the
driver.

- \`fetch\` (**the default**) makes one HTTP request for the document, with the configured
  timeout. Chromium is never started and no asset is downloaded, because only the page itself is
  requested. Use it when the page renders on the server.
- \`browser\` renders the page with Puppeteer/Chromium — JavaScript included — before the HTML is
  read. Use it when the content only exists after client-side rendering.

**Redirects** are followed by default, so \`url\` is the address that finally answered and
\`status\` is the status the site answered with for it — a 404 page is still a successful
extraction. With \`autoRedirect: false\` a redirect is the answer instead of a detour: one cheap
probe decides that before either driver runs, and the result carries **only** \`url\`, \`status\` and
\`location\`, because there is no page to describe.

**What comes back** for a page:

- \`title\` — from \`og:title\`, \`twitter:title\`, \`<title>\` or the first \`<h1>\`, in that order.
- \`metadata\` — description, keywords, author, canonical URL, language and robots, the Open Graph
  and Twitter fields the page declares, and every parsed \`application/ld+json\` block in document
  order (a block that is an array stays an array; a malformed one is dropped).
- \`links\` — every \`a[href]\`, resolved against the final URL and typed \`internal\` or \`external\`
  by hostname. \`javascript:\`, \`mailto:\`, \`tel:\`, \`data:\` and in-page fragments are skipped.
- \`images\` — with their \`alt\` text (\`""\` when the tag has none) and \`data:\` placeholders dropped.
  \`data-src\`, \`data-lazy-src\` and \`data-original\` are used when \`src\` is missing or is a placeholder.
- \`videos\` / \`audios\` — read from the tag and from its \`<source>\` children, with \`type\` only
  when the markup declares one.
- \`content\` — the main article as Markdown-like text, **never HTML**: headings, lists, code
  fences, quotes and tables are preserved, while navigation, cookie banners, sidebars, footers,
  ads, comments and elements the page never painted are removed. Longer than
  \`MAX_CONTENT_LENGTH\` is truncated with a \`[content truncated]\` marker.

\`links\`, \`images\`, \`videos\` and \`audios\` sit next to \`metadata\`, not inside it, and are always
present on a page result — \`[]\` when the page references none. **Nothing is ever downloaded**:
only URLs already present in the markup are reported.

**Only public destinations are read.** The URL must be absolute and \`http\`/\`https\`;
loopback, private, link-local, CGNAT, multicast and cloud-metadata addresses are refused with
\`400 BLOCKED_URL\` — including when a redirect leads to one, for both drivers.

The body is validated before the controller, and a successful answer is cached for 120 seconds.`,
        requestBody: {
          required: true,
          description: "The URL to read and, optionally, how to retrieve it.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebsiteFetchRequest" },
              examples: {
                defaultFetch: {
                  summary: "One HTTP request, no browser",
                  value: { url: "https://example.com", driver: "fetch" },
                },
                browser: {
                  summary: "Render JavaScript with Chromium",
                  value: { url: "https://example.com", driver: "browser" },
                },
                redirectProbe: {
                  summary: "Report a redirect instead of following it",
                  value: { url: "http://github.com", autoRedirect: false },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The extracted page, or — with `autoRedirect: false` — the redirect that was reported.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebsiteFetchResponse" },
                examples: {
                  page: {
                    summary: "An extracted page",
                    value: {
                      ok: true,
                      status: 200,
                      code: "OK",
                      message: messages.OK,
                      meta: { took: 770 },
                      data: {
                        url: "https://example.com/article",
                        status: 200,
                        title: "Example Article",
                        metadata: {
                          description: "Article description",
                          keywords: ["example", "article"],
                          author: "John Doe",
                          canonical: "https://example.com/article",
                          language: "en",
                          robots: "index,follow",
                          og: {
                            title: "Example Article",
                            description: "Article description",
                            image: "https://example.com/image.jpg",
                            type: "article",
                            url: "https://example.com/article",
                            siteName: "Example",
                          },
                          twitter: {
                            card: "summary_large_image",
                            title: "Example Article",
                            image: "https://example.com/image.jpg",
                          },
                          jsonld: [
                            {
                              "@context": "https://schema.org",
                              "@type": "Article",
                              headline: "Example article",
                            },
                          ],
                        },
                        links: [
                          { url: "https://example.com/about", text: "About", type: "internal" },
                          { url: "https://github.com/example/project", text: "GitHub", type: "external" },
                        ],
                        images: [{ url: "https://example.com/image.jpg", alt: "Example image" }],
                        videos: [{ url: "https://example.com/video.mp4", type: "video/mp4" }],
                        audios: [{ url: "https://example.com/audio.mp3", type: "audio/mpeg" }],
                        content:
                          "# Example Article\n\nThis is the introduction.\n\n## Installation\n\nInstall Bun using:\n\n```bash\ncurl -fsSL https://bun.sh/install | bash\n```\n\n- Fast startup\n- Native TypeScript support",
                      },
                    },
                  },
                  reportedRedirect: {
                    summary: "A redirect reported instead of followed",
                    value: {
                      ok: true,
                      status: 200,
                      code: "OK",
                      message: messages.OK,
                      meta: { took: 121 },
                      data: { url: "http://github.com/", status: 301, location: "https://github.com/" },
                    },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "502": { $ref: "#/components/responses/BadGateway" },
          "504": { $ref: "#/components/responses/GatewayTimeout" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
  },
  components: {
    responses: {
      BadRequest: {
        description:
          "The request was refused before the work it asked for was done. Which code depends on " +
          "what was wrong:\n\n" +
          "- `VALIDATION_ERROR` — a route's fastest-validator schema refused the body. This is " +
          "the one failure with a payload: `data` holds the validator's own error objects.\n" +
          "- `INVALID_BODY` — the JSON parser could not read the body at all.\n" +
          "- `INVALID_URL` / `UNSUPPORTED_PROTOCOL` — `/website/fetch` was given something that is " +
          "not an absolute `http`/`https` URL.\n" +
          "- `BLOCKED_URL` — `/website/fetch` was pointed at a local, private or link-local " +
          "destination (directly or through a redirect).\n" +
          "- `INVALID_PARAMETER` — `/website/search` asked for a search source this instance does " +
          "not serve, so the answer would not have been the search that was asked for.\n\n" +
          "Every code but `VALIDATION_ERROR` answers with `data: null`.",
        content: {
          "application/json": {
            schema: {
              description: "Either a plain failure envelope or the validation-error envelope.",
              anyOf: [{ $ref: API_RESPONSE }, { $ref: VALIDATION_ERROR_RESPONSE }],
            },
            examples: {
              validationError: {
                summary: "A body a route's schema refused (`q` missing)",
                value: {
                  ok: false,
                  status: 400,
                  code: "VALIDATION_ERROR",
                  message: messages.VALIDATION_ERROR,
                  meta: { took: 2 },
                  data: [{ type: "required", message: "The 'q' field is required.", field: "q" }],
                },
              },
              blockedUrl: {
                summary: "A destination the SSRF guard refused",
                value: failureExample(codes.BLOCKED_URL, 400),
              },
              unknownEngine: {
                summary: "A search source this instance does not serve",
                value: failureExample(codes.INVALID_PARAMETER, 400),
              },
            },
          },
        },
      },
      InternalError: {
        description:
          "An unexpected failure. The response stays sanitized; the cause is written to the " +
          "server log, and to `debug.txt` when `DEBUG=true`.",
        content: {
          "application/json": {
            schema: { $ref: API_RESPONSE },
            example: failureExample(codes.INTERNAL_ERROR, 500),
          },
        },
      },
      BadGateway: {
        description:
          "The backend answered with something unusable: `SEARCH_FAILED` when the search " +
          "backend's answer could not be read, and `PAGE_FETCH_FAILED` or `BROWSER_FAILED` when " +
          "the page could not be fetched or Chromium could not be started.",
        content: {
          "application/json": {
            schema: { $ref: API_RESPONSE },
            example: failureExample(codes.PAGE_FETCH_FAILED, 502),
          },
        },
      },
      ServiceUnavailable: {
        description:
          "`SEARCH_UNAVAILABLE` — the search backend is not running or not reachable yet, or a " +
          "chosen search source reported a failure (a CAPTCHA, for instance) instead of answering.",
        content: {
          "application/json": {
            schema: { $ref: API_RESPONSE },
            example: failureExample(codes.SEARCH_UNAVAILABLE, 503),
          },
        },
      },
      GatewayTimeout: {
        description:
          "`TIMEOUT` — the search request or the page load exceeded its configured timeout " +
          "(`SEARCH_TIMEOUT`, `PAGE_LOAD_TIMEOUT`).",
        content: {
          "application/json": {
            schema: { $ref: API_RESPONSE },
            example: failureExample(codes.TIMEOUT, 504),
          },
        },
      },
    },
    schemas: {
      /** The one response contract: every answer, success or failure, uses it. */
      ApiResponse: {
        type: "object",
        required: ["ok", "status", "code", "message", "meta", "data"],
        properties: {
          ok: { type: "boolean", description: "`true` when `status` is below 400." },
          status: { type: "integer", description: "The HTTP status, repeated in the body." },
          code: {
            type: "string",
            enum: Object.values(codes),
            description: "Stable uppercase machine-readable code; `OK` on success.",
          },
          message: {
            type: "string",
            description: "Human-readable summary, derived from `code` in exactly one place.",
          },
          meta: { $ref: "#/components/schemas/Meta" },
          data: {
            nullable: true,
            description:
              "The endpoint payload — an array for the search endpoints, an object for " +
              "`/website/fetch`, the status object for `/health`. `null` on any failure that has " +
              "nothing to hand back; an array of validation errors on a `VALIDATION_ERROR`.",
          },
        },
      },
      /** The failure shape: the same envelope, with nothing in `data`. */
      ApiError: {
        description:
          "Any failure except a validation error: `ok` is `false`, `status` is the HTTP status " +
          "and `data` is `null`, so no internals ever travel in the body.",
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [false] },
              data: { nullable: true, description: "Always `null`." },
            },
          },
        ],
      },
      Meta: {
        type: "object",
        required: ["took"],
        properties: {
          took: { type: "integer", description: "Total request processing time in milliseconds." },
          page: { type: "integer", description: "`/website/search` only: the page that was requested." },
          limit: { type: "integer", description: "`/website/search` only: the page size that was requested." },
          total: {
            type: "integer",
            description:
              "`/website/search` only: the result count the search backend reported. Absent when " +
              "it reported none — engines frequently do not.",
          },
          last: {
            type: "integer",
            description: "`/website/search` only: the last page implied by `total` and `limit`.",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description:
              "`/website/search` only: the search sources the search was restricted to. Absent " +
              "when the backend chose its own sources.",
          },
          language: {
            type: "string",
            description:
              "`/website/search` only: the language the search was restricted to. Absent when " +
              "the backend's default was used.",
          },
        },
      },
      /** The one failure that carries a payload: the validator's own error objects. */
      ValidationErrorResponse: {
        description:
          "A body a route's schema refused. `data` holds fastest-validator's own error objects " +
          "unmodified — the API does not reword them or wrap them in a second vocabulary.",
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [false] },
              code: { type: "string", enum: [codes.VALIDATION_ERROR] },
              data: {
                type: "array",
                description: "One entry per rule that failed, in field order.",
                items: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
        ],
      },
      ValidationError: {
        type: "object",
        description: "One fastest-validator error. `type` and `message` are always present.",
        required: ["type", "message"],
        properties: {
          type: {
            type: "string",
            example: "numberMax",
            description:
              "The rule that failed. The rules these routes can produce are `required`, " +
              "`string`, `stringMin`, `stringPattern`, `number`, `numberMin`, `numberMax`, " +
              "`numberInteger`, `enumValue`, `array`, `boolean` and `object`.",
          },
          message: { type: "string", description: "The validator's wording for that rule." },
          field: {
            type: "string",
            description:
              "The offending field, with an index for an array item (`sources[0]`). Absent when " +
              "the error is about the body itself.",
          },
          expected: { description: "What the rule wanted; only some rules report it." },
          actual: { description: "What was received; only some rules report it." },
        },
        example: {
          type: "required",
          message: "The 'q' field is required.",
          field: "q",
        },
      },
      SearchRequest: {
        type: "object",
        required: ["q"],
        properties: {
          q: {
            type: "string",
            minLength: 1,
            description: "The search query. Trimmed before it is used; it cannot be blank.",
          },
          page: {
            type: "integer",
            minimum: 1,
            maximum: MAX_PAGE,
            default: 1,
            description: `Which page of results to ask the search backend for (1–${MAX_PAGE}); deeper pages rarely answer with anything new.`,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: config.search.maxResults,
            default: config.search.maxResults,
            description: `Maximum number of results to return (1–${config.search.maxResults}). Defaults to MAX_RESULTS.`,
          },
          sources: {
            type: "array",
            items: { type: "string", pattern: SOURCE_PATTERN.source, example: "bing" },
            description:
              "Restrict the search to these website search sources, named the way " +
              "[GET /website/search/sources](#/Website%20Search/getWebsiteSearchSources) reports " +
              "them. Each value is trimmed and lower-cased. Omitted or empty means the backend's " +
              "own source selection.",
          },
          language: {
            type: "string",
            example: "en",
            description:
              "The language to search in, e.g. `en` or `fa`. Trimmed; omitted or blank means the " +
              "backend's default.",
          },
        },
        example: { q: "bun javascript runtime", page: 1, limit: 5 },
      },
      SearchResult: {
        type: "object",
        required: ["title", "url", "description", "position"],
        description: "One result. Engine internals, templates and tracking fields are not forwarded.",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          description: {
            type: "string",
            description: "The snippet the search source returned; an empty string when it sent none.",
          },
          source: {
            description:
              "The search source(s) that found this result: one name is a string, several are " +
              "an array. Absent when the backend reported none. Names are normalized the way a " +
              "search accepts them, so a value can be sent straight back in `sources`.",
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          position: { type: "integer", description: "1-based position within this page of results." },
        },
      },
      SearchSource: {
        type: "object",
        required: ["name", "enabled", "categories"],
        description:
          "One available website search source: an enabled general web search engine this " +
          "deployment serves. Specialized engines are not listed at all.",
        properties: {
          name: {
            type: "string",
            description:
              "The name `sources` accepts, normalized the way the search backend names its engines " +
              "(`google cse` is reported as `google_cse`).",
          },
          enabled: {
            type: "boolean",
            enum: [true],
            description:
              "Always `true`: a disabled engine is not a source this API can offer, so it is " +
              "never returned.",
          },
          categories: {
            type: "array",
            items: { type: "string" },
            description:
              "The backend categories the engine is registered under, and the reason it is " +
              "listed: general website/web search and nothing besides (e.g. `[\"general\",\"web\"]`).",
          },
        },
      },
      SearchSourcesResponse: {
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: {
              data: {
                type: "array",
                description: "Every available website search source, sorted by `name`.",
                items: { $ref: "#/components/schemas/SearchSource" },
              },
            },
          },
        ],
      },
      SearchResponse: {
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: {
              data: {
                type: "array",
                description: "At most `limit` results, in the order the search backend ranked them.",
                items: { $ref: "#/components/schemas/SearchResult" },
              },
            },
          },
        ],
      },
      WebsiteFetchRequest: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description:
              "The absolute `http`/`https` URL to read. Trimmed before it is used. Local, " +
              "private, link-local and cloud-metadata destinations are refused with " +
              "`400 BLOCKED_URL`, including when a redirect points at them.",
          },
          driver: {
            type: "string",
            enum: ["fetch", "browser"],
            default: "fetch",
            description:
              "How the HTML is obtained. `fetch` makes one Axios request and never starts " +
              "Chromium; `browser` renders the page with Puppeteer. Omitted means `fetch`. Both " +
              "run the same extraction, so the response shape does not change.",
          },
          autoRedirect: {
            type: "boolean",
            default: true,
            description:
              "`true` (the default) follows redirects, so `url` and `status` describe the final " +
              "response. `false` reports the redirect instead: one probe decides that before " +
              "either driver runs, and the result carries only `url`, `status` and `location`.",
          },
        },
        example: { url: "https://example.com/article", driver: "fetch", autoRedirect: true },
      },
      ExtractionResult: {
        type: "object",
        description:
          "The answer for one URL. A page carries everything; a reported redirect carries only " +
          "`url`, `status` and `location`, because there is no page to describe.",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "The final URL when a redirect was followed, otherwise the requested URL.",
          },
          status: {
            type: "integer",
            description:
              "The status the *site* answered with — a 404 page is still a successful " +
              "extraction. Absent when the driver reported none.",
          },
          location: {
            type: "string",
            description:
              "Where the site points. Only set when a redirect is reported instead of followed " +
              "(`autoRedirect: false`).",
          },
          title: { type: "string" },
          metadata: { $ref: "#/components/schemas/PageMetadata" },
          links: {
            type: "array",
            description: "Every link the page references, resolved against `url`, typed by hostname. Nothing is downloaded.",
            items: { $ref: "#/components/schemas/PageLink" },
          },
          images: {
            type: "array",
            description: "Every image the page references, with its `alt` text. Nothing is downloaded.",
            items: { $ref: "#/components/schemas/PageImage" },
          },
          videos: { type: "array", items: { $ref: "#/components/schemas/PageMedia" } },
          audios: { type: "array", items: { $ref: "#/components/schemas/PageMedia" } },
          content: {
            type: "string",
            description:
              "The main article as Markdown-like text, never HTML. Truncated at " +
              "MAX_CONTENT_LENGTH with a `[content truncated]` marker.",
          },
        },
      },
      WebsiteFetchResponse: {
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: { data: { $ref: "#/components/schemas/ExtractionResult" } },
          },
        ],
      },
      PageMetadata: {
        type: "object",
        required: ["jsonld"],
        description:
          "Only the fields the page actually declares, plus `jsonld`, which is always present " +
          "and `[]` when the page has no JSON-LD block.",
        properties: {
          description: { type: "string" },
          keywords: { type: "array", items: { type: "string" }, description: "Split on commas, de-duplicated, at most 20." },
          author: { type: "string" },
          canonical: { type: "string" },
          language: { type: "string" },
          robots: { type: "string" },
          og: { $ref: "#/components/schemas/OpenGraphMetadata" },
          twitter: { $ref: "#/components/schemas/TwitterMetadata" },
          jsonld: {
            type: "array",
            description:
              "Parsed `application/ld+json` blocks in document order; a block that is an array " +
              "stays an array, and a malformed block is dropped.",
            items: {},
          },
        },
      },
      OpenGraphMetadata: {
        type: "object",
        description: "The Open Graph fields the page declares; absent entirely when it declares none.",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
          type: { type: "string" },
          url: { type: "string" },
          siteName: { type: "string" },
        },
      },
      TwitterMetadata: {
        type: "object",
        description: "The Twitter card fields the page declares; absent entirely when it declares none.",
        properties: {
          card: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
        },
      },
      PageLink: {
        type: "object",
        required: ["url", "text", "type"],
        properties: {
          url: { type: "string" },
          text: { type: "string", description: "The visible link text, whitespace collapsed." },
          type: {
            type: "string",
            enum: ["internal", "external"],
            description: "Internal when the link points at the page's own hostname.",
          },
        },
      },
      PageImage: {
        type: "object",
        required: ["url", "alt"],
        properties: {
          url: { type: "string" },
          alt: { type: "string", description: "Empty string when the tag carries no alt attribute." },
        },
      },
      PageMedia: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          type: { type: "string", description: "Only set when the tag declared one, e.g. `video/webm`." },
        },
      },
      HealthData: {
        type: "object",
        required: ["status", "uptime", "timestamp", "runtime", "version"],
        properties: {
          status: { type: "string", enum: ["healthy"], description: "`healthy` while the process is serving." },
          uptime: { type: "number", description: "Seconds since the process started, rounded to two decimals." },
          timestamp: {
            type: "string",
            format: "date-time",
            description: "The server's current time, ISO-8601 in UTC.",
          },
          runtime: {
            type: "object",
            required: ["name", "version"],
            properties: {
              name: { type: "string", enum: ["bun", "node"], description: "The runtime serving the request." },
              version: { type: "string", description: "That runtime's own version." },
            },
          },
          version: { type: "string", description: "The application version, from package.json." },
        },
      },
      HealthResponse: {
        allOf: [
          { $ref: API_RESPONSE },
          {
            type: "object",
            properties: { data: { $ref: "#/components/schemas/HealthData" } },
          },
        ],
      },
    },
  },
};

/**
 * The Swagger UI, mounted at /docs by server.ts, and only when config.swagger.enabled.
 * It is a route module of its own so the API routes and the API documentation stay in
 * separate files; nothing here is used by the API itself.
 */
export const swaggerRoutes = Router();

swaggerRoutes.get(
  "/",
  // Swagger UI loads its assets relative to the page, so the mount path needs its trailing
  // slash: served at `/docs`, the browser would look for them one level up.
  (req, res, next) => {
    const [pathname = "", query = ""] = req.originalUrl.split("?");
    if (pathname.endsWith("/")) return next();

    return res.redirect(`${pathname}/${query === "" ? "" : `?${query}`}`);
  },
  // The document is served as JSON (below) and fetched by the UI at runtime, rather than
  // embedded in the page. swagger-ui-express embeds an inline document through
  // String.replace, where a `$` in the document is read as a replacement pattern and
  // corrupts the generated script, so the document is kept out of that path entirely.
  swaggerUi.setup(undefined, {
    swaggerUrl: "/docs/openapi.json",
    customSiteTitle: "web-io API",
  }),
);

// The same document as plain JSON, for clients and tooling that want it directly.
swaggerRoutes.get("/openapi.json", (_req, res) => {
  res.json(openApiDocument);
});

// swagger-ui-init.js (with the document embedded) and the Swagger UI static assets.
swaggerRoutes.use(swaggerUi.serve);
