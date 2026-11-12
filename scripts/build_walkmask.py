"""歩けるマス（data/walkmask.png）を作る。白=歩ける、黒=歩けない。

data/landmask.png（陸地）に、OpenStreetMap の「人や自転車が通れる橋」を書き足す。
これで、橋のある川は渡れて、橋のない海や運河は回り込むようになる。
使い方: python scripts/build_landmask.py のあとに python scripts/build_walkmask.py
       （Pillow が必要。橋データは Overpass API から取得）
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

AREA = dict(w=139.45, e=140.05, s=35.45, n=35.90)  # app.js の AREA と同じ
DATA = Path(__file__).resolve().parent.parent / "data"
SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# 歩行者・自転車が通れる道の橋（高速道路 motorway は除く）
HIGHWAYS = ("trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|"
            "pedestrian|footway|cycleway|path|steps|track|road|trunk_link|primary_link|secondary_link|tertiary_link")
QUERY = (f'[out:json][timeout:180];way["bridge"]["highway"~"^({HIGHWAYS})$"]["foot"!="no"]'
         f'({AREA["s"]},{AREA["w"]},{AREA["n"]},{AREA["e"]});out geom;')


def fetch_bridges(cache: Path | None):
    if cache and cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "commute-map-build"})
            with urllib.request.urlopen(req, timeout=240) as r:
                d = json.loads(r.read())
            if cache:
                cache.write_text(json.dumps(d), encoding="utf-8")
            return d
        except Exception as e:  # 混んでいるときは別のサーバーで再試行
            print(f"{url}: {e}", file=sys.stderr)
            time.sleep(10)
    raise SystemExit("橋データを取得できませんでした")


land = Image.open(DATA / "landmask.png").convert("L")
cols, rows = land.size
y_n = math.log(math.tan(math.pi / 4 + math.radians(AREA["n"]) / 2))
y_s = math.log(math.tan(math.pi / 4 + math.radians(AREA["s"]) / 2))


def to_px(lon, lat):
    x = (lon - AREA["w"]) / (AREA["e"] - AREA["w"]) * cols
    y = (y_n - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))) / (y_n - y_s) * rows
    return x, y


cache = Path(sys.argv[1]) if len(sys.argv) > 1 else None  # 取得済みの JSON を使うとき
data = fetch_bridges(cache)
walk = land.copy()
draw = ImageDraw.Draw(walk)
n = 0
for el in data["elements"]:
    pts = [to_px(p["lon"], p["lat"]) for p in el.get("geometry", [])]
    if len(pts) >= 2:
        draw.line(pts, fill=255, width=2)  # 約200m幅で描いて、両岸の陸とつなげる
        n += 1
walk.point(lambda v: 255 if v > 127 else 0).convert("1").save(DATA / "walkmask.png", optimize=True)
print(f"bridges={n} -> {DATA / 'walkmask.png'}")
