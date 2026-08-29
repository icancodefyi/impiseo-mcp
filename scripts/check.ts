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
const p = JSON.parse((profile.content as any)[0].text) as { email: string; activeProperty: string };
console.log("\nAccount:  ", p.email);
console.log("Property: ", p.activeProperty);

const status = await client.callTool({ name: "get_crawl_status", arguments: {} });
console.log("\nCrawl status:", (status.content as any)[0].text);

const overview = await client.callTool({ name: "get_overview", arguments: { days: 7 } });
const o = JSON.parse((overview.content as any)[0].text) as {
  range: { start: string; end: string };
  totals: { clicks: number; impressions: number };
  queries: { key: string; clicks: number }[];
};
console.log(
  `\nGSC (${o.range.start} -> ${o.range.end}):`,
  `${o.totals.clicks} clicks, ${o.totals.impressions} impressions`,
  `| top query: "${o.queries[0]?.key}" (${o.queries[0]?.clicks} clicks)`
);

await client.close();
console.log("\nAll green.");
process.exit(0);