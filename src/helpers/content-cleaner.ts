import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

import { collapseText, renderMarkdown } from "./markdown";

export interface CleanContentOptions {
  /** Used to turn relative links into absolute ones. */
  baseUrl?: string;
}

interface Candidate {
  element: Element;
  score: number;
  textLength: number;
}

// Elements that never contribute to the meaning of a page for a reader (human or LLM).
// Kept as selectors instead of imperative code so the rules stay auditable.
const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "form",
  "input",
  "select",
  "textarea",
  "button",
  "dialog",
  "nav",
  "footer",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='complementary']",
  "[role='search']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='form']",
  "[role='menu']",
  "[role='menubar']",
  "[role='tablist']",
  "[hidden]",
  "[aria-hidden='true']",
  "[aria-modal='true']",
  // Marked by the Page service once the browser has confirmed they are invisible.
  "[data-web-io-hidden]",
  "[style*='display:none']",
  "[style*='display: none']",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='consent']",
  "[id*='consent']",
  "[class*='gdpr']",
  "[class*='banner']",
  "[class*='advert']",
  "[id*='advert']",
  "[class*='ads-']",
  "[class^='ad-']",
  "[class*=' ad-']",
  "[id^='ad-']",
  "[data-ad]",
  "[data-ad-slot]",
  "[class*='sponsor']",
  "[class*='promo']",
  "[class*='newsletter']",
  "[class*='subscribe']",
  "[class*='signup']",
  "[class*='login']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='overlay']",
  "[class*='sidebar']",
  "[class*='widget']",
  "[class*='breadcrumb']",
  "[class*='pagination']",
  "[class*='social']",
  "[class*='share']",
  "[class*='comment']",
  "[class*='related']",
  "[class*='recommend']",
  "[class*='menu']",
  "[class*='navbar']",
  "[class*='site-nav']",
  "[class*='toolbar']",
  "[class*='skip-link']",
  "[class*='sr-only']",
  "[class*='visually-hidden']",
  "[class*='screen-reader']",
  "[class*='tracking']",
  "[class*='analytics']",
].join(",");

const CANDIDATE_SELECTORS = "article, main, [role='main'], section, div, td";

// Class/id names that usually mark the article body. Used as a small multiplier so that a
// well named container wins a close call against an anonymous wrapper.
const CONTENT_NAME_HINT = /(^|[-_ ])(article|content|entry|post|markdown|story|body|main|read)([-_ ]|$)/;

const MIN_CONTENT_LENGTH = 200;

// A page losing more than this share of its text means a noise guess was wrong.
const CONTENT_LOSS_RATIO = 0.1;
const CONTENT_LOSS_FLOOR = 500;

// Anchors that only carry a symbol - the "#" of a heading permalink, an arrow, a separator
// - add nothing to the text and would end up as markdown noise.
const SYMBOL_ONLY_ANCHOR = /^[\s#¶§↑↗→·•|/\\-]+$/u;

/**
 * Picks the meaningful content of a rendered document and returns it as Markdown-like
 * text. The work happens on a copy, because noise removal mutates the tree and the caller
 * still needs the original for metadata.
 */
export function extractReadableContent($: CheerioAPI, options: CleanContentOptions = {}): string {
  const html = $.html() ?? "";
  const document = load(html);

  const before = bodyTextLength(document);
  removeNoise(document);
  const after = bodyTextLength(document);

  // Class and id patterns are only guesses, and a single unlucky match can take the whole
  // page with it (Wikipedia's <html> carries a class ending in
  // "...-in-main-menu-disabled"). Losing that much text means the guess was wrong, so
  // rebuild from an untouched copy instead of returning almost nothing.
  if (before > CONTENT_LOSS_FLOOR && after < before * CONTENT_LOSS_RATIO) {
    return renderContent(load(html), options);
  }

  return renderContent(document, options);
}

function renderContent($: CheerioAPI, options: CleanContentOptions): string {
  const container = findMainContent($);
  if (container === null) return "";

  return renderMarkdown($, container, { baseUrl: options.baseUrl });
}

function bodyTextLength($: CheerioAPI): number {
  const body = $("body").first();
  if (body.length > 0) return collapseText(body.text()).length;

  return collapseText($.root().text()).length;
}

function removeNoise($: CheerioAPI): void {
  $(NOISE_SELECTORS).each((_, element) => {
    // Never remove the document shell: its class list describes the page, not a widget,
    // and dropping it deletes everything.
    if (!("tagName" in element) || element.tagName === "html" || element.tagName === "body") return;
    $(element).remove();
  });

  // A <header> without a heading is navigation chrome; one that has a heading may be the
  // article masthead, and dropping it would lose the title and byline.
  $("header").each((_, element) => {
    if ($(element).find("h1, h2, h3").length === 0) $(element).remove();
  });

  // Icon-only anchors carry no text and only add markdown noise.
  $("a").each((_, element) => {
    const anchor = $(element);
    const text = collapseText(anchor.text());
    if (text === "" || SYMBOL_ONLY_ANCHOR.test(text)) anchor.remove();
  });
}

function findMainContent($: CheerioAPI): Element | null {
  const candidates: Candidate[] = [];

  $(CANDIDATE_SELECTORS).each((_, element) => {
    const text = collapseText($(element).text());
    if (text.length < MIN_CONTENT_LENGTH) return;
    candidates.push({ element, score: scoreContent($, element, text), textLength: text.length });
  });

  if (candidates.length === 0) return $("body").get(0) ?? null;

  const best = candidates.reduce((left, right) => (right.score > left.score ? right : left));

  // Among near-equal candidates the tightest one wins: a wrapper that also holds the
  // sidebar or the comment thread scores slightly higher than the article inside it.
  return candidates
    .filter((candidate) => candidate.score >= best.score * 0.95)
    .reduce((left, right) => (right.textLength < left.textLength ? right : left)).element;
}

function scoreContent($: CheerioAPI, element: Element, text: string): number {
  const linkLength = collapseText($(element).find("a").text()).length;
  const linkDensity = Math.min(linkLength / text.length, 1);
  const paragraphs = $(element).find("p").length;
  const sentences = (text.match(/[.!?…。！？]/g) ?? []).length;

  const score = text.length * (1 - linkDensity) + paragraphs * 30 + Math.min(sentences, 200) * 3;

  const name = `${element.attribs["class"] ?? ""} ${element.attribs["id"] ?? ""}`.toLowerCase();
  return CONTENT_NAME_HINT.test(name) ? score * 1.15 : score;
}
