import type { Request, Response } from "express";

import { config } from "../helpers/config";
import { codes } from "../helpers/response";

/**
 * The health endpoint: liveness plus the runtime context a deployment wants to see. It touches
 * no dependency - neither the search backend nor the browser - so it keeps answering 200 while
 * one of them is down, which is what makes it usable as a liveness probe.
 *
 * The envelope is not built here, exactly as in the other controllers: responseMiddleware
 * wraps `res.json`, so a handler hands over the status, the code and the payload.
 */
export function health(_req: Request, res: Response) {
  return res.json({
    status: 200,
    code: codes.OK,
    data: {
      status: "healthy",
      // Seconds since the process started, rounded to two decimals.
      uptime: Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
      runtime: config.runtime,
      version: config.version,
    },
  });
}
