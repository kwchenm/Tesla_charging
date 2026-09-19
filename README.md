# ⚡ 找充電站（EV Charging Finder）

輸入目的地，列出**步行 5 分鐘內**可到達的前 5 名電動車充電站，並顯示：

- 剩餘充電位 / 總充電位（即時，來源 Google Places）
- 充電費率（來源 Open Charge Map 或自訂 `rates.json`）
- 走到目的地的時間與距離（Google Routes API 步行路線；沒有時用直線距離估算）
- 接頭規格與功率、營業狀態、故障格數、資料更新時間
- 一鍵開始導航（Google 地圖 / Apple 地圖），以及停好車後走到目的地的步行路線

純前端網頁（HTML + JS），不需要後端，用 GitHub Pages 部署後手機直接開，可「加入主畫面」當 App 用。

## 在手機上使用

1. 開啟 GitHub Pages 網址（`https://<你的帳號>.github.io/<repo 名稱>/`）
2. iPhone：Safari → 分享 → 「加入主畫面」；Android：Chrome → ⋮ → 「加到主畫面」
3. 第一次開啟是**示範模式**（假資料），可以先試操作
4. 點右上角 ⚙️ 輸入 API 金鑰 → 取消勾選示範模式 → 儲存

> 金鑰只存在手機瀏覽器的 localStorage，不會寫進程式碼或上傳 GitHub。

## API 金鑰

| 金鑰 | 用途 | 必要性 |
|---|---|---|
| Google Maps Platform | 目的地搜尋、充電站清單、**即時剩餘充電位**、步行時間 | 建議（沒有就沒有即時空位） |
| Open Charge Map | **充電費率**、營運商 | 選用 |

### Google Maps Platform

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案並啟用帳單（每月有免費額度）
2. 「API 和服務」→ 啟用 **Places API (New)** 與 **Routes API**
3. 「憑證」→ 建立 API 金鑰，並**務必設定限制**：
   - 應用程式限制：HTTP 參照網址 → `https://<你的帳號>.github.io/*`
   - API 限制：只勾 Places API (New)、Routes API

> 即時空位（`evChargeOptions.availableCount`）只有業者有提供給 Google 的站點才有；沒有的站會顯示「無即時資料」但仍列出總格數。

### Open Charge Map

到 <https://openchargemap.org/site/develop/api> 註冊後免費取得金鑰。費率是社群填寫的文字，未必最新。

## 費率從哪來

Google API **不提供充電價格**，所以費率依序來自：

1. **Open Charge Map** 使用者回報的費率（需 OCM 金鑰；台灣資料不多）
2. **[rates.json](rates.json)**：依站名/營運商關鍵字比對，已內建 Tesla、U-POWER、EVOASIS、EVALUE、TAIL、星舟、全國特急電、iCHARGING 的公告費率，並依**現在時段**（平日尖峰 16:00–21:59／離峰／假日）顯示當下價格
3. 都比對不到（例如站名只寫「某某停車場」）就顯示「未提供」

搜尋結果下方會顯示 Open Charge Map 的查詢狀態，方便確認金鑰是否正常。

業者價格常調整，更新時直接改 `rates.json` 的數字和 `updated` 日期即可，push 後自動部署。

## 本機開發

```bash
python -m http.server 8765
```

然後開 <http://localhost:8765>。

## 部署

推到 `main` 分支後，`.github/workflows/pages.yml` 會自動部署到 GitHub Pages。
第一次需要到 repo 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
