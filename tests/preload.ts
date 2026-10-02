import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded by bunfig.toml before any test file, so src/helpers/config.ts reads the test
// environment on import (the request logger stays quiet during `bun test`).
process.env.NODE_ENV = "test";

// Tests must not depend on the developer's .env, and must never write into the repository:
// debug logging is off unless a test turns it on, and it points outside the project.
process.env.DEBUG = "false";
process.env.DEBUG_FILE = join(tmpdir(), `web-io-test-debug-${process.pid}.txt`);

// Caching is off by default and no Redis is reachable, so the suite needs neither. Tests
// that exercise a driver set config.cache.driver themselves.
process.env.CACHE_DRIVER = "none";
process.env.REDIS_URL = "";

// The docs are opt-in, so the suite's default app does not serve them. The Swagger tests
// build their own instance with config.swagger.enabled set.
process.env.SWAGGER_ENABLED = "false";

// Same for MCP: the MCP tests build their own instance, and the rest of the suite runs
// against an app without the route.
process.env.MCP_ENABLED = "false";
