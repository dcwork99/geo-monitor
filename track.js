// 命令列：npm run track -- <網域>          執行一輪 AI 平台追蹤
//         npm run track -- <網域> --init   產生追蹤題目（需要 Claude）
import "./src/env.js";
import { runTracking, summarizeTracking } from "./src/ai/track.js";
import { generatePromptSet, templatePromptSet, promptFile } from "./src/ai/promptset.js";
import { enabledProviders } from "./src/ai/providers.js";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input) {
  console.error("用法：npm run track -- www.example.com [--init]");
  process.exit(1);
}
const host = input.replace(/^https?:\/\//, "").split("/")[0];

if (args.includes("--init")) {
  try {
    const set = await generatePromptSet(host);
    console.log(`已產生 ${set.prompts.length} 題，品牌：${set.brand.name}，競品：${set.competitors.map((c) => c.name).join("、")}`);
  } catch (e) {
    console.log(`Claude 產生失敗（${e.message}），改建立空白範本。`);
    await templatePromptSet(host);
  }
  console.log(`請檢查並編輯：${promptFile(host)}`);
  process.exit(0);
}

console.log("啟用的平台：", enabledProviders().map((p) => p.name).join("、") || "無");
const r = await runTracking(host, { onProgress: (p) => process.stdout.write(`\r${p.step} ${p.done}/${p.total}   `) });
console.log(`\n完成 ${r.ok}/${r.total} 次回應`);
if (r.errors.length) console.log("錯誤：\n  " + r.errors.join("\n  "));
const s = await summarizeTracking(host);
for (const p of s.platforms) console.log(`${p.name}：提及率 ${p.mentionRate?.toFixed(0)}%、聲量佔比 ${p.sov?.toFixed(0)}%、官網引用率 ${p.citedRate?.toFixed(0)}%、排名 ${p.rank ?? "—"}/${p.brandCount}`);
