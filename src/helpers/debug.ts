import { appendFile } from "node:fs/promises";
import type { Request } from "express";

import { config } from "./config";

const SEPARATOR = "=".repeat(80);

// Parameter names that usually carry credentials, so their values stay out of the log.
const SECRET_PARAM = /pass|token|secret|key|auth|session|cookie|signature|credential/i;

// Never dump a whole response body into debug.txt; the excerpt is for orientation only.
const TEXT_EXCERPT = 600;

/** Collapses whitespace and keeps the first few hundred characters of a body. */
export function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, TEXT_EXCERPT);
}

export interface DebugEntry {
  request: Request;
  code: string;
  status: number;
  error: unknown;
}

/**
 * Extra context for a failure, labelled for the log. Travels as the `cause` of an
 * AppError, so one failure produces one debug entry with everything needed to place it.
 */
export interface FailureContext {
  kind: "context";
  fields: Record<string, string>;
}

/**
 * Appends failures to debug.txt when DEBUG is enabled, so the real cause (a backend HTTP
 * status, a timeout, an unexpected exception) is not lost behind a sanitized response.
 * Writes are fire-and-forget: a broken log file must never replace the error the request
 * is already reporting.
 */
export const debug = {
  async error(entry: DebugEntry): Promise<void> {
    if (!config.debug) return;

    try {
      await appendFile(debugFile(), format(entry));
    } catch (writeError) {
      console.error("[web-io] could not write the debug log:", writeError);
    }
  },
};

/** DEBUG_FILE points the log elsewhere; tests use it to stay out of the project root. */
function debugFile(): string {
  return process.env.DEBUG_FILE ?? "debug.txt";
}

function format(entry: DebugEntry): string {
  const { request, code, status, error } = entry;

  const header = [new Date().toISOString(), `${request.method} ${request.path}`];
  const query = formatFields(request.query);
  if (query !== "") header.push(`QUERY: ${query}`);
  // The endpoints take their input from the body, so it is what places a failure.
  const body = formatFields(request.body);
  if (body !== "") header.push(`BODY: ${body}`);

  const blocks = [header.join("\n"), `CODE: ${code}\nSTATUS: ${status}`];
  const context = contextOf(error);

  if (context !== undefined) {
    blocks.push(
      ...Object.entries(context.fields).map(([label, value]) => `${label}:\n${value}`),
    );
  }

  blocks.push(`ERROR:\n${describe(error)}`);

  const stack = stackOf(error);
  if (stack !== "") blocks.push(`STACK:\n${stack}`);

  const cause = causeOf(error);
  // A stack already starts with "Error: message"; the context above replaces it when set.
  if (cause !== undefined && context === undefined) blocks.push(`CAUSE:\n${stackOf(cause) || describe(cause)}`);

  return `${SEPARATOR}\n${blocks.join("\n\n")}\n${SEPARATOR}\n\n`;
}

function formatFields(fields: unknown): string {
  return Object.entries(asRecord(fields))
    .map(([name, value]) => `${name}=${SECRET_PARAM.test(name) ? "[redacted]" : describe(value)}`)
    .join("&");
}

/** A parsed body is an object; anything else (absent, a string, an array) has no fields. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "none";

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stackOf(value: unknown): string {
  return value instanceof Error && typeof value.stack === "string" ? value.stack : "";
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

function contextOf(error: unknown): FailureContext | undefined {
  const cause = causeOf(error);
  if (typeof cause !== "object" || cause === null) return undefined;

  const candidate = cause as FailureContext;
  return candidate.kind === "context" ? candidate : undefined;
}
