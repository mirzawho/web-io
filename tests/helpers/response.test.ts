import { describe, expect, test } from "bun:test";
import type { NextFunction } from "express";

import { codes, messages, responseMiddleware } from "../../src/helpers/response";
import type { ApiResponse, ApiResult } from "../../src/helpers/response";
import { createFakeRequest, createFakeResponse } from "./test-utils";

const run = (result: ApiResult) => {
  const { res, status, body } = createFakeResponse();
  let nextCalled = false;

  responseMiddleware(createFakeRequest({}), res, (() => {
    nextCalled = true;
  }) as NextFunction);
  res.json(result);

  return { envelope: body() as ApiResponse, status: status(), nextCalled };
};

describe("responseMiddleware", () => {
  test("records the request start time and continues", () => {
    const { res } = createFakeResponse();
    let nextCalled = false;

    responseMiddleware(createFakeRequest({}), res, (() => {
      nextCalled = true;
    }) as NextFunction);

    expect(nextCalled).toBe(true);
    expect(typeof res.startedAt).toBe("number");
  });

  test("wraps a success result in the public envelope", () => {
    const { envelope, status } = run({ status: 200, code: codes.OK, data: { hello: "world" } });

    expect(status).toBe(200);
    expect(envelope).toEqual({
      ok: true,
      status: 200,
      code: "OK",
      message: "Request completed successfully.",
      meta: { took: expect.any(Number) },
      data: { hello: "world" },
    });
  });

  test("wraps a failure result, keeping the status and clearing the data", () => {
    const { envelope, status } = run({ status: 400, code: codes.INVALID_URL, data: null });

    expect(status).toBe(400);
    expect(envelope).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_URL",
      message: "The provided URL is invalid.",
      meta: { took: expect.any(Number) },
      data: null,
    });
  });

  test("keeps the payload a failure hands back", () => {
    const errors = [{ type: "required", field: "q" }];
    const { envelope, status } = run({ status: 400, code: codes.VALIDATION_ERROR, data: errors });

    expect(status).toBe(400);
    expect(envelope).toMatchObject({
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Request validation failed.",
      data: errors,
    });
  });

  test("takes the message from the code", () => {
    for (const code of Object.values(codes)) {
      const { envelope } = run({ status: 200, code, data: null });

      expect(envelope.code).toBe(code);
      expect(envelope.message).toBe(messages[code]);
      expect(envelope.message.length).toBeGreaterThan(0);
    }
  });

  test("keeps pagination metadata next to the elapsed time", () => {
    const { envelope } = run({
      status: 200,
      code: codes.OK,
      meta: { page: 2, limit: 10, total: 7, last: 1 },
      data: [],
    });

    expect(envelope.meta).toEqual({ page: 2, limit: 10, total: 7, last: 1, took: expect.any(Number) });
  });

  test("reports the elapsed time in milliseconds", async () => {
    const { res, body } = createFakeResponse();
    responseMiddleware(createFakeRequest({}), res, (() => undefined) as NextFunction);

    await Bun.sleep(5);
    res.json({ status: 200, code: codes.OK, data: null });

    const took = (body() as ApiResponse).meta.took;
    expect(typeof took).toBe("number");
    expect(took).toBeGreaterThanOrEqual(0);
  });
});
