'use strict';

// ---------- 常數 ----------
const WALK_M_PER_MIN = 80;      // 一般步行速度約 80 公尺/分鐘
const DETOUR_FACTOR = 1.25;     // 直線距離 → 實際步行路徑的估算係數
const TOP_N = 5;
const OCM_MATCH_M = 80;         // Google 與 Open Charge Map 同一站點的比對距離

const CONNECTOR_NAMES = {
  EV_CONNECTOR_TYPE_OTHER: '其他',
  EV_CONNECTOR_TYPE_J1772: 'J1772',
  EV_CONNECTOR_TYPE_TYPE_2: 'Type 2',
  EV_CONNECTOR_TYPE_CHADEMO: 'CHAdeMO',
  EV_CONNECTOR_TYPE_CCS_COMBO_1: 'CCS1',
  EV_CONNECTOR_TYPE_CCS_COMBO_2: 'CCS2',
  EV_CONNECTOR_TYPE_TESLA: 'Tesla',
  EV_CONNECTOR_TYPE_NACS: 'NACS',
  EV_CONNECTOR_TYPE_UNSPECIFIED_GB_T: 'GB/T',
  EV_CONNECTOR_TYPE_UNSPECIFIED_WALL_OUTLET: '一般插座',
};

// ---------- 設定 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無痕模式等 */ } },
};
const settings = {
  get gKey() { return store.get('gKey', '').trim(); },
  get ocmKey() { return store.get('ocmKey', '').trim(); },
  get walkMin() { return Math.max(1, Number(store.get('walkMin', '5')) || 5); },
  get demo() {
    const v = store.get('demo', null);
    return v === null ? !this.gKey && !this.ocmKey : v === '1';
  },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  form: $('searchForm'), q: $('q'), here: $('btnHere'), badge: $('modeBadge'),
  status: $('status'), candidates: $('candidates'),
  section: $('resultSection'), destName: $('destName'), sortBy: $('sortBy'),
  results: $('results'), moreBox: $('moreBox'), more: $('btnMore'),
  dlg: $('settings'), gKey: $('gKey'), ocmKey: $('ocmKey'), walkMin: $('walkMin'), demo: $('demo'),
};

const state = { dest: null, stations: [], limitMin: 5, selectedId: null, rates: [] };
let map, mapLayer;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showStatus(msg, isError = false) {
  el.status.hidden = !msg;
  el.status.className = 'status' + (isError ? ' error' : '');
  el.status.textContent = msg || '';
}

function updateBadge() {
  const parts = [];
  if (settings.demo) parts.push('示範模式');
  else {
    parts.push(settings.gKey ? 'Google 即時' : '無即時空位');
    if (settings.ocmKey) parts.push('OCM 費率');
  }
  el.badge.textContent = parts.join(' · ');
}

// ---------- 工具 ----------
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.raw || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}

function googlePost(url, fieldMask, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': settings.gKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
}

// ---------- 目的地查詢 ----------
async function geocode(query) {
  if (settings.gKey && !settings.demo) {
    const data = await googlePost(
      'https://places.googleapis.com/v1/places:searchText',
      'places.displayName,places.formattedAddress,places.location',
      { textQuery: query, languageCode: 'zh-TW', regionCode: 'TW', pageSize: 5 },
    );
    return (data.places || []).map((p) => ({
      name: p.displayName?.text || query,
      address: p.formattedAddress || '',
      lat: p.location.latitude, lng: p.location.longitude,
    }));
  }
  // 沒有 Google 金鑰時用 OpenStreetMap Nominatim（免費、請勿大量查詢）
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(query);
  const data = await fetchJson(url);
  return data.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    address: r.display_name,
    lat: Number(r.lat), lng: Number(r.lon),
  }));
}

// ---------- 充電站資料來源 ----------
async function googleStations(dest, radiusM) {
  const data = await googlePost(
    'https://places.googleapis.com/v1/places:searchNearby',
    [
      'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
      'places.evChargeOptions', 'places.googleMapsUri', 'places.rating',
      'places.currentOpeningHours.openNow', 'places.businessStatus',
    ].join(','),
    {
      includedTypes: ['electric_vehicle_charging_station'],
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      languageCode: 'zh-TW',
      locationRestriction: { circle: { center: { latitude: dest.lat, longitude: dest.lng }, radius: Math.min(radiusM, 50000) } },
    },
  );
  return (data.places || [])
    .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p) => {
      const ev = p.evChargeOptions || {};
      const aggs = ev.connectorAggregation || [];
      const hasLive = aggs.some((a) => typeof a.availableCount === 'number');
      const total = ev.connectorCount ?? aggs.reduce((s, a) => s + (a.count || 0), 0);
      return {
        id: 'g:' + p.id,
        name: p.displayName?.text || '充電站',
        address: p.formattedAddress || '',
        lat: p.location.latitude, lng: p.location.longitude,
        total: total || null,
        available: hasLive ? aggs.reduce((s, a) => s + (a.availableCount || 0), 0) : null,
        outOfService: hasLive ? aggs.reduce((s, a) => s + (a.outOfServiceCount || 0), 0) : null,
        updatedAt: aggs.map((a) => a.availabilityLastUpdateTime).filter(Boolean).sort().pop() || null,
        connectors: aggs.map((a) => ({
          type: CONNECTOR_NAMES[a.type] || a.type || '未知',
          kw: a.maxChargeRateKw || null,
          count: a.count || 0,
          available: a.availableCount,
        })),
        openNow: p.currentOpeningHours?.openNow,
        rating: p.rating,
        mapsUri: p.googleMapsUri,
        cost: null, operator: null,
      };
    });
}

async function ocmStations(dest, radiusM) {
  const params = new URLSearchParams({
    output: 'json', compact: 'false', verbose: 'false',
    latitude: dest.lat, longitude: dest.lng,
    distance: (radiusM / 1000).toFixed(2), distanceunit: 'KM',
    maxresults: '50', key: settings.ocmKey,
  });
  const data = await fetchJson('https://api.openchargemap.io/v3/poi/?' + params);
  return data.map((p) => {
    const a = p.AddressInfo || {};
    const conns = p.Connections || [];
    return {
      id: 'o:' + p.ID,
      name: a.Title || '充電站',
      address: [a.AddressLine1, a.Town].filter(Boolean).join(' '),
      lat: a.Latitude, lng: a.Longitude,
      total: p.NumberOfPoints || conns.reduce((s, c) => s + (c.Quantity || 1), 0) || null,
      available: null, outOfService: null, updatedAt: null,
      connectors: conns.map((c) => ({
        type: c.ConnectionType?.Title || '未知', kw: c.PowerKW || null, count: c.Quantity || 1,
      })),
      openNow: undefined, rating: undefined, mapsUri: null,
      cost: p.UsageCost || null,
      operator: p.OperatorInfo?.Title || null,
      operational: p.StatusType ? p.StatusType.IsOperational : undefined,
    };
  }).filter((s) => s.operational !== false);
}

function demoStations(dest) {
  const seeds = [
    ['Tesla 超級充電站 信義', 120, 60, 12, 5, 'Tesla', 250, 'NT$ 13/kWh（示範）'],
    ['U-POWER 超高速充電站', -180, 140, 6, 1, 'CCS1', 360, 'NT$ 15/kWh（示範）'],
    ['EVOASIS 源點 百貨停車場', 90, -230, 8, 0, 'CCS1', 180, 'NT$ 12/kWh（示範）'],
    ['Yes!來電 購物中心 B2', -60, -90, 10, 7, 'J1772', 7, 'NT$ 60/小時（示範）'],
    ['公有停車場 充電格', 310, 200, 4, 2, 'Type 2', 22, '停車費另計，充電免費（示範）'],
    ['飯店地下停車場', -330, -120, 2, 2, 'J1772', 7, null],
    ['iCHARGING 商辦大樓', 520, -260, 6, 3, 'CCS1', 120, 'NT$ 11/kWh（示範）'],
  ];
  const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos(dest.lat * Math.PI / 180);
  return seeds.map(([name, dx, dy, total, avail, type, kw, cost], i) => ({
    id: 'd:' + i, name, address: '示範地址',
    lat: dest.lat + dy / mPerDegLat, lng: dest.lng + dx / mPerDegLng,
    total, available: avail, outOfService: 0, updatedAt: new Date().toISOString(),
    connectors: [{ type, kw, count: total, available: avail }],
    openNow: true, rating: 4.2, mapsUri: null, cost, operator: null,
  }));
}

function mergeOcmInto(googleList, ocmList) {
  for (const g of googleList) {
    let best = null, bestD = Infinity;
    for (const o of ocmList) {
      const d = haversine(g, o);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best && bestD <= OCM_MATCH_M) {
      g.cost = g.cost || best.cost;
      g.operator = g.operator || best.operator;
    }
  }
  return googleList;
}

function applyRateTable(stations) {
  for (const s of stations) {
    if (s.cost) continue;
    const hay = `${s.name} ${s.operator || ''}`.toLowerCase();
    const rule = state.rates.find((r) => (r.match || []).some((m) => hay.includes(String(m).toLowerCase())));
    if (rule) s.cost = `${rule.price}（參考費率，實際以現場為準）`;
  }
}

// ---------- 步行時間 ----------
async function addWalkTimes(stations, dest) {
  for (const s of stations) {
    s.straightM = haversine(s, dest);
    s.walkM = Math.round(s.straightM * DETOUR_FACTOR);
    s.walkMin = s.walkM / WALK_M_PER_MIN;
    s.walkEstimated = true;
  }
  if (!settings.gKey || settings.demo || !stations.length) return;
  try {
    // 充電站 → 目的地（停好車後走過去）
    const rows = await googlePost(
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
      'originIndex,destinationIndex,duration,distanceMeters,condition',
      {
        origins: stations.slice(0, 25).map((s) => ({ waypoint: { location: { latLng: { latitude: s.lat, longitude: s.lng } } } })),
        destinations: [{ waypoint: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } } }],
        travelMode: 'WALK',
        languageCode: 'zh-TW',
      },
    );
    for (const r of Array.isArray(rows) ? rows : []) {
      const s = stations[r.originIndex ?? 0];
      if (!s || r.condition !== 'ROUTE_EXISTS' || !r.duration) continue;
      s.walkM = r.distanceMeters ?? s.walkM;
      s.walkMin = parseFloat(r.duration) / 60;
      s.walkEstimated = false;
    }
  } catch (err) {
    console.warn('Routes API 失敗，改用估算步行時間', err);
  }
}

// ---------- 主流程 ----------
async function loadStations(dest) {
  // 搜尋半徑取稍大於步行上限，最後再用步行時間過濾
  const radiusM = Math.round(Math.max(state.limitMin, 10) * WALK_M_PER_MIN * 1.1);
  let list;
  if (settings.demo) {
    list = demoStations(dest);
  } else if (settings.gKey) {
    const [g, o] = await Promise.all([
      googleStations(dest, radiusM),
      settings.ocmKey ? ocmStations(dest, radiusM).catch((e) => { console.warn('OCM 失敗', e); return []; }) : [],
    ]);
    list = mergeOcmInto(g, o);
  } else if (settings.ocmKey) {
    list = await ocmStations(dest, radiusM);
  } else {
    throw new Error('尚未設定 API 金鑰。請點右上角 ⚙️ 設定，或開啟示範模式。');
  }
  applyRateTable(list);
  await addWalkTimes(list, dest);
  return list;
}

async function chooseDestination(dest) {
  state.dest = dest;
  state.limitMin = settings.walkMin;
  state.selectedId = null;
  el.candidates.hidden = true;
  showStatus('搜尋附近充電站中…');
  try {
    state.stations = await loadStations(dest);
    showStatus('');
    render();
  } catch (err) {
    console.error(err);
    showStatus('查詢充電站失敗：' + err.message, true);
  }
}

function availClass(s) {
  if (s.available == null) return '';
  if (s.available === 0) return 'bad';
  if (s.total && s.available / s.total < 0.3) return 'warn';
  return 'good';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

function navLinks(s) {
  const ll = `${s.lat},${s.lng}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
    apple: `https://maps.apple.com/?daddr=${ll}&dirflg=d`,
    walk: `https://www.google.com/maps/dir/?api=1&origin=${ll}&destination=${state.dest.lat},${state.dest.lng}&travelmode=walking`,
  };
}

function render() {
  const { dest, limitMin } = state;
  el.section.hidden = false;
  el.destName.textContent = dest.name;

  const within = state.stations.filter((s) => s.walkMin <= limitMin + 1e-9);
  const sorted = within.slice().sort((a, b) => {
    if (el.sortBy.value === 'avail') {
      const av = (b.available ?? -1) - (a.available ?? -1);
      if (av) return av;
    }
    return a.walkMin - b.walkMin;
  });
  const top = sorted.slice(0, TOP_N);

  el.results.innerHTML = top.length ? top.map(cardHtml).join('')
    : `<li class="status">步行 ${limitMin} 分鐘內沒有找到充電站。</li>`;

  const canExpand = limitMin < 10 && top.length < TOP_N;
  el.moreBox.hidden = !canExpand;
  drawMap(top);
}

function cardHtml(s) {
  const links = navLinks(s);
  const availText = s.available == null ? '—' : `${s.available}`;
  const availLabel = s.available == null ? '無即時資料' : `剩餘 / 共 ${s.total ?? '?'} 格`;
  const conns = s.connectors.map((c) =>
    `<span class="chip">${esc(c.type)}${c.kw ? ` ${Math.round(c.kw)}kW` : ''} ×${c.count}${typeof c.available === 'number' ? `（空 ${c.available}）` : ''}</span>`).join('');
  const meta = [
    s.openNow === true ? '營業中' : s.openNow === false ? '<span class="v bad">目前未營業</span>' : '',
    s.outOfService ? `故障 ${s.outOfService} 格` : '',
    s.updatedAt ? `更新於 ${fmtTime(s.updatedAt)}` : '',
    s.rating ? `★ ${s.rating}` : '',
    s.operator ? esc(s.operator) : '',
  ].filter(Boolean).join(' · ');

  return `
  <li class="station${state.selectedId === s.id ? ' selected' : ''}" data-id="${esc(s.id)}">
    <div class="station-top">
      <div class="rank" aria-hidden="true"></div>
      <div>
        <h3>${esc(s.name)}</h3>
        <div class="addr">${esc(s.address)}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v ${availClass(s)}">${availText}</div><div class="l">${availLabel}</div></div>
      <div class="stat"><div class="v">${Math.max(1, Math.round(s.walkMin))} 分</div><div class="l">走到目的地${s.walkEstimated ? '（估）' : ''}</div></div>
      <div class="stat"><div class="v">${s.walkM} m</div><div class="l">步行距離</div></div>
    </div>
    <div class="cost">💰 費率：${s.cost ? esc(s.cost) : '<span class="muted">未提供，請以現場或業者 App 為準</span>'}</div>
    <div class="chips">${conns}</div>
    ${meta ? `<div class="small muted">${meta}</div>` : ''}
    <div class="actions">
      <a class="primary" href="${links.google}" target="_blank" rel="noopener" data-nav="${esc(s.id)}">🚗 開始導航（Google 地圖）</a>
      <a class="secondary" href="${links.apple}" target="_blank" rel="noopener">Apple 地圖</a>
      <a class="secondary" href="${links.walk}" target="_blank" rel="noopener">🚶 停好後步行路線</a>
    </div>
  </li>`;
}

function drawMap(top) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const d = state.dest;
  L.circle([d.lat, d.lng], { radius: state.limitMin * WALK_M_PER_MIN / DETOUR_FACTOR, weight: 1, fillOpacity: 0.06 }).addTo(mapLayer);
  L.marker([d.lat, d.lng], { title: d.name }).bindTooltip('目的地', { permanent: false }).addTo(mapLayer);
  top.forEach((s, i) => {
    L.circleMarker([s.lat, s.lng], { radius: 11, color: '#0f766e', fillColor: '#0f766e', fillOpacity: 0.9, weight: 2 })
      .bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'rank-tip' })
      .on('click', () => selectStation(s.id, true))
      .addTo(mapLayer);
  });
  const pts = [[d.lat, d.lng], ...top.map((s) => [s.lat, s.lng])];
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(pts, { padding: [30, 30], maxZoom: 17 });
  }, 0);
}

function selectStation(id, scroll) {
  state.selectedId = id;
  document.querySelectorAll('.station').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  if (scroll) document.querySelector(`.station[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- 事件 ----------
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (!q) return;
  el.q.blur();
  el.section.hidden = true;
  showStatus('查詢目的地中…');
  try {
    const list = await geocode(q);
    if (!list.length) return showStatus('找不到這個地點，請換個關鍵字。', true);
    if (list.length === 1) return chooseDestination(list[0]);
    showStatus('請選擇目的地：');
    el.candidates.innerHTML = list.map((c, i) =>
      `<li data-i="${i}"><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.address)}</div></li>`).join('');
    el.candidates.hidden = false;
    el.candidates.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (li) chooseDestination(list[Number(li.dataset.i)]);
    };
  } catch (err) {
    console.error(err);
    showStatus('查詢目的地失敗：' + err.message, true);
  }
});

el.here.addEventListener('click', () => {
  if (!navigator.geolocation) return showStatus('此瀏覽器不支援定位。', true);
  showStatus('取得目前位置中…');
  navigator.geolocation.getCurrentPosition(
    (pos) => chooseDestination({ name: '目前位置', address: '', lat: pos.coords.latitude, lng: pos.coords.longitude }),
    (err) => showStatus('無法取得位置：' + err.message, true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

el.sortBy.addEventListener('change', () => state.dest && render());
el.more.addEventListener('click', () => { state.limitMin = 10; render(); });

el.results.addEventListener('click', (e) => {
  const li = e.target.closest('.station');
  if (li) selectStation(li.dataset.id, false);
});

$('btnSettings').addEventListener('click', () => {
  el.gKey.value = settings.gKey;
  el.ocmKey.value = settings.ocmKey;
  el.walkMin.value = settings.walkMin;
  el.demo.checked = settings.demo;
  el.dlg.showModal();
});

el.dlg.addEventListener('close', () => {
  if (el.dlg.returnValue !== 'save') return;
  store.set('gKey', el.gKey.value.trim());
  store.set('ocmKey', el.ocmKey.value.trim());
  store.set('walkMin', String(Math.min(30, Math.max(1, Number(el.walkMin.value) || 5))));
  store.set('demo', el.demo.checked ? '1' : '0');
  updateBadge();
  if (state.dest) chooseDestination(state.dest);
});

// ---------- 初始化 ----------
fetch('rates.json').then((r) => r.ok ? r.json() : { rules: [] }).then((d) => { state.rates = d.rules || []; }).catch(() => {});
updateBadge();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
