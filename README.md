# 通勤時間マップ

東京23区と周辺で、通勤先までの所要時間（電車＋徒歩／自転車／徒歩）を地図に色で表示する静的サイトです。

- 公開ページ: https://tosh-tora.github.io/commute-map/
- 電車の時間は駅間の距離と路線ごとの平均速度からの目安です（実際の時刻表ではありません）。

## ファイル

- `index.html` / `style.css` / `app.js` — 画面と計算（ビルド不要）
- `data/graph.json` — 駅と路線のデータ。`node scripts/build-graph.mjs` で作り直せます
- `data/landmask.png` — 海・川を塗らないための陸地マスク。`python scripts/build_landmask.py` で作り直せます（Pillow が必要）
- `data/walkmask.png` — 歩ける場所（陸＋人や自転車が通れる橋）。徒歩・自転車は直線ではなくここをたどる道のりで計算します。`python scripts/build_walkmask.py` で作り直せます（landmask の後に実行）

## ローカルで動かす

```bash
npx serve .
```

## 出典

- 地図・陸地マスク: [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)
- 駅・路線: [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d)（MIT License）
- 橋: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- 住所検索: 国土地理院
