import { describe, expect, test } from "bun:test";

import { AppError } from "../../src/helpers/error";
import { codes } from "../../src/helpers/response";

describe("AppError", () => {
  test("carries the http status and the response code", () => {
    const error = new AppError(400, codes.BLOCKED_URL);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.status).toBe(400);
    expect(error.code).toBe("BLOCKED_URL");
  });

  test("is identified by its code, not by a per-site message", () => {
    expect(new AppError(504, codes.TIMEOUT).message).toBe("TIMEOUT");
  });

  test("keeps the original error as its cause", () => {
    const cause = new Error("net::ERR_NAME_NOT_RESOLVED");

    expect(new AppError(502, codes.SEARCH_FAILED, cause).cause).toBe(cause);
  });

  test("carries the payload a failure hands back, and null when it has none", () => {
    const errors = [{ type: "required", field: "q" }];

    expect(new AppError(400, codes.VALIDATION_ERROR, undefined, errors).data).toBe(errors);
    expect(new AppError(400, codes.VALIDATION_ERROR).data).toBeNull();
  });
});
