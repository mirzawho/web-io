import type { Code } from "./response";

/**
 * Failure with a known HTTP status and response code. The human-readable message is
 * derived from the code by the response middleware, so it is not repeated at each throw.
 * The original exception travels along as `cause` and reaches debug.txt from there.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: Code,
    cause?: unknown,
    /**
     * The payload the response carries in `data`. Only validation has one — it hands the
     * caller the validator's own errors — so every other failure leaves it `null`.
     */
    readonly data: unknown = null,
  ) {
    super(code, { cause });
    this.name = "AppError";
  }
}
