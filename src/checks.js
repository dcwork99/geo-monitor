// 由爬取結果產出技術問題、GEO 內容項目與分數

const titleWidth = (s) => [...s].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);
const strip = (u) => u.replace(/\/$/, "");

function issue(id, severity, title, pages, fix, unit = "頁") {
  return { id, severity, title, count: pages.length, unit, pages: pages.slice(0, 30), fix };
}

export function technicalIssues(c, perf = []) {
  const html = c.pages.filter((p) => p.status === 200 && p.title !== undefined);
  const indexable = html.filter((p) => !p.noindex);
  const sitemapSet = new Set(c.sitemapUrls.map(strip));
  const list = [];

  const blockedBots = c.aiBots.filter((b) => b.blocked).map((b) => b.bot);
  list.push(issue("robots_ai", "crit", "robots.txt 封鎖 AI 爬蟲", blockedBots,
    "調整 robots.txt 的 Disallow 規則，允許 GPTBot、PerplexityBot、ClaudeBot 等讀取公開內容，只封鎖後台與搜尋頁。", "個爬蟲"));

  const broken = c.pages.filter((p) => p.status >= 400 || p.status === 0);
  list.push(issue("broken", "crit", "壞連結與錯誤頁面（4xx／5xx／無法連線）",
    broken.map((p) => `${p.url}（${p.status || p.error}${c.linkedFrom[p.url] ? "，來源：" + c.linkedFrom[p.url][0] : ""}）`),
    "已下架的頁面設 301 導向最相近的頁面，並修正來源頁上的連結。", "個網址"));

  list.push(issue("https", "crit", "HTTP 未自動轉址到 HTTPS", c.httpsRedirect ? [] : ["http://" + c.host + "/"],
    "在伺服器設定全站 301 轉址到 https。", "處"));
  list.push(issue("mixed", "crit", "HTTPS 頁面載入 http 資源（混合內容）", html.filter((p) => p.mixed > 0).map((p) => p.url),
    "把圖片、腳本、樣式表的網址改成 https。"));
  list.push(issue("no_title", "crit", "缺少 title", html.filter((p) => !p.title).map((p) => p.url), "每頁加上獨一無二、描述內容的 title。"));
  list.push(issue("canon_conflict", "crit", "sitemap 內頁面的 canonical 指向其他網址",
    indexable.filter((p) => p.canonical && sitemapSet.has(strip(p.url)) && strip(p.canonical) !== strip(p.finalUrl)).map((p) => `${p.url} → ${p.canonical}`),
    "sitemap 只放 canonical 網址；若頁面本身就是主要版本，canonical 應指向自己。"));

  list.push(issue("no_desc", "warn", "缺少 meta description", indexable.filter((p) => !p.metaDesc).map((p) => p.url),
    "撰寫 80–110 字的摘要，開頭直接說出這頁回答了什麼。"));
  list.push(issue("title_len", "warn", "title 過長或過短", indexable.filter((p) => p.title && (titleWidth(p.title) > 60 || titleWidth(p.title) < 10)).map((p) => `${p.url}（${p.title}）`),
    "控制在約 30 個中文字內，主要關鍵字放前面，品牌名放最後。"));
  const titleCount = {};
  indexable.forEach((p) => p.title && (titleCount[p.title] = (titleCount[p.title] || 0) + 1));
  list.push(issue("dup_title", "warn", "title 重複", indexable.filter((p) => titleCount[p.title] > 1).map((p) => `${p.url}（${p.title}）`),
    "每頁 title 要能區分內容，避免全站共用同一個。"));
  list.push(issue("h1", "warn", "H1 缺漏或超過一個", indexable.filter((p) => p.h1.length !== 1).map((p) => `${p.url}（${p.h1.length} 個）`),
    "每頁保留一個 H1，內容與頁面主題一致。"));
  list.push(issue("no_canonical", "warn", "缺少 canonical", indexable.filter((p) => !p.canonical).map((p) => p.url),
    "每頁加上 <link rel=\"canonical\">，避免參數網址被當成重複內容。"));
  list.push(issue("noindex_sitemap", "warn", "sitemap 內含 noindex 頁面", html.filter((p) => p.noindex && sitemapSet.has(strip(p.url))).map((p) => p.url),
    "從 sitemap 移除 noindex 頁面，並重新提交到 Search Console。"));
  list.push(issue("thin", "warn", "內容過少（少於 150 字）", indexable.filter((p) => p.words < 150).map((p) => `${p.url}（${p.words} 字）`),
    "補充實質內容，或將內容相近的頁面合併。"));
  const slow = [
    ...perf.filter((x) => x.lcp && x.lcp > 2500).map((x) => `${x.url}（LCP ${(x.lcp / 1000).toFixed(1)} 秒）`),
    ...html.filter((p) => p.ttfb > 1500).map((p) => `${p.url}（伺服器回應 ${(p.ttfb / 1000).toFixed(1)} 秒）`),
  ];
  list.push(issue("slow", "warn", "載入速度慢（LCP > 2.5 秒或回應 > 1.5 秒）", slow, "壓縮首屏圖片並改用 WebP、啟用快取與 CDN、延後載入非必要腳本。"));
  list.push(issue("no_sitemap", "warn", "找不到 sitemap.xml", c.sitemapFound ? [] : [c.origin + "/sitemap.xml"], "產生 sitemap.xml，並在 robots.txt 加上 Sitemap: 網址。", "處"));

  list.push(issue("alt", "info", "圖片缺少 alt 文字", html.filter((p) => p.imgsNoAlt > 0).map((p) => `${p.url}（${p.imgsNoAlt} 張）`),
    "用一句話描述圖片內容，產品圖加上名稱與用途。"));
  list.push(issue("og", "info", "缺少 Open Graph 標籤", indexable.filter((p) => !p.og.title || !p.og.image).map((p) => p.url),
    "補上 og:title、og:description、og:image。"));
  list.push(issue("redirect_chain", "info", "連續轉址 2 次以上", c.pages.filter((p) => p.redirects >= 2).map((p) => `${p.url}（${p.redirects} 次）`),
    "讓舊網址一次導向最終網址。"));
  const crawledAll = c.pages.length < c.maxPages;
  const orphans = crawledAll ? c.sitemapUrls.filter((u) => !c.linkedFrom[u] && strip(u) !== strip(c.homeUrl)) : [];
  list.push(issue("orphan", "info", "孤立頁面（sitemap 有，但站內沒有連結指向）", orphans,
    "從相關文章、分類頁或導覽加入內部連結。"));
  list.push(issue("robots_missing", "info", "找不到 robots.txt", c.robotsFound ? [] : [c.origin + "/robots.txt"], "建立 robots.txt，並列出 sitemap 位置。", "處"));

  return list.filter((i) => i.count > 0);
}

export function geoItems(c, llmPages = []) {
  const pages = c.pages.filter((p) => p.status === 200 && p.title !== undefined && !p.noindex);
  const n = Math.max(pages.length, 1);
  const pct = (k) => Math.round((pages.filter(k).length / n) * 100);
  const items = [];
  const schemaCov = pct((p) => p.schemaTypes.length > 0);
  const allTypes = new Set(pages.flatMap((p) => p.schemaTypes));
  const home = pages.find((p) => p.url === c.homeUrl) || pages[0];

  const noAnswer = llmPages.length
    ? llmPages.filter((p) => !p.answerFirst)
    : pages.filter((p) => !p.firstPara);
  items.push({
    id: "answer_first", level: noAnswer.length / Math.max(llmPages.length || n, 1) > 0.4 ? "high" : "mid",
    title: "首段沒有直接回答問題", count: noAnswer.length, base: llmPages.length || n,
    detail: llmPages.length ? `抽樣 ${llmPages.length} 個重點頁中，${noAnswer.length} 頁開頭沒有直接給出答案。` : `${noAnswer.length} 頁找不到足夠長的開頭段落。`,
    fix: "每頁前 2 句寫出結論或定義，再展開說明；小標題改寫成使用者會問的問題。",
    pages: noAnswer.map((p) => p.url).slice(0, 20),
  });
  const noSchema = pages.filter((p) => !p.schemaTypes.length);
  items.push({
    id: "schema", level: schemaCov < 50 ? "high" : schemaCov < 80 ? "mid" : "low",
    title: "結構化資料覆蓋不足", count: noSchema.length, base: n,
    detail: `結構化資料覆蓋率 ${schemaCov}%。已使用：${[...allTypes].slice(0, 8).join("、") || "無"}。`,
    fix: "以 JSON-LD 標記 Organization、WebSite、Article／BlogPosting、FAQPage、Product 或 Service，並用 Rich Results Test 驗證。",
    pages: noSchema.map((p) => p.url).slice(0, 20),
  });
  if (!allTypes.has("Organization") && !allTypes.has("LocalBusiness")) items.push({
    id: "org", level: "high", title: "缺少 Organization 實體標記", count: 1, base: 1,
    detail: "AI 引擎無法從結構化資料確認品牌名稱、網址、Logo 與社群帳號。",
    fix: "在首頁加入 Organization（或 LocalBusiness）JSON-LD，含 name、url、logo、sameAs。", pages: [home?.url].filter(Boolean),
  });
  const noAuthor = pages.filter((p) => !p.hasAuthor || !p.hasDate);
  items.push({
    id: "eeat", level: noAuthor.length / n > 0.5 ? "mid" : "low",
    title: "缺少作者或更新日期", count: noAuthor.length, base: n,
    detail: `${noAuthor.length} 頁缺少作者資訊或發布／更新日期。`,
    fix: "內容頁顯示作者、資歷與最後更新日期，並在 schema 中標記 author 與 dateModified。",
    pages: noAuthor.map((p) => p.url).slice(0, 20),
  });
  const noEvidence = pages.filter((p) => p.words >= 300 && p.externalLinks === 0 && p.numbers === 0);
  items.push({
    id: "evidence", level: noEvidence.length / n > 0.3 ? "mid" : "low",
    title: "內容缺少數據與外部來源", count: noEvidence.length, base: n,
    detail: `${noEvidence.length} 頁沒有具體數字，也沒有連到外部參考來源。`,
    fix: "每頁至少放 2 筆可查證的數據，標註年份與出處連結。",
    pages: noEvidence.map((p) => p.url).slice(0, 20),
  });
  const noStructure = pages.filter((p) => p.words >= 300 && !p.hasList && !p.hasTable && p.questionHeadings === 0);
  items.push({
    id: "structure", level: noStructure.length / n > 0.4 ? "mid" : "low",
    title: "內容不易被 AI 摘錄", count: noStructure.length, base: n,
    detail: `${noStructure.length} 頁沒有清單、表格或問句小標題，AI 較難擷取重點。`,
    fix: "加入重點清單、比較表與 FAQ 區塊，每段聚焦一個問題。",
    pages: noStructure.map((p) => p.url).slice(0, 20),
  });
  const names = new Set();
  pages.forEach((p) => { if (p.og.siteName) names.add(p.og.siteName.trim()); p.orgNames.forEach((x) => names.add(x.trim())); });
  if (names.size > 1) items.push({
    id: "entity", level: "mid", title: "品牌實體名稱不一致", count: names.size, base: names.size,
    detail: `站內出現 ${names.size} 種品牌寫法：${[...names].join("、")}。`,
    fix: "統一正式名稱與一句話定位，並用 sameAs 串接官網、社群與商家資訊。", pages: [],
  });
  if (!c.llmsTxt) items.push({
    id: "llms", level: "low", title: "尚未提供 llms.txt", count: 1, base: 1,
    detail: "網站根目錄沒有給 AI 讀的內容導覽檔。",
    fix: "建立 /llms.txt，列出核心頁面與每頁一句話摘要。", pages: [],
  });
  return items.filter((i) => i.count > 0);
}

const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function computeScores(c, issues, llmPages = []) {
  const pages = c.pages.filter((p) => p.status === 200 && p.title !== undefined && !p.noindex);
  const n = Math.max(pages.length, 1);
  const share = (k) => pages.filter(k).length / n;

  const W = { crit: 12, warn: 5, info: 2 };
  let penalty = 0;
  for (const i of issues) {
    const ratio = i.unit === "頁" ? Math.min(1, i.count / Math.max(3, n * 0.3)) : Math.min(1, i.count / 3);
    penalty += W[i.severity] * (0.4 + 0.6 * ratio);
  }
  const technical = clamp(100 - penalty);

  const types = new Set(pages.flatMap((p) => p.schemaTypes));
  const schema = clamp(share((p) => p.schemaTypes.length > 0) * 55 + (types.has("Organization") || types.has("LocalBusiness") ? 20 : 0) + (types.has("WebSite") ? 10 : 0) + ([...types].some((t) => /Article|BlogPosting|FAQPage|Product|Service|HowTo/.test(t)) ? 15 : 0));

  const structH = (share((p) => p.hasList || p.hasTable) * 0.4 + share((p) => p.questionHeadings > 0) * 0.3 + share((p) => !!p.firstPara) * 0.3) * 100;
  const llmClarity = avg(llmPages.map((p) => p.clarity));
  const content = clamp(llmClarity == null ? structH : structH * 0.4 + llmClarity * 0.6);

  const authH = (share((p) => p.hasAuthor) * 0.45 + share((p) => p.hasDate) * 0.3 + share((p) => p.externalLinks > 0) * 0.25) * 100;
  const llmEeat = avg(llmPages.map((p) => p.eeat));
  const authority = clamp(llmEeat == null ? authH : authH * 0.5 + llmEeat * 0.5);

  const botsOk = c.aiBots.filter((b) => !b.blocked).length / c.aiBots.length;
  const citeH = botsOk * 40 + (c.llmsTxt ? 10 : 0) + share((p) => p.numbers > 0) * 25 + share((p) => !!p.metaDesc) * 25;
  const llmCite = avg(llmPages.map((p) => p.citeability));
  const citeability = clamp(llmCite == null ? citeH : citeH * 0.4 + llmCite * 0.6);

  const overall = clamp(technical * 0.25 + content * 0.2 + schema * 0.2 + authority * 0.15 + citeability * 0.2);
  return { overall, technical, content, schema, authority, citeability };
}
