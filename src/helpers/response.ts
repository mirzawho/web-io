import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Every code the API answers with, and the public message each code maps to. */
export const codes = {
  OK: "OK",
  INVALID_URL: "INVALID_URL",
  INVALID_PARAMETER: "INVALID_PARAMETER",
  INVALID_BODY: "INVALID_BODY",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  BLOCKED_URL: "BLOCKED_URL",
  NOT_FOUND: "NOT_FOUND",
  SEARCH_FAILED: "SEARCH_FAILED",
  SEARCH_UNAVAILABLE: "SEARCH_UNAVAILABLE",
  PAGE_FETCH_FAILED: "PAGE_FETCH_FAILED",
  BROWSER_FAILED: "BROWSER_FAILED",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type Code = (typeof codes)[keyof typeof codes];

export const messages: Record<Code, string> = {
  OK: "Request completed successfully.",
  INVALID_URL: "The provided URL is invalid.",
  INVALID_PARAMETER: "A request parameter is invalid.",
  INVALID_BODY: "The request body is invalid.",
  VALIDATION_ERROR: "Request validation failed.",
  UNSUPPORTED_PROTOCOL: "Only http and https URLs are supported.",
  BLOCKED_URL: "Requests to local, private or link-local addresses are not allowed.",
  NOT_FOUND: "The requested route does not exist.",
  SEARCH_FAILED: "The search request failed.",
  SEARCH_UNAVAILABLE: "The search backend is unavailable.",
  PAGE_FETCH_FAILED: "The page could not be fetched.",
  BROWSER_FAILED: "The browser could not be started.",
  TIMEOUT: "The request timed out.",
  INTERNAL_ERROR: "An internal server error occurred.",
};

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  last?: number;
}

/** What a handler or the error middleware returns. */
export interface ApiResult<T = unknown> {
  status: number;
  code: Code;
  meta?: ApiMeta;
  data: T;
}

/** What leaves the HTTP boundary. */
export interface ApiResponse {
  ok: boolean;
  status: number;
  code: Code;
  message: string;
  meta: ApiMeta & { took: number };
  data: unknown;
}

declare global {
  namespace Express {
    interface Response {
      /** Set by responseMiddleware, read when the response is written. */
      startedAt: number;
    }
  }
}

/**
 * Turns every response into the public envelope. Handlers only hand over the result, so
 * `ok`, `message`, `meta.took` and the HTTP status are decided in exactly one place and
 * can never drift apart.
 */
export const responseMiddleware: RequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  res.startedAt = performance.now();

  const json = res.json.bind(res);
  res.json = (body: ApiResult) => {
    res.status(body.status);

    return json({
      ok: body.status < 400,
      status: body.status,
      code: body.code,
      message: messages[body.code],
      meta: { ...body.meta, took: Math.round(performance.now() - res.startedAt) },
      data: body.data ?? null,
    });
  };

  next();
};
