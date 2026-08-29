import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getCollections, getDb } from "./db.js";
import { getAccessToken, fetchOverview, fetchQueries, fetchPages } from "./gsc.js";
import { resolveApiKey } from "./keys.js";
import { getRecommendations, type ConnectionsInput } from "./recs.js";

const PORT = Number(process.env.PORT ?? 3777);

async function authenticate(req: IncomingMessage): Promise<string> {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (!match) throw new Error("unauthorized: missing Bearer token");
  const override = process.env.MCP_API_KEY;
  if (override && match[1] === override) {
    const { users } = await getCollections();
    const first = await users.findOne({});
    if (!first) throw new Error("unauthorized: no user in database");
    return first.userId;
  }
  const userId = await resolveApiKey(match[1]);
  if (!userId) throw new Error("unauthorized: invalid API key");
  return userId;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function loadConnections(userId: string): Promise<ConnectionsInput> {
  const db = await getDb();
  const docs = await db
    .collection("connections")
    .find({ userId })
    .toArray();
  return docs.map(({ _id: _drop, ...rest }) => rest) as ConnectionsInput;
}

async function buildServer(userId: string): Promise<McpServer> {
  const server = new McpServer({ name: "impiseo", version: "1.0.0" });

  const { users } = await getCollections();
  const user = await users.findOne({ userId });
  if (!user) throw new Error("Account not found");

  const getSite = (site?: string) => {
    const resolved = site ?? user.activeProperty ?? user.siteUrl;
    if (!resolved) throw new Error("No active property for this account");
    return resolved;
  };

  server.registerTool(
    "get_profile",
    {
      title: "Get account profile",
      description: "Returns the connected account's identity, plan context and active Search Console property. Use this first to know who the data belongs to and which site is active.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                userId: user.userId,
                email: user.email,
                onboarded: user.onboarded,
                product: user.product,
                properties: user.properties.map((p) => p.url),
                activeProperty: user.activeProperty ?? user.siteUrl,
                createdAt: user.createdAt,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_sites",
    {
      title: "List Search Console properties",
      description: "Returns the Search Console properties connected to this account, with their URL and permission level, plus which one is currently active.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                activeProperty: user.activeProperty ?? user.siteUrl,
                properties: user.properties.map((p) => ({
                  url: p.url,
                  permissionLevel: p.permissionLevel,
                  addedAt: p.addedAt,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_overview",
    {
      title: "Get organic search overview",
      description: "Mirror of the dashboard stats: totals, previous-period totals, a daily series, the top 25 queries and top 25 pages over a window (default 28 days). All live from Google Search Console.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
        days: z.number().int().min(1).max(90).optional().describe("Window length in days (default 28)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const overview = await fetchOverview({ site, accessToken, days: args.days ?? 28 });
      return { content: [{ type: "text" as const, text: JSON.stringify(overview, null, 2) }] };
    }
  );

  server.registerTool(
    "get_queries",
    {
      title: "Get top organic queries",
      description: "Returns the highest-traffic queries for a site over a window, sorted by clicks, with impressions, CTR and position. Live from Google Search Console.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
        days: z.number().int().min(1).max(90).optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const queries = await fetchQueries({ site, accessToken, days: args.days ?? 28, limit: args.limit ?? 50 });
      return { content: [{ type: "text" as const, text: JSON.stringify({ queries }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_pages",
    {
      title: "Get top organic pages",
      description: "Returns the highest-traffic pages for a site over a window, sorted by clicks, with impressions, CTR and position. Live from Google Search Console.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
        days: z.number().int().min(1).max(90).optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const pages = await fetchPages({ site, accessToken, days: args.days ?? 28, limit: args.limit ?? 50 });
      return { content: [{ type: "text" as const, text: JSON.stringify({ pages }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_ideas",
    {
      title: "Get content ideas",
      description: "Returns the latest generated content-ideas run for a site (gap, striking-distance, intent-mismatch, winner-expansion, new-topic). Stored on the account after a crawl+research run.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const { idea_runs } = await getCollections();
      const run = await idea_runs
        .find({ userId, siteUrl: site })
        .sort({ generatedAt: -1 })
        .limit(1)
        .next();
      return {
        content: [
          {
            type: "text" as const,
            text: run
              ? JSON.stringify({ generatedAt: run.generatedAt, stats: run.stats, ideas: run.ideas }, null, 2)
              : JSON.stringify({ error: "No ideas run yet. Run a crawl on the Pages page first." }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_recommendations",
    {
      title: "Get on-page recommendations",
      description: "Runs the recs engine live: combines crawled page content with Google clicks/impressions to surface actionable SEO fixes (missing meta, thin content, striking-distance keywords, etc.).",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const connections = await loadConnections(userId);
      const recommendations = await getRecommendations({ userId, site, accessToken, connections });
      return { content: [{ type: "text" as const, text: JSON.stringify({ recommendations }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_crawl_status",
    {
      title: "Get crawl / analysis status",
      description: "Returns stored page crawl state: number of pages with metrics, how many have been content-crawled, and the most recent sync. Useful to know if the account has crawled a property yet.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const { pages, page_content } = await getCollections();
      const q = { userId, siteUrl: site };
      const [pagesWithMetrics, pagesWithContent, latest] = await Promise.all([
        pages.countDocuments(q),
        page_content.countDocuments(q),
        pages.find(q).sort({ syncedAt: -1 }).limit(1).next(),
      ]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                site: q.siteUrl,
                pagesWithMetrics,
                pagesWithContent,
                lastSyncedAt: latest?.syncedAt,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname !== "/mcp") {
    return sendJson(res, 404, { error: "not_found" });
  }

  try {
    const parsedBody = await readBody(req);
    // A fresh, stateless session per request keeps userId scoped and avoids
    // leaking access keys or SSE streams across clients.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const userId = await authenticate(req);
    const server = await buildServer(userId);

    transport.onerror = (error) => {
      console.error("[mcp] transport error:", error);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    console.error("[mcp] request failed:", message);
    if (!res.headersSent) {
      sendJson(res, 401, { error: message });
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`impiseo-mcp listening on http://localhost:${PORT}/mcp`);
});