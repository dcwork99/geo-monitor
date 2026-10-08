// Google PageSpeed Insights（行動版）。沒有 PSI_API_KEY 也能呼叫，但額度較低
export async function pagespeed(url) {
  const q = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (process.env.PSI_API_KEY) q.set("key", process.env.PSI_API_KEY);
  try {
    const r = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q, { signal: AbortSignal.timeout(90000) });
    const j = await r.json();
    if (!r.ok) return { url, error: j.error?.message?.slice(0, 120) || "HTTP " + r.status };
    const a = j.lighthouseResult?.audits || {};
    return {
      url,
      score: Math.round((j.lighthouseResult?.categories?.performance?.score ?? 0) * 100),
      lcp: a["largest-contentful-paint"]?.numericValue ?? null,
      cls: a["cumulative-layout-shift"]?.numericValue ?? null,
      tbt: a["total-blocking-time"]?.numericValue ?? null,
    };
  } catch (e) {
    return { url, error: e.name === "TimeoutError" ? "逾時" : e.message };
  }
}
