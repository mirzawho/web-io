import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction } from "express";

import { get } from "../../src/controllers/get";
import { AppError } from "../../src/helpers/error";
import { codes, type Code } from "../../src/helpers/response";
import { page } from "../../src/instance";
import type { ExtractionResult, ExtractOptions } from "../../src/services/page";
import { createFakeRequest, createFakeResponse, stub } from "../helpers/test-utils";

const RESULT: ExtractionResult = {
  url: "https://93.184.216.34/article",
  status: 200,
  title: "Example",
  metadata: { language: "en", jsonld: [] },
  links: [],
  images: [],
  videos: [],
  audios: [],
  content: "# Example",
};

const calls: Array<{ url: URL; options?: ExtractOptions }> = [];
let answer: () => Promise<ExtractionResult> = async () => RESULT;
let restore: () => void;

beforeEach(() => {
  calls.length = 0;
  answer = async () => RESULT;
  restore = stub(page, "extract", async (url, options) => {
    calls.push({ url, options });
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

describe("get controller", () => {
  test("passes the parsed url, the driver and autoRedirect to the service", async () => {
    const { res, body } = createFakeResponse();

    await get(
      createFakeRequest({ url: "https://93.184.216.34/article?x=1", driver: "browser", autoRedirect: false }),
      res,
      forwarding().next,
    );

    expect(calls.map((call) => call.url.toString())).toEqual(["https://93.184.216.34/article?x=1"]);
    expect(calls[0]?.options).toEqual({ autoRedirect: false, driver: "browser" });
    expect(body()).toEqual({ status: 200, code: codes.OK, data: RESULT });
  });

  test("selects no driver itself: the route's schema has already filled it in", async () => {
    const { res } = createFakeResponse();

    await get(createFakeRequest({ url: "https://93.184.216.34/article" }), res, forwarding().next);

    expect(calls[0]?.options).toEqual({ autoRedirect: undefined, driver: undefined });
  });

  test("still applies the url rules a schema cannot express", async () => {
    // The schema only checks that `url` is a non-empty string; the scheme restriction and the
    // SSRF checks stay in helpers/url.ts, where the service can apply them too.
    const rejected: Array<[string, Code]> = [
      ["file:///etc/passwd", codes.UNSUPPORTED_PROTOCOL],
      ["example.com/article", codes.INVALID_URL],
    ];

    for (const [url, code] of rejected) {
      const forwarded = forwarding();

      await get(createFakeRequest({ url }), createFakeResponse().res, forwarded.next);

      expect(forwarded.error()).toBeInstanceOf(AppError);
      expect((forwarded.error() as AppError).code).toBe(code);
    }

    expect(calls).toEqual([]);
  });

  test("forwards a service failure to the error handler", async () => {
    answer = async () => {
      throw new AppError(504, codes.TIMEOUT);
    };
    const forwarded = forwarding();

    await get(createFakeRequest({ url: "https://93.184.216.34/article" }), createFakeResponse().res, forwarded.next);

    expect((forwarded.error() as AppError).code).toBe(codes.TIMEOUT);
  });
});
