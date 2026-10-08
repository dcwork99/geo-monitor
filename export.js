// 把 data/ 內最新的檢測與追蹤結果匯出成靜態網站（docs/），給 GitHub Pages 使用
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./src/env.js";
import { latest, history, listHosts } from "./src/store.js";
import { summarizeTracking } from "./src/ai/track.js";

const OUT = path.join(ROOT, "docs");
await fs.mkdir(path.join(OUT, "data"), { recursive: true });

const index = [];
for (const host of await listHosts()) {
  const r = await latest(host);
  if (!r) continue;
  r.history = await history(host);
  r.tracking = await summarizeTracking(host);
  // 靜態頁不提供追蹤設定與本機路徑
  delete r.promptSet;
  delete r.providers;
  r.history = r.history.map(({ file, ...h }) => h);
  await fs.writeFile(path.join(OUT, "data", `${host}.json`), JSON.stringify(r));
  index.push({ host, finishedAt: r.finishedAt, overall: r.scores.overall });
}
await fs.writeFile(path.join(OUT, "data", "index.json"), JSON.stringify({ exportedAt: new Date().toISOString(), sites: index }));

// 同一份介面，加上靜態模式與不讓搜尋引擎收錄
let html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
html = html.replace("<head>", '<head>\n<meta name="geo-mode" content="static">\n<meta name="robots" content="noindex, nofollow">');
await fs.writeFile(path.join(OUT, "index.html"), html);
await fs.writeFile(path.join(OUT, ".nojekyll"), "");

console.log(`已匯出 ${index.length} 個網站到 docs/：${index.map((s) => s.host).join("、")}`);
