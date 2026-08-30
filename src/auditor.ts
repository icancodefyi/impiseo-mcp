// Live PageSpeed + CrUX auditor, mirrored from the Impiseo app's /api/auditor
// route. Runs all four Lighthouse categories in parallel (the PSI API only
// returns the Performance category when no category filter is passed), merges
// the results, and flattens them into a compact, agent-friendly summary.
//
// The output is deliberately smaller than the raw Lighthouse report (which can
// be 600KB+): only category scores, real-user field data, and the failing
// audits with their concrete savings are kept.

const CATEGORIES = [
  { key: "performance", param: "PERFORMANCE" },
  { key: "accessibility", param: "ACCESSIBILITY" },
  { key: "best-practices", param: "BEST_PRACTICES" },
  { key: "seo", param: "SEO" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

type PsiResult = { disabled: boolean; message?: string; json?: any };

async function callPsi(
  url: string,
  strategy: string,
  key: string,
  category: { key: CategoryKey; param: string }
): Promise<PsiResult> {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("category", category.param);
  endpoint.searchParams.set("key", key);

  const res = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    const disabled =
      res.status === 403 ||
      body?.error?.status === "PERMISSION_DENIED" ||
      body?.error?.details?.some((d: { reason?: string }) => d.reason === "SERVICE_DISABLED");
    return { disabled, message: body?.error?.message ?? `PageSpeed API returned HTTP ${res.status}` };
  }
  return { disabled: false, json: await res.json() };
}

function fmtMs(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s`;
  return `${Math.round(v)} ms`;
}

function displayFor(metricId: string, value: number): string {
  return /_MS$/.test(metricId) ? fmtMs(value) : value.toFixed(2);
}

export type AuditItem = {
  url: string | null;
  description?: string;
  wastedBytes?: number;
  totalBytes?: number;
  wastedMs?: number;
};

export type FailureAudit = {
  category: CategoryKey;
  id: string;
  title: string;
  description?: string;
  score: number | null;
  displayValue?: string;
  scoreDisplayMode?: string;
  savingsBytes?: number;
  savingsMs?: number;
  items: AuditItem[];
};

export type FieldMetric = {
  id: string;
  name: string;
  display: string;
  percentile: number;
  category: string | null;
  distributions: { proportion?: number; category?: string }[];
};

export type AuditSummary = {
  requestedUrl: string | null;
  finalUrl: string | null;
  strategy: string;
  fetchedAt: string | null;
  scores: Partial<Record<CategoryKey, number>>;
  fieldData: {
    overall: string | null;
    originOverall: string | null;
    metrics: FieldMetric[];
  };
  failures: FailureAudit[];
  passedCounts: Record<CategoryKey, number>;
  failedCounts: Record<CategoryKey, number>;
};

export type AuditOutcome =
  | { ok: true; summary: AuditSummary }
  | { ok: false; disabled?: boolean; keyMissing?: boolean; error: string };

const FIELD_NAMES: Record<string, string> = {
  LARGEST_CONTENTFUL_PAINT_MS: "Largest Contentful Paint",
  INTERACTION_TO_NEXT_PAINT: "Interaction to Next Paint",
  INTERACTION_TO_NEXT_PAINT_MS: "Interaction to Next Paint",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "Cumulative Layout Shift",
  FIRST_CONTENTFUL_PAINT_MS: "First Contentful Paint",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "Time to First Byte",
};

const FIELD_CANDIDATE_KEYS: Record<string, string[]> = {
  LARGEST_CONTENTFUL_PAINT_MS: ["LARGEST_CONTENTFUL_PAINT_MS"],
  INTERACTION_TO_NEXT_PAINT: ["INTERACTION_TO_NEXT_PAINT", "INTERACTION_TO_NEXT_PAINT_MS"],
  CUMULATIVE_LAYOUT_SHIFT_SCORE: ["CUMULATIVE_LAYOUT_SHIFT_SCORE"],
  FIRST_CONTENTFUL_PAINT_MS: ["FIRST_CONTENTFUL_PAINT_MS"],
};

function atoi(m: any, keys: string[]): any {
  for (const k of keys) if (m?.[k]) return m[k];
  return null;
}

export async function runPageAudit(url: string, strategy: "mobile" | "desktop"): Promise<AuditOutcome> {
  const psiKey = process.env.GOOGLE_API_KEY?.trim() || process.env.CRUX_API_KEY?.trim();
  if (!psiKey) {
    return { ok: false, keyMissing: true, error: "No Google API key configured (GOOGLE_API_KEY or CRUX_API_KEY)." };
  }

  const results = await Promise.allSettled(
    CATEGORIES.map((c) => callPsi(url, strategy, psiKey, c))
  );
  const ok = results
    .filter((r): r is PromiseFulfilledResult<PsiResult> => r.status === "fulfilled" && Boolean(r.value.json))
    .map((r) => r.value.json as any);

  const disabled = results.some(
    (r): r is PromiseFulfilledResult<PsiResult> => r.status === "fulfilled" && r.value.disabled
  );
  const errors = results
    .filter((r): r is PromiseFulfilledResult<PsiResult> => r.status === "fulfilled" && Boolean(r.value.message))
    .map((r) => r.value.message as string);

  if (ok.length === 0) {
    if (disabled) {
      return {
        ok: false,
        disabled: true,
        error:
          "PageSpeed Insights API is not enabled for this API key. Enable it at https://console.developers.google.com/apis/api/pagespeedonline.googleapis.com/overview",
      };
    }
    return { ok: false, error: errors[0] ?? "PageSpeed audit failed (all categories errored or timed out)." };
  }

  // Merge the per-category Lighthouse passes.
  const audits: Record<string, any> = {};
  const categories: Record<string, any> = {};
  const refsByCategory: Record<string, string[]> = {};
  let requestedUrl: string | null = null;
  let finalUrl: string | null = null;
  let fetchedAt: string | null = null;
  let loadingExperience: any = null;
  let originLoadingExperience: any = null;

  for (const j of ok) {
    const lh = j.lighthouseResult;
    if (lh) {
      Object.assign(audits, lh.audits ?? {});
      Object.assign(categories, lh.categories ?? {});
      for (const [cname, c] of Object.entries(lh.categories ?? {})) {
        refsByCategory[cname] = (c as any).auditRefs?.map((r: any) => r.id) ?? [];
      }
      if (!fetchedAt && lh.fetchTime) fetchedAt = lh.fetchTime;
    }
    if (!requestedUrl && j.requestedUrl) requestedUrl = j.requestedUrl;
    if (!finalUrl && j.finalUrl) finalUrl = j.finalUrl;
    if (!loadingExperience && j.loadingExperience) loadingExperience = j.loadingExperience;
    if (!originLoadingExperience && j.originLoadingExperience) originLoadingExperience = j.originLoadingExperience;
  }

  const scores: Partial<Record<CategoryKey, number>> = {};
  const passedCounts = { performance: 0, accessibility: 0, "best-practices": 0, seo: 0 } as Record<CategoryKey, number>;
  const failedCounts = { performance: 0, accessibility: 0, "best-practices": 0, seo: 0 } as Record<CategoryKey, number>;

  for (const { key } of CATEGORIES) {
    const cat = categories[key];
    if (cat && typeof cat.score === "number") scores[key] = Math.round(cat.score * 100);
  }

  const failures: FailureAudit[] = [];
  for (const { key } of CATEGORIES) {
    const ids = refsByCategory[key] ?? [];
    const failing: FailureAudit[] = [];
    for (const id of ids) {
      const a = audits[id];
      if (!a) continue;
      if (typeof a.score === "number" && a.score >= 0.9) {
        passedCounts[key] += 1;
        continue;
      }
      if (a.score === null || a.score === undefined) continue;
      failedCounts[key] += 1;
      const details = a.details ?? {};
      const items: AuditItem[] = (details.items ?? [])
        .slice(0, 8)
        .map((it: any) => ({
          url: it.url ?? null,
          description: it.description ?? undefined,
          wastedBytes: typeof it.wastedBytes === "number" ? it.wastedBytes : undefined,
          totalBytes: typeof it.totalBytes === "number" ? it.totalBytes : undefined,
          wastedMs: typeof it.wastedMs === "number" ? it.wastedMs : undefined,
        }));
      failing.push({
        category: key,
        id,
        title: a.title ?? id,
        description: a.description ?? undefined,
        score: a.score,
        displayValue: a.displayValue ?? undefined,
        scoreDisplayMode: a.scoreDisplayMode,
        savingsBytes: typeof details.overallSavingsBytes === "number" ? details.overallSavingsBytes : undefined,
        savingsMs: typeof details.overallSavingsMs === "number" ? details.overallSavingsMs : undefined,
        items,
      });
    }
    failing.sort((x, y) => (y.savingsBytes ?? 0) + (y.savingsMs ?? 0) * 1024 - ((x.savingsBytes ?? 0) + (x.savingsMs ?? 0) * 1024));
    failures.push(...failing.slice(0, 12));
  }

  const metrics: FieldMetric[] = [];
  const rawMetrics = loadingExperience?.metrics ?? {};
  for (const [id, candKeys] of Object.entries(FIELD_CANDIDATE_KEYS)) {
    const raw = atoi(rawMetrics, candKeys);
    if (!raw || typeof raw.percentile !== "number") continue;
    metrics.push({
      id,
      name: FIELD_NAMES[id] ?? id,
      display: displayFor(id, raw.percentile),
      percentile: raw.percentile,
      category: raw.category ?? null,
      distributions: raw.distributions ?? [],
    });
  }

  const summary: AuditSummary = {
    requestedUrl,
    finalUrl,
    strategy,
    fetchedAt,
    scores,
    fieldData: {
      overall: loadingExperience?.overall_category ?? null,
      originOverall: originLoadingExperience?.overall_category ?? null,
      metrics,
    },
    failures,
    passedCounts,
    failedCounts,
  };
  return { ok: true, summary };
}