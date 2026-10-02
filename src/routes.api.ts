import { Router } from "express";

import { get } from "./controllers/get";
import { health } from "./controllers/health";
import { search } from "./controllers/search";
import { searchSources } from "./controllers/search-sources";
import { config } from "./helpers/config";
import middlewares from "./middlewares";

/** Mounted at /api/v1 by the Express app. */
export const router = Router();

// Search backends rarely answer with anything new that deep, and every page is a request.
// Both are exported only so the OpenAPI document (routes.swagger.ts) states the same bounds
// and pattern these schemas enforce instead of repeating them.
export const MAX_PAGE = 20;

// Source names are short lowercase words; anything else cannot name one.
export const SOURCE_PATTERN = /^[a-z0-9_.-]{1,50}$/;

// Health is the one domain that is not about searching anything, so it stays at the top level
// next to the grouped ones: /health answers as soon as the process is up, and reports what it
// is running on.
router.get("/health", health);

// Endpoints are grouped by domain under their own prefix: everything that searches or reads
// the open web lives under /website, so a later domain (/news, /images, /maps) is added the
// same way, beside it, without touching these routes.
//
// The schema is the single source of truth for what a route accepts, and it runs before the
// cache so a body it refuses never costs a Redis round-trip. Its sanitizers and defaults write
// back into `req.body`, so the controller reads a trimmed `q`, lower-cased `sources`, a trimmed
// `language` and the filled-in `page`/`limit` without checking or defaulting anything itself.
router.post(
  "/website/search",
  middlewares.validate({
    q: { type: "string", min: 1, trim: true },
    page: { type: "number", integer: true, min: 1, max: MAX_PAGE, optional: true, default: 1 },
    limit: {
      type: "number",
      integer: true,
      min: 1,
      max: config.search.maxResults,
      optional: true,
      default: config.search.maxResults,
    },
    // Empty and absent both mean "let the search backend choose", and each name is normalized
    // the way the backend names its sources, so a value from /website/search/sources passes as
    // it is.
    sources: {
      type: "array",
      items: { type: "string", pattern: SOURCE_PATTERN, trim: true, lowercase: true },
      optional: true,
    },
    language: { type: "string", optional: true, trim: true },
  }),
  middlewares.cache({ ttl: 120 }),
  search,
);

// The website search sources this instance offers, read from the search backend. A literal
// path with no parameter, so it can never be read as a search whose `sources` came from the
// URL.
router.get("/website/search/sources", middlewares.cache({ ttl: 120 }), searchSources);

// The public name is /website/fetch; the controller stays `get` because what it does is
// fetch (and read) one page.
router.post(
  "/website/fetch",
  middlewares.validate({
    // Trimmed like every other string field, so surrounding whitespace is not what a request
    // fails on; what is left has to be non-empty. The scheme and the address rules are the
    // domain's own and stay in helpers/url.ts and the service.
    url: { type: "string", min: 1, trim: true },
    // `fetch` is one Axios request and never starts Chromium; `browser` renders with Puppeteer.
    // The default is `fetch`, so omitting the field is the same as asking for it.
    driver: { type: "enum", values: ["fetch", "browser"], optional: true, default: "fetch" },
    autoRedirect: { type: "boolean", optional: true, default: true },
  }),
  middlewares.cache({ ttl: 120 }),
  get,
);
