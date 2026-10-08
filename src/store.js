import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./env.js";
import { buildPriorities } from "./priorities.js";

const DIR = path.join(ROOT, "data/scans");

export async function saveScan(result) {
  const dir = path.join(DIR, result.target.host);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, result.finishedAt.replace(/[:.]/g, "-") + ".json");
  await fs.writeFile(file, JSON.stringify(result, null, 2));
  return file;
}

export async function history(host) {
  const dir = path.join(DIR, host);
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out = [];
  for (const f of files.slice(-24)) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      out.push({ finishedAt: j.finishedAt, scores: j.scores, issues: j.issues.reduce((n, i) => n + i.count, 0), file: f });
    } catch {}
  }
  return out;
}

export async function latest(host) {
  const h = await history(host);
  if (!h.length) return null;
  const r = JSON.parse(await fs.readFile(path.join(DIR, host, h.at(-1).file), "utf8"));
  // 舊版檢測結果沒有優先修復清單，依存檔資料補算
  r.priorities ??= buildPriorities(r.issues, r.geo.items, r.geo.recommendations || []);
  return r;
}

// 最近檢測過的網站排前面
export async function listHosts() {
  let dirs = [];
  try { dirs = (await fs.readdir(DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const withTime = await Promise.all(dirs.map(async (h) => {
    const files = (await fs.readdir(path.join(DIR, h))).filter((f) => f.endsWith(".json")).sort();
    return { h, last: files.at(-1) || "" };
  }));
  return withTime.sort((a, b) => b.last.localeCompare(a.last)).map((x) => x.h);
}
