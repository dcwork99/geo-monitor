import { crawl } from "./crawler.js";
import { technicalIssues, geoItems, computeScores } from "./checks.js";
import { pagespeed } from "./pagespeed.js";
import { llmEnabled, evaluatePages, evaluateSite, MODEL } from "./llm.js";
import { saveScan, history } from "./store.js";
import { buildPriorities } from "./priorities.js";

// 挑出最值得給 AI 評估的頁面：首頁 + 被最多內部連結指向的內容頁
function pickKeyPages(c, n) {
  const ok = c.pages.filter((p) => p.status === 200 && p.excerpt && !p.noindex && p.words >= 80);
  const score = (p) => (c.linkedFrom[p.url]?.length || 0) + (p.url === c.homeUrl ? 1000 : 0);
  return ok.sort((a, b) => score(b) - score(a)).slice(0, n);
}

async function analyzeSite(url, { maxPages, llmPages, psiPages, onProgress, withSiteEval }) {
  const c = await crawl(url, { maxPages, onProgress });

  onProgress({ step: "測量載入速度" });
  const perfTargets = pickKeyPages(c, psiPages).map((p) => p.finalUrl);
  const perf = await Promise.all(perfTargets.map(pagespeed));

  let pageEvals = [];
  let llm = { used: false, model: MODEL, error: llmPages === 0 || llmEnabled() ? "" : "未設定 ANTHROPIC_API_KEY，內容評分僅使用規則判斷" };
  if (llmEnabled() && llmPages > 0) {
    pageEvals = await evaluatePages(pickKeyPages(c, llmPages), onProgress);
    const ok = pageEvals.filter((p) => !p.error);
    llm = { used: ok.length > 0, model: MODEL, error: ok.length ? "" : pageEvals[0]?.error || "" };
  }
  const goodEvals = pageEvals.filter((p) => !p.error);
  const issues = technicalIssues(c, perf);
  const geo = geoItems(c, goodEvals);
  const scores = computeScores(c, issues, goodEvals);

  let site = null;
  if (withSiteEval && llm.used) {
    onProgress({ step: "產生總評與建議" });
    try { site = await evaluateSite(c, issues, geo, goodEvals); } catch (e) { llm.error = e.message; }
  }
  return { c, perf, issues, geo, scores, pageEvals, llm, site };
}

export async function runScan(url, { maxPages = 100, competitors = [], onProgress = () => {}, useLLM = true } = {}) {
  const startedAt = new Date().toISOString();
  const main = await analyzeSite(url, { maxPages, llmPages: useLLM ? 8 : 0, psiPages: 3, onProgress, withSiteEval: useLLM });

  const comp = [];
  for (const cu of competitors.slice(0, 3)) {
    onProgress({ step: `分析競品 ${cu}` });
    try {
      const r = await analyzeSite(cu, { maxPages: Math.min(40, maxPages), llmPages: useLLM ? 3 : 0, psiPages: 1, onProgress: () => {}, withSiteEval: false });
      comp.push({ host: r.c.host, scores: r.scores, pages: r.c.pages.length, issues: r.issues.reduce((n, i) => n + i.count, 0),
        schemaTypes: [...new Set(r.c.pages.flatMap((p) => p.schemaTypes || []))].slice(0, 10), llmsTxt: r.c.llmsTxt, aiBlocked: r.c.aiBots.filter((b) => b.blocked).length });
    } catch (e) {
      comp.push({ host: cu, error: e.message });
    }
  }

  const { c } = main;
  const result = {
    version: 1,
    target: { input: url, url: c.homeUrl, host: c.host },
    startedAt,
    finishedAt: new Date().toISOString(),
    crawl: {
      pagesCrawled: c.pages.length, htmlPages: c.pages.filter((p) => p.title !== undefined).length, maxPages: c.maxPages,
      sitemapFound: c.sitemapFound, sitemapUrls: c.sitemapUrls.length, robotsFound: c.robotsFound,
      httpsRedirect: c.httpsRedirect, llmsTxt: c.llmsTxt, aiBots: c.aiBots,
    },
    scores: main.scores,
    issues: main.issues,
    geo: { items: main.geo, pages: main.pageEvals, summary: main.site?.verdict || "", recommendations: main.site?.recommendations || [], prompts: main.site?.prompts || [] },
    priorities: buildPriorities(main.issues, main.geo, main.site?.recommendations || []),
    performance: main.perf,
    competitors: comp,
    llm: main.llm,
    pages: c.pages.map((p) => ({ url: p.url, status: p.status, title: p.title || "", words: p.words || 0, schema: p.schemaTypes || [], ttfb: p.ttfb })),
  };
  result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
  await saveScan(result);
  result.history = await history(c.host);
  return result;
}
