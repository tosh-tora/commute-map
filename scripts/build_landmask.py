"""陸地マスク（data/landmask.png）を作る。白=陸、黒=海・川。

地理院タイル（淡色地図）の水部の色 (190,210,255) を読み取り、
ヒートマップと同じ範囲・メルカトル投影で 100m 四方ごとに「半分以上が水なら海」とする。
使い方: python scripts/build_landmask.py   （Pillow が必要）
"""
import io
import math
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageFilter

AREA = dict(w=139.45, e=140.05, s=35.45, n=35.90)  # app.js の AREA と同じ
CELL_M = 100
Z = 13
WATER = (190, 210, 255)
URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"
OUT = Path(__file__).resolve().parent.parent / "data" / "landmask.png"


def px(lon, lat):
    """経度緯度 -> ズーム Z の全体ピクセル座標"""
    n = 256 * 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


x0, y0 = px(AREA["w"], AREA["n"])
x1, y1 = px(AREA["e"], AREA["s"])
tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)

mosaic = Image.new("L", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), 0)
total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
done = 0
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        req = urllib.request.Request(URL.format(z=Z, x=tx, y=ty), headers={"User-Agent": "commute-map-build"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    tile = Image.open(io.BytesIO(r.read())).convert("RGB")
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:  # 何もない場所（海）はタイルがない
                    tile = Image.new("RGB", (256, 256), WATER)
                    break
                time.sleep(2)
        else:
            raise SystemExit(f"tile {tx},{ty} failed")
        # 水=255、それ以外=0
        water = Image.new("L", tile.size, 0)
        water.putdata([255 if p == WATER else 0 for p in tile.getdata()])
        mosaic.paste(water, ((tx - tx0) * 256, (ty - ty0) * 256))
        done += 1
        if done % 20 == 0:
            print(f"{done}/{total}")
        time.sleep(0.05)

crop = mosaic.crop((round(x0 - tx0 * 256), round(y0 - ty0 * 256), round(x1 - tx0 * 256), round(y1 - ty0 * 256)))
cols = round((AREA["e"] - AREA["w"]) * 111320 * math.cos(math.radians(35.68)) / CELL_M)
rows = round((AREA["n"] - AREA["s"]) * 111320 / CELL_M)
frac = crop.resize((cols, rows), Image.BOX)          # 水の割合（0〜255）
land = frac.point(lambda v: 255 if v < 128 else 0)   # 半分未満が水なら陸
land = land.filter(ImageFilter.MedianFilter(5))        # 海の上の文字などの小さな点を消す
OUT.parent.mkdir(exist_ok=True)
land.convert("1").save(OUT, optimize=True)
print(f"tiles={total} mask={cols}x{rows} -> {OUT} ({OUT.stat().st_size} bytes)")
