import { google } from "googleapis";
import type { UserDoc } from "./db.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;

// Access tokens are short-lived; refresh lazily and reuse them instead of
// hammering Google's token endpoint on every tool call.
const accessTokenCache = new Map<
  string,
  { accessToken: string; cachedAt: number }
>();

type GscRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

export type MetricRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type Totals = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function toMetricRows(rows: GscRow[]): MetricRow[] {
  return rows.map((r) => ({
    key: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export function sumTotals(rows: MetricRow[]): Totals {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const weightedPos = rows.reduce((a, r) => a + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weightedPos / impressions : 0,
  };
}

/** Get a valid GSC access token for a user, refreshing if the cached one is stale. */
export async function getAccessToken(user: UserDoc): Promise<string> {
  const refreshToken = user.googleRefreshToken;
  if (!refreshToken) throw new Error("gsc_not_connected");

  const now = Date.now();
  const cached = accessTokenCache.get(user.userId);
  if (cached && now - cached.cachedAt < TOKEN_TTL_MS) {
    return cached.accessToken;
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  const accessToken = credentials.access_token;
  if (!accessToken) throw new Error("no_access_token");

  accessTokenCache.set(user.userId, { accessToken, cachedAt: now });
  if (accessTokenCache.size > 1000) accessTokenCache.clear();
  return accessToken;
}

function getSearchConsole(accessToken: string) {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.searchconsole({ version: "v1", auth: oauth2 });
}

/** Mirror of the app's /api/stats shape: totals, prev totals, date series, top queries and pages. */
export async function fetchOverview(opts: {
  site: string;
  accessToken: string;
  days: number;
}) {
  const { site, accessToken } = opts;
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const searchconsole = getSearchConsole(accessToken);

  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));

  const query = async (
    startDate: string,
    endDate: string,
    dimensions: string[],
    rowLimit: number
  ) => {
    const { data } = await searchconsole.searchanalytics.query({
      siteUrl: site,
      requestBody: { startDate, endDate, dimensions, rowLimit },
    });
    return toMetricRows((data.rows ?? []) as GscRow[]);
  };

  const [series, queries, pages, prevSeries] = await Promise.all([
    query(iso(start), iso(end), ["date"], 100),
    query(iso(start), iso(end), ["query"], 25),
    query(iso(start), iso(end), ["page"], 25),
    query(iso(prevStart), iso(prevEnd), ["date"], 100),
  ]);

  return {
    range: {
      start: iso(start),
      end: iso(end),
      prevStart: iso(prevStart),
      prevEnd: iso(prevEnd),
    },
    totals: sumTotals(series),
    prevTotals: sumTotals(prevSeries),
    series: series.map((r) => ({
      date: r.key,
      clicks: r.clicks,
      impressions: r.impressions,
    })),
    queries: [...queries].sort((a, b) => b.clicks - a.clicks),
    pages: [...pages].sort((a, b) => b.clicks - a.clicks),
  };
}

/** Top queries over a window with optional per-page breakdown. */
export async function fetchQueries(opts: {
  site: string;
  accessToken: string;
  days: number;
  limit: number;
}) {
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const limit = Math.min(Math.max(opts.limit || 100, 1), 300);
  const searchconsole = getSearchConsole(opts.accessToken);
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl: opts.site,
    requestBody: {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["query"],
      rowLimit: limit,
    },
  });
  return toMetricRows((data.rows ?? []) as GscRow[]).sort(
    (a, b) => b.clicks - a.clicks
  );
}

/** Top pages over a window. */
export async function fetchPages(opts: {
  site: string;
  accessToken: string;
  days: number;
  limit: number;
}) {
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const limit = Math.min(Math.max(opts.limit || 50, 1), 300);
  const searchconsole = getSearchConsole(opts.accessToken);
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl: opts.site,
    requestBody: {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["page"],
      rowLimit: limit,
    },
  });
  return toMetricRows((data.rows ?? []) as GscRow[]).sort(
    (a, b) => b.clicks - a.clicks
  );
}

/** Per-query ranking pages: dimensions ["query","page"], filtered to one query. */
export async function fetchQueryPages(opts: {
  site: string;
  accessToken: string;
  query: string;
  days: number;
  limit: number;
}) {
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  const searchconsole = getSearchConsole(opts.accessToken);
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl: opts.site,
    requestBody: {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["query", "page"],
      rowLimit: limit,
      dimensionFilterGroups: [
        {
          filters: [
            {
              dimension: "query",
              operator: "equals",
              expression: opts.query,
            },
          ],
        },
      ],
    },
  });
  return ((data.rows ?? []) as GscRow[])
    .map((r) => ({
      query: r.keys?.[0] ?? "",
      page: r.keys?.[1] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }))
    .sort((a, b) => b.clicks - a.clicks);
}

/** Per-page queries: dimensions ["page","query"], filtered client-side to one page. */
export async function fetchPageQueryPairs(opts: {
  site: string;
  accessToken: string;
  page: string;
  days: number;
  limit: number;
}) {
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const limit = Math.min(Math.max(opts.limit || 50, 1), 300);
  const searchconsole = getSearchConsole(opts.accessToken);
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));

  const want = normalizePage(opts.page);
  const { data } = await searchconsole.searchanalytics.query({
    siteUrl: opts.site,
    requestBody: {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["page", "query"],
      rowLimit: limit,
    },
  });
  return ((data.rows ?? []) as GscRow[])
    .map((r) => ({
      page: r.keys?.[0] ?? "",
      query: r.keys?.[1] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }))
    .filter((r) => normalizePage(r.page) === want)
    .sort((a, b) => b.clicks - a.clicks);
}

function normalizePage(p: string): string {
  let x = p.trim();
  try {
    x = new URL(x).pathname;
  } catch {
    /* already a path */
  }
  if (x.length > 1 && x.endsWith("/")) x = x.slice(0, -1);
  return x || "/";
}

/** Page-level rows over a window (for cross-tool joins). */
export async function fetchPageRows(opts: {
  site: string;
  accessToken: string;
  days: number;
  rowLimit: number;
}): Promise<MetricRow[]> {
  const days = Math.min(Math.max(opts.days || 28, 1), 90);
  const searchconsole = getSearchConsole(opts.accessToken);
  const end = addDays(new Date(), -3);
  const start = addDays(end, -(days - 1));

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl: opts.site,
    requestBody: {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["page"],
      rowLimit: opts.rowLimit,
    },
  });
  return toMetricRows((data.rows ?? []) as GscRow[]);
}