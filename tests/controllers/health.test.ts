import { describe, expect, test } from "bun:test";

import { health } from "../../src/controllers/health";
import { config } from "../../src/helpers/config";
import { codes } from "../../src/helpers/response";
import { createFakeRequest, createFakeResponse } from "../helpers/test-utils";

describe("health controller", () => {
  test("hands over the status, the uptime, the timestamp and the runtime", () => {
    const { res, body } = createFakeResponse();

    health(createFakeRequest({}), res);

    expect(body()).toMatchObject({
      status: 200,
      code: codes.OK,
      data: {
        status: "healthy",
        uptime: expect.any(Number),
        timestamp: expect.any(String),
        runtime: config.runtime,
        version: config.version,
      },
    });
  });

  test("stops at the payload: the envelope belongs to responseMiddleware", () => {
    const { res, body } = createFakeResponse();

    health(createFakeRequest({}), res);

    expect(body()).not.toHaveProperty("ok");
    expect(body()).not.toHaveProperty("message");
  });
});
