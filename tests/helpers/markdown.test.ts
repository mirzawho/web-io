import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import { renderMarkdown } from "../../src/helpers/markdown";

const render = (body: string, baseUrl?: string): string => {
  const $ = load(`<html><body><div id="root">${body}</div></body></html>`);
  const root = $("#root").get(0);
  if (root === undefined) throw new Error("fixture has no root element");

  return renderMarkdown($, root, { baseUrl });
};

describe("renderMarkdown", () => {
  test("maps headings to their level", () => {
    expect(render("<h1>One</h1><h3>Three</h3>")).toBe("# One\n\n### Three");
  });

  test("merges inline siblings into one paragraph and keeps the separators", () => {
    expect(render('<p>Read the <a href="/docs">docs</a> <strong>carefully</strong> now.</p>', "https://example.com")).toBe(
      "Read the [docs](https://example.com/docs) **carefully** now.",
    );
  });

  test("keeps lists, including nesting and numbering", () => {
    expect(render("<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>")).toBe(
      "- One\n- Two\n  - Nested",
    );
    expect(render('<ol start="3"><li>Three</li><li>Four</li></ol>')).toBe("3. Three\n4. Four");
  });

  test("fences code with the language the markup exposes", () => {
    expect(render('<pre><code class="language-bash">bun upgrade</code></pre>')).toBe("```bash\nbun upgrade\n```");
    expect(render("<pre><code>plain</code></pre>")).toBe("```\nplain\n```");
    expect(render("<pre><code>a ``` b</code></pre>")).toBe("````\na ``` b\n````");
  });

  test("prefixes quotes and keeps them as one block", () => {
    expect(render("<blockquote><p>Ship small.</p></blockquote>")).toBe("> Ship small.");
  });

  test("renders tables with a header, padding spanned columns", () => {
    expect(
      render("<table><tr><th>A</th><th>B</th></tr><tr><td colspan=\"2\">both</td></tr></table>"),
    ).toBe("| A | B |\n| --- | --- |\n| both |  |");

    // No <th> anywhere: the first row is reused as the header instead of losing the table.
    expect(render("<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>")).toBe(
      "| x | y |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  test("renders definition lists", () => {
    expect(render("<dl><dt>Term</dt><dd>Meaning</dd></dl>")).toBe("**Term**\n\nMeaning");
  });

  test("drops images but keeps their block text", () => {
    expect(render('<p><img src="/photo.jpg" alt="A photo">Caption text here.</p>')).toBe("Caption text here.");
  });

  test("resolves links against the base url and strips tracking parameters", () => {
    expect(render('<a href="/docs?utm_source=x&page=2">Docs</a>', "https://example.com/article")).toBe(
      "[Docs](https://example.com/docs?page=2)",
    );
  });

  test("keeps the text of links that cannot be followed", () => {
    expect(render('<p>Try <a href="javascript:void(0)">this</a> and <a href="mailto:a@b.c">mail us</a>.</p>')).toBe(
      "Try this and mail us.",
    );
    expect(render('<a href="#section">Jump</a>')).toBe("Jump");
  });

  test("keeps line breaks inside a paragraph", () => {
    expect(render("<p>First<br>Second</p>")).toBe("First\nSecond");
  });

  test("drops html that carries no text", () => {
    expect(render('<p>Before</p><script>var a = 1;</script><p>After</p>')).toBe("Before\n\nAfter");
    expect(render("<svg><path d=\"M0 0\"></path></svg>")).toBe("");
  });

  test("normalises whitespace, repeated lines and repeated blocks", () => {
    const repeated = "A paragraph that is long enough to be treated as boilerplate.";
    const markdown = render(
      `<p>${repeated}</p><p>${repeated}</p><ul><li>Same</li><li>Same</li></ul><p><br><br></p><p>»</p>`,
    );

    expect(markdown).toBe(`${repeated}\n\n- Same`);
  });

  test("keeps code blocks byte for byte", () => {
    expect(render("<pre><code>const a = 1;\n\n\nconst b   = 2;</code></pre>")).toBe(
      "```\nconst a = 1;\n\n\nconst b   = 2;\n```",
    );
  });

  test("keeps horizontal rules", () => {
    expect(render("<p>Above</p><hr><p>Below</p>")).toBe("Above\n\n---\n\nBelow");
  });
});
