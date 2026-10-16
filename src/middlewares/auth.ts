import type { RequestHandler } from "express";

import { AppError } from "../helpers/error";
import { codes } from "../helpers/response";
import { isAuthorized } from "../helpers/token";

/**
 * Requires the access token when this instance has one.
 *
 * The rule is the whole feature: **no token configured means guest mode**, and every request is
 * answered as it always was. Once `AUTH_TOKEN` is set or `bin/generate-token` has written a
 * token file, every request under this middleware has to present it as
 * `Authorization: Bearer <token>` or `X-API-Key: <token>`, and anything else is
 * `401 UNAUTHORIZED`.
 *
 * The token is read per request rather than at startup, so generating one takes effect
 * immediately, without a restart. A refused request answers with the standard failure envelope
 * and no hint about which of the two forms to use, and the presented value is never logged:
 * `helpers/debug.ts` redacts a field named like a credential.
 */
export const requireToken: RequestHandler = async (req, _res, next) => {
  try {
    if (await isAuthorized(req.get("authorization"), req.get("x-api-key"))) return next();
  } catch (error) {
    return next(error);
  }

  return next(new AppError(401, codes.UNAUTHORIZED));
};
