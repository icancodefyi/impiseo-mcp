import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodType } from "zod";
import { getCollections, getDb } from "./db.js";
import { getAccessToken, fetchOverview, fetchQueries, fetchPages, fetchQueryPages, fetchPageQueryPairs, iso, addDays, type MetricRow } from "./gsc.js";
import { fetchPageHtml } from "./html.js";
import { resolveApiKey } from "./keys.js";
import { getRecommendations, type ConnectionsInput } from "./recs.js";
import { computeQueryOpportunities } from "./opportunities.js";
import { normalizePath } from "./url.js";

const PORT = Number(process.env.PORT ?? 3777);

// ---------------------------------------------------------------------------
// Schemas for tool outputs. Kept intentionally tolerant: every tool returns
// the same { ok: true, ... } envelope, documented fields below are typed
// where their shape is stable, and unknown leftovers are preserved via
// passthrough so validation can never reject a response over time.
// ---------------------------------------------------------------------------

const OBJ = z.object({}).passthrough().nullable();
const OBJS = z.array(OBJ).optional();
const STR = z.string().nullish();
const NUM = z.number().optional();
const BOOL = z.boolean().optional();

function envelope(extra: Record<string, ZodType> = {}) {
  return z.object({ ok: z.boolean(), ...extra }).passthrough();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function toJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || k === "_id" || k === "__v") continue;
    out[k] = toJson(v);
  }
  return out;
}

function toJsonObject(payload: Record<string, unknown>): Record<string, unknown> {
  return toJson(payload) as Record<string, unknown>;
}

/** Success envelope: plain object in structuredContent (no JSON-in-JSON), pretty text copy in content[0].text. */
function ok(payload: Record<string, unknown>) {
  const body = toJsonObject({ ok: true, ...payload });
  return {
    structuredContent: body,
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

/** Failure envelope, mirroring the same shape with ok:false. */
function fail(message: string) {
  const body = { ok: false, error: message };
  return {
    isError: true,
    structuredContent: body,
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Authentication / plumbing
// ---------------------------------------------------------------------------

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

/** Page-level GSC rows joined with crawled page_content (title/meta/wordCount). */
async function enrichPages(
  userId: string,
  site: string,
  rows: MetricRow[]
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const { page_content } = await getCollections();
  const paths = rows.map((r) => normalizePath(r.key));
  const docs = await page_content
    .find({ userId, siteUrl: site, path: { $in: paths } })
    .toArray();
  const byPath = new Map(docs.map((d) => [d.path, d]));
  return rows.map((r) => {
    const c = byPath.get(normalizePath(r.key));
    return {
      path: normalizePath(r.key),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      title: c?.title ?? null,
      metaDescription: c?.metaDescription ?? null,
      wordCount: c?.wordCount ?? null,
      httpStatus: c?.httpStatus ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Server builder
// ---------------------------------------------------------------------------

async function buildServer(userId: string): Promise<McpServer> {
  const server = new McpServer({ name: "impiseo", version: "1.1.0" });

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
      description:
        "Returns the connected account's identity, plan context and active Search Console property. Use this first to know who the data belongs to and which site is active.",
      inputSchema: {},
      outputSchema: envelope({
        userId: STR,
        email: STR,
        onboarded: BOOL,
        product: OBJ,
        activeProperty: STR,
        createdAt: STR,
      }),
    },
    async () => {
      return ok({
        userId: user.userId,
        email: user.email,
        onboarded: user.onboarded,
        product: user.product ?? {},
        properties: user.properties.map((p) => p.url),
        activeProperty: user.activeProperty ?? user.siteUrl,
        createdAt: user.createdAt,
      });
    }
  );

  server.registerTool(
    "list_sites",
    {
      title: "List Search Console properties",
      description:
        "Returns the Search Console properties connected to this account, with their URL and permission level, plus which one is currently active.",
      inputSchema: {},
      outputSchema: envelope({
        activeProperty: STR,
        properties: OBJS,
      }),
    },
    async () => {
      return ok({
        activeProperty: user.activeProperty ?? user.siteUrl,
        properties: user.properties.map((p) => ({
          url: p.url,
          permissionLevel: p.permissionLevel,
          addedAt: p.addedAt,
        })),
      });
    }
  );

  server.registerTool(
    "get_overview",
    {
      title: "Get organic search overview",
      description:
        "Mirror of the dashboard stats: totals, previous-period totals, a daily series, the top 25 queries and top 25 pages over a window (default 28 days). All live from Google Search Console.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
        days: z.number().int().min(1, "days must be between 1 and 90").max(90, "days must be between 1 and 90").optional().describe("Window length in days (default 28)."),
      },
      outputSchema: envelope({
        range: OBJ,
        totals: OBJ,
        prevTotals: OBJ,
        series: OBJS,
        queries: OBJS,
        pages: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const overview = await fetchOverview({ site, accessToken, days: args.days ?? 28 });
      return ok({ ...overview });
    }
  );

  const pageableSchema = {
    site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
    days: z.number().int().min(1, "days must be between 1 and 90").max(90, "days must be between 1 and 90").optional().describe("Window length in days (default 28)."),
    offset: z.number().int().min(0, "offset must be >= 0").max(25000, "offset must be <= 25000").optional().describe("Row offset for paging (GSC startRow). Default 0."),
    limit: z.number().int().min(1, "limit must be between 1 and 300").max(300, "limit must be between 1 and 300").optional().describe("Max rows (default 100)."),
  };

  server.registerTool(
    "get_queries",
    {
      title: "Get top organic queries",
      description:
        "Returns the highest-traffic queries for a site over a window, sorted by clicks, with impressions, CTR and position. Live from Google Search Console. Page through full exports with offset+limit.",
      inputSchema: pageableSchema,
      outputSchema: envelope({
        site: STR,
        range: OBJ,
        offset: NUM,
        limit: NUM,
        count: NUM,
        queries: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const queries = await fetchQueries({
        site,
        accessToken,
        days: args.days ?? 28,
        limit: args.limit ?? 100,
        offset: args.offset ?? 0,
      });
      return ok({ site, range: windowRange(args.days ?? 28), offset: args.offset ?? 0, limit: args.limit ?? 100, count: queries.length, queries });
    }
  );

  server.registerTool(
    "get_pages",
    {
      title: "Get top organic pages",
      description:
        "Returns the highest-traffic pages for a site over a window, sorted by clicks, with impressions, CTR and position; joins each page with its crawled title, meta description and word count when available. Live GSC + stored crawl data. Page through with offset+limit.",
      inputSchema: pageableSchema,
      outputSchema: envelope({
        site: STR,
        range: OBJ,
        offset: NUM,
        limit: NUM,
        count: NUM,
        pages: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const rows = await fetchPages({
        site,
        accessToken,
        days: args.days ?? 28,
        limit: args.limit ?? 100,
        offset: args.offset ?? 0,
      });
      const pages = await enrichPages(userId, site, rows);
      return ok({ site, range: windowRange(args.days ?? 28), offset: args.offset ?? 0, limit: args.limit ?? 100, count: pages.length, pages });
    }
  );

  server.registerTool(
    "get_ideas",
    {
      title: "Get content ideas",
      description:
        "Returns the latest generated content-ideas run for a site (gap, striking-distance, intent-mismatch, winner-expansion, new-topic). Stored on the account after a crawl+research run.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
      outputSchema: envelope({
        hasRun: z.boolean(),
        generatedAt: STR,
        stats: OBJ,
        ideas: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const { idea_runs } = await getCollections();
      const run = await idea_runs
        .find({ userId, siteUrl: site })
        .sort({ generatedAt: -1 })
        .limit(1)
        .next();
      if (!run) {
        return ok({ hasRun: false, generatedAt: null, stats: null, ideas: [] });
      }
      return ok({ hasRun: true, generatedAt: run.generatedAt, stats: run.stats, ideas: run.ideas });
    }
  );

  server.registerTool(
    "get_recommendations",
    {
      title: "Get on-page recommendations",
      description:
        "Runs the recs engine live: combines crawled page content with Google clicks/impressions to surface actionable SEO fixes (missing meta, thin content, striking-distance keywords, etc.). Grouped recs include per-page evidence (title, meta, word count).",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
      outputSchema: envelope({
        count: NUM,
        recommendations: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const accessToken = await getAccessToken(user);
      const connections = await loadConnections(userId);
      const recommendations = await getRecommendations({ userId, site, accessToken, connections });
      return ok({ count: recommendations.length, recommendations });
    }
  );

  server.registerTool(
    "get_crawl_status",
    {
      title: "Get crawl / analysis status",
      description:
        "Returns stored page crawl state: number of pages with metrics, how many have been content-crawled, and the most recent sync. Useful to know if the account has crawled a property yet.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
      },
      outputSchema: envelope({
        site: STR,
        pagesWithMetrics: NUM,
        pagesWithContent: NUM,
        lastSyncedAt: STR,
      }),
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
      return ok({
        site: q.siteUrl,
        pagesWithMetrics,
        pagesWithContent,
        lastSyncedAt: latest?.syncedAt ?? null,
      });
    }
  );

  server.registerTool(
    "get_page_content",
    {
      title: "Get crawled page content",
      description:
        "Returns the crawled on-page content we stored for pages of a site: title, meta description, headings, word count, structured data, http status. Filter by path prefix or list by traffic. Stored data — not live fetches (use get_page_html for that).",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        path: z.string().optional().describe("Exact normalized path to look up (e.g. /blog/post-1)."),
        prefix: z.string().optional().describe("Path prefix to filter, e.g. /blog"),
        limit: z.number().int().min(1, "limit must be between 1 and 500").max(500, "limit must be between 1 and 500").optional().describe("Max rows (default 200, sorted by impressions desc)."),
      },
      outputSchema: envelope({
        matched: NUM,
        path: STR,
        page: OBJ,
        count: NUM,
        pages: OBJS,
      }),
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
        if (!hit) return ok({ matched: 0, path: args.path, page: null, count: 0, pages: [] });
        return ok({ matched: 1, path: args.path, page: hit, count: 1, pages: [hit] });
      }
      return ok({ count: rows.length, pages: rows });
    }
  );

  server.registerTool(
    "get_rec_enhancements",
    {
      title: "Get AI-enhanced recommendations",
      description:
        "Returns the stored AI fix plans for recommendations (why, steps, draft title/meta, agent prompt), keyed by rec id. For a richer view of recommendations pairing with the rule output, see get_recommendations.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        recId: z.string().optional().describe("Specific rec id to fetch (e.g. /blog/post::missing-meta). Omit for all."),
      },
      outputSchema: envelope({
        count: NUM,
        enhancements: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const { rec_enhancements } = await getCollections();
      const filter: Record<string, unknown> = { userId, siteUrl: site };
      if (args.recId) filter.recId = args.recId;
      const docs = await rec_enhancements.find(filter).sort({ updatedAt: -1 }).toArray();
      const rows = docs.map(({ _id: _d, userId: _u, siteUrl: _s, ...rest }) => rest);
      return ok({ count: rows.length, enhancements: rows });
    }
  );

  server.registerTool(
    "get_idea_detail",
    {
      title: "Get a single idea's full detail",
      description:
        "Returns one idea from the latest run — full evidence incl. top queries, covering pages, autocomplete phrasings, validation, plus the AI angle/outline if packaged.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        ideaId: z.string().min(1, "ideaId is required").describe("The idea's id (from get_ideas)."),
      },
      outputSchema: envelope({
        found: z.boolean(),
        idea: OBJ,
      }),
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
      if (!idea) return ok({ found: false, idea: null });
      return ok({ found: true, idea });
    }
  );

  server.registerTool(
    "get_page_queries",
    {
      title: "Get queries ranking for a page",
      description:
        "Live from Search Console: the queries that send traffic to a specific page, with clicks, impressions, CTR and position. Dimension pair [page, query] filtered by page.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        page: z.string().min(1, "page is required").describe("The page path (e.g. /blog/post-1) or full URL."),
        days: z.number().int().min(1, "days must be between 1 and 90").max(90, "days must be between 1 and 90").optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1, "limit must be between 1 and 300").max(300, "limit must be between 1 and 300").optional().describe("Max rows (default 50)."),
      },
      outputSchema: envelope({
        page: STR,
        normalizedPath: STR,
        count: NUM,
        queries: OBJS,
      }),
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
      return ok({ page: args.page, normalizedPath: normalizePath(args.page), count: rows.length, queries: rows });
    }
  );

  server.registerTool(
    "get_query_pages",
    {
      title: "Get pages ranking for a query",
      description:
        "Live from Search Console: the pages ranking for a specific query, with clicks, impressions, CTR and position. Useful for seeing which page competes in a topic.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        query: z.string().min(1, "query is required").describe("The exact query to filter by."),
        days: z.number().int().min(1, "days must be between 1 and 90").max(90, "days must be between 1 and 90").optional().describe("Window length in days (default 28)."),
        limit: z.number().int().min(1, "limit must be between 1 and 100").max(100, "limit must be between 1 and 100").optional().describe("Max rows (default 20)."),
      },
      outputSchema: envelope({
        query: STR,
        count: NUM,
        pages: OBJS,
      }),
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
      return ok({ query: args.query, count: pages.length, pages });
    }
  );

  server.registerTool(
    "list_idea_runs",
    {
      title: "List idea-generation runs",
      description:
        "Returns the metadata (not the ideas) of every idea run for the site — generatedAt and stats — so you can see history and whether runs degraded.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
      },
      outputSchema: envelope({
        count: NUM,
        runs: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const { idea_runs } = await getCollections();
      const runs = await idea_runs
        .find({ userId, siteUrl: site }, { projection: { ideas: 0 } })
        .sort({ generatedAt: -1 })
        .limit(20)
        .toArray();
      return ok({ count: runs.length, runs });
    }
  );

  server.registerTool(
    "get_page_html",
    {
      title: "Get live page HTML + heading map",
      description:
        "Fetches a page of the user's own site right now and parses its DOM: title, meta description, canonical, word count, and every heading with its level and on-page order, plus the raw HTML itself (helpful for DOM/structure auditing). Respects the site's robots.txt-disallowed paths are NOT blocked here; live, one-page fetch.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the active property."),
        page: z.string().min(1, "page is required").describe("Page path (e.g. /blog/post-1) or full URL on the same origin."),
        includeHtml: z.boolean().optional().describe("Include the raw HTML in the response (default false — set true for the full markup)."),
      },
      outputSchema: envelope({
        origin: STR,
        url: STR,
        finalUrl: STR,
        httpStatus: NUM,
        contentType: STR,
        fetchedAt: STR,
        sizeBytes: NUM,
        title: STR,
        metaDescription: STR,
        canonical: STR,
        wordCount: NUM,
        headings: OBJS,
        html: STR,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const result = await fetchPageHtml({ site, page: args.page });
      const { html, ...meta } = result;
      return ok({
        ...meta,
        html: args.includeHtml ? html : null,
      });
    }
  );

  server.registerTool(
    "get_query_opportunities",
    {
      title: "Get query-level growth opportunities",
      description:
        "Runs the opportunities math across ALL queries (not just an ideas run): for every query, the best-ranking page, the words the page misses vs the query, projected clicks at top 3 and top 1, the headroom (clicks left on the table), intent, cluster, and a deterministic fixing suggestion. Sorted by headroom at top 3, descending. Live GSC + stored crawl content.",
      inputSchema: {
        site: z.string().optional().describe("Search Console property (URL). Defaults to the account's active property."),
        days: z.number().int().min(1, "days must be between 1 and 90").max(90, "days must be between 1 and 90").optional().describe("Window length in days (default 28)."),
        offset: z.number().int().min(0, "offset must be >= 0").max(25000, "offset must be <= 25000").optional().describe("Row offset for paging. Default 0."),
        limit: z.number().int().min(1, "limit must be between 1 and 500").max(500, "limit must be between 1 and 500").optional().describe("Max rows (default 100)."),
        minImpressions: z.number().int().min(0, "minImpressions must be >= 0").optional().describe("Only include queries with at least this many impressions (default 0 = all)."),
        queryContains: z.string().optional().describe("Only include queries containing this substring (case-insensitive)."),
        excludeBranded: z.boolean().optional().describe("Drop queries containing the brand token (default true)."),
      },
      outputSchema: envelope({
        site: STR,
        range: OBJ,
        offset: NUM,
        limit: NUM,
        count: NUM,
        total: NUM,
        queries: OBJS,
      }),
    },
    async (args) => {
      const site = getSite(args.site);
      const opportunities = await computeQueryOpportunities(userId, user, {
        site,
        days: args.days ?? 28,
        minImpressions: args.minImpressions,
        queryContains: args.queryContains,
        excludeBranded: args.excludeBranded,
      });
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const page = opportunities.slice(offset, offset + limit);
      return ok({
        site,
        range: windowRange(args.days ?? 28),
        offset,
        limit,
        count: page.length,
        total: opportunities.length,
        queries: page,
      });
    }
  );

  return server;
}

function windowRange(days: number) {
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));
  return { start: iso(start), end: iso(end) };
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