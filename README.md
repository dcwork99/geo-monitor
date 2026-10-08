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
| 實際 AI 引用率 | Perplexity／OpenAI／Gemini／SerpAPI | ⏳ 第二階段 |
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

## 專案結構

```
server.js          網頁伺服器與 API（/api/scan、/api/job、/api/latest、/api/hosts）
scan.js            命令列入口
src/crawler.js     爬蟲：robots.txt、sitemap、逐頁解析
src/checks.js      技術問題、GEO 項目與分數計算
src/llm.js         Claude 頁面評估與總評
src/pagespeed.js   PageSpeed Insights
src/store.js       檢測結果存檔與歷史紀錄
public/index.html  報告介面
```

## 分數怎麼算

- 技術 SEO：從 100 分扣分，嚴重 12、警告 5、提示 2，依受影響頁面比例調整。
- 結構化資料：JSON-LD 覆蓋率、Organization、WebSite、內容類型 schema。
- 內容結構、權威訊號、AI 可引用性：規則判斷，有 Claude 時與 Claude 評分加權平均。
- 整體：技術 25%、內容 20%、結構化資料 20%、權威 15%、AI 可引用性 20%。
