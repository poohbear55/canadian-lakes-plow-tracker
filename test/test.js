// End-to-end tests for the standalone public tracker.
// Run: npm test   (starts the real server on a random port, DATA_DIR in a
// temp folder, default PINs; no network beyond localhost is needed except
// the Leaflet CDN, which the tests do not fetch.)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plow-test-'));
process.env.TRUCK1_PIN = '1101';
process.env.TRUCK2_PIN = '2202';
process.env.TRUCK3_PIN = '3303';
process.env.ADMIN_PIN = '9999';

const { server, roadEnds } = require('../server.js');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const j = async (url, opts) => {
    const res = await fetch(base + url, opts);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* html */ }
    return { status: res.status, json, body };
  };
  const post = (url, obj) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  // 1. Routes load: 165 roads, 73/56/36, miles match v11.
  let r = await j('/api/routes');
  assert.equal(r.status, 200);
  assert.equal(r.json.routes.length, 165, '165 roads');
  for (const [t, n, miles] of [[1, 73, 22.51], [2, 56, 19.11], [3, 36, 5.75]]) {
    const tr = r.json.trucks.find((x) => x.truck === t);
    assert.equal(tr.roads, n, `truck ${t} roads`);
    assert.equal(tr.miles, miles, `truck ${t} miles`);
  }
  assert.equal(r.json.landmarks.length, 2, 'sand pile + HOME markers');
  console.log('ok: routes 165 (73/56/36), miles 22.51/19.11/5.75, 2 landmarks');

  // 2. Frontend serves and contains the driver-lock logic.
  r = await j('/');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('driver') && r.body.includes('app.js'), 'index serves with driver mode');
  console.log('ok: frontend serves, driver-lock code present');

  // 3. PINs enforced: no pin / wrong pin rejected.
  assert.equal((await j('/api/state')).status, 401);
  assert.equal((await post('/api/position', { truck: 1, pin: '0000', lat: 43.59, lon: -85.31 })).status, 401);
  console.log('ok: PINs enforced (401 without/wrong PIN)');

  // 4. End-to-end rule on Montreal Lane (Truck 1, order 1, id 1001):
  //    one end -> STARTED, not done; both ends + driving the middle
  //    (>=80% covered) -> DONE. Ends alone are not enough — the middle
  //    segment is more than 45 m from either end, so a truck that only
  //    touched both ends (e.g. from intersecting roads) must not
  //    complete it.
  const routes = (await j('/api/routes')).json.routes;
  const road = routes.find((x) => x.id === 1001);
  assert.ok(Array.isArray(road.segments) && road.segments.length >= 3, 'routes carry ~20 m segments for progressive green');
  const ends = roadEnds(road);
  r = await post('/api/position', { truck: 1, pin: '1101', lat: ends.endA[0], lon: ends.endA[1], driverName: 'Test' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.newlyCompleted, [], 'one end must not complete');
  assert.equal(r.json.inProgress.length, 1, 'one end = in progress');
  let st = await j('/api/state?pin=9999');
  assert.equal(st.json.doneCount, 0, 'still 0 done after one end');
  assert.ok(!st.json.doneRoadIds.includes(1001), 'one end must not mark road done');
  let prog = st.json.progress.find((p) => p.roadId === 1001);
  assert.ok(prog && prog.coveredCount > 0, 'one end covers some segments (green overlay)');
  assert.ok(prog.pct > 0 && prog.pct < 100, 'one end is partial coverage, not 100%');
  r = await post('/api/position', { truck: 1, pin: '1101', lat: ends.endB[0], lon: ends.endB[1], driverName: 'Test' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.newlyCompleted, [], 'both ends without the middle must not complete');
  st = await j('/api/state?pin=9999');
  assert.equal(st.json.doneCount, 0, 'still 0 done after both ends only');
  const midSeg = road.segments[Math.floor(road.segments.length / 2)];
  r = await post('/api/position', { truck: 1, pin: '1101', lat: (midSeg.a[0] + midSeg.b[0]) / 2, lon: (midSeg.a[1] + midSeg.b[1]) / 2, driverName: 'Test' });
  assert.equal(r.json.newlyCompleted.length, 1, 'both ends + middle driven = completed');
  assert.equal(r.json.newlyCompleted[0].id, 1001);
  st = await j('/api/state?pin=9999');
  assert.equal(st.json.doneCount, 1);
  assert.ok(st.json.doneRoadIds.includes(1001));
  console.log('ok: end-to-end rule — Montreal Lane partial green at one end, green at both');

  // 4b. Progressive coverage mid-road: driving the middle of a road (never
  //     reaching either end) turns only that section green and never
  //     counts the road done.
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  const mid = road.segments[Math.floor(road.segments.length / 2)];
  const midLat = (mid.a[0] + mid.b[0]) / 2, midLon = (mid.a[1] + mid.b[1]) / 2;
  r = await post('/api/position', { truck: 1, pin: '1101', lat: midLat, lon: midLon, driverName: 'Test' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.newlyCompleted, [], 'mid-road position must not complete');
  st = await j('/api/state?pin=9999');
  assert.equal(st.json.doneCount, 0, 'mid-road: still 0 done');
  assert.ok(!st.json.doneRoadIds.includes(1001), 'mid-road: road must NOT be in doneRoadIds');
  prog = st.json.progress.find((p) => p.roadId === 1001);
  assert.ok(prog && prog.coveredCount > 0, 'mid-road: covered segments non-empty');
  assert.ok(prog.pct > 0 && prog.pct < 100, 'mid-road: partial pct, not 100%');
  const firstCovered = prog.coveredCount;
  // Driving a different section adds coverage without completing the road.
  const other = road.segments[0];
  await post('/api/position', { truck: 1, pin: '1101', lat: (other.a[0] + other.b[0]) / 2, lon: (other.a[1] + other.b[1]) / 2, driverName: 'Test' });
  st = await j('/api/state?pin=9999');
  prog = st.json.progress.find((p) => p.roadId === 1001);
  assert.ok(prog.coveredCount >= firstCovered, 'second section adds (or keeps) coverage');
  assert.equal(st.json.doneCount, 0, 'two sections still must not complete the road');
  console.log('ok: progressive green — mid-road position covers only driven sections, road not done');

  // 4b2. False-positive guard (Deerfield Road, 2026-11-23): its south
  //      end is a point on Fawn Lake Drive and its north end is a point
  //      on Main Street, so driving those two roads hits both ends
  //      without ever driving Deerfield itself. Both ends alone must
  //      NOT complete it; driving Deerfield end-to-end must.
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  const deer = routes.find((x) => x.id === 2047);
  assert.ok(deer, 'Deerfield Road in routes');
  const dEnds = roadEnds(deer);
  r = await post('/api/position', { truck: 2, pin: '2202', lat: dEnds.endA[0], lon: dEnds.endA[1], driverName: 'Test' });
  assert.equal(r.status, 200);
  r = await post('/api/position', { truck: 2, pin: '2202', lat: dEnds.endB[0], lon: dEnds.endB[1], driverName: 'Test' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.newlyCompleted.filter((x) => x.id === 2047), [], 'both ends from other roads must not complete Deerfield');
  st = await j('/api/state?pin=9999');
  assert.ok(!st.json.doneRoadIds.includes(2047), 'Deerfield must NOT be done after both ends only');
  prog = st.json.progress.find((p) => p.roadId === 2047);
  assert.ok(prog && prog.pct < 80, 'Deerfield coverage after ends only is under 80% (' + (prog ? prog.pct : 0) + '%)');
  // Now actually drive Deerfield, segment by segment.
  for (const seg of deer.segments) {
    await post('/api/position', { truck: 2, pin: '2202', lat: (seg.a[0] + seg.b[0]) / 2, lon: (seg.a[1] + seg.b[1]) / 2, driverName: 'Test' });
  }
  st = await j('/api/state?pin=9999');
  assert.ok(st.json.doneRoadIds.includes(2047), 'driving Deerfield end-to-end must complete it');
  console.log('ok: accuracy — Deerfield not done from intersecting roads, done once actually driven');

  // 4c. Breadcrumb trail: a moving truck leaves a trail in order, on-road
  //     or off; a parked truck does not spam points; trails are scoped
  //     by PIN and cleared on reset.
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  const trailPts = [[43.5900, -85.3100], [43.5902, -85.3100], [43.5904, -85.3100], [43.5906, -85.3100]]; // ~22 m apart
  for (const [lat, lon] of trailPts) {
    r = await post('/api/position', { truck: 1, pin: '1101', lat, lon, driverName: 'Test' });
    assert.equal(r.status, 200);
  }
  st = await j('/api/state?pin=9999');
  let trails = st.json.trails || [];
  let t1 = trails.find((t) => t.truck === 1);
  assert.ok(t1, 'admin sees Truck 1 trail');
  assert.equal(t1.points.length, trailPts.length, 'one trail point per move');
  assert.deepEqual(t1.points.map((p) => [p.lat, p.lon]), trailPts, 'trail points in driving order');
  // Stationary repeat (same spot) and a tiny <10 m shuffle add nothing.
  await post('/api/position', { truck: 1, pin: '1101', lat: 43.5906, lon: -85.3100, driverName: 'Test' });
  await post('/api/position', { truck: 1, pin: '1101', lat: 43.59065, lon: -85.3100, driverName: 'Test' });
  st = await j('/api/state?pin=9999');
  t1 = (st.json.trails || []).find((t) => t.truck === 1);
  assert.equal(t1.points.length, trailPts.length, 'parked truck does not spam trail points');
  // Truck 2 drives elsewhere; each truck PIN sees only its own trail.
  await post('/api/position', { truck: 2, pin: '2202', lat: 43.5800, lon: -85.3000, driverName: 'Test' });
  await post('/api/position', { truck: 2, pin: '2202', lat: 43.5802, lon: -85.3000, driverName: 'Test' });
  st = await j('/api/state?pin=1101');
  trails = st.json.trails || [];
  assert.equal(trails.length, 1, 'Truck 1 PIN sees one trail');
  assert.equal(trails[0].truck, 1, 'Truck 1 PIN sees only its own trail');
  st = await j('/api/state?pin=2202');
  trails = st.json.trails || [];
  assert.equal(trails.length, 1, 'Truck 2 PIN sees one trail');
  assert.equal(trails[0].truck, 2, 'Truck 2 PIN sees only its own trail');
  st = await j('/api/state?pin=9999');
  assert.equal((st.json.trails || []).length, 2, 'admin sees both trails');
  // Reset clears trails.
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  st = await j('/api/state?pin=9999');
  assert.deepEqual(st.json.trails || [], [], 'reset clears trails');
  console.log('ok: breadcrumb trail — ordered points, no parked spam, PIN-scoped, cleared on reset');

  // 4d. Trail colour is black, green coverage is untouched: the dotted
  //     trail polyline in app.js must be black, and the green overlay
  //     colour (#2ca02c) must still be there.
  r = await j('/app.js');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("color: '#000000'"), 'trail polyline is black');
  assert.ok(r.body.includes("dashArray: '1 6'"), 'trail is still dotted');
  assert.ok(r.body.includes("color: '#2ca02c'"), 'green covered-section colour unchanged');
  console.log('ok: black dotted trail in app.js, green fill-in untouched');

  // 4e. Follow mode: driver map pans to the truck, drag pauses it.
  assert.ok(r.body.includes('followMe') && r.body.includes('panTo'), 'follow mode pans map to GPS fix');
  assert.ok(r.body.includes("map.on('dragstart'"), 'dragging the map pauses follow');
  assert.ok(r.body.includes('setFollow(true)'), 'follow turns on when tracking starts');
  r = await j('/');
  assert.ok(r.body.includes('followBtn') && r.body.includes('Follow my truck'), 'Follow button on the page');
  console.log('ok: follow mode — map follows the truck, drag pauses it, button present');

  // 5. Truck isolation: Truck 2 driving at Montreal Lane's ends must NOT
  //    complete Truck 1's road (and must not need Truck 1's PIN).
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  await post('/api/position', { truck: 2, pin: '2202', lat: ends.endA[0], lon: ends.endA[1] });
  await post('/api/position', { truck: 2, pin: '2202', lat: ends.endB[0], lon: ends.endB[1] });
  st = await j('/api/state?pin=9999');
  assert.ok(!st.json.doneRoadIds.includes(1001), 'Truck 2 must not complete Truck 1 road');
  console.log('ok: truck isolation — Orange at Red road ends does not complete it');

  // 6. Truck PIN sees only its own truck; admin sees all.
  st = await j('/api/state?pin=2202');
  assert.equal(st.json.totalRoads, 56, 'Orange PIN sees 56 roads');
  assert.ok(st.json.positions.every((p) => p.truck === 2), 'Orange PIN sees only Orange positions');
  st = await j('/api/state?pin=9999');
  assert.equal(st.json.totalRoads, 165, 'admin sees 165 roads');
  console.log('ok: scoped state — truck PIN sees own truck only, admin sees all');

  // 7. SSE live stream: a position posted after connecting arrives without reload.
  const ctrl = new AbortController();
  const stream = await fetch(base + '/api/events?pin=9999', { signal: ctrl.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const chunks = [];
  const readPump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString());
      if (chunks.join('').includes('TestSSE')) break;
    }
  })();
  await post('/api/position', { truck: 3, pin: '3303', lat: 43.59, lon: -85.30, driverName: 'TestSSE' });
  await Promise.race([readPump, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE timeout')), 5000))]);
  ctrl.abort();
  assert.ok(chunks.join('').includes('TestSSE'), 'SSE delivered the new position');
  console.log('ok: SSE live stream pushes new positions without reload');

  // 8. Manual tap-to-mark override, then undo.
  r = await post('/api/complete', { roadId: 3001, pin: '3303', done: true, driverName: 'Test' });
  assert.equal(r.status, 200);
  st = await j('/api/state?pin=9999');
  assert.ok(st.json.doneRoadIds.includes(3001), 'manual complete works');
  prog = st.json.progress.find((p) => p.roadId === 3001);
  assert.ok(prog && prog.coveredCount === prog.totalSegments && prog.pct === 100, 'manual complete marks all segments green');
  r = await post('/api/complete', { roadId: 3001, pin: '3303', done: false });
  st = await j('/api/state?pin=9999');
  assert.ok(!st.json.doneRoadIds.includes(3001), 'manual undo works');
  prog = st.json.progress.find((p) => p.roadId === 3001);
  assert.ok(!prog || prog.coveredCount === 0, 'manual undo clears covered segments');
  console.log('ok: manual mark done / undo (all segments green, then cleared)');

  // 9. Admin reset clears the run.
  await post('/api/position', { truck: 1, pin: '1101', lat: ends.endA[0], lon: ends.endA[1] });
  await post('/api/position', { truck: 1, pin: '1101', lat: ends.endB[0], lon: ends.endB[1] });
  r = await post('/api/reset', { pin: '9999' });
  assert.equal(r.status, 200);
  st = await j('/api/state?pin=9999');
  assert.equal(st.json.doneCount, 0, 'reset clears done roads');
  assert.deepEqual(st.json.progress, [], 'reset clears covered segments too');
  console.log('ok: admin reset starts a fresh run');

  server.close();
  console.log('\nALL TESTS PASSED');
}
main().catch((e) => { console.error('TEST FAILED:', e); server.close(); process.exit(1); });
