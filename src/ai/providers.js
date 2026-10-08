// 各 AI 平台：送出題目，取回回答文字與引用來源網址
import Anthropic from "@anthropic-ai/sdk";

const TIMEOUT = 120000;
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

async function postJson(url, body, headers) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

// Claude：開啟網路搜尋，引用來源取自回答文字上的 citations
const claude = {
  id: "claude",
  name: "Claude",
  enabled: () => !!process.env.ANTHROPIC_API_KEY && process.env.TRACK_CLAUDE !== "off",
  async ask(prompt) {
    const ws = process.env.ANTHROPIC_WORKSPACE_ID;
    const client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
    const messages = [{ role: "user", content: prompt }];
    let res;
    // 伺服器端搜尋迴圈可能回傳 pause_turn，把回答接回去讓它繼續
    for (let i = 0; i < 3; i++) {
      res = await client.messages.create({
        model: process.env.CLAUDE_TRACK_MODEL || process.env.CLAUDE_MODEL || "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages,
      });
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }
    if (res.stop_reason === "refusal") throw new Error("模型拒絕回應");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const citations = res.content
      .filter((b) => b.type === "text" && b.citations)
      .flatMap((b) => b.citations)
      .filter((c) => c.url)
      .map((c) => ({ url: c.url, title: c.title || "" }));
    return { text, citations };
  },
};

// ChatGPT：OpenAI Responses API + web_search 工具，引用在 url_citation 標註
const chatgpt = {
  id: "chatgpt",
  name: "ChatGPT",
  enabled: () => !!process.env.OPENAI_API_KEY,
  async ask(prompt) {
    const j = await postJson(
      "https://api.openai.com/v1/responses",
      { model: process.env.OPENAI_MODEL || "gpt-5", tools: [{ type: "web_search" }], input: prompt },
      { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    );
    const parts = (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((c) => c.type === "output_text");
    return {
      text: parts.map((p) => p.text).join(""),
      citations: parts.flatMap((p) => p.annotations || []).filter((a) => a.type === "url_citation").map((a) => ({ url: a.url, title: a.title || "" })),
    };
  },
};

// Gemini：Google 搜尋 grounding。來源網址是 Google 的轉址連結，網域放在 title
const gemini = {
  id: "gemini",
  name: "Gemini",
  enabled: () => !!process.env.GEMINI_API_KEY,
  async ask(prompt) {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const j = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
      { "x-goog-api-key": process.env.GEMINI_API_KEY }
    );
    const cand = j.candidates?.[0] || {};
    return {
      text: (cand.content?.parts || []).map((p) => p.text || "").join(""),
      citations: (cand.groundingMetadata?.groundingChunks || []).filter((c) => c.web).map((c) => ({ url: c.web.uri, title: c.web.title || "", domain: c.web.title || "" })),
    };
  },
};

// Google AI 總覽：透過 SerpAPI 取得搜尋結果頁上的 AI Overview
const aiOverview = {
  id: "aio",
  name: "Google AI 總覽",
  enabled: () => !!process.env.SERPAPI_KEY,
  async ask(prompt) {
    const q = new URLSearchParams({ engine: "google", q: prompt, hl: "zh-tw", gl: "tw", api_key: process.env.SERPAPI_KEY });
    let j = await (await fetch("https://serpapi.com/search.json?" + q, { signal: AbortSignal.timeout(TIMEOUT) })).json();
    if (j.error) throw new Error(j.error);
    let ao = j.ai_overview;
    if (ao?.page_token) {
      const q2 = new URLSearchParams({ engine: "google_ai_overview", page_token: ao.page_token, api_key: process.env.SERPAPI_KEY });
      ao = (await (await fetch("https://serpapi.com/search.json?" + q2, { signal: AbortSignal.timeout(TIMEOUT) })).json()).ai_overview || ao;
    }
    if (!ao) return { text: "", citations: [], noAnswer: true };
    const blockText = (b) => [b.snippet, ...(b.list || []).map((x) => x.snippet || x.title)].filter(Boolean).join(" ");
    return {
      text: (ao.text_blocks || []).map(blockText).join("\n"),
      citations: (ao.references || []).map((r) => ({ url: r.link, title: r.title || "" })),
    };
  },
};

export const PROVIDERS = [aiOverview, chatgpt, gemini, claude];
export const enabledProviders = () => PROVIDERS.filter((p) => p.enabled());
export { hostOf };
