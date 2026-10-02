import type { NextFunction, Request, Response } from "express";

import { codes } from "../helpers/response";
import { parseHttpUrl } from "../helpers/url";
import { page } from "../instance";

/**
 * The route's schema (routes.api.ts) already checked that `url` is a non-empty string, that
 * `driver` is one of the two it allows (defaulting to `fetch`) and that `autoRedirect` is a
 * boolean defaulting to true. `parseHttpUrl` still applies the domain rules a schema cannot
 * express — an absolute `http`/`https` URL — and the service adds the SSRF checks before
 * either driver runs.
 *
 * How the page is fetched is the service's business: this only passes the choice on.
 */
export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const url = parseHttpUrl(req.body.url);

    // The service returns plain data; the response envelope is built here, at the HTTP edge.
    return res.json({
      status: 200,
      code: codes.OK,
      data: await page.extract(url, {
        autoRedirect: req.body.autoRedirect,
        driver: req.body.driver,
      }),
    });
  } catch (error) {
    return next(error);
  }
}
