import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 專案根目錄；所有路徑都以此為準，不受啟動時所在目錄影響
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
