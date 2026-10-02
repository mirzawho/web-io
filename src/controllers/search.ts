import type { NextFunction, Request, Response } from "express";

import { codes } from "../helpers/response";
import { searchService } from "../instance";

/**
 * The route's schema (routes.api.ts) already validated and normalized the body: `q` is a non-empty
 * trimmed string, `page` and `limit` are bounded integers, `sources` holds normalized source
 * names and `language` is a string. Reading the fields is therefore all that is left to do here.
 */
export async function search(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, page, limit, sources, language } = req.body;

    // The service returns plain data; the response envelope is built here, at the HTTP edge.
    // An optional field may be null, which for the service means "nothing was chosen".
    const { results, meta } = await searchService.search(q, {
      page,
      limit,
      sources: sources ?? undefined,
      language: language ?? undefined,
    });

    return res.json({ status: 200, code: codes.OK, meta, data: results });
  } catch (error) {
    return next(error);
  }
}
