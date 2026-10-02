import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";

export interface MarkdownOptions {
  /** Used to turn relative links into absolute ones. */
  baseUrl?: string;
}

// Tags that start a new markdown block. Everything else is inline content and is merged
// into the surrounding paragraph.
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "center",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
]);

const MAX_TABLE_ROWS = 80;
const MAX_TABLE_COLUMNS = 12;
const DUPLICATE_BLOCK_LENGTH = 40;

/**
 * Renders one element subtree as Markdown-like text. Structure is preserved (headings,
 * lists, code, quotes, tables) and HTML cannot survive the conversion, because only the
 * text of each node is emitted - never the node itself.
 */
export function renderMarkdown($: CheerioAPI, root: Element, options: MarkdownOptions = {}): string {
  return normalize(renderChildren($, root, options.baseUrl));
}

/** Collapses every run of whitespace into a single space and trims the result. */
export function collapseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderChildren($: CheerioAPI, element: Element, baseUrl?: string): string {
  const blocks: string[] = [];
  let inline = "";

  // Consecutive inline siblings belong to the same paragraph; only block-level nodes
  // start a new one. Without this split, a sentence containing a link would be broken
  // into three separate markdown blocks.
  const flushInline = (): void => {
    const text = collapseInline(inline);
    if (text !== "") blocks.push(text);
    inline = "";
  };

  for (const child of element.children) {
    if (isBlockNode(child)) {
      flushInline();
      const rendered = renderBlock($, child, baseUrl);
      if (rendered !== "") blocks.push(rendered);
    } else {
      inline += renderInline($, child, baseUrl);
    }
  }
  flushInline();

  return blocks.join("\n\n");
}

function isBlockNode(node: AnyNode): boolean {
  return "tagName" in node && BLOCK_TAGS.has(node.tagName.toLowerCase());
}

function renderBlock($: CheerioAPI, node: AnyNode, baseUrl?: string): string {
  if (!("tagName" in node)) return node.type === "text" ? collapseInline(node.data) : "";

  const tag = node.tagName.toLowerCase();

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = collapseInline(renderInline($, node, baseUrl));
      return text === "" ? "" : `${"#".repeat(Number(tag.slice(1)))} ${text}`;
    }
    case "pre":
      return renderCode($, node);
    case "blockquote": {
      const quoted = renderChildren($, node, baseUrl);
      return quoted === "" ? "" : quoted.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    }
    case "ul":
    case "ol":
      return renderList($, node, baseUrl, 0);
    case "table":
      return renderTable($, node, baseUrl);
    case "dl":
      return renderDefinitionList($, node, baseUrl);
    case "figcaption":
    case "caption": {
      const text = collapseInline(renderInline($, node, baseUrl));
      return text === "" ? "" : `*${text}*`;
    }
    case "hr":
      return "---";
    case "script":
    case "style":
    case "noscript":
    case "iframe":
    case "svg":
    case "canvas":
      return "";
    default:
      // Unknown tags are treated as containers when they behave like blocks and as inline
      // text otherwise, so custom elements do not lose their content.
      return BLOCK_TAGS.has(tag) ? renderChildren($, node, baseUrl) : collapseInline(renderInline($, node, baseUrl));
  }
}

function renderInline($: CheerioAPI, node: AnyNode, baseUrl?: string): string {
  if (node.type === "text") return collapseSpaces(node.data);
  if (!("tagName" in node)) return "";

  // Inline fragments are not trimmed here: a "<span> </span>" between two words is what
  // separates them, and trimming it would glue the words together.
  const inner = (): string => {
    const parts: string[] = [];
    for (const child of node.children) parts.push(renderInline($, child, baseUrl));
    return collapseSpaces(parts.join(""));
  };

  switch (node.tagName.toLowerCase()) {
    case "strong":
    case "b": {
      const text = collapseInline(inner());
      return text === "" ? "" : `**${text}**`;
    }
    case "em":
    case "i": {
      const text = collapseInline(inner());
      return text === "" ? "" : `*${text}*`;
    }
    case "del":
    case "s": {
      const text = collapseInline(inner());
      return text === "" ? "" : `~~${text}~~`;
    }
    case "code": {
      const text = collapseInline($(node).text());
      return text === "" ? "" : `\`${text}\``;
    }
    case "a": {
      const text = collapseInline(inner());
      const href = resolveLink(node.attribs["href"], baseUrl);
      if (text === "") return "";
      return href === undefined ? text : `[${text}](${href})`;
    }
    case "br":
      return "\n";
    case "img":
    case "picture":
    case "source":
    case "svg":
    case "input":
    case "button":
    case "script":
    case "style":
    case "noscript":
      return "";
    default:
      return inner();
  }
}

function renderCode($: CheerioAPI, pre: Element): string {
  const code = pre.children.find(
    (child): child is Element => "tagName" in child && child.tagName.toLowerCase() === "code",
  );
  const source = code ?? pre;
  const text = $(source)
    .text()
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "");

  if (text === "") return "";

  // A fence longer than the longest run inside the code keeps the block valid.
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${detectLanguage(source)}\n${text}\n${fence}`;
}

function detectLanguage(element: Element): string {
  const signature = `${element.attribs["class"] ?? ""} ${element.attribs["data-lang"] ?? ""}`;
  const match =
    /language-([\w+#-]+)/.exec(signature) ??
    /\blang-([\w+#-]+)/.exec(signature) ??
    /highlight-source-([\w+#-]+)/.exec(signature) ??
    /brush:\s*([\w+#-]+)/.exec(signature) ??
    /data-lang=["']?([\w+#-]+)/.exec(signature);

  return match?.[1] ?? "";
}

function renderList($: CheerioAPI, list: Element, baseUrl: string | undefined, depth: number): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const start = Number.parseInt(list.attribs["start"] ?? "1", 10);
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let position = Number.isFinite(start) ? start : 1;

  for (const child of list.children) {
    if (!("tagName" in child) || child.tagName.toLowerCase() !== "li") continue;

    const marker = ordered ? `${position}.` : "-";
    position += 1;

    const inlineParts: string[] = [];
    const nested: string[] = [];

    for (const item of child.children) {
      if ("tagName" in item && ["ul", "ol"].includes(item.tagName.toLowerCase())) {
        nested.push(renderList($, item, baseUrl, depth + 1));
      } else {
        inlineParts.push(renderInline($, item, baseUrl));
      }
    }

    const text = collapseInline(inlineParts.join(""));
    if (text !== "") lines.push(`${indent}${marker} ${text}`);
    if (nested.length > 0) lines.push(...nested);
  }

  return lines.join("\n");
}

function renderDefinitionList($: CheerioAPI, list: Element, baseUrl?: string): string {
  const lines: string[] = [];

  for (const child of list.children) {
    if (!("tagName" in child)) continue;

    const text = collapseInline(renderInline($, child, baseUrl));
    if (text === "") continue;

    if (child.tagName.toLowerCase() === "dt") lines.push(`**${text}**`);
    else lines.push(text);
  }

  return lines.join("\n\n");
}

function renderTable($: CheerioAPI, table: Element, baseUrl?: string): string {
  // Layout tables and infoboxes are full of empty cells; keeping only rows that carry
  // text removes the noise without losing any content.
  const rows = readTableRows($, table, baseUrl).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return "";

  const width = Math.min(Math.max(...rows.map((row) => row.length)), MAX_TABLE_COLUMNS);
  if (width === 0) return "";

  // GitHub-flavoured tables require a header row; when a table has no <th> the first row
  // is reused as the header instead of dropping the table entirely.
  const [header, ...body] = rows;
  if (header === undefined) return "";

  const render = (row: string[]): string => {
    const cells = row.slice(0, width).map(escapeCell);
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };

  return [
    render(header),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.slice(0, MAX_TABLE_ROWS).map(render),
  ].join("\n");
}

function readTableRows($: CheerioAPI, table: Element, baseUrl?: string): string[][] {
  const rows: string[][] = [];

  for (const row of table.children) {
    if (!("tagName" in row)) continue;

    const tag = row.tagName.toLowerCase();
    if (tag === "tr") {
      rows.push(readTableCells($, row, baseUrl));
      continue;
    }
    if (["thead", "tbody", "tfoot"].includes(tag)) rows.push(...readTableRows($, row, baseUrl));
  }

  return rows;
}

function readTableCells($: CheerioAPI, row: Element, baseUrl?: string): string[] {
  const cells: string[] = [];

  for (const cell of row.children) {
    if (!("tagName" in cell) || !["td", "th"].includes(cell.tagName.toLowerCase())) continue;

    cells.push(collapseInline(renderInline($, cell, baseUrl)));

    // Preserve the visual column layout of cells that span multiple columns.
    const span = Number.parseInt(cell.attribs["colspan"] ?? "1", 10);
    for (let index = 1; index < span && index < MAX_TABLE_COLUMNS; index += 1) cells.push("");
  }

  return cells;
}

function normalize(markdown: string): string {
  const blocks: string[][] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    // Code is kept verbatim: collapsing it would change the program it describes.
    if (inFence) {
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    current.push(line);
  }
  flush();

  const kept: string[] = [];
  const seen = new Set<string>();
  let previous = "";

  for (const block of blocks) {
    const isCode = /^\s*(```|~~~)/.test(block[0] ?? "");
    const lines = isCode ? block : block.filter((line, index) => line !== block[index - 1]);
    const text = lines.join("\n").trim();

    if (text === "") continue;
    // Separators survive because they mark document structure; every other block made
    // only of punctuation or symbols is noise.
    if (!isCode && text !== "---" && !/[\p{L}\p{N}]/u.test(text)) continue;
    if (text === previous) continue;
    if (text.length > DUPLICATE_BLOCK_LENGTH && seen.has(text)) continue;

    seen.add(text);
    previous = text;
    kept.push(text);
  }

  return kept.join("\n\n").trim();
}

function resolveLink(href: string | undefined, baseUrl: string | undefined): string | undefined {
  const value = href?.trim() ?? "";
  if (value === "" || value.startsWith("#")) return undefined;
  if (/^(javascript|data|mailto|tel|blob):/i.test(value)) return undefined;

  if (baseUrl === undefined) return value.startsWith("http") ? value : undefined;

  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|_ga$|fbclid$|gclid$|mc_cid$|mc_eid$|ref_src$)/.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/** Collapses whitespace but keeps the leading and trailing spaces that separate inline fragments. */
function collapseSpaces(value: string): string {
  return value
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n");
}

function collapseInline(value: string): string {
  return collapseSpaces(value).trim();
}
