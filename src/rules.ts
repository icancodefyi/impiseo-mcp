import type { PageContentDoc } from "./db.js";

export type Rec = {
  id: string;
  type: string;
  severity: "high" | "medium" | "low";
  path: string | null;
  title: string;
  detail: string;
  action: string;
  impact: number;
  count?: number;
  paths?: { path: string; impressions: number; title?: string | null; metaDescription?: string | null; wordCount?: number }[];
};

export type EnrichedContent = PageContentDoc & {
  clicks: number;
  impressions: number;
};

export type PageQueryRow = {
  path: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type RuleInputs = {
  contents: EnrichedContent[];
  phViewsByPath: Map<string, number>;
  posthogConnected: boolean;
  pageQueries: PageQueryRow[];
};

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function makeRec(base: Omit<Rec, "impact">, impressions: number): Rec {
  return { ...base, impact: SEVERITY_WEIGHT[base.severity] * Math.max(impressions, 1) };
}

function ruleMetaIssues(c: EnrichedContent): Rec[] {
  const recs: Rec[] = [];

  if (!c.metaDescription) {
    recs.push(
      makeRec(
        {
          id: `${c.path}::missing-meta`,
          type: "meta",
          severity: c.impressions > 200 ? "high" : "medium",
          path: c.path,
          title: "Missing meta description",
          detail: `Google is inventing a snippet for this page (${nf(c.impressions)} impressions). You're leaving your pitch uncontrolled.`,
          action: "Write a 140–160 char description with the page's main keyword and value proposition.",
        },
        c.impressions
      )
    );
  } else if (c.metaDescription.length > 165) {
    recs.push(
      makeRec(
        {
          id: `${c.path}::long-meta`,
          type: "meta",
          severity: "low",
          path: c.path,
          title: "Meta description gets truncated",
          detail: `${c.metaDescription.length} chars — Google cuts off around 160.`,
          action: "Trim to ≤160 chars keeping the hook.",
        },
        c.impressions
      )
    );
  }

  if (c.title && (c.title.length > 62 || c.title.length < 30)) {
    recs.push(
      makeRec(
        {
          id: `${c.path}::title-length`,
          type: "title",
          severity: "low",
          path: c.path,
          title: c.title.length > 62 ? "Title likely truncated in SERP" : "Title is very short",
          detail: `Title is ${c.title.length} chars${c.title.length > 62 ? " — tail gets cut off (~60 max)" : ""}.`,
          action: c.title.length > 62 ? "Move the keyword toward the front; drop filler." : "Add qualifiers users search for (year, rank, subject…).",
        },
        c.impressions
      )
    );
  }

  const seen = new Map<string, number>();
  for (const h of c.headings) {
    const key = h.text.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  if (dupes.length > 0) {
    recs.push(
      makeRec(
        {
          id: `${c.path}::dupe-headings`,
          type: "structure",
          severity: "low",
          path: c.path,
          title: `Duplicate headings (${dupes.length})`,
          detail: `"${dupes.slice(0, 2).join('", "')}" appears multiple times — dilutes topical clarity.`,
          action: "Differentiate or merge the duplicated sections.",
        },
        c.impressions
      )
    );
  }

  return recs;
}

function ruleThinContent(c: EnrichedContent): Rec | null {
  if (c.wordCount >= 350 || c.impressions < 100) return null;
  return makeRec(
    {
      id: `${c.path}::thin`,
      type: "content",
      severity: c.wordCount < 150 ? "high" : "medium",
      path: c.path,
      title: `Thin content — ${c.wordCount} words`,
      detail: `This page gets real visibility (${nf(c.impressions)} impressions) but has little for Google to rank.`,
      action: "Expand with FAQs, comparisons, or examples targeting the queries below.",
    },
    c.impressions
  );
}

function ruleTrackingGap(c: EnrichedContent, phViewsByPath: Map<string, number>): Rec | null {
  const views = phViewsByPath.get(c.path);
  if (views === undefined || views > 0 || c.clicks < 10) return null;
  return makeRec(
    {
      id: `${c.path}::tracking-gap`,
      type: "analytics",
      severity: "high",
      path: c.path,
      title: "Search clicks with zero tracked views",
      detail: `Google reports ${nf(c.clicks)} clicks, but PostHog logged 0 pageviews. Either the analytics snippet is missing/blocked here, or these are bot clicks.`,
      action: "Check the PostHog snippet loads on this page.",
    },
    c.clicks * 10
  );
}

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
}

function ruleStrikingDistance(iq: RuleInputs): Rec[] {
  const byPath = new Map<string, EnrichedContent>(iq.contents.map((c) => [c.path, c]));
  const recs: Rec[] = [];
  const emitted = new Set<string>();

  for (const q of iq.pageQueries) {
    if (q.position < 4 || q.position > 20 || q.impressions < 30) continue;
    const c = byPath.get(q.path);
    if (!c || !c.title) continue;

    const tokens = tokenize(q.query);
    if (tokens.length === 0) continue;
    const haystack = [
      c.title,
      ...c.headings.filter((h) => h.level <= 2).map((h) => h.text),
    ]
      .join(" ")
      .toLowerCase();
    const missing = tokens.filter((t) => !haystack.includes(t));
    if (missing.length === tokens.length || missing.length === 0) continue;

    const id = `${q.path}::striking::${q.query}`;
    if (emitted.has(id)) continue;
    emitted.add(id);

    recs.push(
      makeRec(
        {
          id,
          type: "keyword",
          severity: q.position <= 12 ? "medium" : "low",
          path: q.path,
          title: `"${q.query}" ranks #${q.position.toFixed(1)} but isn't in your title/headings`,
          detail: `Missing terms: ${missing.join(", ")}. Pages ranking 4–20 with weak keyword alignment are the cheapest wins in SEO.`,
          action: `Work "${q.query}" naturally into the title or an H2, then expand a section around it.`,
        },
        q.impressions
      )
    );
  }
  return recs;
}

function nf(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

const GROUP_LABELS: Record<string, { title: (n: number) => string; action: string }> = {
  "title-length": {
    title: (n) => `${n} pages have titles longer than ~60 chars`,
    action: "This looks like a shared template. Shorten the template's title pattern once — every page benefits.",
  },
  "missing-meta": {
    title: (n) => `${n} pages are missing a meta description`,
    action: "If these share a template, add description generation to it; otherwise write them individually, worst-visibility pages first.",
  },
  "long-meta": {
    title: (n) => `${n} pages have meta descriptions longer than 160 chars`,
    action: "Trim the template's description pattern to ≤160 chars keeping the hook.",
  },
  "dupe-headings": {
    title: (n) => `${n} pages repeat the same heading multiple times`,
    action: "Usually a component rendered twice in the template — dedupe it once.",
  },
  thin: {
    title: (n) => `${n} high-visibility pages have thin content (<350 words)`,
    action: "Prioritize by impressions below — expand each with FAQs, comparisons, or examples targeting its queries.",
  },
};

function groupMechanicalRecs(recs: Rec[], contentsByPath: Map<string, EnrichedContent>): Rec[] {
  const grouped: Rec[] = [];
  const bySignal = new Map<string, Rec[]>();

  for (const r of recs) {
    const signal = r.id.split("::")[1];
    if (!signal || !GROUP_LABELS[signal]) {
      grouped.push(r);
      continue;
    }
    const list = bySignal.get(signal) ?? [];
    list.push(r);
    bySignal.set(signal, list);
  }

  for (const [signal, members] of bySignal) {
    if (members.length < 3) {
      grouped.push(...members);
      continue;
    }
    const label = GROUP_LABELS[signal];
    const severity = members.some((m) => m.severity === "high")
      ? "high"
      : members.some((m) => m.severity === "medium")
        ? "medium"
        : "low";
    const paths = members
      .filter((m) => m.path)
      .sort((a, b) => b.impact - a.impact)
      .map((m) => {
        const content = m.path ? contentsByPath.get(m.path) : undefined;
        return {
          path: m.path!,
          impressions: m.impact,
          title: content?.title ?? null,
          metaDescription: content?.metaDescription ?? null,
          wordCount: content?.wordCount,
        };
      });
    grouped.push({
      id: `group::${signal}`,
      type: members[0].type,
      severity,
      path: null,
      title: label.title(members.length),
      detail:
        signal === "dupe-headings"
          ? `Affects ${members.length} pages — likely the same component rendered twice.`
          : `Affects ${members.length} pages. Worst visibility: ${paths
              .slice(0, 3)
              .map((p) => p.path)
              .join(", ")}.`,
      action: label.action,
      impact: paths.reduce((sum, p) => sum + p.impressions, 0),
      count: members.length,
      paths,
    });
  }

  return grouped;
}

export function generateRecommendations(inputs: RuleInputs): Rec[] {
  const recs: Rec[] = [];

  for (const c of inputs.contents) {
    recs.push(...ruleMetaIssues(c));
    const thin = ruleThinContent(c);
    if (thin) recs.push(thin);
    if (inputs.posthogConnected) {
      const gap = ruleTrackingGap(c, inputs.phViewsByPath);
      if (gap) recs.push(gap);
    }
  }

  recs.push(...ruleStrikingDistance(inputs));

  const contentsByPath = new Map(inputs.contents.map((c) => [c.path, c]));
  return groupMechanicalRecs(recs, contentsByPath).sort((a, b) => b.impact - a.impact).slice(0, 40);
}