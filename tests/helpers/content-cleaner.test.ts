import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import { extractReadableContent } from "../../src/helpers/content-cleaner";

const BASE_URL = "https://example.com/blog/bun";

const ARTICLE_PAGE = `<!doctype html>
<html lang="en">
<head><style>body{color:red}</style></head>
<body>
  <header class="site-header"><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>
  <div class="cookie-banner">We use cookies to improve your experience.</div>
  <aside class="sidebar"><a href="/spam">Buy our stuff now</a></aside>
  <main>
    <article class="post-content">
      <h1>Bun in production</h1>
      <p>Bun is a JavaScript runtime that ships with a bundler, a test runner and a package manager, which makes it a complete toolchain for small services like this one.</p>
      <h2>Installation</h2>
      <pre><code class="language-bash">curl -fsSL https://bun.sh/install | bash</code></pre>
      <ul>
        <li>Fast startup</li>
        <li>Native TypeScript support
          <ul><li>No build step</li></ul>
        </li>
      </ul>
      <ol><li>Install Bun</li><li>Run the service</li></ol>
      <blockquote><p>Ship small, ship often.</p></blockquote>
      <table>
        <thead><tr><th>Flag</th><th>Meaning</th></tr></thead>
        <tbody><tr><td><code>--watch</code></td><td>Restarts on change</td></tr></tbody>
      </table>
      <p>Read the <a href="/docs?utm_source=newsletter&page=2">documentation</a> for the remaining <strong>details</strong> of the deployment story.</p>
      <p>Read the <a href="/docs?utm_source=newsletter&page=2">documentation</a> for the remaining <strong>details</strong> of the deployment story.</p>
      <p><a href="javascript:void(0)">Toggle</a> the menu, or <a href="#top">jump to the top</a> when you are done reading this section.</p>
      <p><a href="/icons/edit"><img src="/icons/edit.svg" alt=""></a></p>
      <div style="display:none">Hidden tracking pixel text that nobody should read.</div>
    </article>
  </main>
  <div class="comments"><p>First! Great article, thanks for writing it all up for us.</p></div>
  <footer><p>Copyright Example Ltd</p></footer>
  <script>window.analytics = { track() {} };</script>
</body>
</html>`;

describe("extractReadableContent", () => {
  test("returns the article as markdown structure", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });

    expect(content.startsWith("# Bun in production")).toBe(true);
    expect(content).toContain("## Installation");
    expect(content).toContain("```bash\ncurl -fsSL https://bun.sh/install | bash\n```");
    expect(content).toContain("- Fast startup");
    expect(content).toContain("- Native TypeScript support");
    expect(content).toContain("  - No build step");
    expect(content).toContain("1. Install Bun");
    expect(content).toContain("2. Run the service");
    expect(content).toContain("> Ship small, ship often.");
    expect(content).toContain("**details**");
  });

  test("never returns html", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });

    expect(content).not.toContain("<p>");
    expect(content).not.toContain("<div");
    expect(content).not.toContain("</");
    expect(content).not.toContain("window.analytics");
    expect(content).not.toContain("body{color:red}");
  });

  test("removes navigation, cookie banners, sidebars, comments and hidden content", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });

    expect(content).not.toContain("Home");
    expect(content).not.toContain("We use cookies");
    expect(content).not.toContain("Buy our stuff");
    expect(content).not.toContain("First! Great article");
    expect(content).not.toContain("Copyright Example");
    expect(content).not.toContain("Hidden tracking pixel");
  });

  test("resolves links, strips tracking parameters and drops unusable ones", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });

    expect(content).toContain("[documentation](https://example.com/docs?page=2)");
    expect(content).not.toContain("utm_source");
    expect(content).toContain("Toggle the menu");
    expect(content).not.toContain("javascript:void(0)");
    expect(content).not.toContain("#top");
  });

  test("renders tables with a header row", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });

    expect(content).toContain("| Flag | Meaning |");
    expect(content).toContain("| --- | --- |");
    expect(content).toContain("| `--watch` | Restarts on change |");
  });

  test("drops table rows that carry no text", () => {
    const $ = load(
      `<html><body><article><p>${"Filler text for the heuristic. ".repeat(12)}</p>
        <table><tr><th>Name</th><th>Value</th></tr><tr><td>Bun</td><td>1.4.2</td></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>
      </article></body></html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("| Name | Value |");
    expect(content).toContain("| Bun | 1.4.2 |");
    expect(content).not.toContain("|  |  |");
  });

  test("removes duplicated paragraphs and collapses whitespace", () => {
    const content = extractReadableContent(load(ARTICLE_PAGE), { baseUrl: BASE_URL });
    const occurrences = content.split("Read the [documentation]").length - 1;

    expect(occurrences).toBe(1);
    expect(content).not.toContain("\n\n\n");
    expect(content).not.toContain("  \n");
  });

  test("reduces any element to block level by dropping the inline markdown", () => {
    const $ = load(
      `<html><body><article><p>Some sufficiently long article body text that will be picked as the main content of this document by the heuristic.</p><p>More text so the container reaches the minimum content length that the heuristic requires to consider a candidate at all.</p><div>Plain <span>inline</span> <em>emphasis</em> text</div></article></body></html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("Plain inline *emphasis* text");
  });

  test("returns an empty string when the page has no usable content", () => {
    expect(extractReadableContent(load("<html><body><nav>menu</nav></body></html>"))).toBe("");
    expect(extractReadableContent(load("<html><body></body></html>"))).toBe("");
  });

  test("keeps the words separated when a page wraps every character in an element", () => {
    // example.com renders its text as one <span> per character, with the spaces in
    // their own element. Trimming those spans would glue every word together.
    const sentence = "This domain is for use in illustrative examples. ".repeat(6).trim();
    const characters = [...sentence]
      .map((character) => `<span>${character === " " ? " " : character}</span>`)
      .join("");
    const $ = load(`<html><body><article><p>${characters}</p></article></body></html>`);

    expect(extractReadableContent($)).toBe(sentence.replace(/\s+/g, " "));
  });

  test("drops content the browser marked as invisible", () => {
    const $ = load(
      `<html><body><article>
        <p data-web-io-hidden="">Navigation drawn on top of the page by a script should not be read.</p>
        <div>${"Visible article text that is long enough for the heuristic. ".repeat(4)}</div>
        <p data-web-io-hidden="">Neither should this hidden paragraph of the same article.</p>
      </article></body></html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("Visible article text");
    expect(content).not.toContain("Navigation drawn on top");
    expect(content).not.toContain("Neither should this hidden paragraph");
  });

  test("keeps article content inside a container whose class only looks hidden", () => {
    // "overflow-hidden" is a layout class, not an invisibility marker; dropping such
    // containers deletes real content.
    const $ = load(
      `<html><body><div class="prose"><h2>Upgrading</h2>
        <p>${"Bun can upgrade itself from the command line. ".repeat(6)}</p>
        <div class="group/fence relative my-5 overflow-hidden rounded-lg"><pre class="shiki"><code>bun upgrade</code></pre></div>
      </div></body></html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("## Upgrading");
    expect(content).toContain("```\nbun upgrade\n```");
  });

  test("removes heading permalink symbols", () => {
    const $ = load(
      `<html><body><article><h2>Installation<a href="#installation">#</a></h2>
        <p>${"Install the runtime and verify the version afterwards. ".repeat(6)}</p>
      </article></body></html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("## Installation");
    expect(content).not.toContain("Installation#");
    expect(content).not.toContain("#installation");
  });

  test("keeps the page when a noise pattern matches the document shell", () => {
    // Wikipedia ships <html class="… vector-feature-language-in-main-menu-disabled">.
    // Matching that would delete the whole document and return nothing at all.
    const $ = load(
      `<html class="vector-feature-language-in-main-menu-disabled skin-vector">
        <body class="skin-vector-2022">
          <article><h1>Bun</h1><p>${"Bun is a JavaScript runtime with a built-in bundler. ".repeat(6)}</p></article>
        </body>
      </html>`,
    );
    const content = extractReadableContent($);

    expect(content).toContain("# Bun");
    expect(content).toContain("built-in bundler");
  });

  test("does not empty the page when a noise pattern matches a wrapper", () => {
    // A single unlucky match must not be able to strip the article: the cleaner falls
    // back to the untouched document instead.
    const article = `<article class="post-content"><h1>Bun</h1><p>${"Text that has to survive a bad noise guess. ".repeat(20)}</p></article>`;
    const $ = load(`<html><body><div class="menu-wrapper">${article}</div></body></html>`);

    const content = extractReadableContent($);

    expect(content).toContain("# Bun");
    expect(content).toContain("Text that has to survive a bad noise guess");
  });

  test("keeps code blocks verbatim", () => {
    const $ = load(`<html><body><div><p>${"Filler text for the heuristic. ".repeat(10)}</p><pre><code>const a = 1;


const b   = 2;</code></pre></div></body></html>`);
    const content = extractReadableContent($);

    expect(content).toContain("const a = 1;\n\n\nconst b   = 2;");
  });
});
