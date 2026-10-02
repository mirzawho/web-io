import { describe, expect, test } from "bun:test";

import { AppError } from "../../src/helpers/error";
import { assertPublicUrl, isBlockedHost, parseHttpUrl } from "../../src/helpers/url";

describe("parseHttpUrl", () => {
  test("accepts absolute http and https URLs", () => {
    expect(parseHttpUrl("https://example.com/article?x=1").hostname).toBe("example.com");
    expect(parseHttpUrl("http://example.com").protocol).toBe("http:");
    expect(parseHttpUrl("  https://example.com  ").hostname).toBe("example.com");
  });

  test("rejects missing, empty and malformed values", () => {
    for (const raw of ["  ", "not a url", "example.com", "/relative/path"]) {
      expect(() => parseHttpUrl(raw)).toThrow(AppError);

      try {
        parseHttpUrl(raw);
      } catch (error) {
        expect((error as AppError).code).toBe("INVALID_URL");
        expect((error as AppError).status).toBe(400);
      }
    }
  });

  test("rejects protocols other than http and https", () => {
    for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "ftp://example.com"]) {
      expect(() => parseHttpUrl(raw)).toThrow(AppError);

      try {
        parseHttpUrl(raw);
      } catch (error) {
        expect((error as AppError).code).toBe("UNSUPPORTED_PROTOCOL");
        expect((error as AppError).status).toBe(400);
      }
    }
  });
});

describe("isBlockedHost", () => {
  test("blocks loopback, private and link-local destinations", () => {
    const blocked = [
      "localhost",
      "localhost.",
      "api.localhost",
      "service.local",
      "printer.home.arpa",
      "0.0.0.0",
      "127.0.0.1",
      "10.13.0.9",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "192.0.2.5",
      "198.18.0.1",
      "224.0.0.1",
      "",
    ];

    for (const host of blocked) expect(isBlockedHost(host)).toBe(true);
  });

  test("allows public hosts", () => {
    for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "93.184.216.34", "sub.domain.co.uk"]) {
      expect(isBlockedHost(host)).toBe(false);
    }
  });

  test("blocks IPv6 loopback, unique-local and link-local addresses", () => {
    for (const host of ["[::1]", "::1", "[::]", "[fd00::1]", "[fc00::1]", "[fe80::1]", "[ff02::1]"]) {
      expect(isBlockedHost(host)).toBe(true);
    }
  });

  test("blocks IPv4 addresses hidden in mapped and NAT64 form", () => {
    expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isBlockedHost("[64:ff9b::127.0.0.1]")).toBe(true);
    expect(isBlockedHost("[::ffff:8.8.8.8]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  test("resolves the hostname before rejecting a private destination", async () => {
    // "localhost" is rejected from the literal checks, without any DNS lookup.
    await expect(assertPublicUrl(new URL("http://localhost:8080/admin"))).rejects.toMatchObject({
      code: "BLOCKED_URL",
      status: 400,
    });
    await expect(assertPublicUrl(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
  });

  test("accepts a public IP literal", async () => {
    await expect(assertPublicUrl(new URL("https://93.184.216.34/article"))).resolves.toBeUndefined();
  });
});
