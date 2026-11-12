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

// 乗換の時間には、歩く時間と次の電車の待ち時間（平均）を含める
const TRANSFER_SAME = 3;     // 同じホーム・すぐ隣の乗換（分）
const TRANSFER_NEAR = 7;     // 同じ駅の中での乗換（分）

// 路線ごとの [走る速さ km/h, 1駅あたりの停車時間 分]
// scripts/check-times.mjs で実際の所要時間と比べて合わせた値
function speedOf(id) {
  if (/Freight|JRTobuConnection|JROdakyuConnection/.test(id)) return null; // 使わない
  if (/^(TokyoMetro|Toei\.(Asakusa|Mita|Shinjuku|Oedo))/.test(id)) return [45, 0.5];
  if (/^(Toei\.(NipporiToneri|Arakawa)|Yurikamome|TokyoMonorail|TamaMonorail|ChibaMonorail|SaitamaTransit|YokohamaSeaside|Yamaman|Tokyu\.Setagaya)/.test(id)) return [25, 0.5];
  // JR の中距離電車（駅が少なく速い）
  if (/^JR-East\.(Tokaido|Utsunomiya|Takasaki|ShonanShinjuku)$/.test(id)) return [78, 0.5];
  if (/^JR-East\.(Yokosuka|SobuRapid)$/.test(id)) return [68, 0.5];
  if (/^JR-East\.JobanRapid$/.test(id)) return [52, 0.5];
  if (/^JR-East\.(ChuoRapid|SaikyoKawagoe|SotetsuDirect|Keiyo|Joban|Sobu)$/.test(id)) return [60, 0.5];
  if (/^(MIR\.TsukubaExpress|Keisei\.NaritaSkyAccess|Hokuso)/.test(id)) return [70, 0.5];
  if (/^JR-East\./.test(id)) return [42, 0.5];
  if (/^TWR\.Rinkai/.test(id)) return [45, 0.5];
  // 私鉄：駅は各停の駅順だが、急行も走るので停車を短めにして平均をとる
  return [60, 0.25];
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
const edges = [];           // [a, b, 分×10, 種類 0=乗車 1=乗換 2=直通]

for (const r of railways) {
  const sp = speedOf(r.id);
  if (!sp) continue;
  const [v, stopMin] = sp;
  const li = lines.length;
  let used = false;
  let prev = null;
  for (const sid of r.stations) {
    const s = stById.get(sid);
    if (!s || !inBox(s.coord)) { prev = null; continue; }
    if (!nodeIdx.has(sid)) {
      nodeIdx.set(sid, nodes.length);
      nodes.push([s.title.ja.normalize('NFKC'), +s.coord[0].toFixed(5), +s.coord[1].toFixed(5), li]);
    }
    const cur = nodeIdx.get(sid);
    if (prev !== null && prev !== cur) {
      const d = km(nodes[prev].slice(1, 3), nodes[cur].slice(1, 3)) * 1.1; // 線路は少し曲がる
      edges.push([prev, cur, Math.round((d / v * 60 + stopMin) * 10), 0]);
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

// 直通運転：つながる路線どうしの乗換を「乗換なし」（0分、種類2）にする
const THROUGH = [
  ['TokyoMetro.Hanzomon', 'Tokyu.DenEnToshi', '渋谷'],
  ['TokyoMetro.Hanzomon', 'Tobu.TobuSkytreeBranch', '押上'],
  ['Tobu.TobuSkytreeBranch', 'Tobu.TobuSkytree', '曳舟'],
  ['TokyoMetro.Hibiya', 'Tobu.TobuSkytree', '北千住'],
  ['TokyoMetro.Fukutoshin', 'Tokyu.Toyoko', '渋谷'],
  ['TokyoMetro.Fukutoshin', 'Tobu.Tojo', '和光市'],
  ['TokyoMetro.Fukutoshin', 'Seibu.SeibuYurakucho', '小竹向原'],
  ['TokyoMetro.Yurakucho', 'Tobu.Tojo', '和光市'],
  ['TokyoMetro.Yurakucho', 'Seibu.SeibuYurakucho', '小竹向原'],
  ['Seibu.SeibuYurakucho', 'Seibu.Ikebukuro', '練馬'],
  ['TokyoMetro.Namboku', 'Tokyu.Meguro', '目黒'],
  ['TokyoMetro.Namboku', 'SaitamaRailway.SaitamaRailway', '赤羽岩淵'],
  ['Toei.Mita', 'Tokyu.Meguro', '目黒'],
  ['TokyoMetro.Chiyoda', 'JR-East.JobanLocal', '綾瀬'],
  ['TokyoMetro.Chiyoda', 'Odakyu.Odawara', '代々木上原'],
  ['TokyoMetro.Tozai', 'JR-East.ChuoSobuLocal', '中野・西船橋'],
  ['TokyoMetro.Tozai', 'ToyoRapid.ToyoRapid', '西船橋'],
  ['Toei.Asakusa', 'Keisei.Oshiage', '押上'],
  ['Toei.Asakusa', 'Keikyu.Main', '泉岳寺'],
  ['Keisei.Oshiage', 'Keisei.Main', '青砥'],
  ['Keisei.Main', 'Hokuso.Hokuso', '京成高砂'],
  ['Keikyu.Main', 'Keikyu.Airport', '京急蒲田'],
  ['Toei.Shinjuku', 'Keio.KeioNew', '新宿'],
  ['Keio.KeioNew', 'Keio.Keio', '笹塚'],
  ['Tokyu.Toyoko', 'Minatomirai.Minatomirai', '横浜'],
  ['Tokyu.Toyoko', 'Tokyu.TokyuShinYokohama', '日吉'],
  ['Tokyu.Meguro', 'Tokyu.TokyuShinYokohama', '日吉'],
  ['Tokyu.TokyuShinYokohama', 'Sotetsu.SotetsuShinYokohama', '新横浜'],
  ['Sotetsu.SotetsuShinYokohama', 'Sotetsu.Main', '西谷'],
  ['JR-East.SotetsuDirect', 'Sotetsu.SotetsuShinYokohama', '羽沢横浜国大'],
  ['JR-East.SaikyoKawagoe', 'TWR.Rinkai', '大崎'],
  ['JR-East.Tokaido', 'JR-East.Utsunomiya', '東京'],            // 上野東京ライン
  ['JR-East.Tokaido', 'JR-East.Takasaki', '東京'],              // 上野東京ライン
  ['JR-East.Tokaido', 'JR-East.JobanRapid', '東京・品川'],            // 上野東京ライン
  ['JR-East.Yokosuka', 'JR-East.SobuRapid', '東京'],
];
const nodeRail = [];
for (const r of railways) for (const sid of r.stations) if (nodeIdx.has(sid)) nodeRail[nodeIdx.get(sid)] = r.id;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
// 組 -> つながる駅の名前（この駅での乗換だけを直通にする）
const through = new Map(THROUGH.map(([a, b, at]) => [pairKey(a, b), at.split('・')]));
const isJunction = (k, i) => through.get(k).some((name) => nodes[i][0].startsWith(name));
const found = new Map();
for (const e of edges) {
  if (e[3] !== 1) continue;
  const k = pairKey(nodeRail[e[0]], nodeRail[e[1]]);
  if (!through.has(k) || !isJunction(k, e[0]) || !isJunction(k, e[1])) continue;
  e[2] = 0; e[3] = 2;
  found.set(k, [...(found.get(k) || []), nodes[e[0]][0]]);
}
// 乗換データに入っていない組は、つながる駅（同じ名前・500m以内）どうしを直接つなぐ
for (const k of through.keys()) {
  if (found.has(k)) continue;
  const [a, b] = k.split('|');
  for (let i = 0; i < nodes.length; i++) {
    if (nodeRail[i] !== a || !isJunction(k, i)) continue;
    for (let j = 0; j < nodes.length; j++) {
      if (nodeRail[j] !== b || nodes[i][0] !== nodes[j][0]) continue;
      if (km(nodes[i].slice(1, 3), nodes[j].slice(1, 3)) > 0.5) continue;
      edges.push([i, j, 0, 2]);
      found.set(k, [...(found.get(k) || []), nodes[i][0]]);
    }
  }
}
for (const k of through.keys()) console.log(`直通 ${k}: ${found.has(k) ? [...new Set(found.get(k))].join('・') : '見つからない'}`);

await mkdir(join(ROOT, 'data'), { recursive: true });
const out = { source: 'Mini Tokyo 3D (MIT License)', lines, nodes, edges };
await writeFile(join(ROOT, 'data', 'graph.json'), JSON.stringify(out));
console.log(`lines=${lines.length} stations=${nodes.length} edges=${edges.length}`);
