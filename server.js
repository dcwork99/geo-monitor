import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./src/env.js";
import { runScan } from "./src/scan.js";
import { latest, history, listHosts } from "./src/store.js";
import { runTracking, summarizeTracking } from "./src/ai/track.js";
import { loadPromptSet, generatePromptSet, templatePromptSet, promptFile, isPlaceholder } from "./src/ai/promptset.js";
import { PROVIDERS } from "./src/ai/providers.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// 公開模式：任何人都能檢測（規則檢測、不用 Claude），管理功能在 /admin 並需要帳密
const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
const LIMIT = {
  maxPages: Number(process.env.PUBLIC_MAX_PAGES || 50),
  perHour: Number(process.env.PUBLIC_SCANS_PER_HOUR || 3),
  concurrent: Number(process.env.MAX_CONCURRENT_SCANS || 2),
  cacheHours: Number(process.env.CACHE_HOURS || 24),
};

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

// ── 長時間工作：前端輪詢進度 ──
const jobs = new Map();
function startJob(fn) {
  const id = crypto.randomUUID();
  const job = { id, status: "running", progress: { step: "開始" }, startedAt: Date.now() };
  jobs.set(id, job);
  fn((p) => (job.progress = p))
    .then((r) => Object.assign(job, { status: "done", result: r }))
    .catch((e) => Object.assign(job, { status: "error", error: e.message }));
  return id;
}
// 一小時前的工作從記憶體清掉
setInterval(() => {
  for (const [id, j] of jobs) if (Date.now() - j.startedAt > 3600e3) jobs.delete(id);
}, 600e3).unref();

// ── 檢測排隊：同時最多 LIMIT.concurrent 個 ──
let running = 0;
const waiting = [];
async function withSlot(onProgress, fn) {
  if (running >= LIMIT.concurrent) {
    await new Promise((resolve) => {
      const me = { resolve, onProgress };
      waiting.push(me);
      const update = () => waiting.forEach((w, i) => w.onProgress({ step: "排隊中", detail: `前面還有 ${i + 1} 個檢測` }));
      update();
      me.update = update;
    });
  }
  running++;
  try { return await fn(); } finally {
    running--;
    const next = waiting.shift();
    if (next) { next.resolve(); next.update(); }
  }
}

// ── 每個 IP 每小時的檢測次數 ──
const hits = new Map();
const clientIp = (req) =>
  (process.env.TRUST_PROXY === "1" && (req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())) || req.socket.remoteAddress;
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= LIMIT.perHour) { hits.set(ip, list); return Math.ceil((list[0] + 3600e3 - now) / 60000); }
  list.push(now);
  hits.set(ip, list);
  return 0;
}

// ── 24 小時內查過的網站直接回傳 ──
const hostOfInput = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase(); } catch { return ""; } };
async function cached(input) {
  const h = hostOfInput(input);
  if (!h) return null;
  for (const host of [h, h.startsWith("www.") ? h.slice(4) : "www." + h]) {
    const r = await latest(host).catch(() => null);
    if (r && Date.now() - Date.parse(r.finishedAt) < LIMIT.cacheHours * 3600e3) {
      r.history = await history(r.target.host);
      return r;
    }
  }
  return null;
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

// ── 帳密（HTTP Basic Auth）──
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
function askLogin(res) {
  res.writeHead(401, { "www-authenticate": 'Basic realm="GEO Monitor Admin", charset="UTF-8"', "content-type": "text/plain; charset=utf-8" });
  res.end("需要登入");
}

async function servePage(res, mode) {
  let html = await fs.readFile(path.join(PUBLIC, "index.html"), "utf8");
  const meta = { public: '<meta name="geo-mode" content="public">', admin: '<meta name="geo-mode" content="admin">\n<meta name="geo-api" content="/admin/api">\n<meta name="robots" content="noindex">' }[mode] || "";
  html = html.replace("<head>", "<head>\n" + meta);
  res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  let pathname = u.pathname;
  let admin = !PUBLIC_MODE;

  // 公開模式：/admin 開頭需要帳密，其餘開放；非公開模式：設了密碼就全站需要帳密
  if (PUBLIC_MODE) {
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      if (!authorized(req)) return askLogin(res);
      admin = true;
      pathname = pathname.slice("/admin".length) || "/";
    }
  } else if (!authorized(req)) return askLogin(res);

  try {
    if (req.method === "POST" && pathname === "/api/scan") {
      const { url, maxPages = 100, competitors = [] } = await readBody(req);
      if (!url || typeof url !== "string" || url.length > 300) return send(res, 400, { error: "請輸入網址" });

      if (!admin) {
        const hit = await cached(url);
        if (hit) return send(res, 202, { id: startJob(async () => hit) });
        const wait = rateLimited(clientIp(req));
        if (wait) return send(res, 429, { error: `檢測次數已達上限（每小時 ${LIMIT.perHour} 次），請 ${wait} 分鐘後再試。` });
      }
      const opts = admin
        ? { maxPages: Math.min(Math.max(Number(maxPages) || 100, 10), 500), competitors: (Array.isArray(competitors) ? competitors : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 3), useLLM: true }
        : { maxPages: LIMIT.maxPages, competitors: [], useLLM: false };
      const id = startJob((onProgress) => withSlot(onProgress, async () => {
        const r = await runScan(url, { ...opts, onProgress });
        return admin ? Object.assign(r, await trackingInfo(r.target.host)) : r;
      }));
      return send(res, 202, { id });
    }
    if (pathname === "/api/job") {
      const job = jobs.get(u.searchParams.get("id"));
      if (!job) return send(res, 404, { error: "找不到這個檢測工作，可能伺服器已重新啟動" });
      return send(res, 200, job);
    }

    // 以下為管理功能
    if (pathname.startsWith("/api/") && !admin) return send(res, 403, { error: "需要管理員權限" });
    if (req.method === "POST" && pathname === "/api/prompts") {
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
    if (req.method === "POST" && pathname === "/api/track") {
      const host = cleanHost((await readBody(req)).host);
      const id = startJob(async (onProgress) => {
        const r = await runTracking(host, { onProgress });
        if (!r.ok) throw new Error("所有平台都失敗：" + r.errors.join("；"));
        return trackingInfo(host);
      });
      return send(res, 202, { id });
    }
    if (pathname === "/api/latest") {
      const r = await latest(cleanHost(u.searchParams.get("host")));
      if (!r) return send(res, 404, { error: "這個網站還沒有檢測紀錄" });
      r.history = await history(r.target.host);
      return send(res, 200, Object.assign(r, await trackingInfo(r.target.host)));
    }
    if (pathname === "/api/hosts") return send(res, 200, await listHosts());

    // 頁面與靜態檔案
    if (pathname === "/" || pathname === "/index.html") return servePage(res, PUBLIC_MODE ? (admin ? "admin" : "public") : "");
    const file = path.join(PUBLIC, path.normalize(pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "forbidden" });
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return send(res, 404, { error: "not found" });
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, process.env.HOST || undefined, () =>
  console.log(`GEO 技術監測系統：http://localhost:${PORT}${PUBLIC_MODE ? "（公開模式，管理後台 /admin）" : ""}`));
