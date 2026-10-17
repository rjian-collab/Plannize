# Plannize 高效規劃

毛玻璃質感的個人專案管理桌面 App(Electron + Express),資料全部存在自己的電腦上。

## 功能

- 清單／日曆視圖、分類與優先級篩選、搜尋、子工作項
- 完成度 100% 自動封存,附完成動畫
- 截止提醒(Windows 桌面通知,使用工作排程器)
- 週期性例行任務與打卡紀錄
- 自動每日備份(保留 14 天)與還原
- 選用:Google 日曆雙向同步、Gmail 提醒信、雲端硬碟連結

## 安裝(一般使用者)

到 [Releases](../../releases) 下載最新的 `.exe` 安裝檔並執行。資料會存在 `%APPDATA%\Plannize\data`。

> 目前只支援 Windows。安裝檔未經程式碼簽章,Windows SmartScreen 可能會警告,選「其他資訊 → 仍要執行」即可。

## 從原始碼執行

需要 [Node.js](https://nodejs.org/) 22 以上。

```
npm install
npm run electron
```

從原始碼執行時,資料存在專案資料夾內的 `data\`(已被 `.gitignore` 排除)。

## 自行打包

```
npm run dist
```

安裝檔會產生在 `dist\`。

## 啟用 Google 功能(選用)

本專案不附帶任何金鑰,需要自己建立:

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案,啟用 Calendar、Gmail、Drive API。
2. 建立「電腦版應用程式」類型的 OAuth 用戶端,下載 JSON。
3. 將內容存成 `data\google-credentials.json`(安裝版為 `%APPDATA%\Plannize\data\google-credentials.json`),欄位需含 `client_id` 與 `client_secret`。
4. 在 App 右上角 ⚙️ 連結 Google 帳號。

## 授權

MIT
