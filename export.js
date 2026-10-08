// 把指定網站最新的檢測與追蹤結果匯出成靜態網站（docs/），給 GitHub Pages 使用
// 只會發布前台已經有的網站；要新增網站請明確指定：npm run publish:site -- www.example.com
// 加上 --push 會順便 commit 並推上 GitHub
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./src/env.js";
import { latest, history, listHosts } from "./src/store.js";
import { summarizeTracking } from "./src/ai/track.js";

const OUT = path.join(ROOT, "docs");
await fs.mkdir(path.join(OUT, "data"), { recursive: true });

const args = process.argv.slice(2);
const push = args.includes("--push");
const add = args.filter((a) => !a.startsWith("--")).map((a) => a.replace(/^https?:\/\//, "").split("/")[0].toLowerCase());
let published = [];
try { published = JSON.parse(await fs.readFile(path.join(OUT, "data", "index.json"), "utf8")).sites.map((s) => s.host); } catch {}
const known = await listHosts();
const missing = add.filter((h) => !known.includes(h));
if (missing.length) { console.error(`沒有這些網站的檢測紀錄：${missing.join("、")}，請先執行 npm run scan`); process.exit(1); }
const targets = [...new Set([...published, ...add])].filter((h) => known.includes(h));

const index = [];
for (const host of targets) {
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
const unpublished = known.filter((h) => !targets.includes(h));
if (unpublished.length) console.log(`未發布（需要時加在指令後面）：${unpublished.join("、")}`);

if (push) {
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, stdio: "inherit" });
  git("add", "docs");
  try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT }); console.log("前台沒有變更"); }
  catch { git("commit", "-m", "更新前台報告"); git("push"); console.log("已推上 GitHub，約 1 分鐘後前台更新"); }
}
