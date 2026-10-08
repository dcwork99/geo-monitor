import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./src/env.js";
import { runScan } from "./src/scan.js";
import { latest, history, listHosts } from "./src/store.js";
import { runTracking, summarizeTracking } from "./src/ai/track.js";
import { loadPromptSet, generatePromptSet, templatePromptSet, promptFile, isPlaceholder } from "./src/ai/promptset.js";
import { enabledProviders, PROVIDERS } from "./src/ai/providers.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(ROOT, "public");
const jobs = new Map();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// 長時間工作（檢測、追蹤、產生題目）都用 job，前端輪詢進度
function startJob(fn) {
  const id = crypto.randomUUID();
  const job = { id, status: "running", progress: { step: "開始" }, startedAt: Date.now() };
  jobs.set(id, job);
  fn((p) => (job.progress = p))
    .then((r) => Object.assign(job, { status: "done", result: r }))
    .catch((e) => Object.assign(job, { status: "error", error: e.message }));
  return id;
}

const cleanHost = (h) => String(h || "").replace(/[^\w.-]/g, "");

async function trackingInfo(host) {
  const set = await loadPromptSet(host);
  return {
    tracking: await summarizeTracking(host),
    promptSet: set ? { file: promptFile(host), brand: set.brand.name, count: set.prompts.filter((p) => !isPlaceholder(p)).length, placeholder: set.prompts.some(isPlaceholder) } : null,
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled() })),
  };
}

async function readBody(req) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1e5) throw new Error("請求內容過大");
  }
  return s ? JSON.parse(s) : {};
}

// 登入保護：設定 AUTH_PASSWORD 後，所有頁面與 API 都要帳密（HTTP Basic Auth）
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
if (process.env.NODE_ENV === "production" && AUTH_PASSWORD.length < 10) {
  console.error("正式環境必須在 .env 設定 AUTH_PASSWORD（至少 10 個字元）");
  process.exit(1);
}
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function authorized(req) {
  if (!AUTH_PASSWORD) return true;
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/);
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], "base64").toString().split(":");
  return safeEqual(user, AUTH_USER) && safeEqual(rest.join(":"), AUTH_PASSWORD);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="GEO Monitor", charset="UTF-8"', "content-type": "text/plain; charset=utf-8" });
    return res.end("需要登入");
  }
  try {
    if (req.method === "POST" && u.pathname === "/api/scan") {
      const { url, maxPages = 100, competitors = [] } = await readBody(req);
      if (!url || typeof url !== "string") return send(res, 400, { error: "請輸入網址" });
      const id = startJob(async (onProgress) => {
        const r = await runScan(url, {
          maxPages: Math.min(Math.max(Number(maxPages) || 100, 10), 500),
          competitors: (Array.isArray(competitors) ? competitors : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 3),
          onProgress,
        });
        return Object.assign(r, await trackingInfo(r.target.host));
      });
      return send(res, 202, { id });
    }
    if (req.method === "POST" && u.pathname === "/api/prompts") {
      const host = cleanHost((await readBody(req)).host);
      const id = startJob(async (onProgress) => {
        onProgress({ step: "Claude 產生追蹤題目" });
        try { await generatePromptSet(host); } catch (e) {
          await templatePromptSet(host);
          throw new Error(`Claude 產生失敗（${e.message}），已建立空白範本：${promptFile(host)}`);
        }
        return trackingInfo(host);
      });
      return send(res, 202, { id });
    }
    if (req.method === "POST" && u.pathname === "/api/track") {
      const host = cleanHost((await readBody(req)).host);
      const id = startJob(async (onProgress) => {
        const r = await runTracking(host, { onProgress });
        if (!r.ok) throw new Error("所有平台都失敗：" + r.errors.join("；"));
        return trackingInfo(host);
      });
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
      return send(res, 200, Object.assign(r, await trackingInfo(r.target.host)));
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

server.listen(PORT, process.env.HOST || undefined, () => console.log(`GEO 技術監測系統：http://localhost:${PORT}`));
