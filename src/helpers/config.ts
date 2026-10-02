import pkg from "../../package.json";

// Every setting is read once, at import time, so a service instance can never see a
// half-changed environment. Bun loads .env itself; this module is the only place that reads
// the environment, so nothing else has to know that.
const toInt = (raw: string | undefined, fallback: number): number => {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * The one rule for every boolean setting. A missing or empty value keeps the fallback, the
 * four truthy spellings turn it on, and anything else is off - a misspelled optional flag
 * must leave the feature disabled rather than take the service down.
 */
export const toBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

/** The backends the response cache can run on. */
export type CacheDriver = "redis" | "memory" | "none";

/**
 * Only the three supported values select a driver: a missing, empty or misspelled
 * CACHE_DRIVER means the cache is off, because caching is an optimization and a typo in an
 * optional setting must never take the API down.
 */
export function toCacheDriver(raw: string | undefined): CacheDriver {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "redis") return "redis";
  if (value === "memory") return "memory";

  return "none";
}

// The Bun/Node versions are read through a record because only one of them is ever present;
// the declared type of `process.versions` cannot say that.
const versions = process.versions as Record<string, string | undefined>;

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: toInt(process.env.PORT, 3000),
  // The service's own version, read from package.json, and the runtime it is running on.
  // Both are runtime identity rather than environment settings, and are reported by /health.
  version: pkg.version,
  runtime: {
    name: versions.bun === undefined ? "node" : "bun",
    version: versions.bun ?? versions.node ?? "unknown",
  },
  // Appends failures to debug.txt instead of showing them over HTTP.
  debug: toBool(process.env.DEBUG, false),
  browser: {
    // GOOGLE_HEADLESS=false opens a visible window: the local debugging mode.
    headless: toBool(process.env.GOOGLE_HEADLESS, true),
    timeout: toInt(process.env.PUPPETEER_TIMEOUT, 30_000),
    // Chromium refuses to start with the sandbox enabled when running as root,
    // which is the default in most container images.
    noSandbox: toBool(process.env.PUPPETEER_NO_SANDBOX, false),
  },
  search: {
    // HTTP timeout for the search backend request.
    timeout: toInt(process.env.SEARCH_TIMEOUT, 30_000),
    maxResults: toInt(process.env.MAX_RESULTS, 10),
    // Search backend: localhost for a local run (the Compose host port), overridden with
    // the service name inside Docker. The current backend is SearXNG, hence the variable.
    url: process.env.SEARXNG_URL?.trim() || "http://localhost:18080",
  },
  google: {
    // Profile directory: keeps cookies, local storage and the consent choice between runs.
    profileDir: process.env.GOOGLE_PROFILE_DIR?.trim() || ".cache/google",
    // Sent as --lang and as Accept-Language, so the session keeps one stable language.
    locale: process.env.GOOGLE_LOCALE?.trim() || "en-US",
    // Empty means the browser's own User-Agent, which is the honest default.
    userAgent: process.env.GOOGLE_USER_AGENT?.trim() ?? "",
  },
  extract: {
    timeout: toInt(process.env.PAGE_LOAD_TIMEOUT, 30_000),
    maxContentLength: toInt(process.env.MAX_CONTENT_LENGTH, 120_000),
  },
  cache: {
    // CACHE_DRIVER: where successful responses are cached. "none" (the default) and any
    // unrecognised value disable caching entirely.
    driver: toCacheDriver(process.env.CACHE_DRIVER),
  },
  redis: {
    // Only read when CACHE_DRIVER=redis, e.g. redis://redis:6379 inside Docker. Empty
    // means there is nothing to connect to, which turns the cache off rather than failing.
    url: process.env.REDIS_URL?.trim() ?? "",
  },
  swagger: {
    // Serves the OpenAPI document and Swagger UI at /docs. Off by default: the docs are
    // a development aid, not part of the public API surface.
    enabled: toBool(process.env.SWAGGER_ENABLED, false),
  },
  mcp: {
    // Serves the MCP server at /mcp, on the same HTTP listener and over the same services
    // as the REST API. Off by default, and also off for any value that is not one of the
    // truthy spellings: MCP is a second interface to the same application, not something a
    // plain API deployment opts into by accident.
    enabled: toBool(process.env.MCP_ENABLED, false),
  },
};

export type Config = typeof config;
