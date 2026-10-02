import axios from "axios";
import type { AxiosResponse } from "axios";
import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import { TimeoutError } from "puppeteer";

import type { Config } from "../helpers/config";
import { extractReadableContent } from "../helpers/content-cleaner";
import { AppError } from "../helpers/error";
import { codes } from "../helpers/response";
import { assertPublicUrl } from "../helpers/url";
import type { Browser } from "./browser";

export interface OpenGraphMetadata {
  title?: string;
  description?: string;
  image?: string;
  type?: string;
  url?: string;
  siteName?: string;
}

export interface TwitterMetadata {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
}

export interface PageLink {
  url: string;
  /** The visible link text, whitespace collapsed. */
  text: string;
  /** Internal when the link points at the page's own hostname. */
  type: "internal" | "external";
}

export interface PageImage {
  url: string;
  /** Empty string when the tag carries no alt attribute. */
  alt: string;
}

export interface PageMedia {
  url: string;
  /** Only set when the tag declared one. */
  type?: string;
}

export interface PageMetadata {
  description?: string;
  keywords?: string[];
  author?: string;
  canonical?: string;
  language?: string;
  robots?: string;
  og?: OpenGraphMetadata;
  twitter?: TwitterMetadata;
  /** Parsed application/ld+json blocks in document order; a block that is an array stays an array. */
  jsonld: unknown[];
}

/**
 * The answer for one URL. A page carries everything; a reported redirect carries only where
 * it points, because there is no page to describe - the rest is left out rather than sent
 * empty.
 */
export interface ExtractionResult {
  /** Final URL when a redirect was followed, otherwise the requested URL. */
  url: string;
  /** The status the site answered with; absent when Chromium reported none. */
  status?: number;
  /** Where the site points. Only set when a redirect is reported instead of followed. */
  location?: string;
  title?: string;
  metadata?: PageMetadata;
  /** What the page references, resolved against `url`; nothing is downloaded. */
  links?: PageLink[];
  images?: PageImage[];
  videos?: PageMedia[];
  audios?: PageMedia[];
  /** Markdown-like text, never HTML. */
  content?: string;
}

/**
 * How the page's HTML is obtained. `fetch` makes one Axios request and never starts Chromium;
 * `browser` renders the page with Puppeteer, which is the only way to see content that appears
 * after JavaScript has run. `fetch` is the default because most pages do not need a browser.
 */
export type Driver = "fetch" | "browser";

export interface ExtractOptions {
  /** Follow redirects instead of reporting them. On by default. */
  autoRedirect?: boolean;
  /** How the HTML is obtained. `fetch` by default. */
  driver?: Driver;
}

/** What either driver hands back: the HTML, and where it really came from after redirects. */
interface FetchedPage {
  html: string;
  finalUrl: string;
  status?: number;
}

/**
 * Gets a page's HTML - with one HTTP request or with Chromium - and then reads it the same way
 * either time: metadata first, then the main content, converted to Markdown for direct
 * consumption by an LLM.
 */
export class Page {
  constructor(
    private readonly browser: Browser,
    private readonly config: Config,
  ) {}

  async extract(url: URL, options: ExtractOptions = {}): Promise<ExtractionResult> {
    // Cheap SSRF guard: refuse private destinations before any driver makes a request.
    await assertPublicUrl(url);

    // Redirects are followed by default. With autoRedirect=false a redirect is the answer
    // rather than a detour: one cheap probe decides that before any driver work, so nothing
    // is followed and nothing is rendered.
    if (options.autoRedirect === false) {
      const redirect = await this.probeRedirect(url);
      if (redirect !== undefined) return redirect;
    }

    const { html, finalUrl, status } = await this.fetchPage(url, options.driver ?? "fetch");

    // A redirect can point back into the private network the caller cannot reach, and both
    // drivers follow redirects, so the URL that really answered is checked before its HTML
    // is read. Guarded by the scheme because a driver may report a non-web URL (about:blank).
    if (/^https?:/i.test(finalUrl)) await assertPublicUrl(new URL(finalUrl));

    const $ = load(html);

    // Metadata is read before the content is cleaned: noise removal deletes nodes that
    // may still hold the best title or description. The asset lists are read from the very
    // same untouched document.
    const title = extractTitle($);
    const metadata = extractMetadata($, finalUrl);
    const body = extractReadableContent($, { baseUrl: finalUrl });

    return {
      url: finalUrl,
      status,
      title,
      metadata,
      links: extractLinks($, finalUrl),
      images: extractImages($, finalUrl),
      videos: extractMedia($, finalUrl, "video"),
      audios: extractMedia($, finalUrl, "audio"),
      content: composeContent(title, body, this.config.extract.maxContentLength),
    };
  }

  /**
   * Asks the site once, without letting the request follow a redirect. A redirect is reported
   * as what it is - status and location, no page fields - and anything else is cancelled so
   * the real render happens as usual. The body is dropped as soon as the headers are in, so a
   * page that is not a redirect costs one round-trip and no download.
   */
  private async probeRedirect(url: URL): Promise<ExtractionResult | undefined> {
    let probe: Response;
    try {
      probe = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.extract.timeout),
      });
    } catch {
      // Unreachable hosts are reported by the render, which knows how to explain them.
      return undefined;
    }

    const location = probe.headers.get("location");
    if (probe.status < 300 || probe.status >= 400 || location === null) {
      await probe.body?.cancel();
      return undefined;
    }

    await probe.body?.cancel();
    return { url: url.toString(), status: probe.status, location };
  }

  /**
   * The driver decides only how the HTML is obtained; parsing, cleaning and Markdown below are
   * shared, so a page reads the same whichever way it was fetched.
   */
  private async fetchPage(url: URL, driver: Driver): Promise<FetchedPage> {
    return driver === "browser" ? this.renderWithBrowser(url) : this.fetchWithAxios(url);
  }

  /**
   * One request for the HTML document itself: Axios fetches nothing else, so no image, video or
   * audio is downloaded, and Chromium is never started. Redirects are followed, and the site's
   * own status is reported rather than thrown, so extracting a 404 page stays a successful
   * extraction - exactly what the browser driver does.
   */
  private async fetchWithAxios(url: URL): Promise<FetchedPage> {
    try {
      const response = await axios.get<string>(url.toString(), {
        timeout: this.config.extract.timeout,
        responseType: "text",
        // Every status is a page worth reading: a 404 or a 500 is still content.
        validateStatus: () => true,
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": this.config.google.locale },
      });

      return { html: response.data, finalUrl: finalUrlOf(response, url), status: response.status };
    } catch (error) {
      throw fetchFailure(error);
    }
  }

  private async renderWithBrowser(url: URL): Promise<FetchedPage> {
    return this.browser.withPage({ blockAssets: true }, async (page) => {
      // page.goto() answers with the main resource response, which is null for a navigation
      // that only redirects, so the status is read from the navigation responses themselves.
      let status: number | undefined;
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.status() > 0) status = response.status();
      });

      try {
        const response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: this.config.extract.timeout,
        });
        status = response?.status() ?? status;
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new AppError(504, codes.TIMEOUT, error);
        }
        throw new AppError(502, codes.PAGE_FETCH_FAILED, error);
      }

      // Give client-side rendering a bounded chance to settle. Waiting for the network
      // to go idle unconditionally would stall on pages that poll or stream forever.
      await page
        .waitForNetworkIdle({ idleTime: 500, timeout: Math.min(3_000, this.config.extract.timeout) })
        .catch(() => undefined);

      // Invisibility cannot be read from the markup: a "hidden" class may be overridden
      // by a responsive rule, and "overflow-hidden" is not hidden at all. So the browser
      // decides, once, and marks what the cleaner should drop.
      await page.evaluate(markHiddenElements).catch(() => undefined);

      const finalUrl = page.url();

      return { html: await page.content(), finalUrl, status };
    });
  }
}

/**
 * Where the response really came from after redirects: the Node adapter leaves the final URL on
 * the response it read. Falls back to the requested URL when it is not available.
 */
function finalUrlOf(response: AxiosResponse<string>, requested: URL): string {
  const received = (response.request as { res?: { responseUrl?: unknown } } | undefined)?.res?.responseUrl;

  return typeof received === "string" && received !== "" ? received : requested.toString();
}

/**
 * Axios reports an elapsed timeout as ECONNABORTED and everything else - a refused connection,
 * a DNS failure, a TLS error - with its own code. Only a request that never produced a response
 * can land here, so the status follows from the code alone. The original error stays attached
 * as the cause, which is where debug.txt reads the detail from.
 */
function fetchFailure(error: unknown): AppError {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const timedOut = code === "ECONNABORTED" || code === "ETIMEDOUT";

  return timedOut ? new AppError(504, codes.TIMEOUT, error) : new AppError(502, codes.PAGE_FETCH_FAILED, error);
}

// Runs inside the page: flags every element the browser does not paint, so the cleaner
// can drop it without guessing from class names. The action is not runnable in the
// service process, so the DOM globals it needs are declared here instead of pulling the
// whole DOM lib into a server-side build.
function markHiddenElements(): void {
  const browser = globalThis as unknown as {
    document: { querySelectorAll(selector: string): ArrayLike<{ setAttribute(name: string, value: string): void }> };
    getComputedStyle(element: unknown): { display: string; visibility: string };
  };

  for (const element of Array.from(browser.document.querySelectorAll("body *"))) {
    const style = browser.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      element.setAttribute("data-web-io-hidden", "");
    }
  }
}

function extractTitle($: CheerioAPI): string {  // Priority order: explicit social metadata, then the document title, then the
  // first heading - the latter being the most reliable on article pages that omit both.
  const candidates = [
    metaContent($, "property", "og:title"),
    metaContent($, "name", "twitter:title"),
    collapse($("title").first().text()),
    collapse($("h1").first().text()),
  ];

  return candidates.find((candidate) => candidate !== undefined && candidate !== "") ?? "";
}

function extractMetadata($: CheerioAPI, baseUrl: string): PageMetadata {
  const metadata: PageMetadata = { jsonld: [] };

  const description = metaContent($, "name", "description") ?? metaContent($, "property", "og:description");
  if (description !== undefined) metadata.description = description;

  const keywords = parseKeywords(metaContent($, "name", "keywords"));
  if (keywords.length > 0) metadata.keywords = keywords;

  const author = metaContent($, "name", "author") ?? metaContent($, "property", "article:author");
  if (author !== undefined) metadata.author = author;

  const canonical = absoluteUrl($("link[rel='canonical']").first().attr("href"), baseUrl);
  if (canonical !== undefined) metadata.canonical = canonical;

  const language = collapse($("html").attr("lang") ?? "") || metaContent($, "http-equiv", "content-language");
  if (language !== undefined && language !== "") metadata.language = language;

  const robots = metaContent($, "name", "robots");
  if (robots !== undefined) metadata.robots = robots;

  const og = compact({
    title: metaContent($, "property", "og:title"),
    description: metaContent($, "property", "og:description"),
    image: absoluteUrl(metaContent($, "property", "og:image"), baseUrl),
    type: metaContent($, "property", "og:type"),
    url: absoluteUrl(metaContent($, "property", "og:url"), baseUrl),
    siteName: metaContent($, "property", "og:site_name"),
  });
  if (og !== undefined) metadata.og = og;

  const twitter = compact({
    card: metaContent($, "name", "twitter:card"),
    title: metaContent($, "name", "twitter:title"),
    description: metaContent($, "name", "twitter:description"),
    image: absoluteUrl(metaContent($, "name", "twitter:image"), baseUrl),
  });
  if (twitter !== undefined) metadata.twitter = twitter;

  metadata.jsonld = extractJsonLd($);

  return metadata;
}

const JSON_LD_TYPE = "application/ld+json";

function extractJsonLd($: CheerioAPI): unknown[] {
  const blocks: unknown[] = [];

  $("script").each((_, element) => {
    const script = $(element);
    if ((script.attr("type") ?? "").trim().toLowerCase() !== JSON_LD_TYPE) return;

    const raw = script.text().trim();
    const parsed = raw === "" ? undefined : parseJson(raw);
    // A single malformed block is dropped: the page around it is still worth extracting.
    if (parsed !== undefined) blocks.push(parsed);
  });

  return blocks;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractLinks($: CheerioAPI, baseUrl: string): PageLink[] {
  const hostname = resolveUrl(baseUrl)?.hostname ?? "";
  const links: PageLink[] = [];

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = (anchor.attr("href") ?? "").trim();
    // An in-page fragment is not a link to somewhere else.
    if (href === "" || href.startsWith("#")) return;

    // Resolving also drops javascript:, mailto:, tel: and data:, which are not web URLs.
    const url = resolveUrl(href, baseUrl);
    if (url === undefined) return;

    links.push({
      url: url.toString(),
      text: collapse(anchor.text()),
      type: url.hostname === hostname ? "internal" : "external",
    });
  });

  return links;
}

const IMAGE_ATTRIBUTES = ["src", "data-src", "data-lazy-src", "data-original"];

// A src matching this is a stand-in rather than the image, so the lazy attribute is the real
// source. A pattern instead of a list of exact values, because placeholders are hand-rolled
// more often than not.
const PLACEHOLDER_SRC =
  /^(#|about:blank$)|^data:image\/|(?:placeholder|spacer|blank\.gif|1x1|pixel\.gif|transparent\.(?:gif|png))/i;

function extractImages($: CheerioAPI, baseUrl: string): PageImage[] {
  const images: PageImage[] = [];

  $("img").each((_, element) => {
    const image = $(element);
    const source =
      IMAGE_ATTRIBUTES.map((name) => (image.attr(name) ?? "").trim()).find(
        (value) => value !== "" && !PLACEHOLDER_SRC.test(value),
      ) ?? "";

    const url = source === "" ? undefined : absoluteUrl(source, baseUrl);
    if (url === undefined) return;

    images.push({ url, alt: collapse(image.attr("alt") ?? "") });
  });

  return images;
}

function extractMedia($: CheerioAPI, baseUrl: string, tagName: "video" | "audio"): PageMedia[] {
  const media: PageMedia[] = [];

  // A tag that only holds <source> children has no src of its own, so both levels are read.
  $(`${tagName}[src], ${tagName} source[src]`).each((_, element) => {
    const item = $(element);
    const source = (item.attr("src") ?? "").trim();
    const url = source === "" ? undefined : absoluteUrl(source, baseUrl);
    if (url === undefined) return;

    const type = collapse(item.attr("type") ?? "");
    media.push(type === "" ? { url } : { url, type });
  });

  return media;
}

function metaContent($: CheerioAPI, attribute: "name" | "property" | "http-equiv", value: string): string | undefined {
  const content = $(`meta[${attribute}="${value}"]`).first().attr("content");
  const text = content === undefined ? "" : collapse(content);
  return text === "" ? undefined : text;
}

function parseKeywords(value: string | undefined): string[] {
  if (value === undefined) return [];
  const keywords = value
    .split(",")
    .map((keyword) => collapse(keyword))
    .filter((keyword) => keyword !== "");
  return [...new Set(keywords)].slice(0, 20);
}

/** Resolves a raw URL against the page, or undefined when it is missing or not on the web. */
function resolveUrl(value: string | undefined, baseUrl?: string): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.trim(), baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  return resolveUrl(value, baseUrl)?.toString();
}

function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

function composeContent(title: string, body: string, maxLength: number): string {
  const heading = title === "" ? "" : `# ${title}`;

  // Article pages usually repeat their title as the first heading; do not print it twice.
  const content =
    heading !== "" && !body.startsWith(heading) ? (body === "" ? heading : `${heading}\n\n${body}`) : body;

  return truncate(content, maxLength);
}

function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  const cut = content.slice(0, maxLength);
  const boundary = cut.lastIndexOf("\n");
  return `${cut.slice(0, boundary > 0 ? boundary : maxLength)}\n\n[content truncated]`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
