// Canadian Lakes Public Plow Tracker — standalone server.
//
// Zero-dependency Node.js (Node 20+). Serves the frontend from public/ and
// relays live GPS positions + road completions between driver phones and
// Grayson's admin map over Server-Sent Events (SSE). No page reload is
// needed: the browser keeps one SSE connection open and the server pushes
// every position/completion to it the moment it arrives.
//
// Same rules as the Muse live tracker (v11 routes):
//   * A road counts DONE only once the truck's GPS has come within 45 m of
//     BOTH ends of that road AND covered at least 80% of its ~20 m
//     sub-segments. One end reached = STARTED, never done. Both ends
//     alone is NOT enough: a road's ends sit on other roads (e.g.
//     Deerfield Road's south end is a point on Fawn Lake Drive and its
//     north end is a point on Main Street), so driving those other roads
//     can hit both ends without ever driving the road itself — that
//     falsely marked Deerfield Road done at only 38% covered on
//     2026-11-23. The 80% coverage rule stops that: the middle has to
//     be driven too.
//   * PROGRESSIVE GREEN: each road is split into ~20 m sub-segments. As the
//     truck drives, every sub-segment within 45 m of its GPS position turns
//     green on the map, section by section. Turning off mid-road leaves only
//     the driven sections green — the rest stays the truck colour and the
//     road does NOT count as done until both ends have been reached.
//   * Breadcrumb trail: every GPS fix also appends to that truck's trail
//     for the current run (only when it has moved >10 m, capped at 2,000
//     points). The trail is drawn on the map as a black dotted line,
//     whether or not the truck is on a route road — so
//     an extra road that isn't on the map still shows exactly where the
//     truck went. Trails follow the same PIN scoping as positions.
//   * Loop roads (ends meet) need the start point plus the far side of the
//     loop — the second "end" is the point farthest from the first.
//   * Drivers may tap a road to mark it done by hand (manual override).
//   * Drivers can plow in any order ("Drive it your way").
//   * Truck 1 = Red Single Axle, Truck 2 = Orange Single Axle,
//     Truck 3 = Backhoe (purple).
//
// Access: every truck has a PIN, and the admin has a PIN. Positions and
// completions are only accepted with the PIN for that truck; the live
// state (positions of all trucks) is only served to the admin PIN. A truck
// PIN sees only its own truck. No PIN = routes/map only, no live data.
// Defaults are in .env.example — CHANGE THEM before sharing the links
// publicly. Set via environment: TRUCK1_PIN, TRUCK2_PIN, TRUCK3_PIN,
// ADMIN_PIN. PORT defaults to 3000. DATA_DIR defaults to ./data
// (state.json there; on hosts with ephemeral disks a restart/redeploy
// starts a fresh run — see README).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GPS_MATCH_METERS = 45;
const COMPLETION_COVERAGE_PCT = 80; // a road also needs >=80% of its ~20 m sections covered before it counts DONE — both ends alone is not enough (see below)
const SEGMENT_METERS = 20; // sub-segment length for progressive green coverage
const TRAIL_MIN_METERS = 10; // only add a trail point after moving this far
const TRAIL_MAX_POINTS = 2000; // per truck, per run; oldest points drop off

const PINS = {
  1: process.env.TRUCK1_PIN || '1101',
  2: process.env.TRUCK2_PIN || '2202',
  3: process.env.TRUCK3_PIN || '3303',
};
const ADMIN_PIN = process.env.ADMIN_PIN || '9999';

const TRUCKS = {
  1: { name: 'Red Single Axle', short: 'Red', color: '#d62728' },
  2: { name: 'Orange Single Axle', short: 'Orange', color: '#e67e22' },
  3: { name: 'Backhoe', short: 'Backhoe', color: '#7d3c98' },
};
const STARTS = {
  1: { lat: 43.5907, lon: -85.3199, label: 'Red start — Buchanan Rd & Highland Trail' },
  2: { lat: 43.5906, lon: -85.3147, label: 'Orange start — Buchanan Rd & East Royal Rd' },
  3: { lat: 43.5906, lon: -85.309, label: 'Backhoe start — Buchanan Rd & West Royal Rd' },
};
const LANDMARKS = [
  { lat: 43.568905, lon: -85.287453, label: 'Sand pile — dead-end turnaround on Seven Mile Rd, closest to 100th Ave' },
  { lat: 43.64184, lon: -85.38378, label: 'Home — truck parking, 150th Ave & 12 Mile Rd' },
];

const ROUTES = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'routes.json'), 'utf8'));
const ROAD_BY_ID = new Map(ROUTES.map((r) => [r.id, r]));

// ---- geometry helpers (same ends logic as the Muse tracker) ----
function distMeters(lat, lon, pt) {
  const latM = 111132;
  const lonM = 111320 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot((lon - pt[1]) * lonM, (lat - pt[0]) * latM);
}

// The two ends a truck must reach. For multi-polyline roads, the ends are
// the pair of polyline endpoints farthest apart. When those meet (a loop,
// or a stub shorter than one GPS radius), the second end is the point of
// the road farthest from the first — the far side of the loop.
const endsCache = new Map();
function roadEnds(road) {
  if (endsCache.has(road.id)) return endsCache.get(road.id);
  const endpoints = [];
  const allPoints = [];
  for (const line of road.lines) {
    if (!line || !line.length) continue;
    endpoints.push(line[0], line[line.length - 1]);
    for (const p of line) allPoints.push(p);
  }
  let result;
  if (!endpoints.length) {
    result = { endA: road.center, endB: road.center, isLoop: false };
  } else {
    let endA = endpoints[0];
    let endB = endpoints[0];
    let best = -1;
    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        const d = distMeters(endpoints[i][0], endpoints[i][1], endpoints[j]);
        if (d > best) { best = d; endA = endpoints[i]; endB = endpoints[j]; }
      }
    }
    let isLoop = best < GPS_MATCH_METERS;
    if (isLoop) {
      let far = endA; let farD = -1;
      for (const p of allPoints) {
        const d = distMeters(endA[0], endA[1], p);
        if (d > farD) { farD = d; far = p; }
      }
      endB = far;
    }
    result = { endA, endB, isLoop };
  }
  endsCache.set(road.id, result);
  return result;
}

// ---- progressive coverage: split each road into ~20 m sub-segments ----
// Segments are sampled points along each polyline line, so a segment index
// always maps to the same piece of road on server and frontend (the
// frontend gets the segment geometry from /api/routes). Total across all
// 165 roads is a few thousand segments — cheap to check per GPS fix.
const segmentsCache = new Map();
function roadSegments(road) {
  if (segmentsCache.has(road.id)) return segmentsCache.get(road.id);
  const segs = [];
  for (let li = 0; li < (road.lines || []).length; li++) {
    const line = road.lines[li];
    if (!line || line.length < 2) continue;
    const pts = [line[0]];
    let acc = 0; // metres since the last sampled point, along this line
    for (let i = 1; i < line.length; i++) {
      let curFrom = line[i - 1];
      const to = line[i];
      let remaining = distMeters(curFrom[0], curFrom[1], to);
      while (acc + remaining >= SEGMENT_METERS && remaining > 0) {
        const need = SEGMENT_METERS - acc;
        const t = need / remaining;
        const p = [curFrom[0] + (to[0] - curFrom[0]) * t, curFrom[1] + (to[1] - curFrom[1]) * t];
        pts.push(p);
        curFrom = p;
        remaining = distMeters(curFrom[0], curFrom[1], to);
        acc = 0;
      }
      acc += remaining;
    }
    const lastPt = line[line.length - 1];
    if (distMeters(pts[pts.length - 1][0], pts[pts.length - 1][1], lastPt) > 0.1) pts.push(lastPt);
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1], line: li });
  }
  segmentsCache.set(road.id, segs);
  return segs;
}

// Distance (m) from a GPS point to a line segment, in a local flat
// projection centred on the segment start.
function pointSegmentDistMeters(lat, lon, a, b) {
  const latM = 111132;
  const lonM = 111320 * Math.cos((lat * Math.PI) / 180);
  const bx = (b[1] - a[1]) * lonM;
  const by = (b[0] - a[0]) * latM;
  const px = (lon - a[1]) * lonM;
  const py = (lat - a[0]) * latM;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}

// ---- state ----
function freshState() {
  return {
    run: { id: 1, label: 'Plow run — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), startedAt: new Date().toISOString(), active: true },
    positions: {},        // truck -> {truck, lat, lon, accuracy, driverName, receivedAt, clientTs}
    trails: {},           // truck -> [{lat, lon, at}] — breadcrumb trail for this run
    progress: {},         // roadId -> {roadId, endA: bool, endB: bool, covered: [segment indices]}
    done: {},             // roadId -> {roadId, doneAt, source: 'gps'|'manual', driverName}
    feed: [],             // newest first, capped
    history: [],          // finished runs: {label, startedAt, endedAt, doneCount}
  };
}
let state = freshState();
function loadState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s && s.run && s.positions && s.done) {
        state = s;
        // State written before trails existed has no trails key.
        if (!state.trails) state.trails = {};
      }
    }
  } catch (e) { console.error('state load failed, starting fresh:', e.message); }
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) { console.error('state save failed:', e.message); }
}
loadState();

// ---- SSE clients ----
const clients = new Set(); // {res, scope: 'admin' | truckNumber}
function broadcast() {
  const payload = publicState();
  for (const c of clients) {
    try { c.res.write('data: ' + JSON.stringify(filterState(payload, c.scope)) + '\n\n'); } catch { /* drop on next write */ }
  }
}
function publicState() {
  const doneIds = Object.keys(state.done).map(Number);
  return {
    run: state.run,
    doneRoadIds: doneIds,
    doneCount: doneIds.length,
    totalRoads: ROUTES.length,
    progress: Object.values(state.progress).map((p) => {
      const total = roadSegments(ROAD_BY_ID.get(p.roadId)).length;
      const covered = (p.covered || []).slice().sort((a, b) => a - b);
      return {
        roadId: p.roadId,
        endsHit: (p.endA ? 1 : 0) + (p.endB ? 1 : 0),
        covered,
        coveredCount: covered.length,
        totalSegments: total,
        pct: total ? Math.round((covered.length / total) * 100) : 0,
      };
    }),
    positions: Object.values(state.positions),
    trails: Object.entries(state.trails || {}).map(([truck, points]) => ({ truck: Number(truck), points: points || [] })),
    feed: state.feed.slice(0, 50),
    history: state.history,
  };
}
// A truck PIN sees only its own truck's position/progress/done/feed.
function filterState(s, scope) {
  if (scope === 'admin') return s;
  const myRoads = new Set(ROUTES.filter((r) => r.truck === scope).map((r) => r.id));
  return {
    ...s,
    doneRoadIds: s.doneRoadIds.filter((id) => myRoads.has(id)),
    doneCount: s.doneRoadIds.filter((id) => myRoads.has(id)).length,
    totalRoads: myRoads.size,
    progress: s.progress.filter((p) => myRoads.has(p.roadId)),
    positions: s.positions.filter((p) => p.truck === scope),
    trails: (s.trails || []).filter((t) => t.truck === scope),
    feed: s.feed.filter((f) => !f.truck || f.truck === scope),
  };
}
function scopeForPin(pin) {
  if (!pin) return null;
  if (String(pin) === String(ADMIN_PIN)) return 'admin';
  for (const t of [1, 2, 3]) if (String(pin) === String(PINS[t])) return t;
  return null;
}

function pushFeed(item) {
  state.feed.unshift({ ...item, at: new Date().toISOString() });
  state.feed = state.feed.slice(0, 100);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// POST /api/position — driver GPS. Body: {truck, pin, lat, lon, accuracy?, driverName?}
function handlePosition(body) {
  const truck = Number(body.truck);
  if (![1, 2, 3].includes(truck)) return { error: 'bad truck', code: 400 };
  if (String(body.pin || '') !== String(PINS[truck])) return { error: 'wrong pin for this truck', code: 401 };
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'bad lat/lon', code: 400 };
  }
  const driverName = String(body.driverName || '').slice(0, 60);
  const receivedAt = new Date().toISOString();
  state.positions[truck] = { truck, lat, lon, accuracy: body.accuracy ?? null, driverName, receivedAt, clientTs: body.clientTs ?? null };
  // Breadcrumb trail: append only after a real move (>10 m), so a parked
  // truck sending heartbeats doesn't pile up duplicate points. Capped
  // at 2,000 points per truck; oldest points drop off. The trail is
  // recorded for every fix, on-road or off — it is not tied to roads.
  if (!state.trails) state.trails = {};
  const trail = state.trails[truck] || (state.trails[truck] = []);
  const lastTrail = trail[trail.length - 1];
  if (!lastTrail || distMeters(lat, lon, [lastTrail.lat, lastTrail.lon]) > TRAIL_MIN_METERS) {
    trail.push({ lat, lon, at: receivedAt });
    while (trail.length > TRAIL_MAX_POINTS) trail.shift();
  }
  const newlyCompleted = [];
  const inProgress = [];
  for (const road of ROUTES.filter((r) => r.truck === truck)) {
    if (state.done[road.id]) continue;
    const ends = roadEnds(road);
    const prev = state.progress[road.id] || { roadId: road.id, endA: false, endB: false, covered: [] };
    const hitA = prev.endA || distMeters(lat, lon, ends.endA) <= GPS_MATCH_METERS;
    const hitB = prev.endB || distMeters(lat, lon, ends.endB) <= GPS_MATCH_METERS;
    // Progressive coverage: mark every ~20 m sub-segment within 45 m of
    // this fix as covered. Coverage plus both ends (below) completes a
    // road — neither alone does.
    const segs = roadSegments(road);
    const coveredSet = new Set(prev.covered || []);
    let coveredChanged = false;
    for (let i = 0; i < segs.length; i++) {
      if (coveredSet.has(i)) continue;
      if (pointSegmentDistMeters(lat, lon, segs[i].a, segs[i].b) <= GPS_MATCH_METERS) {
        coveredSet.add(i);
        coveredChanged = true;
      }
    }
    const endsChanged = hitA !== prev.endA || hitB !== prev.endB;
    if (!coveredChanged && !endsChanged) continue;
    state.progress[road.id] = { roadId: road.id, endA: hitA, endB: hitB, covered: [...coveredSet].sort((a, b) => a - b) };
    // DONE needs both ends AND >=80% of the road's sections covered.
    // (Ends alone can be hit from intersecting roads — Deerfield Road,
    // 2026-11-23 — so coverage is what proves the road itself was driven.)
    const coveredPct = segs.length ? Math.round((coveredSet.size / segs.length) * 100) : 0;
    if (hitA && hitB && coveredPct >= COMPLETION_COVERAGE_PCT) {
      state.done[road.id] = { roadId: road.id, doneAt: new Date().toISOString(), source: 'gps', driverName };
      newlyCompleted.push({ id: road.id, name: road.name });
      pushFeed({ type: 'done', truck, roadId: road.id, name: road.name, source: 'gps', driverName });
    } else if (endsChanged) {
      inProgress.push({ id: road.id, name: road.name, endsHit: (hitA ? 1 : 0) + (hitB ? 1 : 0) });
      pushFeed({ type: 'started', truck, roadId: road.id, name: road.name, endsHit: (hitA ? 1 : 0) + (hitB ? 1 : 0), driverName });
    }
  }
  saveState();
  broadcast();
  return { ok: true, newlyCompleted, inProgress };
}

// POST /api/complete — manual tap-to-mark. Body: {roadId, pin, done, driverName?}
function handleComplete(body) {
  const road = ROAD_BY_ID.get(Number(body.roadId));
  if (!road) return { error: 'unknown road', code: 400 };
  if (String(body.pin || '') !== String(PINS[road.truck])) return { error: 'wrong pin for this truck', code: 401 };
  const driverName = String(body.driverName || '').slice(0, 60);
  if (body.done) {
    state.done[road.id] = { roadId: road.id, doneAt: new Date().toISOString(), source: 'manual', driverName };
    // Manual complete = whole road done: all sub-segments green.
    const total = roadSegments(road).length;
    state.progress[road.id] = { roadId: road.id, endA: true, endB: true, covered: Array.from({ length: total }, (_, i) => i) };
    pushFeed({ type: 'done', truck: road.truck, roadId: road.id, name: road.name, source: 'manual', driverName });
  } else {
    delete state.done[road.id];
    delete state.progress[road.id];
    pushFeed({ type: 'undone', truck: road.truck, roadId: road.id, name: road.name, driverName });
  }
  saveState();
  broadcast();
  return { ok: true };
}

// ---- HTTP server ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/health') return sendJson(res, 200, { ok: true, run: state.run.label, doneCount: Object.keys(state.done).length, totalRoads: ROUTES.length });
    if (p === '/api/routes') {
      return sendJson(res, 200, {
        trucks: [1, 2, 3].map((t) => ({
          truck: t, name: TRUCKS[t].name, color: TRUCKS[t].color,
          roads: ROUTES.filter((r) => r.truck === t).length,
          miles: Math.round(ROUTES.filter((r) => r.truck === t).reduce((s, r) => s + r.miles, 0) * 100) / 100,
          start: STARTS[t],
        })),
        landmarks: LANDMARKS,
        routes: ROUTES.map((r) => ({ ...r, segments: roadSegments(r) })),
      });
    }
    if (p === '/api/state') {
      const scope = scopeForPin(url.searchParams.get('pin'));
      if (!scope) return sendJson(res, 401, { error: 'pin required — enter your truck PIN (driver) or the admin PIN' });
      return sendJson(res, 200, filterState(publicState(), scope));
    }
    if (p === '/api/events') {
      const scope = scopeForPin(url.searchParams.get('pin'));
      if (!scope) return sendJson(res, 401, { error: 'pin required' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(filterState(publicState(), scope)) + '\n\n');
      const client = { res, scope };
      clients.add(client);
      const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closed */ } }, 25000);
      req.on('close', () => { clearInterval(hb); clients.delete(client); });
      return;
    }
    if (req.method === 'POST' && p === '/api/position') {
      const body = await readBody(req);
      const r = handlePosition(body);
      return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/complete') {
      const body = await readBody(req);
      const r = handleComplete(body);
      return r.error ? sendJson(res, r.code, { error: r.error }) : sendJson(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/reset') {
      const body = await readBody(req);
      if (String(body.pin || '') !== String(ADMIN_PIN)) return sendJson(res, 401, { error: 'admin pin required' });
      state.history.unshift({ ...state.run, endedAt: new Date().toISOString(), doneCount: Object.keys(state.done).length });
      state = freshState();
      state.run.id = state.history.length + 1;
      saveState();
      broadcast();
      return sendJson(res, 200, { ok: true, run: state.run });
    }

    // Static files (frontend). Only files under public/, no directory escape.
    let file = p === '/' ? '/index.html' : p;
    const filePath = path.normalize(path.join(PUBLIC_DIR, file));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Canadian Lakes Plow Tracker (public) listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Routes loaded: ${ROUTES.length} roads, ${Object.keys(state.done).length} done in current run.`);
    console.log('Set TRUCK1_PIN/TRUCK2_PIN/TRUCK3_PIN/ADMIN_PIN env vars to change the default PINs.');
  });
}
module.exports = { server, handlePosition, handleComplete, roadEnds, roadSegments, pointSegmentDistMeters, ROUTES, scopeForPin, publicState, filterState };
