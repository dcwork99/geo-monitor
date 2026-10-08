# GEO 技術監測系統

輸入網址，爬取全站頁面，檢測技術 SEO 與 GEO（生成式引擎優化）內容，產出可給客戶看的報告。

## 功能

| 報告區塊 | 資料來源 | 狀態 |
|---|---|---|
| 整體 GEO 分數（5 個面向） | 爬取結果 + Claude 評估 | ✅ |
| 技術 SEO 問題（壞連結、canonical、title、H1、meta、HTTPS、混合內容、sitemap、robots、轉址鏈、alt、OG…） | 自建爬蟲 | ✅ |
| 行動版速度（LCP、CLS） | Google PageSpeed Insights API | ✅（建議設定 `PSI_API_KEY`） |
| GEO 內容（首段答案、結構化資料、作者／日期、數據來源、實體一致性、llms.txt） | 規則判斷 + Claude | ✅ |
| 重點頁面 AI 評估與改寫建議 | Claude | ✅（需 API key） |
| 競品 Gap | 同一套流程檢測最多 3 個競品 | ✅ |
| AI 爬蟲存取狀態（GPTBot、PerplexityBot、ClaudeBot…） | robots.txt | ✅ |
| 建議追蹤的 AI prompts | Claude | ✅（需 API key） |
| 優先修復清單（級別、改動量、AI 缺口） | 技術問題 + GEO 項目 + Claude 建議 + 追蹤缺口 | ✅ |
| AI 平台表現（提及率、聲量佔比、官網引用率、品牌排名、較上期變化） | Claude、ChatGPT、Gemini、Google AI 總覽 | ✅（需各平台 key） |
| 逐題表現（P1 認知／P2 比較／P3 決策） | 同上 | ✅（需各平台 key） |
| 歷史趨勢與追蹤報告 | `data/scans/` 內的歷次結果 | ✅ |

## 安裝

需要 Node.js 22 以上。

```bash
npm install
cp .env.example .env
```

編輯 `.env`：

- `ANTHROPIC_API_KEY`：Claude API key。沒填也能跑，內容分數會改用規則判斷。
- `ANTHROPIC_WORKSPACE_ID`：key 沒有綁定 workspace 時必填（Claude Console → Settings → Workspaces 可查到 ID）。
- `PSI_API_KEY`：Google PageSpeed Insights API key，選填。沒填時共用額度常常用完。

## 使用

網頁版：

```bash
npm start
```

開啟 http://localhost:3000 ，輸入網址按「開始檢測」。完成後可按「下載 PDF」或「下載 JSON」。

命令列：

```bash
npm run scan -- https://www.example.com --max=100 --competitors=a.com,b.com
```

每次檢測結果存在 `data/scans/<網域>/`，報告會自動顯示歷次分數趨勢。

## 前台報告（GitHub Pages）

`docs/` 是給 GitHub Pages 的靜態報告頁，只顯示報告，不能在網頁上檢測。更新步驟：

```bash
npm run scan -- https://www.example.com
npm run publish:site
```

`publish:site` 只會更新前台已經有的網站，然後 commit 並推上 GitHub，前台約 1 分鐘後更新。要把新網站放上前台，請明確指定（repo 是公開的，放上去任何人都看得到）：

```bash
npm run publish:site -- www.example.com
```前台網址可以加 `#網域` 直接開某個網站，例如 `#www.sitevance.tw`。

## AI 平台追蹤

1. 先檢測網站一次。
2. 產生追蹤題目（Claude 會判斷品牌、競品，產生 30 題並分成 P1／P2／P3）：

   ```bash
   npm run track -- www.example.com --init
   ```

   題目存在 `data/prompts/<網域>.json`，可以直接編輯題目、品牌別名（例如中英文名）與競品。Claude 無法使用時會建立空白範本。
3. 在 `.env` 填入要追蹤平台的 key：`OPENAI_API_KEY`（ChatGPT）、`GEMINI_API_KEY`（Gemini）、`SERPAPI_KEY`（Google AI 總覽）。Claude 使用既有的 `ANTHROPIC_API_KEY`。
4. 執行一輪追蹤（網頁上也有「立即執行一輪追蹤」按鈕）：

   ```bash
   npm run track -- www.example.com
   ```

報告統計最近 30 天的結果，並與前 30 天比較。

### 指標定義

- 品牌提及率：回答中提到品牌名稱或別名的比例（官網被引用也算提及）。
- 聲量佔比：所有品牌被提及次數中，本品牌所占比例。
- 官網引用率：回答的引用來源中有官網網址的比例。
- 品牌排名：依被提及次數排序，同分同名次。

### 每週自動執行

macOS 或 Linux 可用 crontab，例如每週一早上 9 點：

```
0 9 * * 1 cd /path/to/geo-monitor && /opt/homebrew/bin/node track.js www.example.com >> data/track.log 2>&1
```

## 專案結構

```
server.js          網頁伺服器與 API（/api/scan、/api/job、/api/latest、/api/hosts）
scan.js            命令列入口
src/crawler.js     爬蟲：robots.txt、sitemap、逐頁解析
src/checks.js      技術問題、GEO 項目與分數計算
src/llm.js         Claude 頁面評估與總評
src/pagespeed.js   PageSpeed Insights
src/store.js       檢測結果存檔與歷史紀錄
src/priorities.js  優先修復清單
src/ai/providers.js 各 AI 平台（Claude、ChatGPT、Gemini、Google AI 總覽）
src/ai/promptset.js 追蹤題目產生與讀取
src/ai/track.js     追蹤執行、提及與引用分析、彙總
track.js           追蹤命令列入口
public/index.html  報告介面
```

## 分數怎麼算

- 技術 SEO：從 100 分扣分，嚴重 12、警告 5、提示 2，依受影響頁面比例調整。
- 結構化資料：JSON-LD 覆蓋率、Organization、WebSite、內容類型 schema。
- 內容結構、權威訊號、AI 可引用性：規則判斷，有 Claude 時與 Claude 評分加權平均。
- 整體：技術 25%、內容 20%、結構化資料 20%、權威 15%、AI 可引用性 20%。
