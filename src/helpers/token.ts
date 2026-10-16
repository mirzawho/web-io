import { createHash, timingSafeEqual } from "node:crypto";

import { config } from "./config";

/**
 * The access token this instance requires, if it requires one at all.
 *
 * Two sources, in this order: `AUTH_TOKEN` (read once, at startup) and the token file
 * `bin/generate-token` writes (read on every request, so generating a token takes effect
 * without restarting the service). Neither set means **guest mode**: every request is
 * answered without a token, which is what a fresh deployment does until someone generates one.
 *
 * Only the sha256 of a token is ever compared or stored, never the token itself: the token
 * file holds a hash, so a copy of that file is not a usable credential.
 */

/** sha256 of a token, lowercase hex - the form the token file holds. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// AUTH_TOKEN does not change while the process runs, so its hash is computed once and kept -
// but the value it was computed from is remembered with it, so a test that sets
// `config.auth.token` gets the token it set rather than the one the process started with.
let declaredFor: string | undefined;
let declaredHash: string | null = null;

function declared(): string | null {
  if (declaredFor === config.auth.token) return declaredHash;

  declaredFor = config.auth.token;
  declaredHash = config.auth.token === "" ? null : hashToken(config.auth.token);

  return declaredHash;
}

/** The hash the token file holds right now, or null when there is no token to read. */
async function stored(): Promise<string | null> {
  try {
    const file = Bun.file(config.auth.tokenFile);
    if (!(await file.exists())) return null;

    const content = (await file.text()).trim();

    return content === "" ? null : content;
  } catch {
    // An unreadable token file is not a reason to refuse every request: it reads as having
    // no token at all, exactly like an unreachable Redis reads as a cache miss.
    return null;
  }
}

/** The hash a presented token has to match, or null in guest mode. */
async function requiredTokenHash(): Promise<string | null> {
  return declared() ?? (await stored());
}

/** Whether a presented token is the one this instance requires. */
async function tokenIsValid(presented: string): Promise<boolean> {
  const expected = await requiredTokenHash();
  // Guest mode: there is nothing to compare against, so nothing to refuse.
  if (expected === null) return true;

  const actual = Buffer.from(hashToken(presented), "hex");
  const wanted = Buffer.from(expected, "hex");
  // Both sides are sha256 digests, so the lengths match; a file holding anything else is not
  // a hash this instance could ever match.
  if (actual.length !== wanted.length) return false;

  return timingSafeEqual(actual, wanted);
}

/** The token a request presents: `Authorization: Bearer <token>` or `X-API-Key: <token>`. */
function presentedToken(header: string | undefined, apiKey: string | undefined): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  if (bearer?.[1] !== undefined) return bearer[1].trim();

  const key = (apiKey ?? "").trim();

  return key === "" ? null : key;
}

/**
 * The whole rule, in one place so both edges apply it identically: **guest mode accepts
 * everything**, and once a token is required, only the right one gets through. The REST
 * middleware and the MCP route differ only in how they report a refusal, so neither of them
 * decides who is allowed in.
 */
export async function isAuthorized(header: string | undefined, apiKey: string | undefined): Promise<boolean> {
  // No token configured: nothing to present and nothing to compare, so the request passes.
  if ((await requiredTokenHash()) === null) return true;

  const presented = presentedToken(header, apiKey);

  return presented !== null && (await tokenIsValid(presented));
}
