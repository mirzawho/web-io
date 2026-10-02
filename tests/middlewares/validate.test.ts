import { describe, expect, test } from "bun:test";
import type { NextFunction, RequestHandler, Response } from "express";

import { AppError } from "../../src/helpers/error";
import { codes } from "../../src/helpers/response";
import { validate } from "../../src/middlewares/validate";
import { createFakeRequest } from "../helpers/test-utils";

/** Runs one middleware call and reports what it did: pass on, or which error it forwarded. */
const invoke = (middleware: RequestHandler, body: unknown) => {
  const outcome: { passed: boolean; error?: unknown } = { passed: false };

  middleware(
    createFakeRequest({}, { body }),
    {} as Response,
    ((error?: unknown) => {
      if (error === undefined) outcome.passed = true;
      else outcome.error = error;
    }) as NextFunction,
  );

  return outcome;
};

describe("validate middleware", () => {
  const middleware = validate({ q: { type: "string", min: 1, trim: true } });

  test("calls next() without an error when the body matches the schema", () => {
    const outcome = invoke(middleware, { q: "bun" });

    expect(outcome.passed).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  test("forwards a 400 VALIDATION_ERROR for every schema violation", () => {
    for (const body of [{}, { q: 42 }, { q: "" }, undefined, null, "bun"]) {
      const outcome = invoke(middleware, body);

      expect(outcome.passed).toBe(false);
      expect(outcome.error).toBeInstanceOf(AppError);
      expect((outcome.error as AppError).status).toBe(400);
      expect((outcome.error as AppError).code).toBe(codes.VALIDATION_ERROR);
    }
  });

  test("carries Fastest Validator's own errors as the response data", () => {
    const error = invoke(middleware, { q: 42 }).error as AppError;

    // Not reworded and not wrapped: the validator's objects are the payload.
    expect(error.data).toEqual([
      { type: "string", message: "The 'q' field must be a string.", field: "q", actual: 42 },
    ]);
  });

  test("a sanitizer writes the cleaned value back into the body", () => {
    const body = { q: "  bun  " };

    expect(invoke(middleware, body).passed).toBe(true);
    expect(body.q).toBe("bun");
  });

  test("compiles the schema when the middleware is created, not per request", () => {
    expect(() => validate({ q: { type: "not-a-rule" } })).toThrow();
  });
});
