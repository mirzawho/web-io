import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";

import { config } from "./helpers/config";
import { debug } from "./helpers/debug";
import { AppError } from "./helpers/error";
import { codes, responseMiddleware } from "./helpers/response";
import { router } from "./routes.api";
import { mcpRoutes } from "./routes.mcp";
import { swaggerRoutes } from "./routes.swagger";

const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();

  res.on("finish", () => {
    const duration = Math.round(performance.now() - startedAt);
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
};

const notFound: RequestHandler = (_req, res) => {
  res.json({ status: 404, code: codes.NOT_FOUND, data: null });
};

/** Exported so the failure envelope is covered by the route tests. */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const known = error instanceof AppError;
  // A body the JSON parser could not read is the caller's mistake, not ours.
  const malformed = isMalformedBody(error);
  const status = known ? error.status : malformed ? 400 : 500;
  const code = known ? error.code : malformed ? codes.INVALID_BODY : codes.INTERNAL_ERROR;

  if (!known && !malformed) console.error("[web-io] unexpected error:", error);

  // The cause goes to debug.txt when DEBUG is on; the response stays sanitized.
  void debug.error({ request: req, code, status, error });

  // Validation hands the caller the validator's own errors; every other failure has nothing
  // to add, so `data` stays null.
  res.json({ status, code, data: known ? error.data : null });
};

/** body-parser marks its own failures with `type` and a 4xx `status`. */
function isMalformedBody(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { type?: unknown; status?: unknown };
  return typeof candidate.type === "string" && typeof candidate.status === "number" && candidate.status < 500;
}

/**
 * Builds the Express app. Exported as a factory so a test can build an instance with a
 * different setting (the docs on or off); `app` below is the one the service actually runs.
 */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  // The documentation is mounted only when it is enabled, so a disabled instance has neither
  // the route nor any of its middleware in the stack. It deliberately sits outside the API
  // envelope: Swagger UI answers with HTML, JavaScript and static assets rather than an API
  // JSON response, and responseMiddleware below rewrites every res.json for exactly that reason.
  if (config.swagger.enabled) app.use("/docs", swaggerRoutes);

  app.use(responseMiddleware);
  if (config.env !== "test") app.use(requestLogger);

  // Both endpoints take a JSON object, so the body is parsed before the router sees it.
  // A malformed body is answered with the standard failure envelope instead of Express's
  // own HTML error page.
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/v1", router);

  // MCP is a second interface to the same services, served by this same listener: a disabled
  // instance registers neither the route nor anything it would load, so an instance with
  // MCP_ENABLED unset behaves exactly as it did before. It is mounted after express.json()
  // because the transport takes the already-parsed JSON-RPC body, and before the 404 handler
  // so that an enabled /mcp is routed instead of falling through.
  if (config.mcp.enabled) app.use("/mcp", mcpRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
