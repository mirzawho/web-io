# web-io

A website search and web content API. It searches the web, fetches web pages, extracts their
content and metadata, and serves the same two capabilities over HTTP and MCP.

```
GET  /api/v1/health                 → service status and runtime information
POST /api/v1/website/search         → website search results as JSON
GET  /api/v1/website/search/sources → the website search sources this deployment offers
POST /api/v1/website/fetch          → a webpage as title, metadata and Markdown
MCP  /mcp                           → website_search and website_fetch as MCP tools (opt-in)
```

## Overview

`web-io` owns the API and everything behind it: the search service, the extraction pipeline, the
response contract and the cache. The tools it depends on — the search backend, the browser, the
cache server — are external, and it is wired to them rather than built out of them.

```
                        ┌── Search ──→ Search service ──→ search backend ──→ search engines
Client ── HTTP / MCP ───┤                                  (SearXNG)
                        └── Page ────→ driver ──→ HTML ──→ Cheerio ──→ extracted page
                                      ├─ fetch:   Axios (one HTTP request)
                                      └─ browser: Puppeteer (renders JavaScript)
```

It is intentionally small: four endpoints, three services and a handful of helpers. No
database, no queue, no plugin system. The search backend is external infrastructure: the current
one is [SearXNG](https://docs.searxng.org), which runs as its own container and is only ever
reached over HTTP. The one optional stateful piece is Redis, and it does one thing: cache
successful responses.

## Features

- **Website search** over plain HTTP: no browser, no scraping, no API key. A search can be
  restricted to named search sources and to one language, and
  `GET /api/v1/website/search/sources` reports the sources this deployment actually offers —
  read from the search backend itself, never from a list kept here, and reduced to the general
  web search engines it serves, so specialized engines never appear. Website search currently
  uses SearXNG as its search backend; the engines stay configurable there.
- **Webpage extraction** that returns structured metadata — description, Open Graph, Twitter
  and JSON-LD — plus every link, image, video and audio URL the page references, and the main
  article as Markdown-like text, ready to be fed to an LLM. The `content` field never contains
  HTML, and no asset is downloaded: only URLs already present in the markup are reported.
- **Two request drivers for `/website/fetch`**: `fetch` (the default) makes one Axios request for the
  HTML and never starts a browser; `browser` renders the page with Puppeteer for sites whose
  content only exists after JavaScript runs. Both feed the same extraction pipeline, so the
  response shape does not change with the driver.
- **One Chromium process** shared by every request that asks for the browser driver; each of
  those requests gets its own page and closes it again.
- **One response contract**: every answer, success or failure, uses the same envelope with
  a stable uppercase `code` and the elapsed time in `meta.took`.
- **Optional response cache**: successful responses are stored for a configurable TTL and
  replayed for an identical request, so a repeat of an expensive search or page extraction
  costs neither the search backend nor Chromium. The backend is chosen with `CACHE_DRIVER` —
  Redis, in-process memory, or nothing at all — and it is always an optimization: if it is
  missing or unavailable, every request is still answered normally.
- **SSRF protection**: local, private, link-local and cloud-metadata destinations are
  refused, including when a redirect points at them.
- **MCP server (opt-in)**: the same two capabilities exposed as
  [MCP](https://modelcontextprotocol.io) tools — `website_search` and `website_fetch` — at
  `/mcp`. It is a second interface to this application, not a second application: the same
  process, the same port, and the same service instances the REST endpoints call.

## Tech stack

| Piece                     | Used for                                                  |
| ------------------------- | --------------------------------------------------------- |
| Bun                       | runtime, package manager, test runner                     |
| TypeScript                | strict types, no build step                               |
| Express                   | HTTP layer                                                |
| fastest-validator         | declaring the request body a route accepts                |
| Axios                     | fetching pages for the `/website/fetch` `fetch` driver    |
| Puppeteer                 | rendering pages for the `/website/fetch` `browser` driver |
| SearXNG                   | the current search backend behind website search (external, not part of this API) |
| Cheerio                   | parsing rendered HTML                                     |
| Redis                     | optional response cache (Bun's built-in client)           |
| swagger-ui-express        | the opt-in Swagger UI at `/docs`                          |
| @modelcontextprotocol/sdk | the opt-in MCP server at `/mcp`                           |
| zod                       | the input schemas of the MCP tools                        |

## Requirements

- [Bun](https://bun.sh) 1.4 or newer
- A Chromium/Chrome build for Puppeteer: `bun install` downloads one automatically.
  On Debian/Ubuntu you can point at the system package instead with
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.

## Installation

```bash
bun install
```

## Environment

Copy the template and adjust what you need:

```bash
cp .env.example .env
```

| Variable                    | Default                   | Meaning                                                                          |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                  | `development`             | `test` disables the request log; anything else keeps it on                       |
| `DEBUG`                     | `false`                   | Append request failures to `debug.txt`                                           |
| `DEBUG_FILE`                | `debug.txt`               | Where `DEBUG=true` writes; the test suite points it outside the repository       |
| `GOOGLE_PROFILE_DIR`        | `.cache/google`           | Browser profile reused between runs (cookies, consent, local storage)            |
| `GOOGLE_HEADLESS`           | `true`                    | `false` opens a visible browser window for `/website/fetch`                      |
| `GOOGLE_LOCALE`             | `en-US`                   | Locale for the browser session (`--lang`, `Accept-Language`)                     |
| `GOOGLE_USER_AGENT`         | *(empty)*                 | Empty uses the browser's own User-Agent                                          |
| `PUPPETEER_EXECUTABLE_PATH` | *(empty)*                 | Chromium/Chrome binary to drive; empty uses the one Puppeteer resolved           |
| `PUPPETEER_NO_SANDBOX`      | `false`                   | Set to `true` in containers (Chromium as root)                                   |
| `PUPPETEER_TIMEOUT`         | `30000`                   | Default page timeout (ms)                                                        |
| `PORT`                      | `3000`                    | HTTP port                                                                        |
| `SEARXNG_URL`               | `http://localhost:18080`  | Search backend base URL (`http://searxng:8080` in Docker and Kubernetes)         |
| `SEARXNG_SECRET`            | *(empty)*                 | SearXNG `server.secret_key`; generate with `openssl rand -hex 32`                |
| `SEARXNG_BASE_URL`          | `http://localhost:18080/` | Public base URL SearXNG uses for the links on its own pages                      |
| `SEARXNG_PORT`              | `18080`                   | Host port for SearXNG's own interface                                            |
| `SEARCH_TIMEOUT`            | `30000`                   | HTTP timeout for the search backend request (ms)                                 |
| `MAX_RESULTS`               | `10`                      | Upper bound for `limit` on `/website/search`                                     |
| `PAGE_LOAD_TIMEOUT`         | `30000`                   | Page navigation timeout for `/website/fetch` (ms)                                |
| `MAX_CONTENT_LENGTH`        | `120000`                  | Maximum length of the extracted `content` (characters)                           |
| `CACHE_DRIVER`              | `none`                    | Response cache backend: `redis`, `memory` or `none` (anything else means `none`) |
| `REDIS_URL`                 | *(empty)*                 | Redis URL, read only when `CACHE_DRIVER=redis`                                   |
| `SWAGGER_ENABLED`           | `false`                   | Serve the OpenAPI document and Swagger UI at `/docs`                             |
| `MCP_ENABLED`               | `false`                   | Serve the MCP server at `/mcp` (tools: `website_search`, `website_fetch`)        |

Every setting is optional: a missing value takes the default above, and a misspelled boolean is
off rather than fatal. `SEARXNG_SECRET`, `SEARXNG_BASE_URL` and `SEARXNG_PORT` are read by the
SearXNG container and Compose rather than by the application, and
`PUPPETEER_EXECUTABLE_PATH` is read by Puppeteer. Every other variable is read by
`src/helpers/config.ts`, once, at startup.

The request log is printed in every environment except `NODE_ENV=test`, which is what
the test suite uses.

## Development

```bash
bun run dev        # watch mode
bun run start      # run once
bun run typecheck  # tsc --noEmit
bun test           # unit tests, no network and no browser required
bun run build      # bundles the server into out/ as a build check
```

`bun run build` is a smoke check that every import resolves and the server bundles; it is not
a deployment step. Bun runs the TypeScript directly — the Docker image is what ships — and
`out/` is disposable.

Then:

```bash
curl "http://localhost:3000/api/v1/health"
curl -X POST "http://localhost:3000/api/v1/website/search" \
  -H "content-type: application/json" -d '{"q":"bun javascript runtime"}'
curl "http://localhost:3000/api/v1/website/search/sources"
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com"}'
```

Chromium starts on the first browser-backed request, so the service boots instantly.

## Debugging

```bash
DEBUG=true bun run dev
```

When debug mode is enabled, application errors are appended to `debug.txt` at the project
root. The public API continues to return sanitized error responses — the file is where the
real cause lives (the Chromium, navigation or network error, its stack, and the cause it
was wrapped in):

```bash
curl -X POST "http://localhost:3000/api/v1/website/search" \
  -H "content-type: application/json" -d '{"q":"google"}'
# -> 502 SEARCH_FAILED in the response, the actual error in debug.txt
```

`debug.txt` is append-only, is not created while `DEBUG=false`, and is ignored by git.
Failures carry their context into the entry — for search, the backend that was called, its
URL, the HTTP status and a bounded excerpt of what it answered:

```text
CODE: SEARCH_UNAVAILABLE
STATUS: 503

SEARCH_SERVICE:
searxng

SEARCH_URL:
http://searxng:8080/search?q=bun&format=json&pageno=1

DETAIL:
Unable to connect. Is the computer able to access the url?
```

Successful requests write nothing.

### Watching the browser

Only the `browser` driver renders a page. To see what it really renders — and what the
extraction is reading — run with a visible window, using the same profile:

```bash
GOOGLE_HEADLESS=false DEBUG=true bun run dev
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com","driver":"browser"}'
```

A Chrome window opens next to the request, so you can watch consent banners, overlays and
client-side rendering happen. Anything you accept there is stored in `GOOGLE_PROFILE_DIR`, so
later runs reuse it. This is a debugging mode for looking at a page: headful runs prefer your
installed Chrome — headless runs and containers use the Chromium the deployment provides — and
nothing about the request changes otherwise.

## API

Every endpoint lives under `/api/v1` and answers with the same envelope. Endpoints are grouped
by the domain they search: the open-web ones live under `/api/v1/website`, so a later domain
(`/api/v1/news`, `/api/v1/images`, `/api/v1/maps`) is added beside them:

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Human readable message",
  "meta": { "took": 123 },
  "data": {}
}
```

| Field           | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `ok`            | `true` for a successful response, `false` for any failure                                                     |
| `status`        | The HTTP status, repeated in the body                                                                         |
| `code`          | Stable uppercase machine-readable code (`OK` on success)                                                      |
| `message`       | Human-readable summary, derived from `code` in one place                                                      |
| `meta.took`     | Total request processing time in milliseconds                                                                 |
| `meta.page`     | Pagination, `/website/search` only: requested page                                                            |
| `meta.limit`    | Pagination, `/website/search` only: requested page size                                                       |
| `meta.total`    | Pagination, `/website/search` only: the result count the search backend reported; absent when it reported none |
| `meta.last`     | Pagination, `/website/search` only: last page number implied by `total` and `limit`                           |
| `meta.sources`  | `/website/search` only: the search sources the search was restricted to; absent when the backend chose        |
| `meta.language` | `/website/search` only: the language the search was restricted to; absent when the backend's default was used |
| `data`          | The endpoint payload, `null` on failure                                                                       |

### `GET /api/v1/health`

Liveness plus the runtime context a deployment wants to see. It touches no dependency, so it keeps
answering `200` while the search backend or Chromium are down — which is what makes it usable as a
liveness probe:

```bash
curl "http://localhost:3000/api/v1/health"
```

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 1 },
  "data": {
    "status": "healthy",
    "uptime": 12.34,
    "timestamp": "2026-10-02T12:00:00.000Z",
    "runtime": { "name": "bun", "version": "1.4.2" },
    "version": "1.0.0"
  }
}
```

| Field       | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `status`    | `healthy` while the process is serving               |
| `uptime`    | Seconds since the process started                    |
| `timestamp` | The server's current time (ISO-8601, UTC)            |
| `runtime`   | The runtime serving the request, and its own version |
| `version`   | The application version, from `package.json`         |

### `POST /api/v1/website/search`

Takes a JSON object as its body:

| Field      | Type     | Required | Default           | Notes                                                                          |
| ---------- | -------- | -------- | ----------------- | ------------------------------------------------------------------------------ |
| `q`        | string   | yes      | –                 | Search query, trimmed                                                          |
| `page`     | number   | no       | `1`               | 1–20, sent to the search backend as `pageno`                                   |
| `limit`    | number   | no       | `MAX_RESULTS`     | 1–`MAX_RESULTS`; the list that comes back is capped, the backend may send more |
| `sources`  | string[] | no       | *(all sources)*   | Restrict the search to these website search sources, e.g. `["google","bing"]`  |
| `language` | string   | no       | *(backend's)*     | Search language, e.g. `en` or `fa`                                             |

The body is validated before the controller runs, from the schema declared next to the route
rather than inside the handler: a request without a non-empty string `q`, or with a `page`
outside 1–20, is answered with `400 VALIDATION_ERROR` and never reaches the search backend.
Fastest Validator's own error objects are returned in `data` (see [Errors](#errors)).

```bash
curl -X POST "http://localhost:3000/api/v1/website/search" \
  -H "content-type: application/json" \
  -d '{"q":"bun javascript runtime","page":1,"limit":5}'

# Restricted to two search sources, in English. The names come from the sources endpoint below.
curl -X POST "http://localhost:3000/api/v1/website/search" \
  -H "content-type: application/json" \
  -d '{"q":"OpenAI","sources":["google","bing"],"language":"en"}'
```

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 842, "page": 1, "limit": 5, "sources": ["google", "bing"], "language": "en", "total": 2, "last": 1 },
  "data": [
    {
      "title": "Bun — A fast JavaScript runtime",
      "url": "https://bun.sh/",
      "description": "Bun is a fast all-in-one JavaScript toolkit.",
      "source": ["google", "bing"],
      "position": 1
    }
  ]
}
```

The query is sent to the search backend as `?q=…&format=json&pageno=<page>`, `sources` as a
comma-separated `engines` parameter and `language` as the backend's own `language` parameter, and
the JSON it answers with is normalized into the fields above: backend internals, tracking fields
and duplicate URLs are dropped, and the list is capped at `limit`. Each value of `sources` is
trimmed and lower-cased, so a name taken from the sources endpoint passes as it is. **Omitting
`sources` (or sending an empty list) leaves the source choice to the backend**, and omitting
`language` uses its default.

A requested source that did not answer is never passed off as a search with no matches:

| Situation                                                 | Status | Code                 |
| --------------------------------------------------------- | ------ | -------------------- |
| The source exists but reported a failure (e.g. a CAPTCHA) | `503`  | `SEARCH_UNAVAILABLE` |
| No source by that name answered this instance             | `400`  | `INVALID_PARAMETER`  |

A query with no matches returns `"data": []` with status 200.

Pagination metadata is only reported when it is real: `page` and `limit` are always echoed
from the request, while `total` and `last` appear only when the search backend reports a result
count (engines do not always provide one, and the API never invents it).

### `GET /api/v1/website/search/sources`

Reports the website search sources this deployment currently offers — exactly the values the
`sources` field above accepts. The list is read from the search backend's own configuration, so
the API keeps no list of its own:

```bash
curl "http://localhost:3000/api/v1/website/search/sources"
```

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 12 },
  "data": [
    { "name": "bing", "enabled": true, "categories": ["general", "web"] },
    { "name": "duckduckgo", "enabled": true, "categories": ["general", "web"] },
    { "name": "google", "enabled": true, "categories": ["general", "web"] }
  ]
}
```

| Field        | Meaning                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `name`       | The source name `sources` accepts, normalized the way the backend names its engines (`google cse` → `google_cse`)          |
| `enabled`    | Always `true`: a disabled engine is not a source this API can offer, so it is never returned                              |
| `categories` | The backend categories the engine is registered under — general website/web search, and nothing besides                   |

**Only general web search engines are returned.** Eligibility is decided from each engine's own
metadata, never from its name or URL, so an engine is classified by what the backend says it is:

| Returned                                      | Excluded                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `["general"]`, `["web"]`, `["general","web"]` | `["images","web"]`, `["videos","web"]`, `["news"]`, `["general","translate"]`, any disabled engine |

An image, news, video, map, academic or file engine is therefore absent — **including when it also
lists a web category**. `google_cse_images` reports `["images","web"]`, so it is an image engine
and not a website search source. This endpoint is the discovery surface for website search, not a
dump of every engine the backend is configured with.

The list is sorted by name and is empty when the deployment serves no website search source at
all. Because the names come from the backend, a deployment that changes its engine configuration
gets the change here without a code change.

### `POST /api/v1/website/fetch`

Takes a JSON object as its body:

| Field          | Type    | Required | Default | Notes                                              |
| -------------- | ------- | -------- | ------- | -------------------------------------------------- |
| `url`          | string  | yes      | –       | Absolute `http`/`https` URL                        |
| `driver`       | enum    | no       | `fetch` | `fetch` (one HTTP request) or `browser` (Chromium) |
| `autoRedirect` | boolean | no       | `true`  | `false` reports a redirect instead of following it |

#### Request drivers

`driver` decides **how the HTML is obtained** and nothing else. Both choices run the same
extraction pipeline, so `title`, `metadata` (including JSON-LD), `links`, `images`, `videos`,
`audios` and the Markdown `content` come out identically — only the way the page is fetched
differs.

| `driver`  | How the page is fetched                                                                                                                                             | Use it when                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `fetch`   | One Axios request for the HTML document, with the configured timeout. No Chromium is started and no asset is downloaded, because only the page itself is requested. | The page renders on the server. This is the default and the cheap path. |
| `browser` | The Puppeteer/Chromium implementation renders the page, JavaScript included, before the HTML is read.                                                               | The content only exists after client-side rendering.                    |

`fetch` is the default, so a body without `driver` behaves exactly like `"driver": "fetch"`.
An unknown value is refused by the schema with `400 VALIDATION_ERROR`, like any other invalid
field.

```bash
# Defaults to the fetch driver: no browser is started.
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com"}'
# Exactly the same request, spelled out.
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com","driver":"fetch"}'
# Renders with Chromium: for pages whose content only appears after JavaScript runs.
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com","driver":"browser"}'
curl -X POST "http://localhost:3000/api/v1/website/fetch" \
  -H "content-type: application/json" -d '{"url":"http://github.com","autoRedirect":false}'
```

`status` is the status the *site* answered with (not ours: extracting a 404 page is still a
successful extraction). Redirects are followed by default; with `autoRedirect=false` the
site's answer is reported as what it is, and the result describes only the redirect — there
is no page, so no page fields are sent:

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 121 },
  "data": {
    "url": "http://github.com/",
    "status": 301,
    "location": "https://github.com/"
  }
}
```

Only public destinations are read, whichever driver is used: the initial URL must be
`http`/`https`, and loopback, private, link-local, CGNAT and cloud-metadata addresses are
refused with `400 BLOCKED_URL` — **including when a redirect leads to one**, which is checked
after the driver has followed it.

By default the redirect is followed instead: `url` becomes the final URL and `status` its
status.

```json
{
  "ok": true,
  "status": 200,
  "code": "OK",
  "message": "Request completed successfully.",
  "meta": { "took": 1284 },
  "data": {
    "url": "https://example.com/article",
    "status": 200,
    "title": "Example Article",
    "metadata": {
      "description": "Article description",
      "keywords": ["example", "article"],
      "author": "John Doe",
      "canonical": "https://example.com/article",
      "language": "en",
      "robots": "index,follow",
      "og": {
        "title": "Example Article",
        "description": "Article description",
        "image": "https://example.com/image.jpg",
        "type": "article",
        "url": "https://example.com/article",
        "siteName": "Example"
      },
      "twitter": {
        "card": "summary_large_image",
        "title": "Example Article",
        "image": "https://example.com/image.jpg"
      },
      "jsonld": [
        {
          "@context": "https://schema.org",
          "@type": "Article",
          "headline": "Example article"
        }
      ]
    },
    "links": [
      { "url": "https://example.com/about", "text": "About", "type": "internal" },
      { "url": "https://github.com/example/project", "text": "GitHub", "type": "external" }
    ],
    "images": [
      { "url": "https://example.com/image.jpg", "alt": "Example image" }
    ],
    "videos": [
      { "url": "https://example.com/video.mp4", "type": "video/mp4" }
    ],
    "audios": [
      { "url": "https://example.com/audio.mp3", "type": "audio/mpeg" }
    ],
    "content": "# Example Article\n\nThis is the introduction.\n\n## Installation\n\nInstall Bun using:\n\n```bash\ncurl -fsSL https://bun.sh/install | bash\n```\n\n## Features\n\n- Fast startup\n- Native TypeScript support\n"
  }
}
```

`metadata` only contains the description/Open Graph/Twitter/JSON-LD fields that were found
on the page, and `url` is the final URL after any redirect that was followed (`location`
says where an unfollowed one pointed). `content` is Markdown: headings, lists, code fences,
quotes and tables are preserved; navigation, cookie banners, sidebars, footers, ads,
comments and invisible elements are removed (invisibility is decided by the browser on the
rendered page, not guessed from class names). Very long pages are truncated with a
`[content truncated]` marker.

`links`, `images`, `videos` and `audios` sit next to `metadata`, not inside it. On a page
result they are always present, as `[]` when the page references none, so a client never has
to test for them (a reported redirect carries no page fields at all). They are read from the
rendered HTML only — nothing is downloaded:

| Field    | Source                            | Notes                                                                                                                                                                                       |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `links`  | `a[href]`                         | `type` is `internal` when the hostname matches the page's. `javascript:`, `mailto:`, `tel:`, `data:` and `#fragment` targets are skipped; relative URLs are resolved against the final URL. |
| `images` | `img`                             | Relative URLs resolved, `alt` is `""` when absent, `data:` URLs skipped. `data-src`, `data-lazy-src` and `data-original` are used when `src` is missing or is a placeholder.                |
| `videos` | `video[src]`, `video source[src]` | `type` only when the tag declares one.                                                                                                                                                      |
| `audios` | `audio[src]`, `audio source[src]` | Same as `videos`.                                                                                                                                                                           |

`metadata.jsonld` holds the parsed `script[type="application/ld+json"]` blocks in document
order — a block whose JSON is an array stays an array. A malformed block is dropped instead
of failing the request.

### Errors

Failures use the same envelope with `ok: false`:

```json
{
  "ok": false,
  "status": 400,
  "code": "INVALID_URL",
  "message": "The provided URL is invalid.",
  "meta": { "took": 2 },
  "data": null
}
```

A request refused by a route's schema is the one failure that carries a payload: `data` holds
Fastest Validator's own error objects, untransformed. Every other failure answers with
`data: null`.

```json
{
  "ok": false,
  "status": 400,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed.",
  "meta": { "took": 2 },
  "data": [
    { "type": "required", "message": "The 'q' field is required.", "field": "q" }
  ]
}
```

| Status | Codes                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR` (a route's schema refused the body), `INVALID_URL`, `UNSUPPORTED_PROTOCOL`, `INVALID_PARAMETER`, `INVALID_BODY`, `BLOCKED_URL` |
| `404`  | `NOT_FOUND`                                                                                                                                       |
| `502`  | `SEARCH_FAILED` (the search backend answered with something unusable), `PAGE_FETCH_FAILED`, `BROWSER_FAILED`                                    |
| `503`  | `SEARCH_UNAVAILABLE` (the search backend is not running or not reachable yet)                                                                    |
| `504`  | `TIMEOUT`                                                                                                                                         |
| `500`  | `INTERNAL_ERROR` — unexpected failure, details stay in the server log                                                                             |

## API documentation (Swagger UI)

The OpenAPI document and its Swagger UI are **opt-in and off by default**: the API is
completely unchanged — same routes, same behaviour, no extra middleware in the request
path — until they are explicitly enabled.

```bash
SWAGGER_ENABLED=true bun run dev
```

With `SWAGGER_ENABLED=true`:

| Path                     | Serves                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `GET /docs`              | The Swagger UI for the endpoints above                             |
| `GET /docs/openapi.json` | The same OpenAPI 3 document as plain JSON, for clients and tooling |

The document is a full API reference: every operation carries a summary, a description of the
behaviour it actually has, its request schema with examples, its success example and only the
error responses it can really answer with. The operations are grouped under three described
tags — `Health`, `Website Search`, `Website Fetch` — and the shared structures are reusable
schemas rather than repeated inline: `ApiResponse`, `ApiError`, `ValidationErrorResponse`,
`Meta`, `SearchRequest`, `SearchResult`, `SearchSource`, `WebsiteFetchRequest`,
`ExtractionResult` and the page metadata schemas.

The request rules are read from the same constants (`MAX_PAGE`, `SOURCE_PATTERN`,
`MAX_RESULTS`) the validators are built from and the codes from the same `codes` map the
response middleware uses, so the document cannot state a bound or a code the API does not
enforce. The UI fetches `/docs/openapi.json` at runtime rather than having the document
embedded in the page.

The documented server URL is relative (`/api/v1`), so "Try it out" targets whatever origin
serves the page: a local run on port 3000 and a container behind a mapped port both work, and
no production host name is baked into the document.

With `SWAGGER_ENABLED=false` (the default), `/docs` is not registered at all and answers
with the API's usual `404 NOT_FOUND` envelope.

## MCP server

The same two capabilities are also served over the
[Model Context Protocol](https://modelcontextprotocol.io), so an MCP client — an agent, an
editor, a desktop assistant — can search the web and read pages without speaking HTTP to the
REST API.

MCP is **opt-in and off by default**, and it is a second interface to this application rather
than a second application: it runs inside the same Express process, on the same port, and its
tools call the same `Search` and `Page` instances the controllers call. There is no second
listener, no second port, and no MCP-specific copy of the search or extraction logic.

```bash
MCP_ENABLED=true bun run dev
```

| Path   | Serves                               |
| ------ | ------------------------------------ |
| `/mcp` | MCP over Streamable HTTP (stateless) |

Point an MCP client at the same origin the REST API is served from:

```json
{
  "mcpServers": {
    "web-io": { "url": "http://localhost:3000/mcp" }
  }
}
```

With `MCP_ENABLED=false`, or when the variable is missing or misspelled, `/mcp` is not
registered at all and answers with the API's usual `404 NOT_FOUND` envelope: the instance
behaves exactly as it did before MCP existed, and no MCP server or transport is ever created.

### Tools

Exactly two tools are exposed.

#### `website_search`

Searches the web for websites and web pages relevant to a query. It is the MCP form of
`POST /api/v1/website/search` and answers with the same search results — titles, URLs,
snippets and the search source that found each one. It returns search results, **not** the contents
of a page; use `website_fetch` afterwards to read one.

| Input      | Type     | Required | Default       | Notes                                                                                              |
| ---------- | -------- | -------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `q`        | string   | yes      | –             | The search query.                                                                                  |
| `page`     | integer  | no       | `1`           | Which page of results to ask the backend for (1–20).                                               |
| `limit`    | integer  | no       | `MAX_RESULTS` | Maximum number of results to return.                                                               |
| `sources`  | string[] | no       | –             | Restrict the search to these website search sources, named the way `/website/search/sources` reports them. |
| `language` | string   | no       | –             | Search language, e.g. `en` or `fa`.                                                                |

```json
{ "q": "bun javascript runtime", "limit": 5 }
```

#### `website_fetch`

Fetches one web page by URL and returns its extracted contents: the main article as Markdown
in `content`, the `title`, the page's metadata (description, author, canonical URL, language,
Open Graph, Twitter, JSON-LD) and the links, images, videos and audio it references. It is the
MCP form of `POST /api/v1/website/fetch`.

| Input    | Type   | Required | Default | Notes                                                            |
| -------- | ------ | -------- | ------- | ---------------------------------------------------------------- |
| `url`    | string | yes      | –       | Absolute `http`/`https` URL.                                     |
| `driver` | enum   | no       | `fetch` | `fetch` (one HTTP request) or `browser` (renders with Chromium). |

```json
{ "url": "https://example.com/article", "driver": "fetch" }
```

`fetch` is the fast default: one HTTP request, no browser. Use `browser` when the page's
content only exists after client-side JavaScript has run. As on the REST route, only public
`http`/`https` URLs are accepted — local and private destinations are refused before either
driver runs. The tool always follows redirects (there is no `autoRedirect` argument), so `url`
is the address that finally answered and `status` is what the site answered with.

The input schemas are built from the same constants as the REST routes (`MAX_PAGE`,
`SOURCE_PATTERN`, `MAX_RESULTS`), so both interfaces accept and reject the same arguments, and
`driver` keeps the same `fetch` default.

### MCP errors

A tool that fails answers with an MCP tool error (`isError: true`) carrying the error the
service raised — `SEARCH_UNAVAILABLE`, `PAGE_FETCH_FAILED`, `BLOCKED_URL`, `TIMEOUT`, and so
on. A failure is never returned as successful tool content, and the REST envelope is
unchanged.

MCP speaks JSON-RPC rather than the REST envelope, so `/mcp` is deliberately **not** part of
the OpenAPI document: an OpenAPI path describes a REST operation, and the MCP protocol is not
adequately represented by one.

## Response cache

All three cached endpoints (`/website/search`, `/website/search/sources` and `/website/fetch`)
are cached for two minutes, so a repeated request is answered without touching the search backend
or Chromium. A route opts in with one middleware and never learns which backend answers:

```ts
// routes.api.ts
router.post(
  "/website/search",
  middlewares.validate(schema),
  middlewares.cache({ ttl: 120 }),
  search,
);
```

`CACHE_DRIVER` selects the backend, and caching is off by default:

| `CACHE_DRIVER` | Backend                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `redis`        | Redis at `REDIS_URL`, shared between instances                           |
| `memory`       | a `Map` inside this process — process-local, not shared between replicas |
| `none`         | no caching at all; the default for a missing, empty or unknown value     |

- `ttl` is the entry's lifetime in **seconds**.
- Only `200` responses are cached; a `4xx` or `5xx` is always produced fresh and never
  stored.
- **Cache keys are built automatically from the request** — HTTP method, full path, and the
  request parameters (body, query and route params) with their object keys sorted, so the
  same input in a different order keys the same entry and a route never manages a key. For
  example: `cache:POST:/api/v1/website/search:{"limit":10,"page":1,"q":"bun"}`. An optional
  field sent as `null` keys the same as one left out, because both mean "nothing was chosen".
- **The cache never breaks the API.** With `redis`, an unreachable server — or a missing
  `REDIS_URL` — is logged and treated as a miss: the request is served normally, a failed
  write is ignored, and the connection is retried on the next request. With `memory` and
  `none`, Redis is never contacted at all.

What is stored is the finished response envelope exactly as it was sent, so a cache hit
returns the same `ok`/`status`/`code`/`message`/`meta`/`data` object without re-running the
controller.

## Docker

```bash
docker compose up --build
docker compose down
```

The image installs Debian's Chromium, points Puppeteer at it with
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, and runs the service as the non-root `bun` user
with `PUPPETEER_NO_SANDBOX=true`, which containerized Chromium requires. It is around
1.5 GB, because it contains a complete browser. Compose overrides `SEARXNG_URL` with the
`searxng` service name, runs a `redis:7-alpine` service for the response cache and selects it
with `CACHE_DRIVER=redis` and `REDIS_URL=redis://redis:6379`; set `CACHE_DRIVER=memory` or
`none` (and drop the `redis` service) for a stack without Redis. A `.env` file, if present, is
loaded for anything Compose does not set itself.

Build and run it manually if you prefer:

```bash
docker build -t web-io .
docker run --rm -p 3000:3000 -e PUPPETEER_NO_SANDBOX=true -e SEARXNG_URL=http://host.docker.internal:18080 web-io
```

## Kubernetes

```bash
kubectl apply -f k8s.yaml
```

This creates a two-replica Deployment and a ClusterIP Service on port 80 targeting 3000.
Push `web-io:latest` to a registry your cluster can reach, or set `image` to your tag. It
also creates a single-replica Redis Deployment and a ClusterIP Service named `redis` (same
`redis:7-alpine` image as Compose), selected with `CACHE_DRIVER=redis` and reached at
`redis://redis:6379`. To run without Redis, set `CACHE_DRIVER` to `memory` or `none` and
delete the Redis Deployment and Service.

SearXNG — the current search backend — is part of the manifest too: a single-replica Deployment
and a ClusterIP Service named `searxng`, reached at `http://searxng:8080` through `SEARXNG_URL`,
the same wiring as Compose. Its `settings.yml` is a ConfigMap (the tracked file, with `json` among
the enabled formats) mounted at `/etc/searxng/settings.yml`, and its `server.secret_key` comes from
the `searxng-secret` Secret, which overrides the placeholder in that file. Replace the placeholder
before applying, or overwrite the Secret afterwards:

```bash
kubectl create secret generic searxng-secret \
  --from-literal=SEARXNG_SECRET="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

To point the API at a search backend outside the cluster instead, change `SEARXNG_URL` and
delete the SearXNG Deployment, Service, ConfigMap and Secret.

## Project structure

```
src/
├── cache/           the response cache: one facade over Redis and in-process memory
│   ├── cache.ts         the get/set the cache middleware uses, and the request key
│   ├── redis.ts         the Redis backend
│   ├── memory.ts        the in-process backend
│   └── index.ts         the module's public exports
├── controllers/     plain handler functions: HTTP in, JSON out
│   ├── health.ts        GET /api/v1/health
│   ├── search.ts        POST /api/v1/website/search
│   ├── search-sources.ts GET /api/v1/website/search/sources
│   └── get.ts           POST /api/v1/website/fetch
├── services/        website search (over HTTP), browser + page extraction
│   ├── browser.ts
│   ├── search.ts
│   └── page.ts
├── middlewares/     route-level middleware, one file per concern
│   ├── cache.ts         stores and replays successful responses
│   └── validate.ts      compiles a fastest-validator schema into a middleware
├── helpers/         configuration, response middleware + codes, errors, URL/SSRF, cleaning
│   ├── config.ts
│   ├── content-cleaner.ts
│   ├── debug.ts
│   ├── error.ts
│   ├── markdown.ts
│   ├── response.ts      res.json wrapper, response codes and messages
│   └── url.ts
├── instance.ts      the shared service instances, created once
├── routes.api.ts    exports the router instance, mounted at /api/v1
├── routes.swagger.ts the OpenAPI document and the Swagger UI, mounted at /docs
├── routes.mcp.ts    the MCP server and its two tools, mounted at /mcp
├── server.ts        builds the Express app (does not listen)
└── index.ts         starts the app, handles graceful shutdown
tests/               mirrors src/, runs without network or browser
docs/architecture.md the request lifecycle, the extraction strategy and the design decisions
settings.yml         SearXNG configuration, mounted into the SearXNG container
Dockerfile           Bun + Chromium, production image
docker-compose.yml   the API, SearXNG and Redis, .env driven
k8s.yaml             Deployment + Services for the API and Redis
```

See [`docs/architecture.md`](docs/architecture.md) for the request lifecycle, the
content-cleaning strategy and the browser lifecycle.

## Limitations

- Search quality and availability belong to the search backend: which engines answer, how fast, and
  how well they behave is configured in its own `settings.yml` and can change
  without warning. Individual engines failing is normal — the backend returns the results the
  others produced.
- The search backend usually reports no result count, so `meta.total` and `meta.last` are often
  absent; `page` and `limit` are always present.
- Result `description` is whatever the engine returned, and is an empty string when the
  engine sent none.
- Extraction is heuristic. Pages built from deeply nested custom components may yield
  less content than a human sees, and JavaScript-rendered pages are only as complete as
  the page's own rendering within the configured timeout.
- Images are not part of `content`: alt text and figure captions are kept, the binary
  payload is not.
