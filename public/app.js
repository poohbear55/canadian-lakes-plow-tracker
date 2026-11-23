// Canadian Lakes Public Plow Tracker — frontend.
// One page, no framework. Live updates arrive over Server-Sent Events
// (/api/events); the map is never reloaded — pins glide and road colours
// change in place. Coverage is progressive: the server splits each road
// into ~20 m sub-segments and reports which are covered; the base line
// stays the truck colour and covered sections draw green on top, so a
// road only counts DONE (fully green) once both ends have been reached.
// Breadcrumb trail: state.trails carries each visible truck's path for
// this run; it draws as a black dotted line, on-road or off, so an extra
// road that isn't on the map still shows where the truck actually went.
// (Black, not the truck colour, so it stands out against the red/orange/
// purple roads and the green covered sections.)
// Driver links (?driver=1&truck=N) lock the phone to that truck only: no
// admin view, no truck switcher, ever.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const isDriverLink = params.get('driver') === '1' || location.hash.indexOf('driver') >= 0;
  const linkTruck = [1, 2, 3].includes(Number(params.get('truck'))) ? Number(params.get('truck')) : null;
  const driverOnly = isDriverLink || !!linkTruck;

  const TRUCKS = {
    1: { name: 'Red Single Axle', color: '#d62728' },
    2: { name: 'Orange Single Axle', color: '#e67e22' },
    3: { name: 'Backhoe', color: '#7d3c98' },
  };
  const STARTS = {};
  let ROUTES = [];
  let LANDMARKS = [];
  let state = null; // last /api/state or SSE payload
  let pin = sessionStorage.getItem('plow.pin') || '';
  let pinScope = null; // 'admin' or 1/2/3
  let myTruck = driverOnly ? linkTruck : null; // driver: fixed; admin: null (all)
  let tracking = false;
  let watchId = null;
  let lastSent = 0;
  let lastPos = null;

  const $ = (id) => document.getElementById(id);
  const fmtAgo = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    return Math.floor(s / 60) + 'm ago';
  };

  // ---------- map ----------
  const map = L.map('map').setView([43.575, -85.305], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const roadLayers = new Map(); // roadId -> {layer, overlay, road}
  const trailLayers = {}; // truck -> L.polyline (breadcrumb trail)
  const pinLayers = {}; // truck -> {marker, from, to, startTs}
  const labelLayer = L.layerGroup().addTo(map);

  // Base colour: a road stays its truck colour until it is DONE, when the
  // whole line is green. Partial progress is shown by the green overlay
  // (refreshCoverage), never by recolouring the whole road amber.
  function roadColor(road) {
    if (state && state.doneRoadIds && state.doneRoadIds.includes(road.id)) return '#2ca02c';
    return TRUCKS[road.truck].color;
  }
  function progressFor(road) {
    const prog = state && state.progress ? state.progress.find((p) => p.roadId === road.id) : null;
    if (!prog) return { covered: [], total: (road.segments || []).length, pct: 0 };
    const total = prog.totalSegments || (road.segments || []).length;
    const covered = prog.covered || [];
    return { covered, total, pct: total ? Math.round((covered.length / total) * 100) : 0 };
  }
  function drawRoads() {
    for (const road of ROUTES) {
      if (roadLayers.has(road.id)) continue;
      const latlngs = road.lines.map((line) => line.map((p) => [p[0], p[1]]));
      const layer = L.polyline(latlngs, { color: roadColor(road), weight: 5, opacity: 0.9 }).addTo(map);
      const overlay = L.layerGroup().addTo(map); // green covered sub-segments
      layer.bindPopup(() => roadPopup(road));
      layer.on('click', () => layer.openPopup());
      roadLayers.set(road.id, { layer, overlay, road });
    }
    refreshRoadColors();
  }
  function refreshRoadColors() {
    for (const { layer, road } of roadLayers.values()) layer.setStyle({ color: roadColor(road) });
    refreshCoverage();
  }
  // Green overlay: draw the covered ~20 m sub-segments (from /api/routes),
  // grouped into contiguous runs within one original polyline line, so a
  // run never jumps across a gap between disconnected pieces of a road.
  // A done road is fully green. Updated in place on every SSE state push.
  function refreshCoverage() {
    for (const { overlay, road } of roadLayers.values()) {
      overlay.clearLayers();
      const segs = road.segments || [];
      if (!segs.length) continue;
      const done = state && state.doneRoadIds && state.doneRoadIds.includes(road.id);
      const covered = done ? segs.map((_, i) => i) : progressFor(road).covered.slice().sort((a, b) => a - b);
      if (!covered.length) continue;
      let run = [covered[0]];
      const flush = () => {
        if (!run.length) return;
        const pts = [[segs[run[0]].a[0], segs[run[0]].a[1]]];
        for (const idx of run) pts.push([segs[idx].b[0], segs[idx].b[1]]);
        overlay.addLayer(L.polyline(pts, { color: '#2ca02c', weight: 6, opacity: 0.95 }));
        run = [];
      };
      for (let i = 1; i < covered.length; i++) {
        const prev = covered[i - 1];
        const cur = covered[i];
        if (cur === prev + 1 && segs[cur].line === segs[prev].line) run.push(cur);
        else { flush(); run = [cur]; }
      }
      flush();
    }
  }
  // Breadcrumb trails: one black dotted polyline per visible truck,
  // grown live from state.trails on every SSE push.
  // Dotted + thinner than the solid road lines, so it reads as "where
  // the truck actually drove" even where it overlaps a road — and it
  // keeps drawing where there is no road at all. A driver sees only
  // their own truck's trail (the server scopes state.trails by PIN);
  // admin sees all three. An empty trail (new run / reset) removes
  // the line.
  function refreshTrails() {
    const visible = pinScope === 'admin' ? [1, 2, 3] : [myTruck || pinScope];
    for (const t of [1, 2, 3]) {
      const entry = (state.trails || []).find((x) => x.truck === t);
      const pts = entry ? entry.points || [] : [];
      const show = visible.includes(t) && pts.length >= 2;
      if (!show) {
        if (trailLayers[t]) { map.removeLayer(trailLayers[t]); delete trailLayers[t]; }
        continue;
      }
      const latlngs = pts.map((p) => [p.lat, p.lon]);
      if (trailLayers[t]) trailLayers[t].setLatLngs(latlngs);
      else {
        trailLayers[t] = L.polyline(latlngs, {
          color: '#000000', weight: 4, opacity: 0.9, dashArray: '1 6', lineCap: 'round',
        }).addTo(map);
      }
    }
  }
  function roadPopup(road) {
    const done = state && state.doneRoadIds.includes(road.id);
    const prog = progressFor(road);
    const status = done ? 'DONE ✓' : prog.covered.length > 0
      ? 'STARTED — ~' + prog.pct + '% covered (' + prog.covered.length + '/' + prog.total + ' sections plowed)'
      : 'Not started';
    const canMark = pinScope === 'admin' || pinScope === road.truck;
    const btn = canMark
      ? '<br><button data-road="' + road.id + '" data-done="' + (done ? '0' : '1') + '" class="markBtn">' + (done ? 'Mark NOT done' : 'Mark done') + '</button>'
      : '';
    return '<b>' + road.name + '</b><br>' + TRUCKS[road.truck].name + ' · order ' + road.order +
      '<br>' + road.miles + ' mi · ~' + road.estMin + ' min<br>Status: <b>' + status + '</b>' + btn;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('.markBtn');
    if (!b) return;
    const roadId = Number(b.dataset.road);
    const done = b.dataset.done === '1';
    const r = await fetch('/api/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roadId, pin, done, driverName: driverName() }) });
    if (!r.ok) alert('Could not save — check your PIN.');
    else map.closePopup();
  });

  // Road-name labels appear as you zoom in (zoom 15+), only for roads in view.
  function refreshLabels() {
    labelLayer.clearLayers();
    if (map.getZoom() < 15) return;
    const b = map.getBounds();
    let n = 0;
    for (const road of ROUTES) {
      if (n > 60) break;
      if (!b.contains([road.center[0], road.center[1]])) continue;
      if (myTruck && road.truck !== myTruck) continue;
      labelLayer.addLayer(L.tooltip({ permanent: true, direction: 'top', className: 'roadLabel', offset: [0, -4] })
        .setLatLng([road.center[0], road.center[1]]).setContent(road.name));
      n++;
    }
  }
  map.on('zoomend moveend', refreshLabels);

  function truckPinIcon(truck) {
    return L.divIcon({ className: 'truckPin', html: '<div class="pinDot" style="background:' + TRUCKS[truck].color + '">' + truck + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
  }
  // Smooth glide: animate the existing marker toward each new position.
  function glidePin(truck, lat, lon) {
    let entry = pinLayers[truck];
    if (!entry) {
      entry = pinLayers[truck] = { marker: L.marker([lat, lon], { icon: truckPinIcon(truck) }).addTo(map), from: [lat, lon], to: [lat, lon], startTs: 0 };
      entry.marker.bindTooltip(TRUCKS[truck].name, { direction: 'top' });
      return;
    }
    const cur = entry.marker.getLatLng();
    entry.from = [cur.lat, cur.lng];
    entry.to = [lat, lon];
    entry.startTs = performance.now();
  }
  function animatePins(now) {
    for (const entry of Object.values(pinLayers)) {
      const t = Math.min(1, (now - entry.startTs) / 2500);
      const lat = entry.from[0] + (entry.to[0] - entry.from[0]) * t;
      const lon = entry.from[1] + (entry.to[1] - entry.from[1]) * t;
      entry.marker.setLatLng([lat, lon]);
    }
    requestAnimationFrame(animatePins);
  }
  requestAnimationFrame(animatePins);

  function addMarkers() {
    for (const t of [1, 2, 3]) {
      const s = STARTS[t];
      if (s) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'startPin', html: '★', iconSize: [20, 20], iconAnchor: [10, 10] }) })
        .addTo(map).bindTooltip(s.label);
    }
    for (const lm of LANDMARKS) {
      L.marker([lm.lat, lm.lon], { icon: L.divIcon({ className: 'lmPin', html: '◆', iconSize: [20, 20], iconAnchor: [10, 10] }) })
        .addTo(map).bindTooltip(lm.label);
    }
  }

  // ---------- state rendering (in place, no reload) ----------
  function render() {
    if (!state) return;
    $('runLabel').textContent = state.run ? state.run.label : '—';
    const total = state.totalRoads || ROUTES.length;
    $('doneCount').textContent = state.doneCount || 0;
    $('totalCount').textContent = total;
    refreshRoadColors();
    refreshTrails();
    // pins
    for (const p of state.positions || []) glidePin(p.truck, p.lat, p.lon);
    // truck cards
    const cards = $('truckCards');
    cards.innerHTML = '';
    const trucks = pinScope === 'admin' ? [1, 2, 3] : [myTruck || pinScope];
    for (const t of trucks) {
      if (!t) continue;
      const roads = ROUTES.filter((r) => r.truck === t);
      const done = roads.filter((r) => state.doneRoadIds.includes(r.id)).length;
      const pos = (state.positions || []).find((p) => p.truck === t);
      const div = document.createElement('div');
      div.className = 'truckCard';
      div.innerHTML = '<b style="color:' + TRUCKS[t].color + '">' + TRUCKS[t].name + '</b> — ' + done + '/' + roads.length + ' done' +
        (pos ? '<br>Last seen ' + fmtAgo(pos.receivedAt) + (pos.accuracy ? ' · ±' + Math.round(pos.accuracy) + ' m' : '') : '<br>Not seen yet');
      cards.appendChild(div);
    }
    // road list (own truck for drivers, all for admin — admin list shows each truck in turn)
    const list = $('roadList');
    list.innerHTML = '';
    const listTrucks = pinScope === 'admin' ? [1, 2, 3] : [myTruck || pinScope];
    let suggested = null;
    for (const t of listTrucks) {
      if (!t) continue;
      const roads = ROUTES.filter((r) => r.truck === t).sort((a, b) => a.order - b.order);
      for (const road of roads) {
        const done = state.doneRoadIds.includes(road.id);
        if (!done && !suggested) suggested = road;
        const prog = progressFor(road);
        const li = document.createElement('li');
        li.className = done ? 'done' : (prog.covered.length > 0 ? 'started' : '');
        li.innerHTML = '<label><input type="checkbox" data-road="' + road.id + '"' + (done ? ' checked' : '') + '> ' +
          road.order + '. ' + road.name + ' — ' + road.miles + ' mi' + (prog.covered.length > 0 && !done ? ' · ~' + prog.pct + '% plowed' : '') + '</label>';
        list.appendChild(li);
      }
    }
    $('suggested').textContent = suggested
      ? 'Suggested next: ' + suggested.name + ' (' + TRUCKS[suggested.truck].name + ') — any highlighted road can be done in any order.'
      : 'All roads done — nice work.';
    // feed
    const feed = $('feed');
    feed.innerHTML = '';
    for (const f of (state.feed || []).slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = (f.type === 'done' ? '✓ ' : f.type === 'started' ? '… ' : '↩ ') + f.name +
        ' — ' + (TRUCKS[f.truck] ? TRUCKS[f.truck].name : '') + (f.source ? ' (' + f.source + ')' : '') + ' · ' + fmtAgo(f.at);
      feed.appendChild(li);
    }
    refreshLabels();
  }
  document.addEventListener('change', async (e) => {
    const cb = e.target.closest && e.target.closest('input[type=checkbox][data-road]');
    if (!cb) return;
    const roadId = Number(cb.dataset.road);
    const r = await fetch('/api/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roadId, pin, done: cb.checked, driverName: driverName() }) });
    if (!r.ok) { alert('Could not save — check your PIN.'); cb.checked = !cb.checked; }
  });

  // ---------- PIN gate ----------
  function driverName() { return (sessionStorage.getItem('plow.name') || '').slice(0, 60); }
  function showPinGate() {
    $('pinGate').classList.remove('hidden');
    const truckName = driverOnly && linkTruck ? TRUCKS[linkTruck].name : 'Admin (all trucks)';
    $('pinTitle').textContent = driverOnly ? 'Enter your ' + truckName + ' PIN' : 'Enter PIN';
    $('pinText').textContent = driverOnly
      ? 'This link is locked to ' + truckName + '. Enter that truck’s PIN to start tracking. No admin view on a driver link.'
      : 'Enter a truck PIN to see that truck, or the admin PIN to see all three trucks live.';
    $('pinInput').focus();
  }
  async function unlock() {
    const value = $('pinInput').value.trim();
    if (!value) return;
    const r = await fetch('/api/state?pin=' + encodeURIComponent(value));
    if (!r.ok) { $('pinError').textContent = 'Wrong PIN — try again.'; return; }
    pin = value;
    sessionStorage.setItem('plow.pin', pin);
    const data = await r.json();
    // Scope: admin PIN sees all 165 roads; a truck PIN sees only its own truck's count.
    pinScope = data.totalRoads === ROUTES.length ? 'admin' : (myTruck || [1, 2, 3].find((t) => ROUTES.filter((x) => x.truck === t).length === data.totalRoads));
    if (driverOnly) pinScope = linkTruck; // driver link is always that truck
    if (driverOnly && !linkTruck) {
      $('pinError').textContent = 'This driver link needs &truck=1 (Red), &truck=2 (Orange) or &truck=3 (Backhoe).';
      return;
    }
    if (pinScope === 'admin') myTruck = null;
    else myTruck = pinScope;
    $('pinGate').classList.add('hidden');
    state = data;
    render();
    setupAfterUnlock();
    connectSSE();
  }
  $('pinSubmit').addEventListener('click', unlock);
  $('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

  function setupAfterUnlock() {
    if (pinScope === 'admin') {
      $('adminNote').classList.remove('hidden');
      $('resetBtn').classList.remove('hidden');
      $('listTitle').textContent = 'All roads';
    } else {
      $('driverNote').classList.remove('hidden');
      $('trackBtn').classList.remove('hidden');
      $('listTitle').textContent = TRUCKS[myTruck].name + ' — roads';
      map.setView([STARTS[myTruck].lat, STARTS[myTruck].lon], 14);
    }
  }
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Start a new run? This clears all done roads and starts fresh.')) return;
    const r = await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (!r.ok) alert('Reset failed — admin PIN required.');
  });

  // ---------- GPS tracking (driver only) ----------
  function sendPosition(pos) {
    const now = Date.now();
    if (now - lastSent < 3000) return;
    lastSent = now;
    lastPos = pos;
    fetch('/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truck: myTruck, pin, lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy || null, driverName: driverName(), clientTs: now }) })
      .catch(() => {});
    $('gpsStatus').textContent = 'Sending position… ' + new Date().toLocaleTimeString();
  }
  $('trackBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { alert('This browser cannot share location.'); return; }
    let name = driverName();
    if (!name) {
      name = prompt('Your name (shown to Grayson on the admin map):') || '';
      sessionStorage.setItem('plow.name', name);
    }
    tracking = true;
    $('trackBtn').classList.add('hidden');
    $('stopBtn').classList.remove('hidden');
    watchId = navigator.geolocation.watchPosition(sendPosition, (err) => { $('gpsStatus').textContent = 'GPS error: ' + err.message; }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
    // Also send a heartbeat even if the position hasn't moved, so the pin stays live.
    setInterval(() => { if (tracking && lastPos) sendPosition(lastPos); }, 5000);
  });
  $('stopBtn').addEventListener('click', () => {
    tracking = false;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    $('stopBtn').classList.add('hidden');
    $('trackBtn').classList.remove('hidden');
    $('gpsStatus').textContent = 'Tracking stopped.';
  });

  // ---------- SSE live feed (no reload, reconnects on drop) ----------
  let es = null;
  function connectSSE() {
    if (es) es.close();
    es = new EventSource('/api/events?pin=' + encodeURIComponent(pin));
    es.onmessage = (ev) => { try { state = JSON.parse(ev.data); render(); } catch { /* ignore */ } };
    es.onerror = () => { /* browser auto-reconnects; state re-syncs on reconnect */ };
  }
  setInterval(() => { if (state) render(); }, 30000); // refresh "last seen" text

  // ---------- boot ----------
  fetch('/api/routes').then((r) => r.json()).then((data) => {
    ROUTES = data.routes;
    LANDMARKS = data.landmarks;
    for (const t of data.trucks) STARTS[t.truck] = t.start;
    drawRoads();
    addMarkers();
    refreshLabels();
    $('totalCount').textContent = ROUTES.length;
    if (driverOnly && !linkTruck) {
      $('pinText').textContent = 'Pick your truck first — this link needs &truck=1 (Red), &truck=2 (Orange) or &truck=3 (Backhoe).';
    }
    // If we already have a PIN this session, try it silently.
    if (pin) {
      $('pinInput').value = pin;
      unlock();
    } else {
      showPinGate();
    }
  }).catch(() => {
    document.body.insertAdjacentHTML('beforeend', '<p style="color:red;padding:1em">Could not load routes from the server. Check your connection and reload.</p>');
  });
})();
