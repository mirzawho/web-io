import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction } from "express";

import { search } from "../../src/controllers/search";
import { AppError } from "../../src/helpers/error";
import { codes } from "../../src/helpers/response";
import { searchService } from "../../src/instance";
import type { SearchOptions, SearchPage } from "../../src/services/search";
import { createFakeRequest, createFakeResponse, stub } from "../helpers/test-utils";

const RESULT: SearchPage = {
  results: [{ title: "Bun", url: "https://bun.sh/", description: "A JavaScript runtime.", position: 1 }],
  meta: { page: 1, limit: 10, total: 1, last: 1 },
};

const calls: Array<{ query: string; options?: SearchOptions }> = [];
let answer: () => Promise<SearchPage> = async () => RESULT;
let restore: () => void;

beforeEach(() => {
  calls.length = 0;
  answer = async () => RESULT;
  restore = stub(searchService, "search", async (query, options) => {
    calls.push({ query, options });
    return answer();
  });
});

afterEach(() => restore());

const forwarding = (): { next: NextFunction; error: () => unknown } => {
  let captured: unknown;
  return {
    next: ((error: unknown) => {
      captured = error;
    }) as NextFunction,
    error: () => captured,
  };
};

describe("search controller", () => {
  test("passes the validated fields to the service and wraps its result in the envelope", async () => {
    const { res, body } = createFakeResponse();

    await search(
      createFakeRequest({ q: "bun", page: 2, limit: 5, sources: ["google", "bing"], language: "en" }),
      res,
      forwarding().next,
    );

    expect(calls).toEqual([
      { query: "bun", options: { page: 2, limit: 5, sources: ["google", "bing"], language: "en" } },
    ]);
    expect(body()).toEqual({ status: 200, code: codes.OK, meta: RESULT.meta, data: RESULT.results });
  });

  test("leaves the optional fields to the service's own defaults", async () => {
    const { res } = createFakeResponse();

    await search(createFakeRequest({ q: "bun" }), res, forwarding().next);

    expect(calls).toEqual([
      {
        query: "bun",
        options: { page: undefined, limit: undefined, sources: undefined, language: undefined },
      },
    ]);
  });

  test("reads nulls as nothing chosen", async () => {
    const { res } = createFakeResponse();

    await search(createFakeRequest({ q: "bun", sources: null, language: null }), res, forwarding().next);

    expect(calls[0]?.options?.sources).toBeUndefined();
    expect(calls[0]?.options?.language).toBeUndefined();
  });

  test("does not validate: the route's schema is the only source of truth", async () => {
    // An empty query is not refused here — routes.api.ts refuses it before this function runs.
    const { res } = createFakeResponse();

    await search(createFakeRequest({ q: "" }), res, forwarding().next);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toBe("");
  });

  test("forwards a service failure to the error handler", async () => {
    answer = async () => {
      throw new AppError(502, codes.SEARCH_FAILED);
    };
    const forwarded = forwarding();

    await search(createFakeRequest({ q: "bun" }), createFakeResponse().res, forwarded.next);

    expect((forwarded.error() as AppError).code).toBe(codes.SEARCH_FAILED);
  });
});
