import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction } from "express";

import { searchSources } from "../../src/controllers/search-sources";
import { AppError } from "../../src/helpers/error";
import { codes } from "../../src/helpers/response";
import { searchService } from "../../src/instance";
import type { SearchSource } from "../../src/services/search";
import { createFakeRequest, createFakeResponse, stub } from "../helpers/test-utils";

const SOURCES: SearchSource[] = [
  { name: "bing", enabled: true, categories: ["general", "web"] },
  { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
];

let answer: () => Promise<SearchSource[]> = async () => SOURCES;
let calls = 0;
let restore: () => void;

beforeEach(() => {
  calls = 0;
  answer = async () => SOURCES;
  restore = stub(searchService, "sources", async () => {
    calls += 1;
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

describe("search-sources controller", () => {
  test("hands the sources the service found to the envelope", async () => {
    const { res, body } = createFakeResponse();

    await searchSources(createFakeRequest({}), res, forwarding().next);

    expect(calls).toBe(1);
    expect(body()).toEqual({ status: 200, code: codes.OK, data: SOURCES });
  });

  test("stops at the payload: the envelope belongs to responseMiddleware", async () => {
    const { res, body } = createFakeResponse();

    await searchSources(createFakeRequest({}), res, forwarding().next);

    expect(body()).not.toHaveProperty("ok");
    expect(body()).not.toHaveProperty("message");
  });

  test("does not keep a list of its own: whatever the service answers is what leaves", async () => {
    answer = async () => [{ name: "only-from-the-backend", enabled: true, categories: ["web"] }];
    const { res, body } = createFakeResponse();

    await searchSources(createFakeRequest({}), res, forwarding().next);

    expect(body()).toMatchObject({ data: [{ name: "only-from-the-backend" }] });
  });

  test("forwards a service failure to the error handler", async () => {
    answer = async () => {
      throw new AppError(503, codes.SEARCH_UNAVAILABLE);
    };
    const forwarded = forwarding();

    await searchSources(createFakeRequest({}), createFakeResponse().res, forwarded.next);

    expect(forwarded.error()).toBeInstanceOf(AppError);
    expect((forwarded.error() as AppError).code).toBe(codes.SEARCH_UNAVAILABLE);
  });
});
