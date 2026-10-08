import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

export function llmEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client;
function getClient() {
  if (!client) {
    const ws = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  }
  return client;
}

const PageEval = z.object({
  answerFirst: z.boolean().describe("開頭兩句是否直接回答這頁主要問題或給出定義"),
  clarity: z.number().describe("內容結構清晰、易被 AI 摘錄的程度，0–100"),
  citeability: z.number().describe("AI 回答時引用這頁的可能性：具體事實、數據、獨特觀點，0–100"),
  eeat: z.number().describe("經驗、專業、權威、可信度訊號，0–100"),
  mainQuestion: z.string().describe("這頁最該回答的使用者問題"),
  issues: z.array(z.string()).describe("最多 3 個最影響 GEO 的問題，繁體中文，每項一句"),
  rewrite: z.string().describe("建議改寫後的開頭段落，繁體中文，60–120 字，直接回答 mainQuestion"),
});

const SiteEval = z.object({
  verdict: z.string().describe("給客戶看的一句話總評，繁體中文，40 字內"),
  recommendations: z.array(z.object({ title: z.string(), detail: z.string(), impact: z.enum(["高", "中", "低"]) })).describe("5 項優先改善建議"),
  prompts: z.array(z.object({ prompt: z.string(), intent: z.string(), targetPage: z.string(), action: z.string() }))
    .describe("10 個潛在客戶會問 AI、且這個網站應該被引用的問題；intent 為意圖分類；targetPage 為最適合回答的現有網址或「需新增頁面」；action 為讓 AI 引用的具體做法"),
});

async function ask(schema, system, user, effort = "medium") {
  const res = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("模型拒絕回應");
  if (!res.parsed_output) throw new Error("模型回傳格式無法解析");
  return res.parsed_output;
}

const SYS = "你是 GEO（生成式引擎優化）顧問，評估網頁被 ChatGPT、Perplexity、Google AI 總覽等 AI 引擎理解與引用的潛力。評分要嚴格且一致，建議要具體可執行，全部使用繁體中文。";

export async function evaluatePages(pages, onProgress = () => {}) {
  const out = [];
  let i = 0;
  let fatal = null;
  async function worker() {
    while (i < pages.length) {
      if (fatal) { out.push({ url: pages[i++].url, error: fatal }); continue; }
      const p = pages[i++];
      try {
        const r = await ask(PageEval, SYS,
          `網址：${p.url}\n標題：${p.title}\nmeta description：${p.metaDesc || "（無）"}\n小標題：${p.headings.slice(0, 15).join(" / ") || "（無）"}\n結構化資料：${p.schemaTypes.join(", ") || "（無）"}\n\n頁面內文（節錄）：\n${p.excerpt}`, "low");
        out.push({ url: p.url, title: p.title, ...r });
      } catch (e) {
        // 400／401／403 是設定問題，重試也不會成功
        if ([400, 401, 403].includes(e.status)) fatal = e.message;
        out.push({ url: p.url, title: p.title, error: e.message });
      }
      onProgress({ step: "AI 內容評估", done: out.length, total: pages.length });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

export async function evaluateSite(c, issues, geo, pageEvals) {
  const summary = {
    host: c.host,
    pages: c.pages.length,
    issues: issues.map((i) => `${i.severity}｜${i.title}｜${i.count}${i.unit}`),
    geo: geo.map((g) => `${g.title}：${g.detail}`),
    pageEvals: pageEvals.filter((p) => !p.error).map((p) => ({ url: p.url, title: p.title, mainQuestion: p.mainQuestion, issues: p.issues })),
    pageList: c.pages.filter((p) => p.title).slice(0, 60).map((p) => `${p.url}｜${p.title}`),
  };
  return ask(SiteEval, SYS, `以下是網站 ${c.host} 的檢測摘要（JSON）。請產出總評、優先建議，以及應追蹤的 AI 提問。\n\n${JSON.stringify(summary)}`, "medium");
}

export { MODEL };
