// Drive one truck through one road end-to-end against a running server,
// so Grayson can watch the admin map without a real truck.
// Usage: node scripts/simulate.js <baseUrl> <truck 1|2|3> <pin> [roadName-substring]
//   node scripts/simulate.js http://localhost:3000 2 2202 "Valley Court"
'use strict';
const base = process.argv[2] || 'http://localhost:3000';
const truck = Number(process.argv[3] || 2);
const pin = process.argv[4] || '2202';
const want = (process.argv[5] || '').toLowerCase();

async function main() {
  const routes = await (await fetch(base + '/api/routes')).json();
  const road = routes.routes.find((r) => r.truck === truck && r.name.toLowerCase().includes(want)) || routes.routes.find((r) => r.truck === truck);
  console.log('Driving truck', truck, 'along', road.name, '(order', road.order + ')');
  // Ends: first point of first polyline, last point of last polyline (approx;
  // the server uses the farthest-apart endpoints — for most roads these are it).
  const pts = road.lines.flat();
  const a = pts[0], b = pts[pts.length - 1];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const lat = a[0] + (b[0] - a[0]) * (i / steps);
    const lon = a[1] + (b[1] - a[1]) * (i / steps);
    const r = await fetch(base + '/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truck, pin, lat, lon, accuracy: 8, driverName: 'Demo' }) });
    console.log(i, (await r.json()));
    await new Promise((x) => setTimeout(x, 3000));
  }
  // Drive back the other way, like plowing the second side.
  for (let i = steps; i >= 0; i--) {
    const lat = a[0] + (b[0] - a[0]) * (i / steps);
    const lon = a[1] + (b[1] - a[1]) * (i / steps);
    await fetch(base + '/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truck, pin, lat, lon, accuracy: 8, driverName: 'Demo' }) });
    await new Promise((x) => setTimeout(x, 3000));
  }
  const state = await (await fetch(base + '/api/state?pin=9999')).json().catch(() => null);
  console.log('Done. Server done count:', state ? state.doneCount : '(admin PIN differs — check /api/health)');
}
main().catch((e) => { console.error(e); process.exit(1); });
