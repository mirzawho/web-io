import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { RequestHandler, Response } from "express";
import * as z from "zod/v4";

import { config } from "./helpers/config";
import { parseHttpUrl } from "./helpers/url";
import { page, searchService } from "./instance";
import { MAX_PAGE, SOURCE_PATTERN } from "./routes.api";

/**
 * The MCP server for a single request. The tools call the shared service instances the REST
 * controllers call - MCP is a second interface to this application, not a client of its own
 * API - and the input schemas repeat the bounds the routes declare, so both interfaces accept
 * and reject the same arguments.
 *
 * A tool that throws answers with an MCP tool error carrying the raised error's message; the
 * SDK builds that result, so a failure is never reported as a successful tool call.
 */
function createServer(): McpServer {
  const server = new McpServer({ name: "web-io", version: config.version });

  server.registerTool(
    "website_search",
    {
      title: "Search the web",
      description: `Search the web for websites and web pages relevant to a user's query.

Use this tool when you need current or external information from the web, when you want to discover pages relevant to a topic, or when you need to find sources before reading them.

You can optionally specify one or more website search sources and a search language. Both are optional, and omitting them means the search service decides which sources to use.

It returns a page of search results - each one a title, a URL, the snippet the search source returned, and the source that found it - together with the requested page and limit. It does not return the contents of any web page.

Use website_fetch when you need to retrieve and extract the contents of a specific page.`,
      inputSchema: {
        q: z.string().trim().min(1).describe('The search query, e.g. "bun javascript runtime".'),
        page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE)
          .default(1)
          .describe(`Which page of results to request (1-${MAX_PAGE}). Deeper pages rarely answer with anything new.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(config.search.maxResults)
          .default(config.search.maxResults)
          .describe(`Maximum number of results to return (1-${config.search.maxResults}).`),
        sources: z
          .array(z.string().trim().toLowerCase().regex(SOURCE_PATTERN))
          .optional()
          .describe('Restrict the search to these website search sources, e.g. ["bing"]. Omitted means the search service chooses its own sources.'),
        language: z
          .string()
          .trim()
          .optional()
          .describe('The language to search in, e.g. "en" or "fa". Omitted means the search service\'s default.'),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await searchService.search(args.q, {
              page: args.page,
              limit: args.limit,
              sources: args.sources,
              language: args.language,
            }),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "website_fetch",
    {
      title: "Fetch a web page",
      description: `Fetch one web page by URL and return its extracted contents.

Use this tool when you already have a URL and need what the page actually says. For finding a page in the first place, use website_search.

The result carries the page's main article as Markdown text in "content", its "title", and the metadata the page declares - description, author, canonical URL, language, Open Graph, Twitter and JSON-LD - along with the links, images, videos and audio it references. Redirects are followed, so "url" is the address that finally answered and "status" is the status it answered with; a page that is not found still comes back as content, with its own status.

"driver" chooses how the page is retrieved. The default, "fetch", makes one fast HTTP request without launching a browser. Use "browser" when the page builds its content with client-side JavaScript.

Only public http and https URLs are accepted; local and private addresses are refused.`,
      inputSchema: {
        url: z
          .string()
          .trim()
          .min(1)
          .describe('The absolute http/https URL to read, e.g. "https://example.com/article".'),
        driver: z
          .enum(["fetch", "browser"])
          .default("fetch")
          .describe('How to retrieve the page. "fetch" (default) is one fast HTTP request without a browser; "browser" renders JavaScript-heavy pages with Chromium.'),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          // The same domain rules the route applies, because a schema cannot express them.
          text: JSON.stringify(await page.extract(parseHttpUrl(args.url), { driver: args.driver }), null, 2),
        },
      ],
    }),
  );

  return server;
}

/**
 * A JSON-RPC error, written straight to the response. An MCP answer is a JSON-RPC message, not
 * the API's envelope, so it deliberately bypasses the shared res.json wrapper - the same reason
 * the Streamable HTTP transport writes its own responses.
 */
function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

/**
 * Stateless Streamable HTTP: there is no session to stream from and none to terminate, so the
 * two methods that would use one are refused the way the MCP SDK's own server does.
 */
const methodNotAllowed: RequestHandler = (_req, res) => {
  jsonRpcError(res, 405, -32000, "Method not allowed.");
};

/**
 * One server and one transport per request, because a McpServer is bound to a single transport
 * for its lifetime and stateless mode keeps no session. The transport answers through the
 * Express response the application already owns: nothing here listens, and there is no second
 * port.
 */
const handleRequest: RequestHandler = async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // A client can leave mid-stream; the pair is torn down either way.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    // express.json() runs before this route, so the JSON-RPC message is already parsed.
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[web-io] mcp request failed:", error);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
  }
};

/** Mounted at /mcp by server.ts, and only when config.mcp.enabled. */
export const mcpRoutes = Router();

mcpRoutes.post("/", handleRequest);
mcpRoutes.get("/", methodNotAllowed);
mcpRoutes.delete("/", methodNotAllowed);
