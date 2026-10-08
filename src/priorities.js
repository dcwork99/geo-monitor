// 優先修復清單：把技術問題、GEO 項目、Claude 建議與 AI 追蹤缺口合併排序

// 每類問題的改動量與它造成的 AI 缺口
const META = {
  robots_ai: ["小", "AI 爬蟲讀不到網站，無法被引用"],
  broken: ["小", "已累積的連結與引用流失"],
  https: ["小", "不安全網址降低可信度"],
  mixed: ["小", "瀏覽器顯示不安全，降低可信度"],
  no_title: ["小", "AI 無法判斷頁面主題"],
  canon_conflict: ["小", "AI 可能引用錯誤版本的網址"],
  no_desc: ["小", "AI 摘要時缺少頁面重點"],
  title_len: ["小", "標題在搜尋結果與 AI 引用中被截斷"],
  dup_title: ["小", "AI 難以區分頁面主題"],
  h1: ["小", "頁面主題不明確"],
  no_canonical: ["小", "重複內容分散引用"],
  noindex_sitemap: ["小", "sitemap 與 noindex 訊號互相矛盾"],
  thin: ["中", "內容不足，AI 沒有可引用的資訊"],
  slow: ["中", "爬蟲抓取效率差，影響收錄"],
  no_sitemap: ["小", "新頁面不容易被發現"],
  alt: ["小", "圖片內容 AI 讀不到"],
  og: ["小", "分享與 AI 預覽缺少摘要"],
  redirect_chain: ["小", "爬蟲浪費抓取資源"],
  orphan: ["小", "爬蟲與 AI 找不到這些頁面"],
  robots_missing: ["小", "缺少爬蟲指引"],
  answer_first: ["大", "AI 找不到可直接引用的答案"],
  schema: ["中", "AI 無法確認頁面類型與重點"],
  org: ["小", "AI 無法確認品牌名稱、地址與聯絡資訊"],
  eeat: ["中", "缺少作者與時效訊號，可信度低"],
  evidence: ["中", "優勢多為業者說法，缺少可查證的事實"],
  structure: ["中", "重點不容易被 AI 摘錄"],
  entity: ["小", "品牌名稱寫法不一，AI 提及無法歸戶"],
  llms: ["小", "AI 缺少網站內容導覽"],
};

const PAGE_ITEMS = new Set(["answer_first", "schema", "eeat", "evidence", "structure"]);
const LEVEL_ORDER = { 緊急: 0, 近期: 1, 觀察: 2 };
const EFFORT_ORDER = { 小: 0, 中: 1, 大: 2 };

export function buildPriorities(issues, geoItems, recommendations = []) {
  const rows = [];
  for (const i of issues) {
    const [effort, gap] = META[i.id] || ["小", "—"];
    rows.push({
      item: `${i.title}（${i.count} ${i.unit}）`,
      level: i.severity === "crit" ? "緊急" : i.severity === "warn" ? "近期" : "觀察",
      effort: i.id === "alt" && i.count > 20 ? "中" : effort,
      gap,
      source: "技術",
    });
  }
  for (const g of geoItems) {
    const [effort, gap] = META[g.id] || ["中", "—"];
    rows.push({
      item: PAGE_ITEMS.has(g.id) ? `${g.title}（${g.count} 頁）` : g.title,
      level: g.level === "low" ? "觀察" : "近期",
      effort: g.id === "answer_first" && g.count <= 5 ? "中" : effort,
      gap,
      source: "GEO",
    });
  }
  for (const r of recommendations) {
    rows.push({
      item: r.title,
      level: r.impact === "低" ? "觀察" : "近期",
      effort: r.effort || "中",
      gap: r.gap || r.detail,
      source: "Claude",
    });
  }
  return sortPriorities(rows);
}

export function sortPriorities(rows) {
  return rows.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort]);
}
