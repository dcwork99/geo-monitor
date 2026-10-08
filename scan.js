// 命令列：npm run scan -- https://www.example.com [--max=100] [--competitors=a.com,b.com]
import "./src/env.js";
import { runScan } from "./src/scan.js";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
if (!url) {
  console.error("用法：npm run scan -- https://www.example.com [--max=100] [--competitors=a.com,b.com]");
  process.exit(1);
}
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const maxPages = Number(opt("max") || 100);
const competitors = (opt("competitors") || "").split(",").filter(Boolean);

let last = "";
const r = await runScan(url, {
  maxPages,
  competitors,
  onProgress: (p) => {
    const line = p.total ? `${p.step} ${p.done}/${p.total}` : p.step;
    if (line !== last) process.stdout.write("\r" + line.padEnd(60));
    last = line;
  },
});
console.log("\n");
console.log(`網站：${r.target.host}　頁數：${r.crawl.pagesCrawled}　耗時：${Math.round(r.durationMs / 1000)} 秒`);
console.log("分數：", r.scores);
console.log(`技術問題：${r.issues.length} 類，共 ${r.issues.reduce((n, i) => n + i.count, 0)} 處`);
for (const i of r.issues) console.log(`  [${i.severity}] ${i.title}：${i.count} ${i.unit}`);
console.log(`GEO 項目：${r.geo.items.length} 項`);
console.log(`Claude：${r.llm.used ? "已使用 " + r.llm.model : "未使用（" + r.llm.error + "）"}`);
console.log("結果已存到 data/scans/" + r.target.host + "/");
