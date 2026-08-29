export function normalizePath(raw: string): string {
  let p = (raw ?? "").trim();
  if (!p) return "/";
  try {
    p = new URL(p).pathname;
  } catch {
    // already a path
  }
  p = p.split(/[?#]/)[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}