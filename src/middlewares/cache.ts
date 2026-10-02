import type { RequestHandler } from "express";

import { cache as cacheStore, cacheKey } from "../cache";

/**
 * Caches the JSON response of the route it is mounted on, e.g.
 * `router.post("/website/search", middlewares.cache({ ttl: 120 }), search)`. `ttl` is the entry's
 * lifetime in seconds.
 *
 * A stored response is returned before the controller runs; otherwise the response the
 * controller produced is stored, but only when it is a 200. The middleware only ever calls
 * `cacheStore.get`/`set`, so which backend answers (Redis, memory or nothing) is decided by
 * CACHE_DRIVER and never known here. Redis failures are swallowed by cache/redis.ts, and
 * the key is derived from the request, so a route never builds one itself.
 *
 * res.send is wrapped rather than res.json because res.send is where the response
 * middleware's res.json wrapper ends up: the finished envelope is stored exactly as it was
 * sent, without a second envelope being built here.
 */
export function cache({ ttl }: { ttl: number }): RequestHandler {
  return async (req, res, next) => {
    const key = cacheKey(req);
    const stored = await cacheStore.get(key);

    if (stored !== null) {
      // The stored value is the finished envelope: send it as it is.
      res.status(200).type("application/json").send(stored);
      return;
    }

    const send = res.send.bind(res);
    res.send = (body) => {
      if (res.statusCode === 200 && typeof body === "string") {
        // Fire and forget: the response must not wait for the cache write.
        void cacheStore.set(key, body, ttl);
      }

      return send(body);
    };

    next();
  };
}
