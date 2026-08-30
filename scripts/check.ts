import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.MCP_URL ?? "http://localhost:3777/mcp";
const KEY = process.argv[2] ?? process.env.MCP_API_KEY ?? "";

if (!KEY) {
  console.error("Usage: pnpm check <imp_..._key>   (or set MCP_API_KEY)");
  process.exit(1);
}

const client = new Client({ name: "check", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
  requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
});

try {
  await client.connect(transport);
} catch (err) {
  console.error("Could not connect to", ENDPOINT, "-", (err as Error).message);
  process.exit(1);
}

const tools = await client.listTools();
console.log("Connected OK -", tools.tools.length, "tools:", tools.tools.map((t: any) => t.name).join(", "));

const profile = await client.callTool({ name: "get_profile", arguments: {} });
const p = (profile.structuredContent as any) ?? {};
console.log("\nAccount:  ", (p as any).email);
console.log("Property: ", (p as any).activeProperty);
if ((p as any).ok !== true) {
  console.error("  ✗ envelope missing ok:true in structuredContent");
  process.exit(1);
}

const status = await client.callTool({ name: "get_crawl_status", arguments: {} });
const s = (status.structuredContent as any) ?? {};
console.log("\nCrawl status: ", `${(s as any).pagesWithMetrics} pages w/ metrics, ${(s as any).pagesWithContent} content-crawled`);

const overview = await client.callTool({ name: "get_overview", arguments: { days: 7 } });
const o = (overview.structuredContent as any) ?? {};
console.log(
  `\nGSC (${(o as any).range?.start} -> ${(o as any).range?.end}):`,
  `${(o as any).totals?.clicks} clicks, ${(o as any).totals?.impressions} impressions`,
  `| top query: "${(o as any).queries?.[0]?.key}" (${(o as any).queries?.[0]?.clicks} clicks)`
);

const q = await client.callTool({ name: "get_queries", arguments: { limit: 300, offset: 0 } });
const qc = (q.structuredContent as any) ?? {};
console.log(
  "\nget_queries:",
  `${(qc as any).count} rows @ offset ${(qc as any).offset},`,
  `limit ${(qc as any).limit}; first: "${(qc as any).queries?.[0]?.key}";`,
  "returns rows w/ title fields only if enriched (pages only)"
);

const pages = await client.callTool({ name: "get_pages", arguments: { limit: 100, offset: 0 } });
const pc = (pages.structuredContent as any) ?? {};
const firstPage = (pc as any).pages?.[0];
console.log(
  "\nget_pages:",
  `${(pc as any).count} rows; first: "${firstPage?.path}"`,
  `(title: ${firstPage?.title ? JSON.stringify(firstPage.title.slice(0, 40)) : "null"},`,
  `meta: ${firstPage?.metaDescription ? "set" : "null"}, words: ${firstPage?.wordCount})`
);

const pd = await client.callTool({ name: "get_idea_detail", arguments: { ideaId: "nonexistent-id" } });
const pdv = (pd.structuredContent as any) ?? {};
console.log("\nget_idea_detail (missing):", (pdv as any).found === false ? "found:false (ok)" : "unexpected");

const html = await client.callTool({
  name: "get_page_html",
  arguments: { page: "/upsc-topper/anuj-agnihotri-rank-1-2025", includeHtml: false },
});
const hv = (html.structuredContent as any) ?? {};
console.log(
  "\nget_page_html:",
  `${(hv as any).httpStatus}, "${(hv as any).title?.slice(0, 50)}",`,
  `${(hv as any).headings?.length} headings, ${(hv as any).wordCount} words`
);

const audit = await client.callTool({
  name: "run_page_audit",
  arguments: { url: "https://upscprepnotes.in/", strategy: "mobile" },
});
const av = (audit.structuredContent as any) ?? {};
const ascores = av.scores ?? {};
console.log(
  "\nrun_page_audit:",
  `perf ${ascores.performance ?? "-"}, a11y ${ascores.accessibility ?? "-"}, bp ${ascores["best-practices"] ?? "-"}, seo ${ascores.seo ?? "-"}`,
  `| field overall: ${av.fieldData?.overall ?? "-"}`,
  `| ${av.failures?.length ?? 0} failing audits,`,
  `top: "${av.failures?.[0]?.title ?? "none"}" (${av.failures?.[0]?.displayValue ?? ""})`
);
if (av.disabled) {
  console.error("  ✗ PSI API disabled — enable it on this key");
}

await client.close();
console.log("\nAll green.");
process.exit(0);