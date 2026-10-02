import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import axios from "axios";
import type { AxiosResponse } from "axios";
import { TimeoutError } from "puppeteer";

import { config } from "../../src/helpers/config";
import { AppError } from "../../src/helpers/error";
import { Browser } from "../../src/services/browser";
import { Page } from "../../src/services/page";
import { createFakeBrowser, createFakePage, stub } from "../helpers/test-utils";
import type { FakePage } from "../helpers/test-utils";

const testConfig = { ...config, extract: { ...config.extract, timeout: 1_000, maxContentLength: 120_000 } };

const PAGE_URL = "https://93.184.216.34/articles/bun-in-production";

const realFetch = globalThis.fetch;
let probes: URL[] = [];

/** Replaces the global fetch: the redirect probe must never reach the network in a test. */
const respondToProbe = (answer: (url: URL) => Response) => {
  globalThis.fetch = (async (input: URL | Request | string) => {
    const url = new URL(String(input));
    probes.push(url);
    return answer(url);
  }) as typeof fetch;
};

const redirectsTo = (location: string, status = 302) =>
  respondToProbe(() => new Response(null, { status, headers: { location } }));

beforeEach(() => {
  probes = [];
  respondToProbe(() => new Response("<html><body>not a redirect</body></html>", { status: 200 }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Bun in production | Example</title>
  <meta name="description" content="How to ship a Bun service to production">
  <meta name="keywords" content="bun, deployment, bun, production">
  <meta name="author" content="Jane Doe">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="/articles/bun-in-production">
  <meta property="og:title" content="Bun in production">
  <meta property="og:description" content="How to ship a Bun service to production">
  <meta property="og:image" content="/images/bun.png">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${PAGE_URL}">
  <meta property="og:site_name" content="Example">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Bun in production">
  <meta name="twitter:image" content="https://cdn.example.com/bun.png">
  <script>window.analytics = true;</script>
</head>
<body>
  <header class="site-header"><nav><a href="/">Home</a></nav></header>
  <div class="cookie-banner">We use cookies.</div>
  <aside class="sidebar"><a href="/spam">Buy our stuff</a></aside>
  <main>
    <article class="post-content">
      <h1>Bun in production</h1>
      <p>Bun is a JavaScript runtime with a built-in bundler and package manager, and it runs TypeScript without a build step, which is a good fit for a small service like this one.</p>
      <h2>Installation</h2>
      <pre><code class="language-bash">curl -fsSL https://bun.sh/install | bash</code></pre>
      <ul><li>Fast startup</li><li>Native TypeScript support</li></ul>
      <blockquote><p>Ship small.</p></blockquote>
      <p>Read the <a href="/docs">documentation</a> before you deploy this service to a real environment with traffic.</p>
    </article>
  </main>
  <footer><p>Copyright Example Ltd</p></footer>
  <div class="comments"><p>First! Great write-up.</p></div>
</body>
</html>`;

const PLAIN_PAGE_HTML = `<!doctype html>
<html><head><title>Plain page</title></head>
<body><h1>Plain page</h1><p>${"Plain body text that is long enough for the content heuristic to pick it up. ".repeat(4)}</p></body>
</html>`;

// The four asset lists sit next to `metadata` and are always present: empty when the page
// references nothing, so a client never has to test for them.
const NO_ASSETS = { links: [], images: [], videos: [], audios: [] };

const RICH_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Rich page</title>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Article","headline":"Rich page"}
  </script>
  <script type="APPLICATION/LD+JSON">[{"@type":"BreadcrumbList"},{"@type":"WebSite"}]</script>
  <script type="application/ld+json">{ "not": valid json }</script>
  <script type="application/ld+json"></script>
  <script>window.analytics = true;</script>
</head>
<body>
  <a href="/about">  About
    us </a>
  <a href="https://github.com/example/project">GitHub</a>
  <a href="mailto:hello@example.com">Mail</a>
  <a href="tel:+15550100">Call</a>
  <a href="javascript:void(0)">Menu</a>
  <a href="data:text/html,<h1>inline</h1>">Inline</a>
  <a href="#section">Section</a>
  <a href="">Empty</a>
  <a href="   ">Whitespace</a>
  <a href="http://">Broken</a>
  <img src="/images/hero.jpg" alt="Hero image">
  <img src="/images/no-alt.jpg">
  <img data-src="/images/lazy.jpg" alt="Lazy image">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-lazy-src="/images/real.jpg" alt="Placeholder image">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Inline spacer">
  <img alt="No source">
  <video src="/media/clip.mp4"></video>
  <video><source src="https://cdn.example.com/clip.webm" type="video/webm"></video>
  <audio src="/media/song.mp3"></audio>
  <audio><source src="https://cdn.example.com/song.ogg" type="audio/ogg"></audio>
</body>
</html>`;

const extract = (
  html: string,
  options: { finalUrl?: string; page?: FakePage; maxContentLength?: number; status?: number | null } = {},
) => {
  const page = options.page ?? createFakePage({ html, finalUrl: options.finalUrl ?? PAGE_URL, status: options.status });
  const harness = createFakeBrowser([page]);
  const service = new Page(
    new Browser(testConfig, harness.launcher),
    options.maxContentLength === undefined
      ? testConfig
      : { ...testConfig, extract: { ...testConfig.extract, maxContentLength: options.maxContentLength } },
  );
  return { service, page, harness };
};

describe("Page", () => {
  test("extracts title, metadata and markdown content", async () => {
    const { service, page } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(result.url).toBe(PAGE_URL);
    expect(result.title).toBe("Bun in production");
    expect(result.metadata).toEqual({
      description: "How to ship a Bun service to production",
      keywords: ["bun", "deployment", "production"],
      author: "Jane Doe",
      canonical: "https://93.184.216.34/articles/bun-in-production",
      language: "en",
      robots: "index,follow",
      og: {
        title: "Bun in production",
        description: "How to ship a Bun service to production",
        image: "https://93.184.216.34/images/bun.png",
        type: "article",
        url: PAGE_URL,
        siteName: "Example",
      },
      twitter: {
        card: "summary_large_image",
        title: "Bun in production",
        image: "https://cdn.example.com/bun.png",
      },
      jsonld: [],
    });

    expect(result.links).toEqual([
      { url: "https://93.184.216.34/", text: "Home", type: "internal" },
      { url: "https://93.184.216.34/spam", text: "Buy our stuff", type: "internal" },
      { url: "https://93.184.216.34/docs", text: "documentation", type: "internal" },
    ]);

    expect(page.isClosed()).toBe(true);
  });

  test("parses every json-ld block and drops the malformed one", async () => {
    const { service } = extract(RICH_HTML);

    const { metadata } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(metadata?.jsonld).toEqual([
      { "@context": "https://schema.org", "@type": "Article", headline: "Rich page" },
      // A block that is an array stays an array instead of being flattened into the list.
      [{ "@type": "BreadcrumbList" }, { "@type": "WebSite" }],
    ]);
    expect(JSON.stringify(metadata?.jsonld)).not.toContain("<script");
  });

  test("returns web links only, typed by the page's hostname", async () => {
    const { service } = extract(RICH_HTML);

    const { links } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(links).toEqual([
      { url: "https://93.184.216.34/about", text: "About us", type: "internal" },
      { url: "https://github.com/example/project", text: "GitHub", type: "external" },
    ]);
  });

  test("returns images with their alt text, preferring a lazy source over a placeholder", async () => {
    const { service } = extract(RICH_HTML);

    const { images } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(images).toEqual([
      { url: "https://93.184.216.34/images/hero.jpg", alt: "Hero image" },
      { url: "https://93.184.216.34/images/no-alt.jpg", alt: "" },
      { url: "https://93.184.216.34/images/lazy.jpg", alt: "Lazy image" },
      { url: "https://93.184.216.34/images/real.jpg", alt: "Placeholder image" },
    ]);
  });

  test("returns videos and audios from the tag and its sources", async () => {
    const { service } = extract(RICH_HTML);

    const { videos, audios } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(videos).toEqual([
      { url: "https://93.184.216.34/media/clip.mp4" },
      { url: "https://cdn.example.com/clip.webm", type: "video/webm" },
    ]);
    expect(audios).toEqual([
      { url: "https://93.184.216.34/media/song.mp3" },
      { url: "https://cdn.example.com/song.ogg", type: "audio/ogg" },
    ]);
  });

  test("ignores media that has no web source", async () => {
    const html = `<html><body>
      <video src="javascript:void(0)"></video>
      <video src="blob:https://93.184.216.34/9d1e"></video>
      <audio src=""></audio>
      <audio><source src="data:audio/mpeg;base64,AAAA" type="audio/mpeg"></audio>
    </body></html>`;
    const { service } = extract(html);

    const { videos, audios } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(videos).toEqual([]);
    expect(audios).toEqual([]);
  });

  test("reports the status the site answered with", async () => {
    const { service } = extract(ARTICLE_HTML, { status: 404 });

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(result.status).toBe(404);
    expect(result.title).toBe("Bun in production");
  });

  test("reports a redirect instead of following it", async () => {
    redirectsTo("https://93.184.216.34/moved");
    const { service, harness } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser", autoRedirect: false });

    expect(probes.map((url) => url.toString())).toEqual([PAGE_URL]);
    // A reported redirect describes where it points and nothing else: there is no page.
    expect(result).toEqual({ url: PAGE_URL, status: 302, location: "https://93.184.216.34/moved" });
    // The page was never opened: nothing was rendered and nothing was followed.
    expect(harness.launches()).toBe(0);
  });

  test("probes first and renders when there is nothing to follow", async () => {
    const { service, harness, page } = extract(ARTICLE_HTML, { status: 200 });

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser", autoRedirect: false });

    expect(probes).toHaveLength(1);
    expect(harness.launches()).toBe(1);
    expect(page.navigations).toEqual([PAGE_URL]);
    expect(result.status).toBe(200);
  });

  test("follows redirects without probing when autoRedirect is on", async () => {
    redirectsTo("https://93.184.216.34/moved");
    const { service, page } = extract(ARTICLE_HTML, { finalUrl: "https://93.184.216.34/moved" });

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser", autoRedirect: true });

    expect(probes).toEqual([]);
    expect(page.navigations).toEqual([PAGE_URL]);
    expect(result.url).toBe("https://93.184.216.34/moved");
  });

  test("still renders when the probe cannot reach the site", async () => {
    respondToProbe(() => {
      throw new TypeError("Unable to connect");
    });
    const { service, harness } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(harness.launches()).toBe(1);
    expect(result.title).toBe("Bun in production");
  });

  test("returns markdown, never html", async () => {
    const { service } = extract(ARTICLE_HTML);

    const { content } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(content).toContain("# Bun in production");
    expect(content).toContain("## Installation");
    expect(content).toContain("```bash\ncurl -fsSL https://bun.sh/install | bash\n```");
    expect(content).toContain("- Native TypeScript support");
    expect(content).toContain("> Ship small.");
    expect(content).toContain("[documentation](https://93.184.216.34/docs)");

    expect(content).not.toContain("<article");
    expect(content).not.toContain("<p>");
    expect(content).not.toContain("window.analytics");
    expect(content).not.toContain("We use cookies");
    expect(content).not.toContain("Buy our stuff");
    expect(content).not.toContain("First! Great write-up");
  });

  test("prints the title only once", async () => {
    const { service } = extract(ARTICLE_HTML);

    const { content = "" } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(content.split("# Bun in production").length - 1).toBe(1);
  });

  test("falls back to the document title and the final URL after a redirect", async () => {
    const finalUrl = "https://93.184.216.34/redirected/plain";
    const { service } = extract(PLAIN_PAGE_HTML, { finalUrl });

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(result.title).toBe("Plain page");
    expect(result.url).toBe(finalUrl);
    expect(result.metadata).toEqual({ jsonld: [] });
    expect(result).toMatchObject(NO_ASSETS);
    expect(result.content?.startsWith("# Plain page")).toBe(true);
  });

  test("truncates very long content", async () => {
    const { service } = extract(ARTICLE_HTML, { maxContentLength: 80 });

    const { content = "" } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(content.length).toBeLessThan(140);
    expect(content.endsWith("[content truncated]")).toBe(true);
  });

  test("asks the browser to mark invisible elements before reading the html", async () => {
    const { service, page } = extract(ARTICLE_HTML);

    await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(page.evaluations()).toBe(1);
  });

  test("ignores content the browser marked as invisible", async () => {
    const html = ARTICLE_HTML.replace(
      "<h2>Installation</h2>",
      `<h2>Installation</h2><div data-web-io-hidden="">A modal that the page never painted.</div>`,
    );
    const { service } = extract(html);

    const { content } = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(content).toContain("## Installation");
    expect(content).not.toContain("A modal that the page never painted");
  });

  test("refuses private destinations before the default driver runs", async () => {
    const { service, harness } = extract(ARTICLE_HTML);

    await expect(service.extract(new URL("http://127.0.0.1:8080/admin"))).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
    await expect(service.extract(new URL("http://localhost/"))).rejects.toMatchObject({ code: "BLOCKED_URL" });

    expect(harness.launches()).toBe(0);
  });

  test("refuses a redirect into the private network", async () => {
    const { service } = extract("", { page: createFakePage({ html: "", finalUrl: "http://169.254.169.254/meta-data" }) });

    await expect(service.extract(new URL(PAGE_URL), { driver: "browser" })).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  test("reports a navigation timeout as a gateway timeout", async () => {
    const { service, page } = extract("", {
      page: createFakePage({ navigateError: new TimeoutError("Navigation timeout") }),
    });

    await expect(service.extract(new URL(PAGE_URL), { driver: "browser" })).rejects.toMatchObject({ status: 504, code: "TIMEOUT" });
    expect(page.isClosed()).toBe(true);
  });

  test("reports any other navigation failure as a bad gateway", async () => {
    const { service } = extract("", { page: createFakePage({ navigateError: new Error("net::ERR_CONNECTION_REFUSED") }) });

    await expect(service.extract(new URL(PAGE_URL), { driver: "browser" })).rejects.toMatchObject({ status: 502, code: "PAGE_FETCH_FAILED" });
  });
});

describe("driver", () => {
  // Axios is replaced, never reached: the fetch driver must not touch the network in a test.
  let requests: string[] = [];
  let restores: Array<() => void> = [];

  const axiosReturns = (html: string, options: { status?: number; finalUrl?: string } = {}): void => {
    restores.push(
      stub(axios, "get", (async (url: string) => {
        requests.push(url);
        return {
          data: html,
          status: options.status ?? 200,
          request: { res: { responseUrl: options.finalUrl ?? url } },
        } as unknown as AxiosResponse<string>;
      }) as unknown as typeof axios.get),
    );
  };

  const axiosFails = (error: unknown): void => {
    restores.push(
      stub(axios, "get", (async () => {
        throw error;
      }) as unknown as typeof axios.get),
    );
  };

  beforeEach(() => {
    requests = [];
    restores = [];
  });

  afterEach(() => {
    for (const restore of restores) restore();
  });

  test("the default driver is fetch: one Axios request for the page and no Chromium", async () => {
    axiosReturns(ARTICLE_HTML);
    const { service, harness } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL));

    // Exactly one request, for the document itself: no image, video or audio is ever fetched.
    expect(requests).toEqual([PAGE_URL]);
    expect(harness.launches()).toBe(0);
    expect(result.url).toBe(PAGE_URL);
    expect(result.status).toBe(200);
    expect(result.title).toBe("Bun in production");
  });

  test("the browser driver renders with Puppeteer and never calls Axios", async () => {
    axiosReturns(ARTICLE_HTML);
    const { service, harness, page } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "browser" });

    expect(harness.launches()).toBe(1);
    expect(page.navigations).toEqual([PAGE_URL]);
    expect(requests).toEqual([]);
    expect(result.title).toBe("Bun in production");
  });

  test("both drivers run the same extraction pipeline over the same HTML", async () => {
    axiosReturns(ARTICLE_HTML);
    const viaFetch = extract(ARTICLE_HTML);
    const viaBrowser = extract(ARTICLE_HTML);

    const fetched = await viaFetch.service.extract(new URL(PAGE_URL), { driver: "fetch" });
    const rendered = await viaBrowser.service.extract(new URL(PAGE_URL), { driver: "browser" });

    // Title, metadata, json-ld, links, images, videos, audios and Markdown are identical: the
    // driver only decides how the HTML arrives.
    expect(fetched).toEqual(rendered);
    expect(fetched.metadata?.description).toBe("How to ship a Bun service to production");
    expect(fetched.content).toContain("## Installation");
    expect(viaFetch.harness.launches()).toBe(0);
    expect(viaBrowser.harness.launches()).toBe(1);
  });

  test("the fetch driver reports the site's status instead of throwing", async () => {
    axiosReturns(ARTICLE_HTML, { status: 404 });
    const { service } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "fetch" });

    expect(result.status).toBe(404);
    expect(result.title).toBe("Bun in production");
  });

  test("the fetch driver reports the final URL after a redirect", async () => {
    const finalUrl = "https://93.184.216.34/moved";
    axiosReturns(ARTICLE_HTML, { finalUrl });
    const { service } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "fetch" });

    expect(result.url).toBe(finalUrl);
  });

  test("the fetch driver still probes for a redirect first when autoRedirect is off", async () => {
    redirectsTo("https://93.184.216.34/moved");
    axiosReturns(ARTICLE_HTML);
    const { service } = extract(ARTICLE_HTML);

    const result = await service.extract(new URL(PAGE_URL), { driver: "fetch", autoRedirect: false });

    expect(result).toEqual({ url: PAGE_URL, status: 302, location: "https://93.184.216.34/moved" });
    expect(requests).toEqual([]);
  });

  test("the fetch driver refuses private destinations before Axios is called", async () => {
    axiosReturns(ARTICLE_HTML);
    const { service } = extract(ARTICLE_HTML);

    await expect(service.extract(new URL("http://127.0.0.1:8080/admin"))).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });

    expect(requests).toEqual([]);
  });

  test("the fetch driver refuses a redirect into the private network", async () => {
    // Axios follows redirects itself, so the URL that finally answered is the one that has
    // to be checked: a public host must not be able to hand back cloud metadata.
    axiosReturns(ARTICLE_HTML, { finalUrl: "http://169.254.169.254/latest/meta-data" });
    const { service } = extract(ARTICLE_HTML);

    await expect(service.extract(new URL(PAGE_URL), { driver: "fetch" })).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
  });

  test("an elapsed timeout becomes a gateway timeout", async () => {
    axiosFails({ code: "ECONNABORTED", message: "timeout of 1000ms exceeded" });
    const { service } = extract(ARTICLE_HTML);

    await expect(service.extract(new URL(PAGE_URL))).rejects.toMatchObject({ status: 504, code: "TIMEOUT" });
  });

  test("a network failure becomes a bad gateway and keeps the cause", async () => {
    const failure = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.invalid" };
    axiosFails(failure);
    const { service } = extract(ARTICLE_HTML);

    const error = await service.extract(new URL(PAGE_URL)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "PAGE_FETCH_FAILED" });
    // The Axios error travels as the cause, which is where debug.txt reads the detail from.
    expect((error as AppError).cause).toBe(failure);
  });
});
