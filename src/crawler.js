import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (compatible; GEOMonitorBot/1.0)";
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|wav|webm|css|js|json|xml|txt|docx?|xlsx?|pptx?)$/i;
export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Google-Extended", "CCBot", "Bingbot"];

// 手動跟隨轉址，記錄轉址鏈與 TTFB
export async function fetchPage(url, { timeout = 20000, maxHops = 6 } = {}) {
  const chain = [];
  let cur = url;
  for (let i = 0; i <= maxHops; i++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(cur, {
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      return { url, finalUrl: cur, status: 0, chain, error: e.name === "TimeoutError" ? "逾時" : e.message };
    }
    const ttfb = Date.now() - t0;
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      chain.push({ url: cur, status: res.status });
      cur = new URL(loc, cur).href;
      await res.body?.cancel();
      continue;
    }
    const type = res.headers.get("content-type") || "";
    const body = type.includes("html") || type.includes("xml") || type.includes("text") ? await res.text() : (await res.body?.cancel(), "");
    return { url, finalUrl: cur, status: res.status, chain, ttfb, type, body, xRobots: res.headers.get("x-robots-tag") || "" };
  }
  return { url, finalUrl: cur, status: 0, chain, error: "轉址次數過多" };
}

export function normalize(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return null;
  }
}

const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

// robots.txt 解析：回傳每個 AI 爬蟲是否被禁止抓首頁
export function parseRobots(txt) {
  const groups = [];
  const sitemaps = [];
  let g = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.toLowerCase();
    if (key === "sitemap") { sitemaps.push(v); continue; }
    if (key === "user-agent") {
      if (!lastWasAgent) { g = { agents: [], rules: [] }; groups.push(g); }
      g.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if (g && (key === "disallow" || key === "allow")) {
      g.rules.push({ allow: key === "allow", path: v });
      lastWasAgent = false;
    }
  }
  const blocked = (bot, path = "/") => {
    const b = bot.toLowerCase();
    let grp = groups.filter((x) => x.agents.some((a) => a !== "*" && b.includes(a)));
    if (!grp.length) grp = groups.filter((x) => x.agents.includes("*"));
    let best = null;
    for (const r of grp.flatMap((x) => x.rules)) {
      if (!r.path) continue;
      if (path.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
    return !!best && !best.allow;
  };
  return { sitemaps, blocked };
}

async function readSitemaps(urls, host, limit = 2000) {
  const seen = new Set();
  const pages = new Set();
  const queue = [...urls];
  let found = false;
  while (queue.length && seen.size < 25 && pages.size < limit) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await fetchPage(sm);
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.body || "")) continue;
    found = true;
    const locs = [...r.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].trim());
    if (/<sitemapindex/i.test(r.body)) queue.push(...locs);
    else for (const l of locs) {
      const n = normalize(l);
      if (n && sameSite(new URL(n).hostname, host)) pages.add(n);
    }
  }
  return { found, urls: [...pages] };
}

function textLen(s) {
  // 中文字算 1，英文以單字計
  const cjk = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const words = (s.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

export function analyzeHtml(html, pageUrl, host) {
  const $ = cheerio.load(html);
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o["@type"]) jsonLd.push(...[].concat(o["@type"]).map(String));
        if (o["@graph"]) walk(o["@graph"]);
        if (o.author) jsonLd.push("_author");
        if (o.datePublished || o.dateModified) jsonLd.push("_date");
        if (o["@type"] === "Organization" && o.name) jsonLd.push("_org:" + o.name);
      };
      walk(JSON.parse($(el).text()));
    } catch {}
  });
  const meta = (sel) => ($(sel).attr("content") || "").trim();
  const links = new Set();
  let externalLinks = 0;
  $("a[href]").each((_, a) => {
    const n = normalize($(a).attr("href"), pageUrl);
    if (!n) return;
    const h = new URL(n).hostname;
    if (sameSite(h, host)) links.add(n);
    else externalLinks++;
  });
  const imgs = $("img");
  let imgsNoAlt = 0;
  imgs.each((_, i) => { if (!($(i).attr("alt") || "").trim()) imgsNoAlt++; });
  let mixed = 0;
  if (pageUrl.startsWith("https:")) $("img[src],script[src],link[href][rel=stylesheet],iframe[src]").each((_, e) => {
    const v = $(e).attr("src") || $(e).attr("href") || "";
    if (v.startsWith("http://")) mixed++;
  });
  const headings = [];
  $("h2,h3").each((_, h) => headings.push($(h).text().trim().replace(/\s+/g, " ")));
  $("script,style,noscript,svg,nav,footer,header,form").remove();
  const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  const text = main.text().replace(/\s+/g, " ").trim();
  let firstPara = "";
  main.find("p").each((_, p) => {
    const t = $(p).text().replace(/\s+/g, " ").trim();
    if (!firstPara && textLen(t) >= 25) firstPara = t;
  });
  return {
    title: $("title").first().text().trim(),
    metaDesc: meta('meta[name="description"]'),
    h1: $("h1").map((_, h) => $(h).text().trim()).get(),
    canonical: $('link[rel="canonical"]').attr("href") ? normalize($('link[rel="canonical"]').attr("href"), pageUrl) : "",
    robotsMeta: meta('meta[name="robots"]').toLowerCase(),
    lang: $("html").attr("lang") || "",
    hreflang: $('link[rel="alternate"][hreflang]').length,
    og: { title: meta('meta[property="og:title"]'), desc: meta('meta[property="og:description"]'), image: meta('meta[property="og:image"]'), siteName: meta('meta[property="og:site_name"]') },
    schemaTypes: [...new Set(jsonLd.filter((t) => !t.startsWith("_")))],
    orgNames: [...new Set(jsonLd.filter((t) => t.startsWith("_org:")).map((t) => t.slice(5)))],
    hasAuthor: jsonLd.includes("_author") || !!meta('meta[name="author"]') || $('[rel="author"], .author, .byline, [itemprop="author"]').length > 0,
    hasDate: jsonLd.includes("_date") || !!meta('meta[property="article:published_time"]') || !!meta('meta[property="article:modified_time"]') || $("time[datetime]").length > 0,
    imgs: imgs.length,
    imgsNoAlt,
    mixed,
    headings,
    questionHeadings: headings.filter((h) => /[?？]|如何|怎麼|什麼|為什麼|哪些|多少|嗎/.test(h)).length,
    hasTable: $("table").length > 0,
    hasList: main.find("ul li, ol li").length >= 3,
    externalLinks,
    numbers: (text.match(/\d+(\.\d+)?\s?(%|％|元|萬|億|倍|年|天|小時|分鐘|位|家|間)/g) || []).length,
    words: textLen(text),
    firstPara: firstPara.slice(0, 400),
    excerpt: text.slice(0, 3500),
    links: [...links],
  };
}

export async function crawl(startUrl, { maxPages = 100, concurrency = 6, onProgress = () => {} } = {}) {
  let input = startUrl.trim();
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  input = normalize(input);
  if (!input) throw new Error("網址格式不正確");
  const home = await fetchPage(input);
  if (!home.status || home.status >= 400) throw new Error(`無法開啟首頁（${home.error || "HTTP " + home.status}）`);
  const origin = new URL(home.finalUrl).origin;
  const host = new URL(home.finalUrl).hostname;

  // HTTP → HTTPS 檢查
  const httpCheck = await fetchPage("http://" + host + "/", { maxHops: 3 });
  const httpsRedirect = httpCheck.finalUrl.startsWith("https://");

  const robotsRes = await fetchPage(origin + "/robots.txt");
  const robotsFound = robotsRes.status === 200 && !/<html/i.test(robotsRes.body || "");
  const robots = parseRobots(robotsFound ? robotsRes.body : "");
  const aiBots = AI_BOTS.map((bot) => ({ bot, blocked: robots.blocked(bot) }));

  const llms = await fetchPage(origin + "/llms.txt");
  const llmsTxt = llms.status === 200 && !/<html/i.test(llms.body || "") && (llms.body || "").trim().length > 20;

  onProgress({ step: "讀取 sitemap" });
  const smCandidates = robots.sitemaps.length ? robots.sitemaps : [origin + "/sitemap.xml", origin + "/sitemap_index.xml", origin + "/wp-sitemap.xml"];
  const sitemap = await readSitemaps(smCandidates, host);

  const pages = new Map();
  const queued = new Set();
  const queue = [];
  const linkedFrom = new Map();
  const push = (u) => {
    if (!u || queued.has(u) || SKIP_EXT.test(new URL(u).pathname) || queued.size >= maxPages) return;
    if (!sameSite(new URL(u).hostname, host)) return;
    queued.add(u);
    queue.push(u);
  };
  home.finalUrl = normalize(home.finalUrl);
  push(home.finalUrl);
  // 先排首頁連結，再排 sitemap，兼顧重要頁與覆蓋率
  const homeInfo = home.body ? analyzeHtml(home.body, home.finalUrl, host) : { links: [] };
  homeInfo.links.forEach(push);
  sitemap.urls.forEach(push);

  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      const r = u === home.finalUrl ? home : await fetchPage(u);
      const rec = { url: u, finalUrl: r.finalUrl, status: r.status, redirects: r.chain.length, ttfb: r.ttfb ?? null, error: r.error || "" };
      if (r.status === 200 && (r.type || "").includes("html") && r.body) {
        Object.assign(rec, analyzeHtml(r.body, r.finalUrl, host));
        rec.noindex = /noindex/.test(rec.robotsMeta) || /noindex/i.test(r.xRobots || "");
        for (const l of rec.links) {
          if (!linkedFrom.has(l)) linkedFrom.set(l, new Set());
          linkedFrom.get(l).add(u);
          push(l);
        }
      }
      pages.set(u, rec);
      onProgress({ step: "爬取頁面", done: pages.size, total: queued.size });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // 平行爬取會拉高回應時間，慢的頁面逐一重測，取較快的一次
  const slow = [...pages.values()].filter((p) => p.ttfb > 1500).slice(0, 15);
  for (const p of slow) {
    onProgress({ step: "重測回應時間" });
    const r = await fetchPage(p.finalUrl);
    if (r.ttfb != null) p.ttfb = Math.min(p.ttfb, r.ttfb);
  }

  return {
    input,
    origin,
    host,
    homeUrl: home.finalUrl,
    httpsRedirect,
    robotsFound,
    aiBots,
    llmsTxt,
    sitemapFound: sitemap.found,
    sitemapUrls: sitemap.urls,
    pages: [...pages.values()],
    linkedFrom: Object.fromEntries([...linkedFrom].map(([k, v]) => [k, [...v]])),
    maxPages,
  };
}
