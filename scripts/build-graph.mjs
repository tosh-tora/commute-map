// 駅と路線のデータ（data/graph.json）を作る。
// 出典: Mini Tokyo 3D (MIT License) https://github.com/nagix/mini-tokyo-3d
// 使い方: node scripts/build-graph.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://raw.githubusercontent.com/nagix/mini-tokyo-3d/master/data/';

// 駅を残す範囲（ヒートマップの範囲より少し広く）
const BBOX = { w: 139.30, e: 140.20, s: 35.35, n: 36.00 };

const STOP_MIN = 0.5;        // 1駅あたりの停車時間（分）
const TRANSFER_SAME = 2;     // 同じホーム・すぐ隣の乗換（分）
const TRANSFER_NEAR = 5;     // 同じ駅の中での乗換（分）

// 路線ごとの平均速度（km/h、停車時間は別）
function speedOf(id) {
  if (/Freight|JRTobuConnection|JROdakyuConnection/.test(id)) return 0; // 使わない
  if (/^(TokyoMetro|Toei\.(Asakusa|Mita|Shinjuku|Oedo))/.test(id)) return 32;
  if (/^(Toei\.(NipporiToneri|Arakawa)|Yurikamome|TokyoMonorail|TamaMonorail|ChibaMonorail|SaitamaTransit|YokohamaSeaside|Yamaman|Tokyu\.Setagaya)/.test(id)) return 25;
  if (/^JR-East\.(ChuoRapid|Tokaido|Utsunomiya|Takasaki|Yokosuka|SobuRapid|JobanRapid|ShonanShinjuku|SaikyoKawagoe|SotetsuDirect|Keiyo|Joban|Sobu)$/.test(id)) return 60;
  if (/^(MIR\.TsukubaExpress|Keisei\.NaritaSkyAccess|Hokuso)/.test(id)) return 70;
  if (/^JR-East\./.test(id)) return 42;
  if (/^TWR\.Rinkai/.test(id)) return 45;
  return 45; // 私鉄（各停と急行の中間くらい）
}

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const get = async (f) => (await fetch(SRC + f)).json();
const [railways, stations, groups] = await Promise.all([
  get('railways.json'), get('stations.json'), get('station-groups.json'),
]);

const stById = new Map(stations.filter((s) => s.coord).map((s) => [s.id, s]));
const inBox = (c) => c[0] >= BBOX.w && c[0] <= BBOX.e && c[1] >= BBOX.s && c[1] <= BBOX.n;

const lines = [];           // [名前, 色]
const nodes = [];           // [駅名, 経度, 緯度, 路線番号]
const nodeIdx = new Map();  // 駅ID -> 番号
const edges = [];           // [a, b, 分×10, 種類 0=乗車 1=乗換]

for (const r of railways) {
  const v = speedOf(r.id);
  if (!v) continue;
  const li = lines.length;
  let used = false;
  let prev = null;
  for (const sid of r.stations) {
    const s = stById.get(sid);
    if (!s || !inBox(s.coord)) { prev = null; continue; }
    if (!nodeIdx.has(sid)) {
      nodeIdx.set(sid, nodes.length);
      nodes.push([s.title.ja, +s.coord[0].toFixed(5), +s.coord[1].toFixed(5), li]);
    }
    const cur = nodeIdx.get(sid);
    if (prev !== null && prev !== cur) {
      const d = km(nodes[prev].slice(1, 3), nodes[cur].slice(1, 3)) * 1.1; // 線路は少し曲がる
      edges.push([prev, cur, Math.round((d / v * 60 + STOP_MIN) * 10), 0]);
      used = true;
    }
    prev = cur;
  }
  lines.push([r.title.ja, r.color || "#888"]);
}

// 乗換
for (const g of groups) {
  const all = [];
  for (const sub of g) {
    const ids = sub.map((id) => nodeIdx.get(id)).filter((x) => x !== undefined);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) edges.push([ids[i], ids[j], TRANSFER_SAME * 10, 1]);
    all.push(ids);
  }
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++)
    for (const x of all[a]) for (const y of all[b]) edges.push([x, y, TRANSFER_NEAR * 10, 1]);
}

await mkdir(join(ROOT, 'data'), { recursive: true });
const out = { source: 'Mini Tokyo 3D (MIT License)', lines, nodes, edges };
await writeFile(join(ROOT, 'data', 'graph.json'), JSON.stringify(out));
console.log(`lines=${lines.length} stations=${nodes.length} edges=${edges.length}`);
