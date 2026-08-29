import { google } from "googleapis";
import type { WithId } from "mongodb";
import { getDb, type PageContentDoc, type PageDoc } from "./db.js";
import { fetchPosthogStats } from "./posthog.js";
import { generateRecommendations, type EnrichedContent, type PageQueryRow, type Rec, type RuleInputs } from "./rules.js";
import { normalizePath } from "./url.js";

type GscRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

export type ConnectionsInput = {
  userId: string;
  provider: string;
  apiKey?: string;
  host?: string;
  projectId?: number;
}[];

export async function buildRuleInputs(opts: {
  userId: string;
  site: string;
  accessToken: string;
  connections: ConnectionsInput;
}): Promise<{ inputs: RuleInputs; contentDocs: WithId<PageContentDoc>[]; pageDocs: PageDoc[] }> {
  const db = await getDb();
  const pages = db.collection<PageDoc>("pages");
  const page_content = db.collection<PageContentDoc>("page_content");

  const [pageDocs, contentDocs] = await Promise.all([
    pages.find({ userId: opts.userId, siteUrl: opts.site, active: { $ne: false } }).toArray(),
    page_content.find({ userId: opts.userId, siteUrl: opts.site }).toArray(),
  ]);

  const metricsByPath = new Map<string, PageDoc>(pageDocs.map((p) => [p.path, p]));
  const contents: EnrichedContent[] = contentDocs.map((c) => {
    const m = metricsByPath.get(c.path);
    return { ...c, clicks: m?.clicks ?? 0, impressions: m?.impressions ?? 0 };
  });

  const ph = opts.connections.find((c) => c.provider === "posthog" && c.apiKey);
  let posthogConnected = false;
  const phViewsByPath = new Map<string, number>();
  if (ph) {
    try {
      const stats = await fetchPosthogStats({
        host: ph.host,
        apiKey: ph.apiKey!,
        projectId: ph.projectId,
        days: 28,
        limit: 50,
      });
      posthogConnected = true;
      for (const p of stats.topPages) phViewsByPath.set(normalizePath(p.path), p.views);
    } catch {
      // PostHog unreachable — skip tracking-gap rule
    }
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: opts.accessToken });
  const searchconsole = google.searchconsole({ version: "v1", auth: oauth2 });

  const end = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 27 * 24 * 60 * 60 * 1000);

  let pageQueries: PageQueryRow[] = [];
  try {
    const { data } = await searchconsole.searchanalytics.query({
      siteUrl: opts.site,
      requestBody: {
        startDate: iso(start),
        endDate: iso(end),
        dimensions: ["page", "query"],
        rowLimit: 500,
      },
    });
    pageQueries = ((data.rows ?? []) as GscRow[])
      .map((r) => ({
        path: normalizePath(r.keys?.[0] ?? ""),
        query: r.keys?.[1] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        position: r.position ?? 0,
      }))
      .filter((r) => r.path && r.query);
  } catch {
    // striking-distance rule degrades silently
  }

  return {
    inputs: { contents, phViewsByPath, posthogConnected, pageQueries },
    contentDocs,
    pageDocs,
  };
}

export async function getRecommendations(opts: {
  userId: string;
  site: string;
  accessToken: string;
  connections: ConnectionsInput;
}): Promise<Rec[]> {
  const built = await buildRuleInputs(opts);
  return generateRecommendations(built.inputs);
}