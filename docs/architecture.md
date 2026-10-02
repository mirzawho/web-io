# Architecture

`web-io` is a small Bun + Express service with two jobs: search the web through a selected search
backend, and turn a webpage into text an LLM can consume. This document describes the implementation
that exists in `src/`, the reasoning behind it, and the parts that were deliberately left out.

## Purpose

The project owns the API and the application behaviour behind it, and it is wired to a handful of
external tools that do the parts it should not implement itself:

| The project owns      | Implementation dependencies               |
| --------------------- | ----------------------------------------- |
| Website Search API    | SearXNG — the current search backend      |
| Website Fetch API     | Puppeteer/Chromium — renders JavaScript   |
| MCP interface         | Axios — one plain HTTP request            |
| Response cache facade | Redis — the optional shared cache         |
| Extraction pipeline   | Cheerio — parses already-obtained HTML    |

Search and extraction are deliberately different paths:

```
                        ┌── Search ──→ Search service ──→ search backend ──→ search engines
HTTP request → routes ─┤                                  (SearXNG)
                        └── Page ────→ driver ──→ HTML ──→ Cheerio ──→ Markdown
                                      ├─ fetch:   Axios (one HTTP request)
                                      └─ browser: Puppeteer renders JavaScript
```

`/website/search` has no business rendering anything: the search backend already aggregates the
engines and answers with JSON, so the service is one `fetch` and a mapper. `/website/search/sources`
reads the source list from the same backend, so no list of sources is kept in `src/`.
`/website/fetch` is the opposite - some pages only exist after a browser has run them and the DOM has
been rewritten - so Puppeteer stays available for extraction and is **never used for search**. The
default driver is `fetch` (Axios), because most pages do not need Chromium at all; the driver decides
only how the HTML arrives, not how it is read.

## Project layout

```
src/
├── controllers/        HTTP layer as plain functions: read input, call a service, answer
│   ├── health.ts         exports health() → handler for GET /api/v1/health
│   ├── search.ts         exports search() → handler for POST /api/v1/website/search
│   ├── search-sources.ts exports searchSources() → handler for GET /api/v1/website/search/sources
│   └── get.ts            exports get() → handler for POST /api/v1/website/fetch
├── services/           application logic, one class per responsibility
│   ├── search.ts                 class Search, query → search backend JSON → our result shape
│   ├── browser.ts                class Browser, owns the Chromium process
│   └── page.ts                   class Page, fetches/renders and extracts metadata/content
├── cache/              the response cache: one facade, one file per backend
│   ├── cache.ts                  the get/set the cache middleware uses, and the request key
│   ├── redis.ts                  the Redis backend
│   ├── memory.ts                 the in-process backend
│   └── index.ts                  the module's public exports
├── middlewares/        route-level middleware, one file per concern
│   ├── cache.ts                  cache({ ttl }) → replays and stores successful responses
│   └── validate.ts               validate(schema) → rejects a body the schema refuses
├── helpers/            small reusable pieces
│   ├── config.ts                 environment, loaded once
│   ├── response.ts               response envelope, response codes, request timer
│   ├── error.ts                  AppError carrying an HTTP status and a code
│   ├── debug.ts                  appends failures to debug.txt when DEBUG is on
│   ├── url.ts                    URL validation and SSRF checks
│   ├── content-cleaner.ts        noise removal and main content detection
│   └── markdown.ts               DOM → Markdown serialisation
├── instance.ts         the shared service instances, created once
├── routes.api.ts       exports `router`, mounted at /api/v1: /health and the /website domain
├── routes.swagger.ts   the OpenAPI document and the Swagger UI, mounted at /docs
├── routes.mcp.ts       the MCP server and its two tools, mounted at /mcp
├── server.ts           exports the configured Express `app` (never listens)
└── index.ts            entrypoint: starts the app, graceful shutdown
```

The dependency direction is one-way: `controllers → instance → services → helpers`, and
`middlewares → cache → helpers`. `routes.api.ts` is the only module that knows both a middleware and a
controller. Controllers never touch Puppeteer or Cheerio, services never touch
`Request`/`Response`. Controllers are plain functions that import the instance they need;
services are classes; middleware are functions that return a `RequestHandler`.

Services return plain domain data (`ExtractionResult`, `SearchPage`) and never a status or
an envelope: `Page.extract()` answers with the extracted page, `Search.search()` with
`{ results, meta }` and `Search.sources()` with the source list. Building the response object is
the controller's job, so the HTTP shape lives in exactly one layer.

## Request lifecycle

```
POST /api/v1/website/search  {"q":"bun"}
  │
  ├─ server.ts        app.use(responseMiddleware), express.json(), then app.use("/api/v1", router)
  ├─ routes.api.ts    router.post("/website/search", middlewares.validate(schema), middlewares.cache({ttl:120}), search)
  ├─ middlewares/validate.ts  rejects a body the schema refuses with 400 VALIDATION_ERROR
  ├─ middlewares/cache.ts     serves a stored 200, or stores the 200 that follows
  ├─ controllers/search.ts  reads q/page/limit/sources/language, already validated and defaulted
  ├─ instance.ts            the shared searchService instance
  ├─ services/search.ts     fetch(<search backend>/search?q=…&format=json&pageno=…&engines=…&language=…)
  ├─ controllers/search.ts  res.json({ status: 200, code: "OK", meta, data })
  └─ helpers/response.ts    the res.json wrapper adds ok, message, meta.took
```

Both JSON endpoints take a JSON object as their body, so `express.json()` runs before the router. A
body the parser itself cannot accept — a bare number, a string, `null` — is recognised in the
error middleware by body-parser's own `type`/`status` markers and answered with the
`INVALID_BODY` envelope instead of Express's HTML error page. The body is capped at 100 kb,
which is far above what either endpoint needs.

Everything else is **fastest-validator**, and only fastest-validator: each route declares the
shape it accepts with `middlewares.validate(schema)`. The schema is compiled once, when the
route is defined, and the resulting middleware rejects anything that does not match before the
handler is called, so the rule lives next to the route instead of being spelled out as `if`
statements inside the controller:

```ts
// routes.api.ts
router.post(
  "/website/search",
  middlewares.validate({
    q: { type: "string", min: 1, trim: true },
    page: { type: "number", integer: true, min: 1, max: MAX_PAGE, optional: true, default: 1 },
    // … limit, sources and language
  }),
  middlewares.cache({ ttl: 120 }),
  search,
);
```

That yields two properties worth stating outright:

- **A refused body is an `AppError(400, VALIDATION_ERROR)` whose `data` is the validator's own
  error array** — not reworded, not wrapped, and not turned into a second error vocabulary.
  The standard envelope and the single error middleware therefore handle it unchanged, and
  every other failure answers with `data: null`.
- **Sanitizers and defaults write back into `req.body`.** `trim`, `lowercase` and `default`
  are applied before the controller runs, so `q` arrives trimmed, the `sources` names
  lower-cased, a `url` trimmed and `page`/`limit` already filled in. The controllers contain no
  request checks at all: `controllers/search.ts` reads the five fields and calls the service, and
  `controllers/get.ts` reads `url`, `driver` and `autoRedirect` and calls the service.

What a schema cannot express stays with the code that owns it: `/website/fetch` still runs
`parseHttpUrl` (absolute `http`/`https` only) and the service still applies the SSRF rules,
because a scheme restriction and a private-address range are domain rules, not request shape.

Any thrown `AppError` travels back through `next(error)` and is serialised by the single
error middleware in `server.ts`. Everything else becomes a generic `500 INTERNAL_ERROR`
and is logged, never returned.

## Response contract

Every response - success, validation failure, 404, upstream failure - is the same object:

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 842, "page": 1, "limit": 10, "total": 10, "last": 1 },
  "data": []
}
```

Handlers do not build this object. They hand over the internal result only:

```ts
res.json({ status: 200, code: codes.OK, meta: { page, limit, total, last }, data: results });
```

`helpers/response.ts` wraps `res.json` once, in middleware, and completes the envelope:

- `res.startedAt = performance.now()` when the request arrives;
- `res.status(body.status)` so the HTTP status and the `status` field cannot drift apart;
- `ok` from `body.status < 400`;
- `message` from the central `messages` map, so a code has exactly one public wording;
- `meta.took` from `performance.now() - res.startedAt`;
- `data`, or `null` when a handler returns nothing meaningful.

Because everything happens in the wrapper, the error middleware gets the same treatment for
free: it just calls `res.json({ status: 404, code: codes.NOT_FOUND, data: null })`.
`codes` is the single source of truth for the uppercase vocabulary (typed as `Code`, so a
typo is a compile error) and `messages` is a `Record<Code, string>`, so a new code without
a message does not compile.

Pagination fields exist only on `/website/search`: `page` and `limit` are echoed from the request,
`total` and `last` are added only when the search backend reports a non-zero result count (they are
never invented), and `sources`/`language` are echoed only when they were chosen. Endpoints that do
not paginate return `{ "took": … }` alone instead of meaningless values.

## MCP interface

`/mcp` is a second presentation edge over the same application, so an MCP client can search
and read pages without speaking the REST API. It is opt-in (`MCP_ENABLED=true`) and it is a
route module, not an application:

```
                 ┌── REST  ── /api/v1/website/search ─┐
HTTP ── Express ─┤                                    ├──→ instance.ts ──→ services
                 ├── MCP   ── /mcp ── website_search ─┤
                 │                    website_fetch ──┘
                 └── ...
```

- **One listener, one port.** `server.ts` mounts `mcpRoutes` at `/mcp` on the app it has
  already built, after `express.json()` — the transport takes the already-parsed JSON-RPC body
  — and before the 404 handler, so an enabled `/mcp` is routed instead of falling through.
  Nothing calls `listen()` a second time, and no second Express instance is created.
- **Same services.** The tools import the shared `searchService` and `page` from `instance.ts`,
  the same objects the controllers use, and call them directly. MCP never makes an HTTP request
  to its own REST API, so nothing is duplicated and there is no internal loopback.
- **Off means absent.** `config.mcp.enabled` is read when the app is built, and the flag is the
  ordinary boolean rule (`toBool`): a missing, empty or misspelled value leaves it off. A
  disabled instance registers neither the route nor any middleware for it, and creates no MCP
  server, transport or resource — `/mcp` answers with the ordinary `404 NOT_FOUND` envelope.
- **Stateless transport.** `routes.mcp.ts` uses the SDK's `StreamableHTTPServerTransport` with
  `sessionIdGenerator: undefined`. One `McpServer` is bound to one transport for its lifetime,
  so each request builds its own pair and tears it down when the response closes; no session
  state survives a request. The transport writes its own JSON-RPC response, so it deliberately
  bypasses the `res.json` envelope wrapper the REST responses go through.
- **Two tools, not a tool framework.** `website_search` and `website_fetch` are registered on
  the SDK's `McpServer` with zod input schemas that mirror the route schemas — built from the
  same `MAX_PAGE`, `SOURCE_PATTERN` and `config.search.maxResults` the routes and the OpenAPI
  document already read — so the two interfaces cannot state different bounds. Each tool body is
  one call to a service plus the `CallToolResult` wrapper the SDK requires: there is no MCP
  controller, service, repository, factory or generic tool layer.
- **Errors surface as tool errors.** A service that throws travels out of the tool unchanged
  and the SDK turns it into a tool result with `isError: true`, so a failure is never reported
  as a successful call and no error is swallowed. The REST envelope is untouched; because the
  endpoint answers JSON-RPC rather than that envelope, `/mcp` is deliberately not described in
  the OpenAPI document.

`tests/routes.mcp.test.ts` covers the gate (off by default, off for a misspelled value, and
`/mcp` absent or present accordingly), the exact tool list and their input schemas, that each
tool reaches the shared service with the arguments the route would have produced, and that a
service error becomes a tool error. It drives the server with the SDK's own client over a real
loopback connection and stubs only the services, so the suite still needs no search backend, no
browser and no external site.

## API documentation

`routes.swagger.ts` is the third presentation edge, and the only one that is hand-written:
it holds the OpenAPI 3 document and mounts the Swagger UI at `/docs` when
`SWAGGER_ENABLED=true`. It is a route module rather than an application — it reads the same
`MAX_PAGE`, `SOURCE_PATTERN`, `config.search.maxResults` and `codes` the routes and the
response middleware use, so it cannot document a bound or a code the API does not enforce.

Two things about it are deliberate:

- **The document is served, not embedded.** The UI is started with
  `swaggerUi.setup(undefined, { swaggerUrl: "/docs/openapi.json" })`, so it fetches the
  document from the JSON endpoint at runtime. `swagger-ui-express` embeds an inline document
  through `String.replace`, where a `$` in the document is read as a replacement pattern (a
  dollar sign followed by a backtick, an ampersand, a quote or another dollar sign) and
  silently corrupts the generated JavaScript — and this document contains regexes and
  Markdown, so that is the wrong path for it. `tests/swagger.test.ts` compiles the generated
  script to prove it is valid JavaScript.
- **It sits outside the response envelope.** `/docs` is mounted before
  `responseMiddleware`, because Swagger UI answers with HTML, JavaScript and static assets
  rather than an API envelope. `/mcp` is deliberately absent from the document: MCP speaks
  JSON-RPC, and an OpenAPI path describes a REST operation.

## Response cache

`middlewares/cache.ts` sits between the schema and the controller on all three cached routes,
and the `cache/` module owns everything else about caching. A route only ever writes:

```ts
router.post("/website/search", middlewares.validate(schema), middlewares.cache({ ttl: 120 }), search);
```

`ttl` is seconds. `CACHE_DRIVER` — `redis`, `memory`, or `none`, which is the default and also
what any unrecognised value means — decides which backend `cache.get`/`cache.set` talk to. The
middleware never learns which one it is: it calls those two methods and nothing else, so the
route, the controller and the response layer are byte-for-byte identical in all three modes.

- **Hit.** The stored string is the finished envelope, so it is sent as it is: `res.status(200)`
  and `res.type("application/json")` followed by `res.send`. The controller never runs and no
  second envelope is built.
- **Miss.** `res.send` is wrapped and the controller is called. As the response leaves, the
  middleware stores it **only when it is a 200**. The write is fire-and-forget: a response
  never waits for the cache.

Wrapping `res.send` rather than `res.json` is deliberate. `helpers/response.ts` has already
replaced `res.json` with the envelope builder and that builder ends in `res.send`, so the
wrapper sees the finished envelope as the exact bytes that were sent — the one place that
decides the response shape is not duplicated. Because the cache sits after `validate`, the key
is derived from the normalized body (`q` trimmed, `page`/`limit` filled in), and a refused body
never costs a cache round-trip.

The two backends are deliberately small:

- **`memory`** (`cache/memory.ts`) is one `Map` of `{ value, expiresAt }` with no external dependency. A read past
  `expiresAt` deletes the entry as it finds it and reports a miss, so a key nobody reads again
  does not stay for the life of the process. It is process-local: two replicas, or a restarted
  one, share nothing — which is all an optional response cache needs.
- **`redis`** (`cache/redis.ts`) uses `REDIS_URL`, and `SET key value EX ttl` carries the TTL. A missing
  `REDIS_URL` is reported once and then behaves like `none`. The client gets a 500 ms
  connection timeout and a single retry — an unreachable Redis costs a few dozen milliseconds
  rather than the client's 10 second default — and a connection that fails is forgotten, so the
  next request reconnects and caching resumes by itself.

Caching is never a dependency. `none` and `memory` open no connection at all, and `redis`
swallows every failure after logging it: a failed read is a miss, a failed write is ignored.
Neither can turn a request into an error, and neither switches the configured driver.
`cache.close()` runs on shutdown next to `browser.close()`.

## Search flow

Website search is one layer over a selected backend. The backend owns the engines, their rate
limits and their HTML, and answers with JSON, so the service is one HTTP request and one mapper -
no browser, no HTML, no engine-specific knowledge. The current backend is SearXNG.

1. `Search.search()` clamps `limit` to `MAX_RESULTS` and builds
   `${SEARCH_URL}/search?q=…&format=json&pageno=…`; `pageno` is the requested page, and
   `Accept-Language` follows the configured locale.
2. `sources` becomes the backend's own comma-separated `engines` parameter — and is left out
   entirely when the caller did not choose any, which is what makes the backend pick its own set.
   `language` becomes the backend's `language` parameter, again only when one was chosen: an empty
   string counts as "not chosen", exactly like an empty `sources` list.
3. `fetch` carries `AbortSignal.timeout(SEARCH_TIMEOUT)`, so a stuck backend cannot hold the
   request open.
4. The JSON body is read once. `results[].title`, `.url` and `.content` are mapped onto
   `SearchResult`, trimmed of whitespace, de-duplicated by URL, capped at `limit` and
   numbered from 1; `engine`/`engines` become `source` (one name stays a string, several become
   an array, and spaces become underscores so the value can be sent straight back as a source).
   Templates, thumbnails, infoboxes and suggestions are dropped rather than forwarded.
5. `meta` always echoes `page` and `limit`. `total` and `last` are added **only** when the backend
   reports a non-zero `number_of_results`, because the engines behind it often do not provide a
   count and the API does not invent one.
6. When sources were chosen, every one of them has to be accounted for: the backend ignores names
   it does not know and answers with its default set, so a requested source that produced no
   result is reported as `400 INVALID_PARAMETER` (a name this instance does not serve) or
   `503 SEARCH_UNAVAILABLE` (it failed, and said so in `unresponsive_engines`) instead of looking
   like a search that had no matches.

`Search.sources()` reads the same backend's `/config` and maps its `engines[]` onto
`{ name, enabled, categories }`, normalized exactly like a result's engine name and sorted by
name. That is why `src/` contains no list of engines: the backend's own configuration is the
single source of truth, and changing it is enough.

### Which sources are listed

`GET /website/search/sources` is a public abstraction over the backend, not a dump of its
configuration. It answers "which sources can a client pass in `sources`?", and for this API that
means the sources relevant to its current purpose: general website/web search. The rule is applied
to each engine's own metadata:

```
enabled === true
AND categories is non-empty
AND every category is "general" or "web"
```

SearXNG labels the general category `general` and its web sub-category `web`, so a pure web search
engine carries `["general"]`, `["web"]` or `["general","web"]` — and nothing else. An engine that
also declares a specialized category fails the last condition:

| Engine metadata                    | Listed | Why                                                   |
| ---------------------------------- | ------ | ----------------------------------------------------- |
| `["general","web"]`, enabled       | yes    | pure general web search                               |
| `["general"]`, enabled             | yes    | the general category on its own                       |
| `["images","web"]`, enabled        | no     | an image engine, even though it also declares `web`   |
| `["videos","web"]`, enabled        | no     | a video engine                                        |
| `["news"]`, enabled                | no     | a news category                                       |
| `["general","translate"]`, enabled | no     | general, but not a website search engine              |
| `["web"]`, disabled                | no     | switched off, so it cannot answer a search            |

`enabled` is therefore always `true` in the response: a disabled engine is not a source this API can
offer. Filtering looks at the metadata only — never at the engine's name, its URL, or a hard-coded
list of known engines — so the rule holds for any backend configuration, and a deployment that adds
or removes engines changes the list without a code change.

Failures are split by cause, so the caller learns which side broke:

| Situation                              | Status | Code                 |
| -------------------------------------- | ------ | -------------------- |
| The search backend is not reachable    | `503`  | `SEARCH_UNAVAILABLE` |
| The search backend answered `5xx`      | `503`  | `SEARCH_UNAVAILABLE` |
| A chosen source reported a failure     | `503`  | `SEARCH_UNAVAILABLE` |
| Request exceeded `SEARCH_TIMEOUT`      | `504`  | `TIMEOUT`            |
| The search backend answered `4xx`      | `502`  | `SEARCH_FAILED`      |
| Body was not JSON we can read          | `502`  | `SEARCH_FAILED`      |
| A chosen source does not exist here    | `400`  | `INVALID_PARAMETER`  |

Every one of those carries a `FailureContext` as the AppError `cause`: the backend name, the
requested URL, the HTTP status when there was one, and a bounded excerpt of the answer.
`helpers/debug.ts` writes it into `debug.txt` when `DEBUG=true`, which keeps the sanitized
response and the diagnosis apart.

Because `depends_on` only orders startup, the API answers `SEARCH_UNAVAILABLE` while the search
backend is still booting instead of failing the request as an internal error.

## Webpage extraction flow

1. `controllers/get.ts` reads `url` from the JSON body (already trimmed by the route's schema)
   and validates it with `parseHttpUrl` (absolute, `http`/`https`, hostname present).
2. `Page.extract()` calls `assertPublicUrl()`, which rejects loopback,
   private, link-local, CGNAT, multicast and reserved destinations — including IPv4
   addresses hidden in IPv6-mapped or NAT64 form — and resolves public hostnames once so
   that a name pointing at a private address is refused too.
3. Redirects are followed by default. With `autoRedirect=false` one `fetch` with
   `redirect: "manual"` decides that before any driver work: a 3xx becomes the result itself
   - the site's `status` and its `location`, and no page fields at all, because there is no
   page - and anything else is cancelled immediately, so the probe costs one round-trip and
   no download.
4. `fetchPage()` asks the chosen driver for the HTML and nothing else:
   - `fetch` (the default) is one Axios request for the document, with
     `validateStatus: () => true` so a 404 or a 500 page is still a page, and the final URL read
     from the response. Chromium is never started and no asset is downloaded.
   - `browser` renders with Puppeteer (`domcontentloaded` + a short bounded network-idle wait).
     Before the HTML is read, one pass marks every element the browser does not paint
     (`display: none` or `visibility: hidden`) with `data-web-io-hidden`: invisibility cannot
     be read from markup, because a `hidden` class may be overridden by a responsive rule and
     `overflow-hidden` is not hidden at all.
5. The URL that really answered is validated before its HTML is read, for **both** drivers: a
   redirect must not be able to lead into the private network.
6. Cheerio parses the HTML **once**. Metadata and title are read first, because content
   cleaning removes nodes that may still hold the best title or description. The same pass
   over the untouched document collects the JSON-LD blocks and every link, image, video and
   audio URL declared in the markup: resolved against the final URL, typed internal or
   external by hostname, and never downloaded.
7. `extractReadableContent()` cleans a copy of the DOM and converts the main container to
   Markdown.
8. The title is prepended as an `# H1` unless the article already starts with it, and the
   result is truncated at a line boundary if it exceeds `MAX_CONTENT_LENGTH`.

Because the driver only replaces step 4, everything from step 5 on is the same code, and
`tests/services/page.test.ts` asserts that both drivers produce an identical result for the
same HTML.

## Puppeteer's responsibility

`services/browser.ts` is the only place that knows about Puppeteer, and only the `browser`
driver of `/website/fetch` uses it: search never reaches this file, and a `fetch`-driver request
never starts a process. It:

- launches **one** Chromium process and reuses it; concurrent `getPage()` calls share a
  single launch promise, so a burst of requests cannot start a dozen browsers;
- creates a page per request and configures a fixed 1366×768 viewport, the configured
  locale (`Accept-Language`) and the default timeouts;
- launches with the persistent profile from `GOOGLE_PROFILE_DIR`, so cookies and local
  storage survive between requests and container restarts instead of being discarded with
  every page;
- prefers the installed Chrome channel only when `GOOGLE_HEADLESS=false`, and falls back to
  the browser Puppeteer resolved - the bundled Chromium locally, or the system package named
  by `PUPPETEER_EXECUTABLE_PATH` in a container - if that channel is missing;
- never touches the User-Agent unless `GOOGLE_USER_AGENT` is set, and launches without any
  automation-hiding flags: no `--disable-blink-features`, no fingerprint or profile patches;
- drops the cached browser when Chromium disconnects, so the next request starts a new
  process instead of failing forever;
- installs a request guard that aborts images/fonts/media and every request to a blocked
  host or a non-HTTP scheme — note that this also covers redirects and subresources;
- closes pages in `withPage()` via `finally`, so a failed request cannot leak a page;
- wraps a launch failure in `502 BROWSER_FAILED`;
- is closed explicitly on shutdown.

The browser starts lazily on the first browser-backed request: `/health` works even when
Chromium is missing.

## Cheerio's responsibility

Cheerio parses already-rendered HTML — it never fetches anything. It is used in two
places, with a deliberate split:

- `Search` maps the search backend's JSON onto `SearchResult[]` (no HTML parsing at all).
- `page.ts` reads `title`, `meta`, Open Graph and Twitter tags and the JSON-LD
  blocks (all under `metadata`), plus the `links`/`images`/`videos`/`audios` lists that sit
  next to `metadata` on the result.
- `content-cleaner.ts` removes noise and selects the main container.
- `markdown.ts` serialises that container.

Because everything after `page.content()` — or after the Axios response — is pure string
handling, all of it is unit tested without a browser.

## Content extraction strategy

`content-cleaner.ts` picks what to keep, `markdown.ts` renders it. Both run on a copy of
the document, so the caller can still read metadata from the original.

**1. Remove noise.** A single selector list removes scripts, styles, templates, forms,
buttons, iframes, SVG, and anything that is navigation, footer, aside, cookie banner,
advertisement, modal, sidebar, widget, social or comment related, plus `[hidden]`,
`[aria-hidden=true]`, `display:none` style rules, the `data-web-io-hidden` marks left by
the browser pass, and symbol-only anchors (a heading's `#` permalink, an icon link). A
`<header>` is kept when it contains a heading — that is usually the article masthead — and
dropped when it does not. `html` and `body` are never removed: their class lists describe
the page, not a widget, and one unlucky match (Wikipedia's
`vector-feature-language-in-main-menu-disabled`) would delete the whole document.

After removal the remaining text is compared with the text before it. If a heuristic
guess removed more than 90 % of a page that had real content, the result is rebuilt from
the untouched document instead of returning almost nothing. Class names are guesses, and a
wrong guess should degrade to noisy output, not to an empty page.

**2. Choose the main container.** Every `article`, `main`, `[role=main]`, `section`, `div`
and `td` with at least 200 characters of text is a candidate. Each is scored with

```
text length × (1 − link density) + 30 × <p> count + 3 × sentence punctuation
```

with a small bonus for containers whose class or id looks like `article`, `content`,
`post`, `entry`, `markdown` or `story`. The highest score wins — but among candidates
within 95 % of the best score, the one with the least text wins, because a wrapper that
also contains the sidebar or the comment thread scores marginally higher than the article
inside it. If nothing qualifies, the whole `<body>` is used.

**3. Convert to Markdown** (`markdown.ts`). A recursive walk distinguishes block-level from
inline nodes and merges consecutive inline siblings into one paragraph, so a sentence with
a link in the middle stays one block — and so that a page which wraps every character in a
`<span>` (example.com does) keeps the spaces that live in their own elements. Headings
become `#`-prefixed lines, lists become `-`/`1.` (including nested lists), `pre`/`code`
become fenced blocks with the language taken from the class name when the site exposes one,
`blockquote` is prefixed, tables become GitHub-flavoured tables with a header row (reusing
the first row when a table has no `<th>`, and dropping rows that carry no text), and links
become `[text](absolute-url)` with tracking parameters removed. Images are dropped: their
alt text carries the meaning, the binary does not.

**4. Normalise.** Lines are trimmed, runs of blank lines collapse, blocks are joined with
exactly one blank line, duplicate blocks are removed (consecutive copies always, repeated
blocks longer than 40 characters anywhere), pure punctuation blocks are dropped while `---`
separators survive, and code blocks are kept byte-for-byte because collapsing them would
change the program they describe.

Verified by `tests/helpers/content-cleaner.test.ts` and `tests/helpers/markdown.test.ts`,
which assert both the presence of structure (`## Installation`, ` ```bash `, `- item`,
`> quote`, `| cell |`) and the absence of HTML, chrome and hidden text.

## AI-readable output

`content` is Markdown-like text and nothing else. HTML tags, class names, scripts and
inline styles never reach it. The trade-offs are explicit:

- images are omitted, captions are kept;
- in-page anchors (`#section`) and `javascript:`/`mailto:` links lose their target but
  keep their text;
- `---` separators survive, pure punctuation blocks do not;
- content longer than `MAX_CONTENT_LENGTH` ends with `[content truncated]`.

What the Markdown drops is still reported as data: `metadata.jsonld` holds the parsed
JSON-LD blocks, and `links`, `images`, `videos` and `audios` — siblings of `metadata` on the
result, not fields inside it — hold every URL the page referenced.

## Browser lifecycle

```
services/browser.ts  new Browser(config)     module load; no process started yet
index.ts             app.listen()            nothing rendered yet
  └── getPage() on first request → launch Chromium (once)
        └── withPage()           new page → work → page.close()
  SIGINT/SIGTERM → server.close() → browser.close() → exit
```

A disconnected browser is forgotten, a failed launch is not cached as a failure, and a
page is always closed — on success, on exception and when page setup itself fails.

## Dependency wiring

`instance.ts` creates the shared services once, and everything that needs them imports them:

```ts
// instance.ts
export const searchService = new Search(config);
export const browser = new Browser(config);
export const page = new Page(browser, config);

// routes.api.ts — the schema is declared inline; only the order matters here.
router.post("/website/search", middlewares.validate({ /* q, page, limit, sources, language */ }), middlewares.cache({ ttl: 120 }), search);
router.get("/website/search/sources", middlewares.cache({ ttl: 120 }), searchSources);
router.post("/website/fetch", middlewares.validate({ /* url, driver, autoRedirect */ }), middlewares.cache({ ttl: 120 }), get);

// controllers/get.ts
import { page } from "../instance";
```

A controller is then a plain Express function with no parameters to thread through, and no
request validation of its own — the route's schema already ran:

```ts
export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const url = parseHttpUrl(req.body.url);
    return res.json({
      status: 200,
      code: codes.OK,
      data: await page.extract(url, { autoRedirect: req.body.autoRedirect, driver: req.body.driver }),
    });
  } catch (error) {
    return next(error);
  }
}
```

The module is the dependency boundary: no container, no decorator, no service locator, no
router or server factory, no controller factory. `instance.ts` imports only helpers and
services, so there is no cycle; `index.ts` imports the `browser` instance to close it on
shutdown. For tests, the seams stay in the classes (`Browser`'s launcher, the services'
dependencies) and in stubbing the shared instance's method, which keeps controllers free of
injection plumbing.

## Error handling

`AppError(status, code, cause?, data?)` is thrown by helpers, services and the validation
middleware; `code` is typed as the `Code` union exported by `helpers/response.ts`, so the
vocabulary cannot drift, `cause` keeps the original exception attached for the debug log, and
`data` is what the response carries — the validator's own errors for a validation failure,
`null` for every other failure.
`server.ts` has one error middleware: an `AppError` is answered with the standard failure
envelope and its own status, anything else is logged and answered with
`500 INTERNAL_ERROR` plus a message that contains no internals. A single 404 handler
covers unknown routes.

Because every failure passes through that single middleware, debugging has exactly one
integration point: when `DEBUG=true`, `helpers/debug.ts` appends the request (method, path,
sanitized query and body), the code, the status, the original error with its stack and its
cause to `debug.txt`. The write is fire-and-forget and swallows its own failures, so logging can
never slow down or break a request, and the HTTP body never carries any of it.

| Status | Code                                  | Raised by                 |
| ------ | ------------------------------------- | ------------------------- |
| 400    | `INVALID_URL`, `UNSUPPORTED_PROTOCOL` | `helpers/url.ts`          |
| 400    | `BLOCKED_URL`                         | `helpers/url.ts` (SSRF)   |
| 400    | `VALIDATION_ERROR`                    | `middlewares/validate.ts` |
| 400    | `INVALID_PARAMETER`                   | `services/search.ts`      |
| 400    | `INVALID_BODY`                        | `server.ts` (body-parser) |
| 404    | `NOT_FOUND`                           | `server.ts`               |
| 502    | `BROWSER_FAILED`                      | `services/browser.ts`     |
| 502    | `SEARCH_FAILED`                       | `services/search.ts`      |
| 503    | `SEARCH_UNAVAILABLE`                  | `services/search.ts`      |
| 502    | `PAGE_FETCH_FAILED`                   | `services/page.ts`        |
| 504    | `TIMEOUT`                             | services (`TimeoutError`) |
| 500    | `INTERNAL_ERROR`                      | `server.ts` fallback      |

## Security considerations

- **SSRF.** `/api/v1/website/fetch` takes a caller-supplied URL and hands it to a browser (or to
  Axios) inside our network. `parseHttpUrl` restricts schemes to `http`/`https`,
  `assertPublicUrl` blocks
  loopback and private address space (literals *and* resolved hostnames), the request
  guard blocks private hosts on every redirect and subresource the browser asks for, and the
  URL that finally answered is checked again — for both drivers — before its HTML is read.
- **No sandbox bypassing.** The extraction path behaves like a normal automated browser: a
  real Chromium, a persistent profile and the browser's own User-Agent. Searching does not
  touch the browser at all, so there is nothing to disguise or work around on that path.
- **No internals in responses.** Stack traces stay in the server log.
- **Input bounds.** `page` ≤ 20, `limit` ≤ `MAX_RESULTS`, `content` ≤
  `MAX_CONTENT_LENGTH`, and every Puppeteer call has a timeout.
- **Resource limits.** Assets are not downloaded, pages are always closed, and one
  Chromium process serves all requests.
- **Secrets.** Only `.env.example` is committed; `.env` is ignored.

## Docker and the search backend

The search backend — currently SearXNG — runs as its own service in `docker-compose.yml` and is not
part of the Bun image: the API reaches it as `http://searxng:8080` over the Compose network, a name
that only resolves inside that network. Its settings are the tracked, minimal `settings.yml` at the
project root (`use_default_settings: true`, a secret key that `SEARXNG_SECRET` overrides, the
limiter off, and `json` among the enabled formats); the image is launched with its own dropped
capabilities and that one file bind-mounted at `/etc/searxng/settings.yml`, so everything else
in the config directory stays inside the container. Host port 8080 is mapped to
`SEARXNG_PORT` (default 18080) purely so a developer can look at SearXNG's own interface;
the API never uses that port. SearXNG's own Valkey is deliberately absent — it exists for the
limiter and SearXNG's result cache, and this configuration enables neither — which is
unrelated to the API's own response cache: that is a separate `redis:7-alpine` service,
selected with `CACHE_DRIVER=redis` and reached as `redis://redis:6379` through `REDIS_URL`.
Setting `CACHE_DRIVER` to `memory` or `none` is how the stack runs without it.

The Bun image is built in two stages. The first installs production dependencies with
`PUPPETEER_SKIP_DOWNLOAD=true`; the second installs Debian's `chromium` plus fonts and
copies `node_modules` and `src` over. `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` points
Puppeteer at the system browser (Puppeteer reads that variable itself, so no launch option has
to be set), `PUPPETEER_NO_SANDBOX=true` makes Chromium start as the
non-root `bun` user, `GOOGLE_HEADLESS=true` keeps it headless, and the process runs
`bun src/index.ts` directly — Bun needs no build
step. `docker-compose.yml` adds the port mapping, an optional `.env`, `init: true` (to reap
Chromium's helper processes) and a `/api/v1/health` healthcheck.

## Kubernetes

`k8s.yaml` contains exactly what this service needs: a two-replica API Deployment and a
ClusterIP Service, a single-replica SearXNG Deployment and Service (the search backend,
reached as `http://searxng:8080` through `SEARXNG_URL`), and a single-replica Redis
Deployment and Service for the response cache. The API keeps no state of its own and the
cache is disposable — Redis runs with snapshots and the append-only file switched off, so
there is nothing to back up — and SearXNG's own cache is an `emptyDir`.

SearXNG is the one workload that needs more than environment variables. Its `settings.yml`
is a ConfigMap (the same tracked file Compose bind-mounts, with `json` among the enabled
formats, which the API requires and the image's default does not enable) mounted at
`/etc/searxng/settings.yml` with `subPath`, so the rest of the image's config directory stays
in place. Its `server.secret_key` comes from the `searxng-secret` Secret: SearXNG reads
`SEARXNG_SECRET` and it overrides the placeholder in the file, so the ConfigMap never holds a
real secret. `SEARXNG_BASE_URL` is set to the Service URL for the links on SearXNG's own
pages, and the container keeps the same dropped capabilities as Compose (only `CHOWN`,
`SETGID`, `SETUID` and `DAC_OVERRIDE` are added, because the entrypoint chowns its config and
cache directories). SearXNG's probes use its `/healthz`, which answers `OK`; the API keeps
probing its own `/api/v1/health`.

CPU and memory requests/limits reflect the fact that an idle process is small while a
rendering Chromium is not (`--disable-dev-shm-usage` avoids needing a larger `/dev/shm`).

## Testing

`tests/` mirrors `src/`: `cache/`, `controllers/`, `helpers/`, `middlewares/`, `services/` and
`routes.test.ts`. The
suite is deterministic and offline — no live search backend, no external site, no Chromium, no
Redis — for three reasons: `tests/services/search.test.ts` replaces the global `fetch` and feeds the
service canned JSON (including a backend that never answers, which exercises the real
`AbortSignal` timeout), `Browser` accepts a launcher so pages come from a fake that returns
fixed HTML, and the shared instances can have their methods stubbed for one test
(`stub(searchService, "search", …)` in `tests/helpers/test-utils.ts`).

Controller tests call the exported function directly with a fake response, asserting the
service arguments, the result handed to `res.json` and the AppError forwarded to `next`.
`tests/helpers/response.test.ts` covers the response middleware on its own: the envelope,
the message derived from each code, pagination metadata and `meta.took`.
`tests/middlewares/validate.test.ts` covers the validation middleware directly — a matching
body passes, every violation (missing, wrong type, too short, or not an object at all) is
forwarded as `400 VALIDATION_ERROR` with the validator's own objects as the error's `data`, a
sanitizer writes the cleaned value back into the body, and an uncompilable schema throws when
the middleware is built. `tests/middlewares/cache.test.ts` drives the cache middleware against
a double: a miss runs the controller and stores the finished envelope with the configured TTL,
a hit is replayed without running the controller, a non-200 is not stored, and the TTL from the
route is the one written. It then runs the same middleware with the real backends: `none` lets
every request through to the controller, `memory` misses once and hits on the identical
request, and a `memory` entry whose TTL has run out is a miss again. `tests/cache/cache.test.ts`
covers the driver rule (`toCacheDriver` accepts only the three values and turns anything else
into `none`), the key directly — identical requests key alike regardless of parameter order or
of a field sent as `null` instead of omitted, and
different methods, paths or parameters key apart — and the failure contract: a missing
`REDIS_URL` or an unreachable Redis is a silent miss rather than a thrown error, while `memory`
and `none` never reach for Redis at all. Controller tests assert the other
half of the contract: the handler
validates nothing itself and forwards what it is given. Route tests start the real app on port
0 and assert the envelope for `/health` (runtime information included), the three success paths
(with the instance stubbed), the
`/website/search` schema rejection for a missing, mistyped or out-of-range field (with the validator's
errors in `data`), every other validation failure, the SSRF refusals on `/website/fetch`, 404, and the two
error-middleware paths. `tests/routes.mcp.test.ts` does the same for the MCP interface, driving
the real `/mcp` route with the SDK's own client and stubbing only the services it reaches.
`tests/swagger.test.ts` asserts the document against the routes it describes — the operations,
the tags, the request bounds read from the same constants, and the examples — and that the
generated Swagger UI script is valid JavaScript pointing at `/docs/openapi.json`.
`tests/preload.ts` sets `NODE_ENV=test` (and turns the docs and MCP off) so the request log stays quiet and
no test depends on the developer's `.env`. The whole suite runs in well under a second.

What the suite deliberately does **not** cover is the real backends: a live search backend, a real
JavaScript-heavy site, a real Chromium process. Those stay manual — `docker compose up -d` then
`curl "http://localhost:18080/search?q=bun&format=json"` and
`curl -X POST "http://localhost:3000/api/v1/website/search" -H "content-type: application/json" -d '{"q":"bun"}'` — so that `bun test` never depends on the
network or on a running container.

## Why this is not over-engineered

The application has four endpoints and three services (search, browser, extraction), four
controller functions, two middleware, one instance
module and a handful of helpers. The search backend is infrastructure: it is reached with one
`fetch`, contributes no file to `src/`, and its source list is read from the same place rather than
copied into a constant. There is no `types.ts`
(each type lives next to its consumer), no `responses/`, `serializers/` or `dto/` package —
the whole response layer is the `res.json` wrapper in `helpers/response.ts` — no generic
validation framework, no validators/models/schemas split, no repository or DI container,
no base classes, no router/server factory, no controller factory and no injection
plumbing: a controller is one function that imports the instance it needs. `middlewares/`
holds one file per concern, and `validate.ts` exists because the shape a route accepts
belongs next to the route instead of inside the handler: `validate(schema)` compiles one
schema into one `RequestHandler` and reuses the existing `AppError` and response envelope,
so it is not a second error system and the controllers keep no validation of their own.
`cache({ ttl })` has the same shape: one `RequestHandler` that derives its key from the request
and hands over to the existing response layer, with `cache/` holding the driver
selection and one backend per file behind one `get`/`set` pair rather than a cache
repository, provider, adapter, factory or interface — there is nothing to configure beyond
`CACHE_DRIVER` and nothing to resolve. Duplication is
accepted where it is cheaper than the abstraction: the two services map navigation
timeouts in two three-line `catch` blocks rather than sharing a helper that would need its
own tests. MCP follows the same rule: `routes.mcp.ts` is the only file that knows the SDK, its
two tools are one service call each, and their schemas are built from the constants the routes
already export, so it introduces no second validation vocabulary, no tool abstraction and no
server of its own. An instance that does not set `MCP_ENABLED` mounts none of it — no MCP
server, transport or session is ever created — and `/mcp` behaves like any unknown path.
Every file in the tree exists because something imports it.
