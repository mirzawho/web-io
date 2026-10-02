import { afterEach, describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";

import { cache as cacheStore, cacheKey } from "../../src/cache";
import { config } from "../../src/helpers/config";
import { codes, responseMiddleware } from "../../src/helpers/response";
import { cache } from "../../src/middlewares/cache";
import { createFakeRequest, stub } from "../helpers/test-utils";

/**
 * Only what responseMiddleware plus the cache middleware touch. `json` serializes like
 * Express does, so the cache sees exactly the string a real response would send.
 */
function createResponse() {
  const sent: { type?: string; body?: string } = {};
  const res = {
    statusCode: 200,
    startedAt: 0,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(value: string) {
      sent.type = value;
      return res;
    },
    json(body: unknown) {
      return res.send(JSON.stringify(body));
    },
    send(body?: unknown) {
      sent.body = typeof body === "string" ? body : JSON.stringify(body);
      return res;
    },
  };

  return { res: res as unknown as Response, sent };
}

const writes: Array<{ key: string; value: string; ttl: number }> = [];
const reads: string[] = [];
let restores: Array<() => void> = [];

/** Replaces the configured backend with a double, so neither Redis nor memory is needed. */
const stubCache = (stored: string | null): void => {
  writes.length = 0;
  reads.length = 0;
  restores.push(
    stub(cacheStore, "get", async (key) => {
      reads.push(key);
      return stored;
    }),
    stub(cacheStore, "set", async (key, value, ttl) => {
      writes.push({ key, value, ttl });
    }),
  );
};

/** Runs the middleware exactly as the router does: response layer first, then the cache. */
const run = async (
  req: Request,
  controller: (res: Response) => void,
  ttl = 120,
): Promise<{ res: Response; sent: { type?: string; body?: string } }> => {
  const { res, sent } = createResponse();
  responseMiddleware(req, res, (() => undefined) as NextFunction);

  await cache({ ttl })(req, res, ((error?: unknown) => {
    if (error !== undefined) throw error;

    controller(res);
  }) as NextFunction);

  return { res, sent };
};

const searchRequest = (): Request => createFakeRequest({ q: "bun" });

const configuredDriver = config.cache.driver;

afterEach(() => {
  config.cache.driver = configuredDriver;
  for (const restore of restores) restore();
  restores = [];
});

describe("cache middleware", () => {
  test("a miss runs the controller and stores the finished 200 envelope with the TTL", async () => {
    stubCache(null);
    let ran = 0;

    const { sent } = await run(searchRequest(), (res) => {
      ran += 1;
      res.json({ status: 200, code: codes.OK, meta: { page: 1 }, data: [{ title: "Bun" }] });
    });

    expect(ran).toBe(1);
    expect(reads).toEqual([cacheKey(searchRequest())]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toBe(cacheKey(searchRequest()));
    expect(writes[0]!.ttl).toBe(120);
    // The cached value is the envelope the response layer produced, not the handler's result.
    expect(JSON.parse(writes[0]!.value)).toEqual({
      ok: true,
      status: 200,
      code: "OK",
      message: "Request completed successfully.",
      meta: { page: 1, took: expect.any(Number) },
      data: [{ title: "Bun" }],
    });
    expect(sent.body).toBe(writes[0]!.value);
  });

  test("a hit is returned as stored and the controller never runs", async () => {
    const stored = JSON.stringify({
      ok: true,
      status: 200,
      code: "OK",
      message: "Request completed successfully.",
      meta: { took: 5 },
      data: ["cached"],
    });
    stubCache(stored);
    let ran = 0;

    const { res, sent } = await run(searchRequest(), () => {
      ran += 1;
    });

    expect(ran).toBe(0);
    expect(res.statusCode).toBe(200);
    expect(sent.type).toBe("application/json");
    expect(sent.body).toBe(stored);
    expect(writes).toHaveLength(0);
  });

  test("a non-200 response is never cached", async () => {
    stubCache(null);

    const { res } = await run(searchRequest(), (response) => {
      response.json({ status: 502, code: codes.SEARCH_FAILED, data: null });
    });

    expect(res.statusCode).toBe(502);
    expect(writes).toHaveLength(0);
  });

  test("the TTL given to the middleware is the one written to Redis", async () => {
    stubCache(null);

    await run(
      searchRequest(),
      (res) => {
        res.json({ status: 200, code: codes.OK, data: null });
      },
      7,
    );

    expect(writes[0]!.ttl).toBe(7);
  });
});

describe("the configured driver is the one the middleware uses", () => {
  test('"none" leaves the middleware a no-op: the controller runs every time', async () => {
    config.cache.driver = "none";
    let ran = 0;
    const handler = (res: Response) => {
      ran += 1;
      res.json({ status: 200, code: codes.OK, data: ["fresh"] });
    };
    const req = () => createFakeRequest({ q: "driver-none" });

    await run(req(), handler);
    await run(req(), handler);

    expect(ran).toBe(2);
  });

  test('"memory" misses once, then serves the identical request from the process cache', async () => {
    config.cache.driver = "memory";
    let ran = 0;
    const handler = (res: Response) => {
      ran += 1;
      res.json({ status: 200, code: codes.OK, data: ["from memory"] });
    };
    const req = () => createFakeRequest({ q: "driver-memory" });

    const first = await run(req(), handler);
    const second = await run(req(), handler);

    expect(ran).toBe(1);
    expect(second.sent.body).toBe(first.sent.body);
  });

  test('"memory" treats an expired entry as a miss', async () => {
    config.cache.driver = "memory";
    let ran = 0;
    const handler = (res: Response) => {
      ran += 1;
      res.json({ status: 200, code: codes.OK, data: ["expiring"] });
    };
    const req = () => createFakeRequest({ q: "driver-memory-ttl" });

    // A TTL of 0 is already in the past, so the second request has to run the controller again.
    await run(req(), handler, 0);
    await run(req(), handler, 0);

    expect(ran).toBe(2);
  });
});
