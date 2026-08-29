import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getCollections, getDb } from "./db.js";
import { getAccessToken, fetchOverview, fetchQueries, fetchPages, fetchQueryPages, fetchPageQueryPairs } from "./gsc.js";
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

  server.registerTool(
    "get_page_content",
    {
      title: "Get crawled page content",
      description: "Returns the crawled on-page content we stored for pages of a site: title, meta description, headings, word count, structured data, http status. Filter by path prefix or list by traffic. Stored data — not live fetches.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        path: z.string().optional().describe("Exact normalized path to look up (e.g. /blog/post-1)."),
        prefix: z.string().optional().describe("Path prefix to filter, e.g. /blog"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 200, sorted by impressions desc)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const { page_content } = await getCollections();
      const filter: Record<string, unknown> = { userId, siteUrl: site };
      if (args.path) filter.path = args.path;
      else if (args.prefix) filter.path = { $regex: `^${escapeRegex(args.prefix)}` };
      const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
      const docs = await page_content
        .find(filter)
        .sort({ fetchedAt: -1 })
        .limit(limit)
        .toArray();
      const rows = docs.map(({ _id: _d, ...c }) => c);
      if (args.path) {
        const hit = rows[0];
        return {
          content: [
            {
              type: "text" as const,
              text: hit
                ? JSON.stringify(hit, null, 2)
                : JSON.stringify({ error: "No crawled content for this path. Run Sync & analyze on the Pages page first." }, null, 2),
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, pages: rows }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_rec_enhancements",
    {
      title: "Get AI-enhanced recommendations",
      description: "Returns the stored AI fix plans for recommendations (why, steps, draft title/meta, agent prompt), keyed by rec id. For a richer view of recommendations pairing with the rule output, see get_recommendations.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        recId: z.string().optional().describe("Specific rec id to fetch (e.g. /blog/post::missing-meta). Omit for all."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const { rec_enhancements } = await getCollections();
      const filter: Record<string, unknown> = { userId, siteUrl: site };
      if (args.recId) filter.recId = args.recId;
      const docs = await rec_enhancements.find(filter).sort({ updatedAt: -1 }).toArray();
      const rows = docs.map(({ _id: _d, userId: _u, siteUrl: _s, ...rest }) => rest);
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, enhancements: rows }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_idea_detail",
    {
      title: "Get a single idea's full detail",
      description: "Returns one idea from the latest run — full evidence incl. top queries, covering pages, autocomplete phrasings, validation, plus the AI angle/outline if packaged.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        ideaId: z.string().describe("The idea's id (from get_ideas)."),
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
      const idea = run?.ideas.find((i) => i.id === args.ideaId);
      if (!idea) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Idea not found in the latest run." }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(idea, null, 2) }] };
    }
  );

  server.registerTool(
    "get_page_queries",
    {
      title: "Get queries ranking for a page",
      description: "Live from Search Console: the queries that send traffic to a specific page, with clicks, impressions, CTR and position. Dimension pair [page, query] filtered by page.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        page: z.string().describe("The page path (e.g. /blog/post-1) or full URL."),
        days: z.number().int().min(1).max(90).optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 50)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const rows = await fetchPageQueryPairs({
        site,
        accessToken,
        page: args.page,
        days: args.days ?? 28,
        limit: args.limit ?? 50,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ page: args.page, queries: rows }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_query_pages",
    {
      title: "Get pages ranking for a query",
      description: "Live from Search Console: the pages ranking for a specific query, with clicks, impressions, CTR and position. Useful for seeing which page competes in a topic.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        query: z.string().describe("The exact query to filter by."),
        days: z.number().int().min(1).max(90).optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 20)."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const pages = await fetchQueryPages({
        site,
        accessToken,
        query: args.query,
        days: args.days ?? 28,
        limit: args.limit ?? 20,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ query: args.query, pages }, null, 2) }] };
    }
  );

  server.registerTool(
    "list_idea_runs",
    {
      title: "List idea-generation runs",
      description: "Returns the metadata (not the ideas) of every idea run for the site — generatedAt and stats — so you can see history and whether runs degraded.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
      },
    },
    async (args) => {
      const site = getSite(args.site);
      const { idea_runs } = await getCollections();
      const runs = await idea_runs
        .find({ userId, siteUrl: site }, { projection: { ideas: 0 } })
        .sort({ generatedAt: -1 })
        .limit(20)
        .toArray();
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: runs.length, runs }, null, 2) }] };
    }
  );

  return server;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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