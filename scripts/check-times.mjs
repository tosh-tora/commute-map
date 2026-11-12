// 駅間の推定時間を、実際の所要時間（目安）と比べる。
// 使い方: node scripts/build-graph.mjs のあとに node scripts/check-times.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const g = JSON.parse(await readFile(join(ROOT, 'data', 'graph.json'), 'utf8'));

// [路線名, 乗る駅, 降りる駅, 実際の所要時間（分、日中のふつうの列車の目安）]
const REAL = [
  ['山手線', '東京', '品川', 12],
  ['山手線', '新宿', '渋谷', 7],
  ['中央線快速', '新宿', '東京', 14],
  ['中央線快速', '新宿', '吉祥寺', 15],
  ['東海道線', '品川', '横浜', 17],
  ['総武快速線', '東京', '船橋', 24],
  ['埼京線・川越線', '新宿', '赤羽', 14],
  ['半蔵門線', '渋谷', '大手町', 13],
  ['浅草線', '押上', '大門', 18],
  ['銀座線', '渋谷', '銀座', 16],
  ['丸ノ内線', '池袋', '東京', 16],
  ['常磐線快速', '北千住', '上野', 11],
  ['宇都宮線', '上野', '大宮', 26],
  ['大江戸線', '新宿', '六本木', 9],
  ['東横線', '渋谷', '横浜', 30],
  ['田園都市線', '渋谷', '二子玉川', 16],
  ['京王線', '新宿', '調布', 20],
  ['小田原線', '新宿', '登戸', 22],
  ['東上線', '池袋', '和光市', 17],
];

const ride = new Map();
for (const [a, b, t10, k] of g.edges) if (k === 0) { ride.set(`${a}-${b}`, t10 / 10); ride.set(`${b}-${a}`, t10 / 10); }

let sumErr = 0;
for (const [line, from, to, real] of REAL) {
  const li = g.lines.findIndex(([n]) => n === line);
  const ids = g.nodes.map((n, i) => i).filter((i) => g.nodes[i][3] === li);
  const names = ids.map((i) => g.nodes[i][0]);
  const find = (s) => (names.indexOf(s) >= 0 ? names.indexOf(s) : names.findIndex((n) => n.startsWith(s)));
  const a = find(from), b = find(to);
  if (li < 0 || a < 0 || b < 0) { console.log(`${line} ${from}→${to}: 見つからない`); continue; }
  // その路線だけを使った最短時間（環状線は近い方を回る）
  const best = new Map([[ids[a], 0]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, w] of ride) {
      const [x, y] = key.split('-').map(Number);
      if (!best.has(x) || g.nodes[y][3] !== li) continue;
      const nt = best.get(x) + w;
      if (nt < (best.get(y) ?? Infinity)) { best.set(y, nt); changed = true; }
    }
  }
  const t = best.get(ids[b]);
  const err = t - real;
  sumErr += Math.abs(err);
  console.log(`${line.padEnd(8, '　')} ${from}→${to}  推定 ${t.toFixed(1).padStart(5)}分  実際 ${String(real).padStart(2)}分  差 ${err >= 0 ? '+' : ''}${err.toFixed(1)}`);
}
console.log(`平均のずれ ${(sumErr / REAL.length).toFixed(1)}分`);
