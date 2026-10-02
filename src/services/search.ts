import type { Config } from "../helpers/config";
import { excerpt } from "../helpers/debug";
import { AppError } from "../helpers/error";
import { codes } from "../helpers/response";

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  /** The search engine(s) that found this result; absent when the backend reported none. */
  source?: string | string[];
  position: number;
}

export interface SearchOptions {
  page?: number;
  limit?: number;
  /**
   * Restricts the search to these search sources, named the way `Search.sources` reports them
   * (see `GET /website/search/sources`). Empty or omitted means the backend's own selection.
   */
  sources?: string[];
  /** The language to search in, e.g. "en" or "fa". Omitted means the backend's default. */
  language?: string;
}

/** What the caller gets back about the request itself, beyond the results. */
export interface SearchMeta {
  page: number;
  limit: number;
  /** Only when the search backend reports a count; engines do not always provide one. */
  total?: number;
  last?: number;
  /** Only when the search was restricted to specific sources. */
  sources?: string[];
  /** Only when a language was chosen. */
  language?: string;
}

/** One page of results: plain data, with no HTTP status or envelope attached. */
export interface SearchPage {
  results: SearchResult[];
  meta: SearchMeta;
}

/**
 * One search source: a general website/web search engine this instance serves, and the name
 * `sources` accepts for it.
 */
export interface SearchSource {
  name: string;
  /** Always `true`: a disabled engine is not a source this API can offer, so it is not here. */
  enabled: boolean;
  /**
   * The categories the backend registered the engine under. It is in this list because they
   * are general website/web search categories and nothing else.
   */
  categories: string[];
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  engines?: string[];
}

/** The part of SearXNG's JSON answer this service uses. */
interface SearxngResponse {
  results?: SearxngResult[];
  number_of_results?: number;
  unresponsive_engines?: unknown;
}

/** One entry of SearXNG's `/config` engine list, as far as this service reads it. */
interface SearxngEngine {
  name?: string;
  enabled?: boolean;
  categories?: string[];
}

/** The part of SearXNG's `/config` answer this service uses. */
interface SearxngConfig {
  engines?: SearxngEngine[];
}

/**
 * The backend categories that make an engine a general website/web search engine. SearXNG uses
 * `general` for the tab and `web` for the sub-category, so a pure web search engine carries
 * either or both - and nothing besides.
 */
const WEB_CATEGORIES = new Set(["general", "web"]);

/**
 * Search is the application's website-search capability: it takes a query and answers with
 * results. Behind it sits one HTTP request to the configured search backend - no browser and
 * no HTML parsing - so the service never learns how any engine works.
 *
 * The backend is SearXNG, which owns the search engines and their configuration. `sources()`
 * reads the engine list from it rather than from a list kept here, and reduces it to the
 * engines this API can actually search: general website/web search engines, enabled.
 */
export class Search {
  constructor(private readonly config: Config) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchPage> {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? this.config.search.maxResults, this.config.search.maxResults);
    const sources = normalizeSources(options.sources);
    const language = normalizeLanguage(options.language);
    const url = this.searchUrl(query, page, sources, language);

    const response = await this.request(url);
    const body = await this.readJson<SearxngResponse>(response, url);

    // The backend ignores source names it does not know and answers with its default set, so a
    // source that produced nothing has to be caught here instead of looking like a search that
    // simply had no matches.
    if (sources !== undefined) assertSourcesAnswered(sources, body, url);

    return {
      results: normalizeResults(body.results, limit),
      meta: metaOf(page, limit, sources, language, body.number_of_results),
    };
  }

  /**
   * The search sources a client may pass in `sources`, read from the backend's own `/config`.
   *
   * This is the public website-search source list, not the backend's whole engine list: only
   * enabled engines that are general website/web search engines are returned. A specialised
   * engine is never included, not even when it also lists a web category - the backend
   * registers an image engine as `["images","web"]`, and that is not a website search source.
   */
  async sources(): Promise<SearchSource[]> {
    const url = new URL("/config", this.config.search.url);

    const response = await this.request(url);
    const config = await this.readJson<SearxngConfig>(response, url);

    return (config.engines ?? [])
      .flatMap((engine) => {
        // The same normalization a result's engine gets, so a name taken from here can be
        // sent straight back in `sources`.
        const name = engineName(engine.name ?? "");
        const categories = normalizeCategories(engine.categories);

        if (name === "" || !isWebsiteSearchEngine(engine.enabled, categories)) return [];

        return [{ name, enabled: true, categories }];
      })
      .sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0));
  }

  private searchUrl(
    query: string,
    page: number,
    sources: string[] | undefined,
    language: string | undefined,
  ): URL {
    const url = new URL("/search", this.config.search.url);
    const params = new URLSearchParams({ q: query, format: "json", pageno: String(page) });
    // The backend takes the sources as one comma-separated list; leaving the parameter off is
    // what makes it choose its own sources.
    if (sources !== undefined) params.set("engines", sources.join(","));
    if (language !== undefined) params.set("language", language);

    url.search = params.toString();
    return url;
  }

  private async request(url: URL): Promise<Response> {
    try {
      return await fetch(url, {
        headers: { accept: "application/json", "accept-language": this.config.google.locale },
        signal: AbortSignal.timeout(this.config.search.timeout),
      });
    } catch (error) {
      // Either SearXNG is not reachable yet, or it did not answer in time.
      const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new AppError(
        timedOut ? 504 : 503,
        timedOut ? codes.TIMEOUT : codes.SEARCH_UNAVAILABLE,
        failureContext(url, undefined, timedOut ? "The request timed out." : describeError(error)),
      );
    }
  }

  /**
   * Reads the answer as JSON. The URL is the one that was asked for rather than the one the
   * response reports, because that is the endpoint a failure has to name in the debug log.
   */
  private async readJson<T>(response: Response, url: URL): Promise<T> {
    const text = await response.text();

    if (response.ok === false) {
      throw new AppError(
        response.status >= 500 ? 503 : 502,
        response.status >= 500 ? codes.SEARCH_UNAVAILABLE : codes.SEARCH_FAILED,
        failureContext(url, response.status, excerpt(text)),
      );
    }

    try {
      const body: unknown = JSON.parse(text);
      return (typeof body === "object" && body !== null ? body : {}) as T;
    } catch {
      throw new AppError(502, codes.SEARCH_FAILED, failureContext(url, response.status, excerpt(text)));
    }
  }
}

/**
 * Whether an engine is a general website/web search source this API can offer: enabled by the
 * backend, categorised, and categorised as nothing but general web search.
 *
 * Decided from the engine's own metadata and never from its name, so the rule holds for any
 * backend configuration: an engine this API does not search - images, news, videos, maps,
 * academic, files - carries a category outside `WEB_CATEGORIES` and is left out, even when it
 * also declares `web`.
 */
function isWebsiteSearchEngine(enabled: boolean | undefined, categories: string[]): boolean {
  return enabled === true && categories.length > 0 && categories.every((one) => WEB_CATEGORIES.has(one));
}

/** The engine's categories, cleaned the way the backend's own values should already be. */
function normalizeCategories(categories: string[] | undefined): string[] {
  return (categories ?? []).flatMap((category) => {
    const name = collapse(category).toLowerCase();
    return name === "" ? [] : [name];
  });
}

/**
 * Keeps the page and size that were asked for, echoes the sources and the language only when
 * they were chosen, and adds a total only when the backend reports one: engines answer with a
 * count often enough to be worth passing on, and never reliably enough to be invented.
 */
function metaOf(
  page: number,
  limit: number,
  sources: string[] | undefined,
  language: string | undefined,
  reported?: number,
): SearchMeta {
  const meta: SearchMeta = {
    page,
    limit,
    ...(sources === undefined ? {} : { sources }),
    ...(language === undefined ? {} : { language }),
  };

  if (reported !== undefined && reported > 0) {
    meta.total = reported;
    meta.last = Math.ceil(reported / limit);
  }

  return meta;
}

/** The sources to ask for, without blanks or repeats; none left means "let the backend choose". */
function normalizeSources(sources: string[] | undefined): string[] | undefined {
  const names = [...new Set((sources ?? []).filter((name) => name !== ""))];
  return names.length === 0 ? undefined : names;
}

/**
 * The language to ask for; a blank value means the same as omitting it, exactly as an empty
 * `sources` list means "no restriction".
 */
function normalizeLanguage(language: string | undefined): string | undefined {
  const value = (language ?? "").trim();
  return value === "" ? undefined : value;
}

/**
 * A source that produced nothing is either known to the backend but failing - it says so in
 * `unresponsive_engines` - or a name this instance does not serve at all. Neither is a search
 * that legitimately had no matches, so neither is answered as one, and every source the caller
 * asked for has to be accounted for.
 */
function assertSourcesAnswered(sources: string[], body: SearxngResponse, url: URL): void {
  const answered = new Set((body.results ?? []).flatMap((result) => {
    const names = sourcesOf(result);
    return names === undefined ? [] : [names].flat();
  }));

  for (const source of sources) {
    if (answered.has(source)) continue;

    const failure = failureReasonOf(body.unresponsive_engines, source);
    if (failure !== undefined) {
      throw new AppError(
        503,
        codes.SEARCH_UNAVAILABLE,
        failureContext(url, undefined, `The "${source}" engine did not answer: ${failure}`),
      );
    }

    throw new AppError(
      400,
      codes.INVALID_PARAMETER,
      failureContext(url, undefined, `No engine named "${source}" answered this instance.`),
    );
  }
}

/** Backend results mapped onto our own shape: no engine internals, no tracking fields. */
function normalizeResults(results: SearxngResponse["results"], limit: number): SearchResult[] {
  const seen = new Set<string>();

  return (results ?? [])
    .flatMap((result) => {
      const title = collapse(result.title);
      const url = collapse(result.url);
      if (title === "" || url === "" || seen.has(url)) return [];

      seen.add(url);

      const source = sourcesOf(result);
      return [{ title, url, description: collapse(result.content), ...(source === undefined ? {} : { source }) }];
    })
    .slice(0, limit)
    .map((result, index) => ({ ...result, position: index + 1 }));
}

/**
 * SearXNG reports the engines that found a result, both singular and merged. One name stays a
 * string, several become an array, and spaces become underscores so the value can be sent
 * straight back as a source (SearXNG's own key for "google cse" is "google_cse").
 */
function sourcesOf(result: SearxngResult): string | string[] | undefined {
  const names = [...new Set([...(result.engines ?? []), result.engine ?? ""].map(engineName).filter((name) => name !== ""))];
  return names.length > 1 ? names : names[0];
}

function engineName(name: string): string {
  return collapse(name).toLowerCase().replace(/\s+/g, "_");
}

/** SearXNG answers with [[engine, reason], …] for the engines that failed. */
function failureReasonOf(unresponsive: unknown, source: string): string | undefined {
  if (!Array.isArray(unresponsive)) return undefined;

  for (const entry of unresponsive) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    if (engineName(entry[0]) !== source) continue;

    const reason: unknown = entry[1];
    return Array.isArray(reason) ? reason.join(", ") : String(reason ?? "unknown error");
  }

  return undefined;
}

/** What the debug log shows when a search fails; never the query or the search backend alone. */
function failureContext(url: URL | string, status: number | undefined, detail: string) {
  return {
    kind: "context" as const,
    fields: {
      SEARCH_SERVICE: "searxng",
      SEARCH_URL: url.toString(),
      ...(status === undefined ? {} : { HTTP_STATUS: String(status) }),
      DETAIL: detail,
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function collapse(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
