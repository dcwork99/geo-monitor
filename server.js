import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./src/env.js";
import { runScan } from "./src/scan.js";
import { latest, history, listHosts } from "./src/store.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(ROOT, "public");
const jobs = new Map();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1e5) throw new Error("請求內容過大");
  }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST" && u.pathname === "/api/scan") {
      const { url, maxPages = 100, competitors = [] } = await readBody(req);
      if (!url || typeof url !== "string") return send(res, 400, { error: "請輸入網址" });
      const id = crypto.randomUUID();
      const job = { id, status: "running", progress: { step: "開始" }, startedAt: Date.now() };
      jobs.set(id, job);
      runScan(url, {
        maxPages: Math.min(Math.max(Number(maxPages) || 100, 10), 500),
        competitors: (Array.isArray(competitors) ? competitors : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 3),
        onProgress: (p) => (job.progress = p),
      })
        .then((r) => Object.assign(job, { status: "done", result: r }))
        .catch((e) => Object.assign(job, { status: "error", error: e.message }));
      return send(res, 202, { id });
    }
    if (u.pathname === "/api/job") {
      const job = jobs.get(u.searchParams.get("id"));
      if (!job) return send(res, 404, { error: "找不到這個檢測工作，可能伺服器已重新啟動" });
      return send(res, 200, job);
    }
    if (u.pathname === "/api/latest") {
      const host = u.searchParams.get("host") || "";
      const r = await latest(host.replace(/[^\w.-]/g, ""));
      if (!r) return send(res, 404, { error: "這個網站還沒有檢測紀錄" });
      r.history = await history(r.target.host);
      return send(res, 200, r);
    }
    if (u.pathname === "/api/hosts") return send(res, 200, await listHosts());

    // 靜態檔案
    const file = path.join(PUBLIC, u.pathname === "/" ? "index.html" : path.normalize(u.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "forbidden" });
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, { error: "not found" });
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`GEO 技術監測系統：http://localhost:${PORT}`));
