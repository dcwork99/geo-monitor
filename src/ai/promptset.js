// 追蹤題目設定：data/prompts/<網域>.json，可手動編輯
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ROOT } from "../env.js";
import { latest } from "../store.js";

const DIR = path.join(ROOT, "data/prompts");
export const LAYERS = {
  P1: "認知層｜不指名品牌，詢問品類、需求與推薦",
  P2: "比較層｜比較選項、價格、評價與挑選標準",
  P3: "決策層｜指名品牌，或已在挑選服務商",
};

export const promptFile = (host) => path.join(DIR, host.replace(/[^\w.-]/g, "") + ".json");

export async function loadPromptSet(host) {
  try { return JSON.parse(await fs.readFile(promptFile(host), "utf8")); } catch { return null; }
}

export async function savePromptSet(host, set) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(promptFile(host), JSON.stringify(set, null, 2));
}

const Gen = z.object({
  brand: z.object({ name: z.string(), aliases: z.array(z.string()).describe("回答中可能出現的其他寫法、簡稱、英文名") }),
  competitors: z.array(z.object({ name: z.string(), aliases: z.array(z.string()), domain: z.string().describe("官網網域，不確定就留空字串") }))
    .describe("同市場、同地區的主要競爭品牌，最多 6 個"),
  prompts: z.array(z.object({ text: z.string(), layer: z.enum(["P1", "P2", "P3"]) }))
    .describe("30 題：P1 12 題、P2 9 題、P3 9 題，用台灣潛在客戶實際會問 AI 的口吻，繁體中文"),
});

// 依最近一次檢測結果，請 Claude 產生品牌、競品與 30 題追蹤題目
export async function generatePromptSet(host) {
  const scan = await latest(host);
  if (!scan) throw new Error("請先檢測這個網站一次，再產生追蹤題目");
  const ws = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  const ctx = {
    host,
    pages: scan.pages.filter((p) => p.title).slice(0, 60).map((p) => `${p.url}｜${p.title}`),
    knownCompetitors: scan.competitors.map((c) => c.host),
  };
  const res = await client.beta.messages.parse({
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Gen) },
    system: "你是 GEO 顧問，負責設計用來監測品牌在 AI 回答中能見度的題目。題目要涵蓋客戶從認知到決策的不同階段，避免重複，並貼近台灣在地用語。",
    messages: [{ role: "user", content: `網站資訊（JSON）：\n${JSON.stringify(ctx)}\n\n請判斷品牌名稱、主要競品，並產生 30 題追蹤題目。分層定義：\n${Object.entries(LAYERS).map(([k, v]) => `${k}：${v}`).join("\n")}` }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("Claude 沒有產生有效的題目");
  const g = res.parsed_output;
  const set = {
    host,
    brand: { ...g.brand, domain: host },
    competitors: g.competitors,
    prompts: g.prompts.map((p, i) => ({ id: `q${String(i + 1).padStart(2, "0")}`, ...p })),
    layers: LAYERS,
    updatedAt: new Date().toISOString(),
  };
  await savePromptSet(host, set);
  return set;
}

// 沒有 Claude 時建立空白範本，讓使用者自己填
export async function templatePromptSet(host) {
  const scan = await latest(host);
  const home = scan?.pages.find((p) => p.url === scan.target.url) || scan?.pages[0];
  const name = (home?.title || host).split(/[|｜\-–—]/).map((s) => s.trim()).filter(Boolean).pop() || host;
  const set = {
    host,
    brand: { name, aliases: [], domain: host },
    competitors: (scan?.competitors || []).map((c) => ({ name: c.host, aliases: [], domain: c.host })),
    prompts: [
      { id: "q01", layer: "P1", text: "（請改成不指名品牌的品類問題，例如：台北有哪些推薦的網站設計公司？）" },
      { id: "q02", layer: "P2", text: "（請改成比較型問題，例如：網站設計公司要怎麼挑？價格大概多少？）" },
      { id: "q03", layer: "P3", text: `（請改成指名品牌的問題，例如：${name} 的評價如何？）` },
    ],
    layers: LAYERS,
    updatedAt: new Date().toISOString(),
  };
  await savePromptSet(host, set);
  return set;
}

export const isPlaceholder = (p) => /^（請改成/.test(p.text);
