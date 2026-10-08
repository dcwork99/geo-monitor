# 部署到寶塔主機

目標：在寶塔主機上以 Node 常駐執行，透過 nginx 對外提供 https://www.sitevance.tech 。

## 0. 準備

- 部署檔：在本機專案執行打包後的 `deploy/geo-monitor.zip`（已含 `.env`，不在 Git 裡）。
- `.env` 內的正式環境設定：`NODE_ENV=production`、`HOST=127.0.0.1`、`PORT=3100`、`AUTH_USER`、`AUTH_PASSWORD`。登入帳密就是這兩個值。

## 1. DNS

到網域註冊商新增一筆 A 紀錄：

| 主機 | 類型 | 值 |
|---|---|---|
| www | A | 寶塔主機的公網 IP |

## 2. 安裝 Node.js 22

寶塔面板 → 軟體商店 → 搜尋「Node.js 版本管理器」→ 安裝 → 設定 → 安裝 **v22** 的最新版本，並設為命令列版本。

## 3. 上傳程式

1. 檔案 → 進入 `/www/wwwroot/` → 上傳 `geo-monitor.zip`。
2. 對 zip 按右鍵 → 解壓縮，得到 `/www/wwwroot/geo-monitor/`。
3. 開啟終端機，安裝套件：

   ```bash
   cd /www/wwwroot/geo-monitor && npm ci --omit=dev
   ```

## 4. 建立 Node 專案

網站 → Node 項目 → 新增 Node 項目：

| 欄位 | 填寫 |
|---|---|
| 項目目錄 | `/www/wwwroot/geo-monitor` |
| 項目名稱 | `geo-monitor` |
| 啟動選項 | 自訂命令 `node server.js`（或選 package.json 的 `start`） |
| 項目連接埠 | `3100` |
| Node 版本 | v22 |
| 綁定網域 | `www.sitevance.tech` |

送出後狀態應為「運行中」。寶塔會自動建立 nginx 反向代理到 127.0.0.1:3100。

不需要在防火牆開放 3100，程式只聽 127.0.0.1。

## 5. HTTPS

網站 → 找到 `www.sitevance.tech` → 設定 → SSL → Let's Encrypt → 申請 → 開啟「強制 HTTPS」。

## 6. 驗證

開 https://www.sitevance.tech ，瀏覽器會要求帳密（`.env` 裡的 `AUTH_USER`／`AUTH_PASSWORD`），登入後應看到最近一次的檢測報告。

## 7. 每週自動追蹤（選用）

計劃任務 → 新增任務 → Shell 腳本，週期「每週一 09:00」：

```bash
cd /www/wwwroot/geo-monitor && $(command -v node) track.js www.sitevance.tw >> data/track.log 2>&1
```

若找不到 node，改用 Node 版本管理器顯示的完整路徑，例如 `/www/server/nodejs/v22.x.x/bin/node`。

## 更新版本

1. 在本機重新打包，上傳新的 zip 覆蓋解壓縮（保留主機上的 `data/` 與 `.env`）。
2. 若 `package.json` 有變動，重新執行 `npm ci --omit=dev`。
3. Node 項目 → `geo-monitor` → 重新啟動。

## 常見問題

- **502 Bad Gateway**：Node 項目沒在運行，到 Node 項目查看日誌。最常見是 `.env` 沒有 `AUTH_PASSWORD`，或 Node 版本低於 22。
- **檢測一直轉圈**：寶塔的 nginx 預設逾時 60 秒，但這個系統用輪詢，不受影響；若仍異常，查看 Node 項目日誌。
- **修改 `.env` 後沒生效**：要在 Node 項目重新啟動。
