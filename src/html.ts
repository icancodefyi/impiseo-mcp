import * as cheerio from "cheerio";
import { normalizePath } from "./url.js";

const USER_AGENT = "ImpiseoMCP/1.0 (+https://impiseo.com/mcp)";
const FETCH_TIMEOUT_MS = 15000;

export function originForSite(site: string): string | null {
  let s = (site ?? "").trim();
  if (!s) return null;
  if (s.startsWith("sc-domain:")) {
    const host = s.slice("sc-domain:".length).trim();
    return host ? `https://${host}` : null;
  }
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function resolveUrl(siteLike: string, page: string): URL | null {
  const origin = originForSite(siteLike);
  if (!origin) return null;
  const isAbsolute = /^https?:\/\//i.test(page.trim());
  if (isAbsolute) {
    try {
      const u = new URL(page.trim());
      if (u.origin !== origin) return null;
      return u;
    } catch {
      return null;
    }
  }
  try {
    return new URL(normalizePath(page), `${origin}/`);
  } catch {
    return null;
  }
}

export type PageHtmlResult = {
  origin: string;
  url: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  fetchedAt: string;
  sizeBytes: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  wordCount: number;
  headings: { level: number; text: string; position: number }[];
  html: string;
};

/** Live-fetch one page of the user's own site and parse its DOM. */
export async function fetchPageHtml(opts: {
  site: string;
  page: string;
}): Promise<PageHtmlResult> {
  const origin = originForSite(opts.site);
  if (!origin) throw new Error("Could not resolve an origin for this site property.");
  const url = resolveUrl(opts.site, opts.page);
  if (!url) throw new Error(`Page does not belong to origin ${origin}.`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    const maybeRes = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: controller.signal,
    });
    if (maybeRes.status === 401 || maybeRes.status === 403) {
      throw new Error(`Origin refused the fetch (HTTP ${maybeRes.status}).`);
    }
    res = maybeRes;
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get("content-type");
  const htmlText = await res.text();
  if (contentType && !/html|xml/i.test(contentType)) {
    throw new Error(`Not an HTML document (${contentType}).`);
  }

  const $ = cheerio.load(htmlText);
  const title = $("title").first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').first().attr("content")?.trim() || null;
  const canonical = $('link[rel="canonical"]').first().attr("href") || null;

  const headings: { level: number; text: string; position: number }[] = [];
  let position = 0;
  $("h1,h2,h3,h4,h5,h6").each((_i, el) => {
    const level = Number(el.tagName.slice(1));
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text) headings.push({ level, text, position: position++ });
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;

  return {
    origin,
    url: url.href,
    finalUrl: res.url || url.href,
    httpStatus: res.status,
    contentType,
    fetchedAt: new Date().toISOString(),
    sizeBytes: htmlText.length,
    title,
    metaDescription,
    canonical,
    wordCount,
    headings,
    html: htmlText,
  };
}