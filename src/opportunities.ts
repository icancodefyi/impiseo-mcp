import { getCollections } from "./db.js";
import type { UserDoc } from "./db.js";
import { getAccessToken, fetchAllQueryPagePairs } from "./gsc.js";
import { normalizePath } from "./url.js";

// Organic CTR averages by position — same conservative industry curve used by
// the app's ideas engine, interpolated between the anchor points.
const CTR_CURVE: [number, number][] = [
  [1, 0.28],
  [2, 0.15],
  [3, 0.1],
  [4, 0.07],
  [5, 0.05],
  [6, 0.04],
  [7, 0.032],
  [8, 0.026],
  [9, 0.021],
  [10, 0.017],
  [12, 0.012],
  [15, 0.008],
  [20, 0.005],
];

export function expectedCtr(pos: number): number {
  if (!Number.isFinite(pos) || pos <= CTR_CURVE[0][0]) return CTR_CURVE[0][1];
  const last = CTR_CURVE[CTR_CURVE.length - 1];
  if (pos >= last[0]) return last[1];
  for (let i = 0; i < CTR_CURVE.length - 1; i++) {
    const [p1, c1] = CTR_CURVE[i];
    const [p2, c2] = CTR_CURVE[i + 1];
    if (pos >= p1 && pos <= p2) return c1 + ((c2 - c1) * (pos - p1)) / (p2 - p1);
  }
  return last[1];
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "for", "to", "with", "at", "by",
  "from", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
  "those", "how", "what", "when", "where", "which", "who", "why", "can", "do", "does",
  "did", "vs", "versus", "best", "top", "my", "your", "i", "you", "we", "our", "me",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function brandTokenFor(site: string): string | null {
  let host = site.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  host = host.replace(/^www\./, "").toLowerCase();
  const core = host.split(".")[0] ?? "";
  const token = core.replace(/[^a-z0-9]/g, "");
  return token.length >= 4 ? token : null;
}

const INTENT_RX = {
  transactional:
    /\b(pdf|download|buy|price|cost|fee|fees|apply|admission|login|register|signup|sign up|purchase|order|enroll|eligible|eligibility|book|ticket|result card)\b/,
  informational:
    /\b(meaning|rules|marks|marking|syllabus|notes|strategy|interview|answer|solved|solution|difference|analysis|review|preparation|tips|trick|list|summary|how|what|why|when)\b/,
};

export type QueryOpportunity = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  intent: "transactional" | "informational" | "navigational" | "other";
  topPagePath: string | null;
  pageTitle: string | null;
  matchScore: number | null;
  missingTerms: string[];
  clusterId: string | null;
  clusterTopic: string | null;
  clusterSize: number;
  projectedTop3: number;
  headroomTop3: number;
  projectedTop1: number;
  headroomTop1: number;
  fixing: string;
};

export type OpportunitiesOptions = {
  site?: string;
  days?: number;
  minImpressions?: number;
  queryContains?: string;
  excludeBranded?: boolean;
};

function classifyIntent(
  query: string,
  tokens: string[],
  brand: string | null
): QueryOpportunity["intent"] {
  if (brand && tokens.includes(brand)) return "navigational";
  if (INTENT_RX.transactional.test(query)) return "transactional";
  if (INTENT_RX.informational.test(query)) return "informational";
  return "other";
}

function bestToken(tokens: string[], tokenImpr: Map<string, number>): string | null {
  let best: string | null = null;
  let bestImpr = -1;
  for (const t of tokens) {
    const i = tokenImpr.get(t) ?? 0;
    if (i > bestImpr) {
      best = t;
      bestImpr = i;
    }
  }
  return best;
}

function round(v: number): number {
  return Math.round(v);
}

type QueryAgg = {
  impressions: number;
  clicks: number;
  posSum: number;
  topPage: string | null;
};

export async function computeQueryOpportunities(
  userId: string,
  user: UserDoc,
  opts: OpportunitiesOptions
): Promise<QueryOpportunity[]> {
  const days = Math.min(Math.max(opts.days ?? 28, 1), 90);
  const site = opts.site ?? user.activeProperty ?? user.siteUrl;
  if (!site) throw new Error("No active property for this account");

  const accessToken = await getAccessToken(user);
  const pairs = await fetchAllQueryPagePairs({ site, accessToken, days });
  if (pairs.length === 0) return [];

  const brand = brandTokenFor(site);
  const minImpr = Math.max(0, opts.minImpressions ?? 0);
  const qFilter = opts.queryContains?.toLowerCase() ?? null;
  const excludeBranded = opts.excludeBranded !== false;

  // Aggregate per query: totals, impressions-weighted position, best page.
  const byQuery = new Map<string, typeof pairs>();
  for (const p of pairs) {
    const arr = byQuery.get(p.query);
    if (arr) arr.push(p);
    else byQuery.set(p.query, [p]);
  }
  const aggs = new Map<string, QueryAgg>();
  for (const [query, ps] of byQuery) {
    let impressions = 0;
    let clicks = 0;
    let posSum = 0;
    let topPage: string | null = null;
    let topClicks = -1;
    for (const p of ps) {
      impressions += p.impressions;
      clicks += p.clicks;
      posSum += p.position * p.impressions;
      if (p.clicks > topClicks) {
        topClicks = p.clicks;
        topPage = p.page;
      }
    }
    aggs.set(query, { impressions, clicks, posSum, topPage });
  }

  // Filters + token stats over kept queries.
  const kept: { query: string; agg: QueryAgg; tokens: string[] }[] = [];
  const tokenImpr = new Map<string, number>();
  const tokenQueryCount = new Map<string, number>();
  for (const [query, agg] of aggs) {
    if (agg.impressions < minImpr) continue;
    if (qFilter && !query.toLowerCase().includes(qFilter)) continue;
    const tokens = tokenize(query);
    if (excludeBranded && brand && tokens.includes(brand)) continue;
    kept.push({ query, agg, tokens });
    for (const t of new Set(tokens)) {
      tokenImpr.set(t, (tokenImpr.get(t) ?? 0) + agg.impressions);
      tokenQueryCount.set(t, (tokenQueryCount.get(t) ?? 0) + 1);
    }
  }

  // One batched content lookup for the best pages we report on.
  const paths = [
    ...new Set(
      kept
        .map((k) => (k.agg.topPage ? normalizePath(k.agg.topPage) : null))
        .filter((p): p is string => p !== null)
    ),
  ];
  const { page_content } = await getCollections();
  const docs = paths.length
    ? await page_content.find({ userId, siteUrl: site, path: { $in: paths } }).toArray()
    : [];
  const contentByPath = new Map(docs.map((d) => [d.path, d]));

  const monthlyScale = 30 / days;
  const rows: QueryOpportunity[] = [];
  for (const { query, agg, tokens } of kept) {
    const impressions = agg.impressions;
    const clicks = agg.clicks;
    const position = impressions ? agg.posSum / impressions : 0;
    const ctr = impressions ? clicks / impressions : 0;
    const intent = classifyIntent(query, tokens, brand);

    const clusterId = bestToken(tokens, tokenImpr);
    const clusterTopic = clusterId;
    const clusterSize = clusterId ? (tokenQueryCount.get(clusterId) ?? 1) : 1;

    let pageTitle: string | null = null;
    let matchScore: number | null = null;
    let missingTerms: string[] = [];
    let topPagePath: string | null = null;
    if (agg.topPage) {
      topPagePath = normalizePath(agg.topPage);
      const c = contentByPath.get(topPagePath);
      if (c) {
        pageTitle = c.title ?? null;
        const haystack = new Set(
          tokenize(
            [c.path.replace(/\//g, " "), c.title ?? "", ...(c.headings ?? []).map((h) => h.text)].join(" ")
          )
        );
        missingTerms = tokens.filter((t) => !haystack.has(t));
        matchScore = tokens.length ? (tokens.length - missingTerms.length) / tokens.length : 0;
      }
    }

    const monthlyImpr = impressions * monthlyScale;
    const monthlyClicks = clicks * monthlyScale;
    const projectedTop3 = round(expectedCtr(3) * monthlyImpr);
    const projectedTop1 = round(expectedCtr(1) * monthlyImpr);

    rows.push({
      query,
      clicks,
      impressions,
      ctr: Number(ctr.toFixed(4)),
      position: Number(position.toFixed(1)),
      intent,
      topPagePath,
      pageTitle,
      matchScore: matchScore === null ? null : Number(matchScore.toFixed(2)),
      missingTerms,
      clusterId,
      clusterTopic,
      clusterSize,
      projectedTop3,
      headroomTop3: Math.max(0, projectedTop3 - Math.round(monthlyClicks)),
      projectedTop1,
      headroomTop1: Math.max(0, projectedTop1 - Math.round(monthlyClicks)),
      fixing: fixingMessage({
        position,
        ctr,
        topPagePath,
        matchScore,
        missingTerms,
      }),
    });
  }

  rows.sort((a, b) => b.headroomTop3 - a.headroomTop3);
  return rows;
}

function fixingMessage(o: {
  position: number;
  ctr: number;
  topPagePath: string | null;
  matchScore: number | null;
  missingTerms: string[];
}): string {
  const posFmt = o.position.toFixed(1);
  if (!o.topPagePath) return "No ranked page for this query on the property";
  if (o.matchScore === null)
    return `Ranks #${posFmt} — crawl "${o.topPagePath}" to analyze the on-page match`;
  const terms = o.missingTerms.join(", ");
  if (o.missingTerms.length > 0 && o.matchScore === 0)
    return `Search terms "${terms}" are entirely absent from the page's title & headings — total keyword gap`;
  if (o.missingTerms.length > 0)
    return `Add "${terms}" to the title or headings of ${o.topPagePath}`;
  const expected = expectedCtr(o.position);
  if (o.ctr < expected * 0.5)
    return `CTR ${(o.ctr * 100).toFixed(1)}% vs ${(expected * 100).toFixed(1)}% expected at #${posFmt} — rewrite title/snippet to match intent`;
  if (o.ctr < expected * 0.6)
    return `Snippet under-converting at #${posFmt} — add a format/date/price hook`;
  return `Well-positioned at #${posFmt} — push toward top 3 for more clicks`;
}