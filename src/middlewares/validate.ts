import type { RequestHandler } from "express";
import Validator from "fastest-validator";
import type { ValidationSchema } from "fastest-validator";

import { AppError } from "../helpers/error";
import { codes } from "../helpers/response";

const validator = new Validator();

/**
 * Rejects a request whose JSON body does not match `schema` before its controller runs, and
 * answers with the validator's own error objects in `data`. The schema is compiled once, when
 * the route is defined, so validating a request is one function call.
 *
 * Sanitizers (`trim`, `lowercase`) and `default` write back into `req.body`, so a controller
 * reads the cleaned, filled-in fields and never checks them again.
 */
export function validate(schema: ValidationSchema): RequestHandler {
  const check = validator.compile(schema);

  return (req, _res, next) => {
    const errors = check(req.body);
    if (errors === true) return next();

    return next(new AppError(400, codes.VALIDATION_ERROR, undefined, errors));
  };
}
