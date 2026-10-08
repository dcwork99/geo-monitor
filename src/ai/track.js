// AI 平台追蹤：把題目送到各平台，分析品牌提及與官網引用，存檔並彙總
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../env.js";
import { enabledProviders, PROVIDERS, hostOf } from "./providers.js";
import { loadPromptSet, isPlaceholder, LAYERS } from "./promptset.js";

const DIR = path.join(ROOT, "data/tracking");
const DAY = 86400000;
const bare = (h) => (h || "").toLowerCase().replace(/^www\./, "");

function brandsOf(set) {
  return [
    { name: set.brand.name, names: [set.brand.name, ...(set.brand.aliases || [])], domain: bare(set.brand.domain), self: true },
    ...(set.competitors || []).map((c) => ({ name: c.name, names: [c.name, ...(c.aliases || [])], domain: bare(c.domain) })),
  ];
}

// 品牌在回答中第一次出現的位置；沒出現回傳 -1
function firstPos(text, names) {
  const t = text.toLowerCase();
  let best = -1;
  for (const n of names.filter((x) => x && x.trim().length >= 2)) {
    const i = t.indexOf(n.toLowerCase());
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

const citesDomain = (cites, domain) =>
  !!domain && cites.some((c) => {
    const h = bare(hostOf(c.url));
    const d = bare(c.domain || "");
    return h === domain || h.endsWith("." + domain) || d === domain || d.endsWith("." + domain);
  });

export function analyze(answer, set) {
  const brands = brandsOf(set);
  const mentions = {};
  for (const b of brands) {
    const pos = firstPos(answer.text, b.names);
    // 官網被引用也算提及
    if (pos >= 0 || citesDomain(answer.citations, b.domain)) mentions[b.name] = pos >= 0 ? pos : 1e9;
  }
  const self = brands[0];
  return { mentions, selfMentioned: self.name in mentions, selfCited: citesDomain(answer.citations, self.domain) };
}

export async function runTracking(host, { onProgress = () => {} } = {}) {
  const set = await loadPromptSet(host);
  if (!set) throw new Error("還沒有追蹤題目，請先產生或建立題目");
  const prompts = set.prompts.filter((p) => p.text && !isPlaceholder(p));
  if (!prompts.length) throw new Error(`追蹤題目還是範本內容，請先編輯 data/prompts/${host}.json`);
  const providers = enabledProviders();
  if (!providers.length) throw new Error("沒有可用的 AI 平台，請在 .env 設定至少一個平台的 API key");

  const repeat = Math.max(1, Number(process.env.TRACK_RUNS || 1));
  const tasks = [];
  for (const p of prompts) for (const pv of providers) for (let r = 0; r < repeat; r++) tasks.push({ p, pv });
  const runAt = new Date().toISOString();
  const records = [];
  const fatal = {};
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const { p, pv } = tasks[i++];
      const rec = { platform: pv.id, promptId: p.id, layer: p.layer, prompt: p.text };
      if (fatal[pv.id]) Object.assign(rec, { ok: false, error: fatal[pv.id] });
      else {
        try {
          const a = await pv.ask(p.text);
          Object.assign(rec, { ok: true, noAnswer: !!a.noAnswer, text: a.text.slice(0, 4000), citations: a.citations.slice(0, 20), ...analyze(a, set) });
        } catch (e) {
          // 金鑰、額度等設定錯誤，同平台後面的題目直接跳過
          if (/401|403|invalid|api key|credit|quota|billing|workspace/i.test(e.message)) fatal[pv.id] = e.message;
          Object.assign(rec, { ok: false, error: e.message });
        }
      }
      records.push(rec);
      onProgress({ step: "AI 平台追蹤", done: records.length, total: tasks.length });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const run = { runAt, host, platforms: providers.map((p) => p.id), brand: set.brand.name, records };
  const dir = path.join(DIR, host);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, runAt.replace(/[:.]/g, "-") + ".json"), JSON.stringify(run, null, 2));
  return { runAt, total: records.length, ok: records.filter((r) => r.ok).length, errors: Object.entries(fatal).map(([k, v]) => `${k}：${v}`) };
}

async function loadRuns(host) {
  const dir = path.join(DIR, host);
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const runs = [];
  for (const f of files) { try { runs.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))); } catch {} }
  return runs.sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
}

const pct = (a, b) => (b ? (a / b) * 100 : null);
const diff = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);

function platformStats(recs, brand) {
  const ok = recs.filter((r) => r.ok && !r.noAnswer);
  const counts = {};
  let totalMentions = 0;
  for (const r of ok) for (const b of Object.keys(r.mentions || {})) { counts[b] = (counts[b] || 0) + 1; totalMentions++; }
  const ranking = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  // 同分同名次：名次 = 1 + 提及次數比自己多的品牌數
  const mine = counts[brand] || 0;
  return {
    responses: ok.length,
    mentionRate: pct(ok.filter((r) => r.selfMentioned).length, ok.length),
    sov: pct(counts[brand] || 0, totalMentions),
    citedRate: pct(ok.filter((r) => r.selfCited).length, ok.length),
    rank: mine ? 1 + ranking.filter(([, n]) => n > mine).length : null,
    brandCount: ranking.length,
    leader: ranking[0]?.[0] || null,
  };
}

// 彙總最近 30 天，並與前 30 天比較
export async function summarizeTracking(host) {
  const runs = await loadRuns(host);
  if (!runs.length) return null;
  const set = await loadPromptSet(host);
  const brand = set?.brand.name || runs.at(-1).brand;
  const last = Date.parse(runs.at(-1).runAt);
  const tag = (r) => r.records.map((x) => ({ ...x, runAt: r.runAt }));
  const cur = runs.filter((r) => Date.parse(r.runAt) > last - 30 * DAY).flatMap(tag);
  const prev = runs.filter((r) => Date.parse(r.runAt) <= last - 30 * DAY && Date.parse(r.runAt) > last - 60 * DAY).flatMap(tag);
  const errors = [...new Set(runs.at(-1).records.filter((r) => !r.ok).map((r) => `${PROVIDERS.find((p) => p.id === r.platform)?.name || r.platform}：${r.error}`))].slice(0, 5);

  const platforms = PROVIDERS.filter((p) => cur.some((r) => r.platform === p.id)).map((p) => {
    const c = platformStats(cur.filter((r) => r.platform === p.id), brand);
    const v = platformStats(prev.filter((r) => r.platform === p.id), brand);
    return { id: p.id, name: p.name, ...c, delta: { mentionRate: diff(c.mentionRate, v.mentionRate), sov: diff(c.sov, v.sov), citedRate: diff(c.citedRate, v.citedRate), rank: c.rank && v.rank ? v.rank - c.rank : null } };
  });

  const overallC = platformStats(cur, brand);
  const overallP = platformStats(prev, brand);
  const prompts = (set?.prompts || []).filter((p) => !isPlaceholder(p)).map((p) => {
    const rc = cur.filter((r) => r.promptId === p.id && r.ok && !r.noAnswer);
    const rp = prev.filter((r) => r.promptId === p.id && r.ok && !r.noAnswer);
    const m = rc.filter((r) => r.selfMentioned).length;
    const rate = pct(m, rc.length);
    return { id: p.id, text: p.text, layer: p.layer, mentioned: m, total: rc.length, rate, delta: diff(rate, pct(rp.filter((r) => r.selfMentioned).length, rp.length)), cited: rc.filter((r) => r.selfCited).length };
  });
  const layers = Object.keys(LAYERS).map((k) => {
    const ps = prompts.filter((p) => p.layer === k);
    const lc = cur.filter((r) => r.layer === k && r.ok && !r.noAnswer);
    const lp = prev.filter((r) => r.layer === k && r.ok && !r.noAnswer);
    const rate = pct(lc.filter((r) => r.selfMentioned).length, lc.length);
    return { id: k, label: LAYERS[k], count: ps.length, rate, delta: diff(rate, pct(lp.filter((r) => r.selfMentioned).length, lp.length)),
      mentionedPrompts: ps.filter((p) => p.mentioned > 0).length, citedPrompts: ps.filter((p) => p.cited > 0).length,
      prompts: ps.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)) };
  }).filter((l) => l.count);

  const gaps = prompts.filter((p) => p.total > 0 && p.mentioned === 0).slice(0, 5).map((p) => ({
    item: `補上能回答「${p.text}」的內容`, level: "近期", effort: "大", gap: `這題提及率 0%（${p.layer}）`, source: "AI 追蹤",
  }));

  return {
    brand,
    competitors: (set?.competitors || []).map((c) => c.name),
    period: { from: new Date(last - 30 * DAY).toISOString(), to: runs.at(-1).runAt, runs: runs.filter((r) => Date.parse(r.runAt) > last - 30 * DAY).length, hasPrev: prev.length > 0 },
    overall: { ...overallC, delta: { mentionRate: diff(overallC.mentionRate, overallP.mentionRate), sov: diff(overallC.sov, overallP.sov), citedRate: diff(overallC.citedRate, overallP.citedRate) } },
    platforms,
    layers,
    gaps,
    errors,
  };
}
