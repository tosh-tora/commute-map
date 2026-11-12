'use strict';

// ===== 設定 =====
const AREA = { w: 139.45, e: 140.05, s: 35.45, n: 35.90 }; // ヒートマップの範囲
const CELL_M = 100;            // マスの大きさ（m）。data/landmask.png と同じ
const WALK_M_PER_MIN = 80;
const WALK_DETOUR = 1.3;       // 道の回り道ぶん
const BIKE_M_PER_MIN = 250;    // 時速15km
const BIKE_DETOUR = 1.25;
const WAIT_MIN = 3;            // 最初の電車の待ち時間
const ACCESS_MAX_M = 1500;     // 駅まで歩く最大距離（直線）
const EGRESS_MAX_MIN = 20;     // 通勤先の近くで電車を降りる駅（徒歩の上限）
const MAX_MIN = 90;

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

// ===== 状態 =====
const state = {
  graph: null,
  mode: 'train',
  dest: null,          // {lon, lat, name}
  toDest: null,        // 駅ごとの通勤先までの時間（分）
  next: null,          // 経路で次に進む駅（-1 = ここで降りて歩く）
  nextKind: null,      // 0=乗車 1=乗換
  point: null,         // 選んだ地点
  opacity: 1,
  showStations: true,
};

// ===== 駅データ =====
let adj = [];          // [[to, 分, 種類], ...]
let bucket = new Map(); // 近くの駅を探すための格子
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

// ===== 最短時間（通勤先から逆向きに計算） =====
function solve() {
  const g = state.graph, N = g.nodes.length, { lon, lat } = state.dest;
  const dist = new Float64Array(N).fill(Infinity);
  const next = new Int32Array(N).fill(-1);
  const kind = new Int8Array(N);
  const heap = new MinHeap();
  for (const [i, d] of nearbyStations(lon, lat, EGRESS_MAX_MIN * WALK_M_PER_MIN / WALK_DETOUR)) {
    const t = walkMin(d);
    if (t < dist[i]) { dist[i] = t; heap.push(t, i); }
  }
  while (heap.size) {
    const [t, u] = heap.pop();
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

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

// ある地点から通勤先までの時間。{min, via: 駅番号 or -1, access: 駅まで歩く分}
function timeFrom(lon, lat) {
  const d = meters(lon, lat, state.dest.lon, state.dest.lat);
  if (state.mode === 'bike') return { min: bikeMin(d), via: -1 };
  let best = { min: walkMin(d), via: -1 };
  if (state.mode === 'walk') return best;
  for (const [i, dm] of nearbyStations(lon, lat, ACCESS_MAX_M)) {
    const acc = walkMin(dm);
    const t = acc + WAIT_MIN + state.toDest[i];
    if (t < best.min) best = { min: t, via: i, access: acc };
  }
  return best;
}

// ===== ヒートマップ画像 =====
// 行はメルカトル座標で等間隔にとる（地図の画像レイヤーとずれないように）
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const latOf = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
const COLS = Math.round((AREA.e - AREA.w) * M_PER_DEG_LAT * COS0 / CELL_M);
const ROWS = Math.round((AREA.n - AREA.s) * M_PER_DEG_LAT / CELL_M);
const canvas = document.createElement('canvas');
canvas.width = COLS; canvas.height = ROWS;
let land = null; // 陸=1、海・川=0（マスごと）

// 陸地マスク（scripts/build_landmask.py で作成）を読み込む。読めなければ全部陸として扱う
async function loadLandMask() {
  try {
    const img = new Image();
    img.src = 'data/landmask.png';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = COLS; c.height = ROWS;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, COLS, ROWS);
    const px = ctx.getImageData(0, 0, COLS, ROWS).data;
    land = new Uint8Array(COLS * ROWS);
    for (let i = 0; i < land.length; i++) land[i] = px[i * 4] > 127 ? 1 : 0;
  } catch { land = null; }
}

const RGB = BINS.map(([, c]) => c && [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));

function drawHeatmap() {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(COLS, ROWS);
  const yN = mercY(AREA.n), yS = mercY(AREA.s);
  for (let r = 0; r < ROWS; r++) {
    const lat = latOf(yN - (r + 0.5) / ROWS * (yN - yS));
    for (let c = 0; c < COLS; c++) {
      const lon = AREA.w + (c + 0.5) / COLS * (AREA.e - AREA.w);
      if (land && !land[r * COLS + c]) continue; // 海・川の上は塗らない
      const t = timeFrom(lon, lat).min;
      const bi = BINS.findIndex(([max]) => t < max);
      const rgb = RGB[bi];
      const p = (r * COLS + c) * 4;
      if (rgb) { img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255; }
    }
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
const timeMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'time-tag' }), anchor: 'bottom', offset: [0, -14] });
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
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ride'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } });
  map.addLayer({ id: 'route-ride', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ride'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5 } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'walk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#13233f', 'line-width': 3, 'line-dasharray': [1, 2] } });
}

// ===== 通勤先・地点 =====
function setDest(lon, lat, name) {
  state.dest = { lon, lat, name: name || nearestName(lon, lat) };
  destMarker.setLngLat([lon, lat]).addTo(map);
  document.getElementById('dest-name').textContent = state.dest.name;
  document.getElementById('dest-coord').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  recompute();
}

function recompute() {
  if (state.mode === 'train') solve();
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
  pointMarker.setLngLat([lon, lat]).addTo(map);
  timeMarker.setLngLat([lon, lat]).addTo(map);
  timeMarker.getElement().textContent = `${fmt(res.min)}分`;

  document.getElementById('hint').hidden = true;
  document.getElementById('point').hidden = false;
  document.getElementById('point-name').textContent = nearestName(lon, lat);
  document.getElementById('point-min').textContent = fmt(res.min);
  const dKm = meters(lon, lat, state.dest.lon, state.dest.lat) / 1000;
  document.getElementById('point-sub').textContent = `${MODE_LABEL[state.mode]}・直線 ${dKm.toFixed(1)}km`;

  const steps = [];
  const features = [];
  const walkLine = (a, b) => features.push({ type: 'Feature', properties: { kind: 'walk' }, geometry: { type: 'LineString', coordinates: [a, b] } });
  const destPt = [state.dest.lon, state.dest.lat];

  if (res.via < 0) {
    const label = state.mode === 'bike' ? '自転車' : '徒歩';
    steps.push({ c: '#13233f', what: `${label}で通勤先へ`, t: res.min, sub: `約${(dKm * (state.mode === 'bike' ? BIKE_DETOUR : WALK_DETOUR)).toFixed(1)}km` });
    walkLine([lon, lat], destPt);
  } else {
    // 駅までの徒歩
    let i = res.via;
    const n0 = g.nodes[i];
    steps.push({ c: '#13233f', what: `${n0[0]}駅まで徒歩`, t: res.access });
    walkLine([lon, lat], [n0[1], n0[2]]);
    steps.push({ c: '#999', what: '電車を待つ', t: WAIT_MIN, sub: '目安' });
    // 乗車区間を路線ごとにまとめる
    let seg = null;
    while (state.next[i] >= 0) {
      const j = state.next[i];
      const w = state.toDest[i] - state.toDest[j];
      const ni = g.nodes[i], nj = g.nodes[j];
      if (state.nextKind[i] === 1) {
        if (seg) { steps.push(seg.step(ni[0])); seg = null; }
        steps.push({ c: '#999', what: `${ni[0]}で乗換`, t: w, sub: nj[0] !== ni[0] ? `${nj[0]}へ` : '' });
      } else {
        const [ln, color] = g.lines[ni[3]];
        if (!seg) {
          seg = { from: ni[0], line: ln, color, t: 0, n: 0, coords: [[ni[1], ni[2]]],
            step(to) { return { c: this.color, line: this.line, what: `${this.from} → ${to}`, t: this.t, sub: `${this.n}駅` }; } };
          features.push({ type: 'Feature', properties: { kind: 'ride', color }, geometry: { type: 'LineString', coordinates: seg.coords } });
        }
        seg.t += w; seg.n += 1; seg.coords.push([nj[1], nj[2]]);
      }
      i = j;
    }
    const last = g.nodes[i];
    if (seg) steps.push(seg.step(last[0]));
    steps.push({ c: '#13233f', what: `${last[0]}駅から徒歩`, t: state.toDest[i] });
    walkLine([last[1], last[2]], destPt);
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
  recompute();
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
  buildStationIndex();
  buildLegend();
  addLayers();
  const d = readHash() || { lon: 139.75653, lat: 35.65084, name: 'フェアモント東京' };
  setDest(d.lon, d.lat, d.name);
});
