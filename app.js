'use strict';

// ===== 設定 =====
const AREA = { w: 139.45, e: 140.05, s: 35.45, n: 35.90 }; // ヒートマップの範囲
const CELL_M = 100;            // マスの大きさ（m）。data/landmask.png と同じ
const WALK_M_PER_MIN = 80;
const WALK_DETOUR = 1.2;       // 道の回り道ぶん（マスをたどった距離に掛ける）
const BIKE_M_PER_MIN = 250;    // 時速15km
const BIKE_DETOUR = 1.15;
const WAIT_MIN = 3;            // 最初の電車の待ち時間
const EGRESS_MAX_MIN = 20;     // 通勤先の近くで電車を降りる駅（徒歩の上限）
const BRIDGE_CELLS = 2;        // この幅（×2マス＝約400m）までの川・運河は橋で渡れるとみなす

const BINS = [ // [上限の分, 色]
  // 45分までは5分刻み（近いほど濃い青→緑→黄）
  [10, '#0b3d91'], [15, '#1565c0'], [20, '#1e88e5'], [25, '#26a69a'],
  [30, '#43a047'], [35, '#7cb342'], [40, '#c0ca33'], [45, '#fdd835'],
  // それ以降は15分刻み
  [60, '#fb8c00'], [75, '#e64a19'], [90, '#b71c1c'], [Infinity, null],
];
const OPACITY = [['薄', 0.4], ['中', 0.6], ['濃', 0.8]];
const MODE_LABEL = { train: '電車＋徒歩', bike: '自転車', walk: '徒歩' };

// ===== 距離 =====
const M_PER_DEG_LAT = 111320;
const COS0 = Math.cos(35.68 * Math.PI / 180);
function meters(lon1, lat1, lon2, lat2) {
  const dx = (lon2 - lon1) * M_PER_DEG_LAT * COS0;
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}
const walkMin = (m) => m * WALK_DETOUR / WALK_M_PER_MIN;
const bikeMin = (m) => m * BIKE_DETOUR / BIKE_M_PER_MIN;

// ===== マス目 =====
// 行はメルカトル座標で等間隔にとる（地図の画像レイヤーとずれないように）
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const latOf = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
const COLS = Math.round((AREA.e - AREA.w) * M_PER_DEG_LAT * COS0 / CELL_M);
const ROWS = Math.round((AREA.n - AREA.s) * M_PER_DEG_LAT / CELL_M);
const NCELL = COLS * ROWS;
const Y_N = mercY(AREA.n), Y_S = mercY(AREA.s);
const CELL_W = (AREA.e - AREA.w) * M_PER_DEG_LAT * COS0 / COLS;
const CELL_H = (AREA.n - AREA.s) * M_PER_DEG_LAT / ROWS;
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  .map(([dc, dr]) => [dc, dr, Math.hypot(dc * CELL_W, dr * CELL_H)]);

function cellOf(lon, lat) {
  const c = Math.floor((lon - AREA.w) / (AREA.e - AREA.w) * COLS);
  const r = Math.floor((Y_N - mercY(lat)) / (Y_N - Y_S) * ROWS);
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return -1;
  return r * COLS + c;
}
function cellCenter(i) {
  const c = i % COLS, r = (i - c) / COLS;
  return [AREA.w + (c + 0.5) / COLS * (AREA.e - AREA.w), latOf(Y_N - (r + 0.5) / ROWS * (Y_N - Y_S))];
}

// ===== 状態 =====
const state = {
  graph: null,
  mode: 'train',
  dest: null,          // {lon, lat, name}
  toDest: null,        // 駅ごとの通勤先までの時間（分）
  next: null,          // 経路で次に進む駅（-1 = ここで降りて歩く）
  nextKind: null,      // 0=乗車 1=乗換
  destField: null,     // マスごとの通勤先までの歩く距離（m）{dist, prev}
  trainField: null,    // マスごとの電車＋徒歩の時間（分）{dist, prev, via}
  point: null,         // 選んだ地点
  opacity: 1,
  showStations: true,
};

// ===== 駅データ =====
let adj = [];          // [[to, 分, 種類], ...]
let bucket = new Map(); // 近くの駅を探すための格子
let nodeCell = null;   // 駅ごとのマス番号
const BUCKET_DEG = 0.02;
const bkey = (x, y) => x * 10000 + y;

async function loadGraph() {
  const g = await (await fetch('data/graph.json')).json();
  adj = g.nodes.map(() => []);
  for (const [a, b, t10, k] of g.edges) {
    adj[a].push([b, t10 / 10, k]);
    adj[b].push([a, t10 / 10, k]);
  }
  g.nodes.forEach(([, lon, lat], i) => {
    const k = bkey(Math.floor(lon / BUCKET_DEG), Math.floor(lat / BUCKET_DEG));
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(i);
  });
  nodeCell = Int32Array.from(g.nodes, ([, lon, lat]) => cellOf(lon, lat));
  state.graph = g;
}

function nearbyStations(lon, lat, maxM) {
  const g = state.graph;
  const rx = Math.ceil(maxM / (M_PER_DEG_LAT * COS0 * BUCKET_DEG));
  const ry = Math.ceil(maxM / (M_PER_DEG_LAT * BUCKET_DEG));
  const bx = Math.floor(lon / BUCKET_DEG), by = Math.floor(lat / BUCKET_DEG);
  const out = [];
  for (let x = bx - rx; x <= bx + rx; x++) for (let y = by - ry; y <= by + ry; y++) {
    const list = bucket.get(bkey(x, y));
    if (!list) continue;
    for (const i of list) {
      const n = g.nodes[i];
      const d = meters(lon, lat, n[1], n[2]);
      if (d <= maxM) out.push([i, d]);
    }
  }
  return out;
}

// ===== 陸地 =====
let land = null;     // 陸=1、海・川=0（色を塗るかどうか）
let walkable = null; // 歩ける=1（陸＋橋で渡れる幅の川・運河＋駅）

let walkMask = null; // 陸＋橋（scripts/build_walkmask.py で作成）

// 白黒のマスク画像をマスごとの 0/1 にする。読めなければ null
async function loadMask(path) {
  try {
    const img = new Image();
    img.src = path;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = COLS; c.height = ROWS;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, COLS, ROWS);
    const px = ctx.getImageData(0, 0, COLS, ROWS).data;
    const out = new Uint8Array(NCELL);
    for (let i = 0; i < NCELL; i++) out[i] = px[i * 4] > 127 ? 1 : 0;
    return out;
  } catch { return null; }
}
async function loadLandMask() {
  [land, walkMask] = await Promise.all([loadMask('data/landmask.png'), loadMask('data/walkmask.png')]);
}

// 正方形の窓で広げる（dilate）/ 削る（erode）。端の外は陸として扱う
function morph(src, R, dilate) {
  const tmp = new Uint8Array(NCELL), out = new Uint8Array(NCELL);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    let v = dilate ? 0 : 1;
    for (let k = -R; k <= R; k++) {
      const cc = c + k;
      if (cc < 0 || cc >= COLS) continue;
      const x = src[r * COLS + cc];
      if (dilate ? x : !x) { v = dilate ? 1 : 0; break; }
    }
    tmp[r * COLS + c] = v;
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    let v = dilate ? 0 : 1;
    for (let k = -R; k <= R; k++) {
      const rr = r + k;
      if (rr < 0 || rr >= ROWS) continue;
      const x = tmp[rr * COLS + c];
      if (dilate ? x : !x) { v = dilate ? 1 : 0; break; }
    }
    out[r * COLS + c] = v;
  }
  return out;
}

function buildWalkable() {
  if (walkMask) walkable = Uint8Array.from(walkMask); // 陸＋実際の橋
  // 橋データがないときは、狭い川・運河を埋めて渡れるとみなす（おおまか）
  else walkable = land ? morph(morph(land, BRIDGE_CELLS, true), BRIDGE_CELLS, false) : new Uint8Array(NCELL).fill(1);
  for (const i of nodeCell) if (i >= 0) walkable[i] = 1;
}

// 水の上のマスを選んだときは、近くの歩けるマスに寄せる
function snapCell(i) {
  if (i < 0 || walkable[i]) return i;
  const c0 = i % COLS, r0 = (i - c0) / COLS;
  for (let R = 1; R <= 3; R++) for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const c = c0 + dc, r = r0 + dr;
    if (c >= 0 && r >= 0 && c < COLS && r < ROWS && walkable[r * COLS + c]) return r * COLS + c;
  }
  return -1;
}

// ===== 最短経路 =====
class Heap { // 値の小さい順に取り出す
  constructor() { this.k = new Float64Array(1 << 16); this.v = new Int32Array(1 << 16); this.n = 0; this.key = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    const K = this.k, V = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0]; this.key = K[0];
    const n = --this.n, key = K[n], val = V[n];
    let i = 0;
    for (;;) {
      let m = i * 2 + 1;
      if (m >= n) break;
      if (m + 1 < n && K[m + 1] < K[m]) m++;
      if (K[m] >= key) break;
      K[i] = K[m]; V[i] = V[m]; i = m;
    }
    K[i] = key; V[i] = val;
    return top;
  }
}

// 歩けるマスだけを通る最短経路。seeds: [[マス, 初期値, 由来]]、perM: 1mあたりの増え方
function gridDijkstra(seeds, perM) {
  const dist = new Float64Array(NCELL).fill(Infinity);
  const prev = new Int32Array(NCELL).fill(-1);
  const via = new Int32Array(NCELL).fill(-1);
  const h = new Heap();
  for (const [i, t, s] of seeds) {
    if (i >= 0 && t < dist[i]) { dist[i] = t; via[i] = s; h.push(t, i); }
  }
  while (h.n) {
    const u = h.pop(), t = h.key;
    if (t > dist[u]) continue;
    const uc = u % COLS, ur = (u - uc) / COLS;
    for (const [dc, dr, len] of STEPS) {
      const c = uc + dc, r = ur + dr;
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
      const v = r * COLS + c;
      if (!walkable[v]) continue;
      // 斜めに進むときは、角の両側が水なら通れない（細い川を斜めにすり抜けない）
      if (dc && dr && !walkable[ur * COLS + c] && !walkable[r * COLS + uc]) continue;
      const nt = t + len * perM;
      if (nt < dist[v]) { dist[v] = nt; prev[v] = u; via[v] = via[u]; h.push(nt, v); }
    }
  }
  return { dist, prev, via };
}

// 電車：通勤先から逆向きに、駅ごとの「通勤先までの時間」を出す
function solveRail() {
  const g = state.graph, N = g.nodes.length, dm = state.destField.dist;
  const dist = new Float64Array(N).fill(Infinity);
  const next = new Int32Array(N).fill(-1);
  const kind = new Int8Array(N);
  const heap = new Heap();
  for (let i = 0; i < N; i++) {
    if (nodeCell[i] < 0) continue;
    const t = walkMin(dm[nodeCell[i]]);
    if (t <= EGRESS_MAX_MIN) { dist[i] = t; heap.push(t, i); }
  }
  while (heap.n) {
    const u = heap.pop(), t = heap.key;
    if (t > dist[u]) continue;
    for (const [v, w, k] of adj[u]) {
      const nt = t + w;
      if (nt < dist[v]) { dist[v] = nt; next[v] = u; kind[v] = k; heap.push(nt, v); }
    }
  }
  state.toDest = dist;
  state.next = next;
  state.nextKind = kind;
}

function computeFields() {
  const destCell = snapCell(cellOf(state.dest.lon, state.dest.lat));
  state.destField = gridDijkstra([[destCell, 0, -1]], 1);
  solveRail();
  // 電車＋徒歩：通勤先（そのまま歩く）と各駅（待ち＋乗車）から同時に歩いて広げる
  const seeds = [[destCell, 0, -1]];
  state.toDest.forEach((t, s) => { if (t < Infinity && nodeCell[s] >= 0) seeds.push([nodeCell[s], WAIT_MIN + t, s]); });
  state.trainField = gridDijkstra(seeds, WALK_DETOUR / WALK_M_PER_MIN);
}

// ある地点から通勤先までの時間。{min, via: 駅番号 or -1, access: 駅まで歩く分, cell}
function timeFrom(lon, lat) {
  const i = snapCell(cellOf(lon, lat));
  if (i < 0) return { min: Infinity, via: -1, cell: -1 };
  return timeAt(i);
}
function timeAt(i) {
  const m = state.destField.dist[i];
  if (state.mode === 'walk') return { min: walkMin(m), via: -1, cell: i, m };
  if (state.mode === 'bike') return { min: bikeMin(m), via: -1, cell: i, m };
  const f = state.trainField, via = f.via[i];
  return { min: f.dist[i], via, cell: i, m, access: via >= 0 ? f.dist[i] - WAIT_MIN - state.toDest[via] : 0 };
}

// prev をたどって、マスの並び（経路）を座標にする
function tracePath(prev, i) {
  const out = [];
  for (let n = 0; i >= 0 && n < 5000; n++) { out.push(cellCenter(i)); i = prev[i]; }
  return out;
}

// ===== ヒートマップ画像 =====
const canvas = document.createElement('canvas');
canvas.width = COLS; canvas.height = ROWS;
const RGB = BINS.map(([, c]) => c && [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));

function drawHeatmap() {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(COLS, ROWS);
  for (let i = 0; i < NCELL; i++) {
    if (land && !land[i]) continue; // 海・川の上は塗らない
    const t = timeAt(i).min;
    const rgb = RGB[BINS.findIndex(([max]) => t < max)];
    if (!rgb) continue;
    const p = i * 4;
    img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const src = map.getSource('heat');
  const coords = [[AREA.w, AREA.n], [AREA.e, AREA.n], [AREA.e, AREA.s], [AREA.w, AREA.s]];
  if (src) src.updateImage({ url: canvas.toDataURL(), coordinates: coords });
  else {
    map.addSource('heat', { type: 'image', url: canvas.toDataURL(), coordinates: coords });
    map.addLayer({ id: 'heat', type: 'raster', source: 'heat', paint: { 'raster-opacity': OPACITY[state.opacity][1], 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, 'stations');
  }
}

// ===== 地図 =====
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      pale: {
        type: 'raster', tileSize: 256, maxzoom: 18,
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
    },
    layers: [{ id: 'pale', type: 'raster', source: 'pale' }],
  },
  center: [139.75, 35.68],
  zoom: 11,
  minZoom: 9,
  maxBounds: [[139.1, 35.2], [140.4, 36.15]],
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

const destMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'dest-pin' }), anchor: 'bottom' });
const timeMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'time-tag' }), anchor: 'bottom', offset: [0, -36] }); // 地点のピン（高さ約33px）に重ねない
const pointMarker = new maplibregl.Marker({ color: '#13233f', scale: 0.8 });

function addLayers() {
  const g = state.graph;
  map.addSource('stations', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: g.nodes.map(([name, lon, lat, li]) => ({
        type: 'Feature', properties: { name, color: g.lines[li][1] }, geometry: { type: 'Point', coordinates: [lon, lat] },
      })),
    },
  });
  map.addLayer({
    id: 'stations', type: 'circle', source: 'stations', minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 5],
      'circle-color': '#fff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2],
    },
  });
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // スマホの小さい画面でもヒートマップの色に埋もれないよう、濃い縁＋白い縁で二重に縁取る
  const W = (z11, z15) => ['interpolate', ['linear'], ['zoom'], 11, z11, 15, z15];
  const ride = ['==', ['get', 'kind'], 'ride'];
  const walk = ['==', ['get', 'kind'], 'walk'];
  const round = { 'line-join': 'round', 'line-cap': 'round' };
  for (const [kind, f, halo, casing] of [['walk', walk, W(9, 12), W(6, 8)], ['ride', ride, W(13, 18), W(10, 14)]]) {
    map.addLayer({ id: `route-halo-${kind}`, type: 'line', source: 'route', filter: f, layout: round, paint: { 'line-color': '#13233f', 'line-opacity': 0.55, 'line-width': halo } });
    map.addLayer({ id: `route-casing-${kind}`, type: 'line', source: 'route', filter: f, layout: round, paint: { 'line-color': '#fff', 'line-width': casing } });
  }
  map.addLayer({ id: 'route-ride', type: 'line', source: 'route', filter: ride, layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': W(6, 9) } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: walk, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#13233f', 'line-width': W(3, 4), 'line-dasharray': [1, 1.6] } });
  // 乗車駅・乗換駅・降車駅
  map.addLayer({ id: 'route-stops', type: 'circle', source: 'route', filter: ['==', ['get', 'kind'], 'stop'], paint: { 'circle-radius': W(5, 7), 'circle-color': '#fff', 'circle-stroke-color': '#13233f', 'circle-stroke-width': W(2.5, 3) } });
}


// ===== 通勤先・地点 =====
function setDest(lon, lat, name) {
  state.dest = { lon, lat, name: name || nearestName(lon, lat) };
  destMarker.setLngLat([lon, lat]).addTo(map);
  document.getElementById('dest-name').textContent = state.dest.name;
  document.getElementById('dest-coord').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  computeFields();
  redraw();
}

function redraw() {
  if (!state.destField) return; // まだ読み込み中
  drawHeatmap();
  if (state.point) showPoint(state.point.lon, state.point.lat);
  saveHash();
}

function nearestName(lon, lat) {
  const near = nearbyStations(lon, lat, 2000).sort((a, b) => a[1] - b[1])[0];
  return near ? `${state.graph.nodes[near[0]][0]}駅付近` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

const fmt = (m) => Math.max(1, Math.round(m));

function showPoint(lon, lat) {
  state.point = { lon, lat };
  const g = state.graph;
  const res = timeFrom(lon, lat);
  const ok = res.min < Infinity;
  pointMarker.setLngLat([lon, lat]).addTo(map);
  timeMarker.setLngLat([lon, lat]).addTo(map);
  timeMarker.getElement().textContent = ok ? `${fmt(res.min)}分` : '—';

  document.getElementById('hint').hidden = true;
  document.getElementById('point').hidden = false;
  document.getElementById('point-name').textContent = nearestName(lon, lat);
  document.getElementById('point-min').textContent = ok ? fmt(res.min) : '—';
  const dKm = meters(lon, lat, state.dest.lon, state.dest.lat) / 1000;
  document.getElementById('point-sub').textContent = ok
    ? `${MODE_LABEL[state.mode]}・直線 ${dKm.toFixed(1)}km`
    : '海の上か、陸から行けない場所です';

  const steps = [];
  const features = [];
  const walkLine = (coords) => features.push({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: coords } });
  const destPt = [state.dest.lon, state.dest.lat];

  if (!ok) {
    // 何も描かない
  } else if (res.via < 0) {
    const bike = state.mode === 'bike';
    steps.push({ c: '#13233f', what: `${bike ? '自転車' : '徒歩'}で通勤先へ`, t: res.min, sub: `約${(res.m * (bike ? BIKE_DETOUR : WALK_DETOUR) / 1000).toFixed(1)}km` });
    walkLine([[lon, lat], ...tracePath(state.destField.prev, res.cell), destPt]);
  } else {
    // 駅までの徒歩（水辺を回り込む道のり）
    let i = res.via;
    const n0 = g.nodes[i];
    steps.push({ c: '#13233f', what: `${n0[0]}駅まで徒歩`, t: res.access });
    walkLine([[lon, lat], ...tracePath(state.trainField.prev, res.cell), [n0[1], n0[2]]]);
    steps.push({ c: '#999', what: '電車を待つ', t: WAIT_MIN, sub: '目安' });
    // 乗車区間を路線ごとにまとめる
    let seg = null, through = false;
    while (state.next[i] >= 0) {
      const j = state.next[i];
      const w = state.toDest[i] - state.toDest[j];
      const ni = g.nodes[i], nj = g.nodes[j];
      if (state.nextKind[i] === 2) {
        // 直通運転：乗り換えずにそのまま次の路線へ
        through = !!seg; // 乗る前（乗った駅での付け替え）は直通と書かない
        if (seg) { steps.push(seg.step(ni[0])); seg = null; }
      } else if (state.nextKind[i] === 1) {
        if (seg) { steps.push(seg.step(ni[0])); seg = null; }
        steps.push({ c: '#999', what: `${ni[0]}で乗換`, t: w, sub: nj[0] !== ni[0] ? `${nj[0]}へ` : '' });
      } else {
        const [ln, color] = g.lines[ni[3]];
        if (!seg) {
          seg = { from: ni[0], line: ln, color, t: 0, n: 0, coords: [[ni[1], ni[2]]], through,
            step(to) { return { c: this.color, line: this.line, what: `${this.from} → ${to}`, t: this.t, sub: `${this.n}駅${this.through ? '・直通（乗換なし）' : ''}` }; } };
          through = false;
          features.push({ type: 'Feature', properties: { kind: 'ride', color }, geometry: { type: 'LineString', coordinates: seg.coords } });
        }
        seg.t += w; seg.n += 1; seg.coords.push([nj[1], nj[2]]);
      }
      i = j;
    }
    const last = g.nodes[i];
    if (seg) steps.push(seg.step(last[0]));
    for (const f of features.filter((f) => f.properties.kind === 'ride')) {
      const c = f.geometry.coordinates;
      for (const pt of [c[0], c[c.length - 1]]) features.push({ type: 'Feature', properties: { kind: 'stop' }, geometry: { type: 'Point', coordinates: pt } });
    }
    steps.push({ c: '#13233f', what: `${last[0]}駅から徒歩`, t: state.toDest[i] });
    walkLine([[last[1], last[2]], ...tracePath(state.destField.prev, nodeCell[i]), destPt]);
  }
  map.getSource('route').setData({ type: 'FeatureCollection', features });

  const ol = document.getElementById('steps');
  ol.replaceChildren(...steps.map((s) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', s.c);
    li.innerHTML = `<span class="t"></span>${s.line ? '<span class="line-tag"></span> ' : ''}<span class="what"></span><span class="sub"></span>`;
    li.querySelector('.t').textContent = `${fmt(s.t)}分`;
    li.querySelector('.what').textContent = s.what;
    li.querySelector('.sub').textContent = s.sub || '';
    if (s.line) li.querySelector('.line-tag').textContent = s.line;
    return li;
  }));
}

// ===== 検索 =====
const q = document.getElementById('q');
const sug = document.getElementById('suggest');
let stationIndex = [];   // [名前, lon, lat, 路線名一覧]
let sugItems = [];
let sugActive = -1;
let searchTimer = 0;

function buildStationIndex() {
  const byName = new Map();
  for (const [name, lon, lat, li] of state.graph.nodes) {
    const e = byName.get(name);
    if (!e) byName.set(name, { name, lon, lat, lines: [state.graph.lines[li][0]] });
    else if (meters(lon, lat, e.lon, e.lat) < 800 && !e.lines.includes(state.graph.lines[li][0])) e.lines.push(state.graph.lines[li][0]);
  }
  stationIndex = [...byName.values()];
}

function renderSuggest(items) {
  sugItems = items; sugActive = -1;
  sug.replaceChildren(...items.map((it, i) => {
    const li = document.createElement('li');
    li.textContent = it.label;
    if (it.sub) { const s = document.createElement('small'); s.textContent = it.sub; li.append(s); }
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
    return li;
  }));
  sug.hidden = items.length === 0;
}

function pick(i) {
  const it = sugItems[i];
  if (!it) return;
  q.value = it.label;
  sug.hidden = true;
  q.blur();
  map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(map.getZoom(), 11.5) });
  setDest(it.lon, it.lat, it.label);
}

q.addEventListener('input', () => {
  const s = q.value.trim().replace(/駅$/, '');
  clearTimeout(searchTimer);
  if (!s) { renderSuggest([]); return; }
  const st = stationIndex
    .filter((x) => x.name.includes(s))
    .sort((a, b) => (a.name.startsWith(s) ? 0 : 1) - (b.name.startsWith(s) ? 0 : 1) || a.name.length - b.name.length)
    .slice(0, 8)
    .map((x) => ({ label: `${x.name}駅`, sub: x.lines.slice(0, 3).join('・'), lon: x.lon, lat: x.lat }));
  renderSuggest(st);
  if (s.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q.value.trim())}`);
      const list = await res.json();
      const addr = list
        .map((f) => ({ label: f.properties.title, sub: '住所', lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
        .filter((x) => x.lon > AREA.w - 0.2 && x.lon < AREA.e + 0.2 && x.lat > AREA.s - 0.2 && x.lat < AREA.n + 0.2)
        .slice(0, 8);
      if (q.value.trim().replace(/駅$/, '') === s) renderSuggest([...st, ...addr]);
    } catch { /* 住所検索が使えないときは駅だけ */ }
  }, 350);
});
q.addEventListener('keydown', (e) => {
  if (sug.hidden) return;
  const lis = sug.children;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugActive = (sugActive + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
    [...lis].forEach((li, i) => li.classList.toggle('active', i === sugActive));
  } else if (e.key === 'Enter') {
    pick(sugActive >= 0 ? sugActive : 0);
  } else if (e.key === 'Escape') {
    sug.hidden = true;
  }
});
q.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 100));

// ===== ボタン =====
document.getElementById('modes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === state.mode) return;
  setMode(b.dataset.mode);
  redraw();
});
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
}
document.getElementById('opacity').addEventListener('click', (e) => {
  state.opacity = (state.opacity + 1) % OPACITY.length;
  e.currentTarget.textContent = `濃さ：${OPACITY[state.opacity][0]}`;
  map.setPaintProperty('heat', 'raster-opacity', OPACITY[state.opacity][1]);
});
document.getElementById('stations').addEventListener('click', (e) => {
  state.showStations = !state.showStations;
  e.currentTarget.classList.toggle('on', state.showStations);
  map.setLayoutProperty('stations', 'visibility', state.showStations ? 'visible' : 'none');
});

function buildLegend() {
  const el = document.getElementById('legend-bins');
  const cells = BINS.filter(([, c]) => c).map(([, c]) => { const d = document.createElement('div'); d.style.background = c; return d; });
  const empty = document.createElement('div'); empty.style.background = '#eee';
  const labels = BINS.map(([max], i) => {
    const s = document.createElement('span');
    s.textContent = max === Infinity ? `${BINS[i - 1][0]}〜` : `${max}`;
    return s;
  });
  el.style.gridTemplateColumns = `repeat(${BINS.length}, 1fr)`;
  el.replaceChildren(...cells, empty, ...labels);
}

// ===== URL に状態を残す（共有用） =====
function saveHash() {
  const d = state.dest;
  const p = new URLSearchParams({ dest: `${d.lat.toFixed(5)},${d.lon.toFixed(5)}`, name: d.name, mode: state.mode });
  history.replaceState(null, '', `#${p}`);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const m = p.get('mode');
  if (MODE_LABEL[m]) setMode(m);
  const d = (p.get('dest') || '').split(',').map(Number);
  if (d.length === 2 && d.every(Number.isFinite)) return { lat: d[0], lon: d[1], name: p.get('name') || '' };
  return null;
}

// ===== クリック・右クリック・長押し =====
map.on('click', (e) => showPoint(e.lngLat.lng, e.lngLat.lat));
map.on('contextmenu', (e) => setDest(e.lngLat.lng, e.lngLat.lat));
let pressTimer = 0, pressStart = null;
map.on('touchstart', (e) => {
  if (e.originalEvent.touches.length !== 1) return;
  pressStart = e.point;
  const ll = e.lngLat;
  pressTimer = setTimeout(() => { pressStart = null; setDest(ll.lng, ll.lat); }, 600);
});
map.on('touchmove', (e) => { if (pressStart && (Math.abs(e.point.x - pressStart.x) > 8 || Math.abs(e.point.y - pressStart.y) > 8)) clearTimeout(pressTimer); });
map.on('touchend', () => clearTimeout(pressTimer));

// ===== 起動 =====
map.on('load', async () => {
  await Promise.all([loadGraph(), loadLandMask()]);
  buildWalkable();
  buildStationIndex();
  buildLegend();
  addLayers();
  const d = readHash() || { lon: 139.75653, lat: 35.65084, name: 'フェアモント東京' };
  setDest(d.lon, d.lat, d.name);
});
