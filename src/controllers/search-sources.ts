import type { NextFunction, Request, Response } from "express";

import { codes } from "../helpers/response";
import { searchService } from "../instance";

/**
 * The discovery endpoint for `sources`: the website search sources this instance offers, read
 * from the search backend so no list is kept here. The service returns plain data; the
 * envelope is built by responseMiddleware, exactly as for the other controllers.
 */
export async function searchSources(_req: Request, res: Response, next: NextFunction) {
  try {
    return res.json({ status: 200, code: codes.OK, data: await searchService.sources() });
  } catch (error) {
    return next(error);
  }
}
