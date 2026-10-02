import { afterEach, describe, expect, test } from "bun:test";
import type { Request } from "express";

import { cache, cacheKey } from "../../src/cache";
import { config, toCacheDriver } from "../../src/helpers/config";
import { createFakeRequest } from "../helpers/test-utils";

/** A request as the router sees it: mounted at /api/v1, so baseUrl + path is the full path. */
const request = (overrides: Partial<Request> = {}): Request =>
  createFakeRequest({}, { method: "GET", path: "/website/search", baseUrl: "/api/v1", ...overrides });

describe("cacheKey", () => {
  test("is the method, the full path and the sorted parameters", () => {
    expect(cacheKey(request({ query: { q: "google", limit: "10" } }))).toBe(
      'cache:GET:/api/v1/website/search:{"limit":"10","q":"google"}',
    );
    expect(
      cacheKey(request({ method: "POST", query: {}, body: { q: "google", limit: 10 } })),
    ).toBe('cache:POST:/api/v1/website/search:{"limit":10,"q":"google"}');
  });

  test("does not depend on the order the parameters arrived in", () => {
    const one = cacheKey(request({ query: { q: "google", limit: "10" } }));
    const other = cacheKey(request({ query: { limit: "10", q: "google" } }));

    expect(one).toBe(other);
  });

  test("sorts nested objects as well", () => {
    const one = cacheKey(request({ query: { filter: { b: "2", a: "1" } } }));
    const other = cacheKey(request({ query: { filter: { a: "1", b: "2" } } }));

    expect(one).toBe(other);
    expect(one).toBe('cache:GET:/api/v1/website/search:{"filter":{"a":"1","b":"2"}}');
  });

  test("differs when a query or body parameter differs", () => {
    const base = cacheKey(request({ query: { q: "google" } }));

    expect(cacheKey(request({ query: { q: "bing" } }))).not.toBe(base);
    expect(cacheKey(request({ query: { q: "google", limit: "10" } }))).not.toBe(base);
  });

  test("keys an optional field sent as null the same as one left out", () => {
    // Both reach the service as "nothing was chosen", so they have to share one entry.
    const absent = cacheKey(request({ body: { q: "google" } }));

    expect(cacheKey(request({ body: { q: "google", sources: null } }))).toBe(absent);
    expect(cacheKey(request({ body: { q: "google", language: null, sources: null } }))).toBe(absent);
  });

  test("differs between HTTP methods on the same path", () => {
    const get = cacheKey(request({ method: "GET", query: { q: "google" } }));
    const post = cacheKey(request({ method: "POST", query: { q: "google" } }));

    expect(get).not.toBe(post);
  });

  test("differs between paths", () => {
    expect(cacheKey(request({ path: "/website/search" }))).not.toBe(
      cacheKey(request({ path: "/website/fetch" })),
    );
  });
});

describe("toCacheDriver", () => {
  test("accepts the three supported drivers, ignoring case and surrounding space", () => {
    expect(toCacheDriver("redis")).toBe("redis");
    expect(toCacheDriver("memory")).toBe("memory");
    expect(toCacheDriver("none")).toBe("none");
    expect(toCacheDriver("  REDIS  ")).toBe("redis");
  });

  test("falls back to none for a missing, empty or unknown value", () => {
    for (const raw of [undefined, "", "   ", "memcached", "true", "memory_cache", "0"]) {
      expect(toCacheDriver(raw)).toBe("none");
    }
  });
});

describe("the driver decides the backend behind cache.get/set", () => {
  const configured = { driver: config.cache.driver, url: config.redis.url };

  afterEach(() => {
    config.cache.driver = configured.driver;
    config.redis.url = configured.url;
    cache.close();
  });

  test('"none" never stores anything', async () => {
    config.cache.driver = "none";

    await cache.set("cache:none-mode", "value", 60);

    expect(await cache.get("cache:none-mode")).toBeNull();
  });

  test('"memory" keeps a value until its TTL runs out', async () => {
    config.cache.driver = "memory";

    await cache.set("cache:memory-live", "value", 60);
    expect(await cache.get("cache:memory-live")).toBe("value");

    // ttl 0 is already in the past, so the entry counts as expired.
    await cache.set("cache:memory-expired", "value", 0);
    expect(await cache.get("cache:memory-expired")).toBeNull();
  });

  test("an expired memory entry is forgotten, so a later write takes its place", async () => {
    config.cache.driver = "memory";

    await cache.set("cache:memory-reuse", "old", 0);
    expect(await cache.get("cache:memory-reuse")).toBeNull();

    await cache.set("cache:memory-reuse", "new", 60);
    expect(await cache.get("cache:memory-reuse")).toBe("new");
  });

  test('"memory" and "none" never reach for Redis', async () => {
    // A URL that would fail loudly if anything tried to connect to it.
    config.redis.url = "redis://127.0.0.1:6398";

    const logged = console.error;
    let reported = false;
    console.error = () => {
      reported = true;
    };

    try {
      config.cache.driver = "memory";
      await cache.set("cache:no-redis-memory", "value", 60);
      expect(await cache.get("cache:no-redis-memory")).toBe("value");

      config.cache.driver = "none";
      expect(await cache.get("cache:no-redis-none")).toBeNull();
      await cache.set("cache:no-redis-none", "value", 60);

      // A connection attempt to the dead URL would fail asynchronously, so give it time to
      // report before concluding that nothing reached for Redis.
      await Bun.sleep(150);
      expect(reported).toBe(false);
    } finally {
      console.error = logged;
    }
  });

  test('"redis" without REDIS_URL is a miss and never throws', async () => {
    config.cache.driver = "redis";
    config.redis.url = "";

    const logged = console.error;
    console.error = () => undefined;

    try {
      expect(await cache.get("cache:redis-no-url")).toBeNull();
      await cache.set("cache:redis-no-url", "value", 60);
    } finally {
      console.error = logged;
    }
  });

  test('"redis" against an unreachable server is a miss, not a thrown error', async () => {
    config.cache.driver = "redis";
    // Nothing listens here, so both operations have to fail on their own.
    config.redis.url = "redis://127.0.0.1:6398";

    const logged = console.error;
    console.error = () => undefined;

    try {
      expect(await cache.get("cache:redis-down")).toBeNull();
      await cache.set("cache:redis-down", "value", 60);
    } finally {
      console.error = logged;
    }
  });
});
