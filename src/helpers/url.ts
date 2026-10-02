import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { AppError } from "./error";
import { codes } from "./response";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
]);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export function parseHttpUrl(raw: string): URL {
  const value = raw.trim();
  if (value === "") {
    throw new AppError(400, codes.INVALID_URL);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, codes.INVALID_URL);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AppError(400, codes.UNSUPPORTED_PROTOCOL);
  }

  if (url.hostname === "") {
    throw new AppError(400, codes.INVALID_URL);
  }

  return url;
}

/**
 * Rejects loopback, private, link-local and other non-routable destinations.
 * The HTTP API takes a URL from an untrusted caller and hands it to a browser
 * that runs inside our own network, so this is the cheapest place to stop SSRF.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "") return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isBlockedAddress(host);
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (isBlockedHost(url.hostname)) throw blockedUrlError();

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return;

  // A public hostname may still resolve to a private address (split-horizon DNS
  // or DNS rebinding), so resolve it before Chromium is allowed to connect.
  // Resolution failures are ignored on purpose: the navigation itself will
  // report an unreachable host with a better error message.
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (addresses.some((record) => isBlockedAddress(record.address))) throw blockedUrlError();
}

function isBlockedAddress(address: string): boolean {
  const host = address.toLowerCase();

  if (host.includes(":")) return isBlockedIpv6(host);

  const octets = host.split(".");
  if (octets.length !== 4) return false;

  const [a, b] = octets.map((octet) => Number.parseInt(octet, 10));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;

  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isBlockedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;

  // IPv4-mapped ("::ffff:127.0.0.1") and NAT64 ("64:ff9b::7f00:1") addresses can
  // hide a private IPv4 destination, so unwrap and check the embedded address.
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (embedded !== undefined) return isBlockedAddress(embedded);

  return (
    address.startsWith("fc") || // unique local
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) || // link-local
    address.startsWith("ff") // multicast
  );
}

function blockedUrlError(): AppError {
  return new AppError(400, codes.BLOCKED_URL);
}
