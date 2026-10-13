# 特殊教育工作分析輔助系統

React / TypeScript / Vite，手機優先，資料只存放在目前瀏覽器的 LocalStorage。

## 開發與驗證

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run dev
pnpm run build
```

GitHub Pages：<https://jimmy-508.github.io/task-analysis-assistant/>

推送 main 後，GitHub Actions 執行 build、資料遷移測試與 Pages 部署。Vite 使用相對資源路徑，介面使用狀態切換，沒有需要伺服器轉址的 SPA 子路由。

## 操作

- 首頁一次顯示一個工作；左右箭頭切換，右上角加號建立工作。
- 齒輪開啟設定，可選擇提醒／測試工作，以及編輯或刪除工作。刪除需要確認，歷史 session 仍保留。
- 長按齒輪 7 秒進入教師分析，可依工作篩選；「清除測試紀錄」只清除目前篩選工作的 session。
- 新增、編輯工作時可以新增、刪除、上移、下移步驟。每個工作至少有一個非空白步驟。
- 每個工作依自己的時間安排每日提醒；測試提醒可以設定秒或分鐘。相同時間到期的提醒依序顯示。
- 網頁關閉或進入手機背景時，提醒／提示音可能受瀏覽器限制，不取代原生鬧鐘。
- 語音與求助計數分開；語音不支援或播放失敗不阻止任務。完成按鈕獨立固定在底部，保留 iPhone Safe Area。

## LocalStorage 相容性

沿用 `seta_mvp_state`，資料版本升級為 `version: 2`：

- `tasks`：工作 ID、名稱、自己的提醒時間、穩定步驟 ID、建立／更新時間。步驟陣列順序就是操作順序。
- `sessions`：工作 ID／名稱快照、總步數、每步的時間、語音次數、求助次數與獨立層級。
- `progress`：進行中工作的完整快照、session 與目前步驟，可在重新整理後繼續。
- `reminders` / `reminderQueue`：各工作的預定提醒與已到期的提醒。
- `selectedTaskId`：首頁所選工作。

舊資料第一次升級時，原始 JSON 備份到 `seta_mvp_state_backup_v1`。舊 session 缺少 taskId 時歸入「整理明天的書包」；舊語音、求助、每步時間與 session ID 保留。無法解析的資料會安全回復，避免白畫面；原始備份仍可供查核。新使用者建立預設 8 步工作，但明確刪除全部工作後不會自動重新建立。

已開始的工作與歷史 session 不隨後續工作編輯改變。刪除工作後，仍可在分析工作選單查看其歷史紀錄。不同瀏覽器與裝置不會同步資料。
