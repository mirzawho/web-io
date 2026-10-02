import type { Request, Response } from "express";
import type { Browser, LaunchOptions, Page } from "puppeteer";

import type { ApiResult } from "../../src/helpers/response";
import type { BrowserLauncher } from "../../src/services/browser";

/**
 * Shared doubles for the tests. The suite never starts Chromium and never touches the
 * network: services are exercised against a fake browser that returns fixed HTML, and
 * handlers against a fake response that captures the result (or, with the middleware
 * installed, the envelope).
 */
export interface FakeResponse {
  res: Response;
  status: () => number;
  body: () => ApiResult | undefined;
}

export function createFakeResponse(): FakeResponse {
  const state: { status: number; body?: ApiResult } = { status: 200 };

  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: ApiResult) {
      state.body = payload;
      return res;
    },
  };

  return { res: res as unknown as Response, status: () => state.status, body: () => state.body };
}

export function createFakeRequest(body: Record<string, unknown> = {}, overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/api/v1/website/search",
    baseUrl: "",
    query: {},
    body,
    ...overrides,
  } as unknown as Request;
}

/** Replaces a method of a shared instance for one test; call the result to restore it. */
export function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
  const original = target[key];
  target[key] = value;

  return () => {
    target[key] = original;
  };
}

export interface FakePageOptions {
  html?: string;
  finalUrl?: string;
  /** Status the fake navigation answers with; null means it answers without a response. */
  status?: number | null;
  navigateError?: Error;
  /** What the page serves once a consent control has been clicked. */
  afterConsent?: { html: string; finalUrl: string };
}

export interface FakePage {
  page: Page;
  navigations: string[];
  cookies: Array<Record<string, unknown>>;
  /** The viewport, User-Agent and extra headers the browser service configured. */
  viewport: () => Record<string, number> | undefined;
  userAgents: string[];
  headers: Array<Record<string, string>>;
  /** Number of times the page was asked to inspect itself (e.g. the visibility pass). */
  evaluations: () => number;
  isClosed: () => boolean;
}

export function createFakePage(options: FakePageOptions = {}): FakePage {
  const navigations: string[] = [];
  const cookies: Array<Record<string, unknown>> = [];
  const state = { closed: false, evaluations: 0 };
  const current = { html: options.html ?? "<html><body></body></html>", finalUrl: options.finalUrl };
  const viewport: { current?: Record<string, number> } = {};
  const userAgents: string[] = [];
  const headers: Array<Record<string, string>> = [];

  const page = {
    setViewport: async (size: Record<string, number>) => {
      viewport.current = size;
    },
    setUserAgent: async (agent: string) => {
      userAgents.push(agent);
    },
    setExtraHTTPHeaders: async (extra: Record<string, string>) => {
      headers.push(extra);
    },
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    setRequestInterception: async () => undefined,
    setCookie: async (cookie: Record<string, unknown>) => {
      cookies.push(cookie);
    },
    on: () => page,
    evaluate: async () => {
      state.evaluations += 1;

      // Stands in for clicking a consent control: the page then serves what follows.
      if (options.afterConsent === undefined) return undefined;
      current.html = options.afterConsent.html;
      current.finalUrl = options.afterConsent.finalUrl;
      return true;
    },
    goto: async (url: string) => {
      navigations.push(url);
      if (options.navigateError !== undefined) throw options.navigateError;
      if (options.status === null) return null;
      return { status: () => options.status ?? 200 };
    },
    content: async () => current.html,
    url: () => current.finalUrl ?? navigations.at(-1) ?? "about:blank",
    waitForSelector: async () => null,
    waitForNetworkIdle: async () => undefined,
    close: async () => {
      state.closed = true;
    },
  };

  return {
    page: page as unknown as Page,
    navigations,
    cookies,
    viewport: () => viewport.current,
    userAgents,
    headers,
    evaluations: () => state.evaluations,
    isClosed: () => state.closed,
  };
}

export interface FakeBrowser {
  launcher: BrowserLauncher;
  /** Pages still to be handed out by newPage(), in order. */
  pending: FakePage[];
  /** The options each launch was called with, so config can be asserted. */
  options: () => LaunchOptions[];
  launches: () => number;
  isClosed: () => boolean;
  /** Simulates Chromium dying: the connection drops and listeners fire. */
  disconnect: () => void;
}

export function createFakeBrowser(pages: FakePage[] = [createFakePage()]): FakeBrowser {
  const state = { launches: 0, closed: false, connected: true };
  const options: LaunchOptions[] = [];
  const listeners: Array<() => void> = [];

  const browser = {
    get connected() {
      return state.connected;
    },
    newPage: async () => {
      const next = pages.shift();
      if (next === undefined) throw new Error("The fake browser handed out more pages than expected.");
      return next.page;
    },
    close: async () => {
      state.closed = true;
      state.connected = false;
    },
    on: (event: string, listener: () => void) => {
      if (event === "disconnected") listeners.push(listener);
      return browser;
    },
  };

  return {
    launcher: async (launchOptions) => {
      state.launches += 1;
      state.connected = true; // a freshly launched process is connected again
      options.push(launchOptions);
      return browser as unknown as Browser;
    },
    pending: pages,
    options: () => options,
    launches: () => state.launches,
    isClosed: () => state.closed,
    disconnect: () => {
      state.connected = false;
      for (const listener of listeners) listener();
    },
  };
}
