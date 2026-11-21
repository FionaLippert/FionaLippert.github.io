// Scroll-driven globe for the hero. While the hero is pinned, scrolling turns the
// Earth, moves flocks of birds along autumn migration routes and lets a satellite
// record a swath of reflected sunlight. Data comes from assets/globe-data.js; the
// radar network, routes and swath values are schematic. Only the coastlines are data.
//
// Smoothness: the drawing loop projects points into plain numbers (no arrays per
// point, so no garbage-collection pauses), draws the swath in batched paths, only
// draws while the eased progress is still moving, eases by elapsed time so it feels
// the same at 60 Hz and 120 Hz, and caps the canvas resolution on very large screens.
(() => {
  const D = window.GLOBE_DATA;
  const hero = document.querySelector(".hero");
  const stage = document.querySelector(".stage");
  const canvas = document.querySelector(".globe-canvas");
  if (!D || !hero || !stage || !canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const RAD = Math.PI / 180;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  const params = new URLSearchParams(location.search);
  const fixed = params.has("progress") ? clamp01(Number(params.get("progress")) || 0) : null;
  const still = fixed !== null || matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- data
  // Unit vectors are stored flat: [x0, y0, z0, x1, y1, z1, ...]
  const put = (out, i, lon, lat) => {
    const a = lon * RAD, b = lat * RAD, c = Math.cos(b);
    out[i] = c * Math.cos(a); out[i + 1] = c * Math.sin(a); out[i + 2] = Math.sin(b);
  };
  const vecs = (lonlat) => {
    const n = lonlat.length / 2, out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) put(out, 3 * i, lonlat[2 * i], lonlat[2 * i + 1]);
    return out;
  };

  // Coastlines. Each ring keeps a bounding cap, so rings on the far side are skipped
  // without projecting their points.
  let maxRing = 0;
  const land = D.land.map((d) => {
    const n = d.length / 2, ll = new Float32Array(2 * n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += d[2 * i]; y += d[2 * i + 1]; ll[2 * i] = x / D.q; ll[2 * i + 1] = y / D.q; }
    const v = vecs(ll);
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += v[3 * i]; my += v[3 * i + 1]; mz += v[3 * i + 2]; }
    const m = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= m; my /= m; mz /= m;
    let minDot = 1;
    for (let i = 0; i < n; i++) minDot = Math.min(minDot, v[3 * i] * mx + v[3 * i + 1] * my + v[3 * i + 2] * mz);
    maxRing = Math.max(maxRing, n);
    return { v, n, mx, my, mz, cut: minDot < 0 ? -2 : -Math.sqrt(1 - minDot * minDot) };
  });
  const scratch = new Float32Array(maxRing * 2);

  const sites = D.sites.map(([lon, lat]) => ({ lon, lat, v: vecs([lon, lat]) }));
  const cells = D.cells.map((c) => ({ site: sites[c[0]], v: vecs(c.slice(1)) }));
  const flux = D.flux.map(([a, b, c, d]) => ({ a: vecs([a, b]), b: vecs([c, d]), lon: (a + c) / 2, lat: (b + d) / 2 }));

  const routes = D.routes.map((r, k) => {
    const n = r.length / 2, cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const a = r[2 * i - 2], b = r[2 * i - 1], c = r[2 * i], d = r[2 * i + 1];
      cum[i] = cum[i - 1] + Math.hypot((c - a) * Math.cos(((b + d) / 2) * RAD), d - b);
    }
    // a small flock per route: each bird lags the leader and flies slightly to one side
    let seed = 11 + k * 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const flock = Array.from({ length: 7 }, () => ({
      lag: rand() * 0.15, side: (rand() - 0.5) * 3.4, phase: rand() * 6.28, scale: 0.85 + rand() * 0.3,
    }));
    return { ll: r, n, cum, len: cum[n - 1], v: vecs(r), flock, head: 0.05 + 0.035 * (k % 3), lead: 0 };
  });
  const at = { lon: 0, lat: 0, dlon: 0, dlat: 0, i: 0 }; // reused by along()
  const along = (rt, s) => {
    const target = s * rt.len, { cum, ll } = rt;
    let i = 1;
    while (i < rt.n - 1 && cum[i] < target) i++;
    const f = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const a = ll[2 * i - 2], b = ll[2 * i - 1], c = ll[2 * i], d = ll[2 * i + 1];
    at.lon = a + (c - a) * f; at.lat = b + (d - b) * f; at.dlon = c - a; at.dlat = d - b; at.i = i;
    return at;
  };

  const grat = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    const ll = [];
    for (let lon = -180; lon <= 180; lon += 3) ll.push(lon, lat);
    grat.push(vecs(ll));
  }
  for (let lon = -180; lon < 180; lon += 15) {
    const ll = [];
    for (let lat = -87; lat <= 87; lat += 3) ll.push(lon, lat);
    grat.push(vecs(ll));
  }

  // Satellite orbit: a great circle; t runs along the track, s across it (degrees).
  const O = D.orbit, inc = O.inc * RAD, node = O.node * RAD;
  const A = [Math.cos(node), Math.sin(node), 0];
  const B = [-Math.sin(node) * Math.cos(inc), Math.cos(node) * Math.cos(inc), Math.sin(inc)];
  const N = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const track = (out, i, t, s) => {
    t *= RAD; s *= RAD;
    const ct = Math.cos(t), st = Math.sin(t), cs = Math.cos(s), ss = Math.sin(s);
    for (let k = 0; k < 3; k++) out[i + k] = cs * (ct * A[k] + st * B[k]) + ss * N[k];
  };
  const ORBIT_N = 241;
  const orbit = new Float32Array(ORBIT_N * 3);
  for (let i = 0; i < ORBIT_N; i++) track(orbit, 3 * i, i * 1.5, 0);
  const one = new Float32Array(3); // scratch vector

  // Swath: a grid of corners shared by neighbouring pixels; pixel colours are
  // quantised so pixels of one colour can be filled together.
  const S = D.swath, cols = Math.round((2 * S.sw) / S.ds), rows = S.v.length / cols;
  const stops = [[44, 17, 95], [114, 31, 129], [183, 55, 121], [241, 96, 93], [254, 176, 120], [252, 253, 191]];
  const magma = (v) => {
    v = Math.min(0.999, Math.max(0, v)) * (stops.length - 1);
    const i = Math.floor(v), t = v - i, a = stops[i], b = stops[i + 1];
    return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * t)).join(",")})`;
  };
  const LEVELS = 24;
  const palette = Array.from({ length: LEVELS }, (_, i) => magma((i + 0.5) / LEVELS));
  const byColor = Array.from({ length: LEVELS }, () => []);
  for (let p = 0; p < S.v.length; p++) byColor[Math.min(LEVELS - 1, Math.floor((S.v[p] / 100) * LEVELS))].push(p);
  const byColorArr = byColor.map((l) => Int32Array.from(l));
  const ptr = new Int32Array(LEVELS);
  const CW = cols + 1, nCorners = (rows + 1) * CW;
  const corners = new Float32Array(nCorners * 3);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) track(corners, 3 * (r * CW + c), S.t0 + r * S.dt, -S.sw + c * S.ds);
  const SX = new Float32Array(nCorners), SY = new Float32Array(nCorners), SZ = new Float32Array(nCorners);
  // older measurements fade: alpha falls from 0.8 to 0.16 over 64° of track, in bands
  const BANDS = 12, FADE = 64, bandW = FADE / (BANDS - 1);

  // ---------------------------------------------------------------- view
  let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 0, unit = 1;
  let gAir, gOcean, gShade;
  let exx = 0, exy = 1, exz = 0, eyx = 0, eyy = 0, eyz = 1, ezx = 1, ezy = 0, ezz = 0;
  const setView = (lon0, lat0) => {
    const l = lon0 * RAD, p = lat0 * RAD, cl = Math.cos(l), sl = Math.sin(l), cp = Math.cos(p), sp = Math.sin(p);
    ezx = cp * cl; ezy = cp * sl; ezz = sp;
    exx = -sl; exy = cl; exz = 0;
    eyx = -sp * cl; eyy = -sp * sl; eyz = cp;
  };
  let PX = 0, PY = 0, PZ = 0;
  const proj = (v, i, k) => {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    PX = cx + k * R * (x * exx + y * exy + z * exz);
    PY = cy - k * R * (x * eyx + y * eyy + z * eyz);
    PZ = x * ezx + y * ezy + z * ezz;
  };
  const layout = () => {
    const r = canvas.getBoundingClientRect();
    const dev = window.devicePixelRatio || 1;
    const d = Math.min(dev, 2, Math.max(1, Math.sqrt(6.5e6 / Math.max(1, r.width * r.height))));
    if (r.width === W && r.height === H && d === dpr) return false;
    W = r.width; H = r.height; dpr = d;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (W < 760) {
      R = Math.min(W * 0.92, H * 0.5); cx = W * 0.62; cy = H * 0.6 + R * 0.92;
    } else {
      R = Math.min(H * 0.62, W * 0.42); cx = W * 0.71; cy = H * 0.64;
    }
    unit = Math.max(0.55, R / 600);
    gAir = ctx.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.13);
    gAir.addColorStop(0, "rgba(124,196,232,0)");
    gAir.addColorStop(0.12, "rgba(124,196,232,.34)");
    gAir.addColorStop(1, "rgba(124,196,232,0)");
    gOcean = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, 0, cx, cy, R * 1.05);
    gOcean.addColorStop(0, "#14325a"); gOcean.addColorStop(0.65, "#0d2340"); gOcean.addColorStop(1, "#081629");
    gShade = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.5, cx, cy, R * 1.02);
    gShade.addColorStop(0, "rgba(0,0,0,0)"); gShade.addColorStop(1, "rgba(0,0,0,.42)");
    return true;
  };

  // ---------------------------------------------------------------- drawing helpers
  // polyline through flat vectors, lifting the pen where points fall behind the limb
  const lineFront = (v, from, to, minZ) => {
    let pen = false;
    for (let i = from; i < to; i++) {
      proj(v, 3 * i, 1);
      if (PZ > minZ) { if (pen) ctx.lineTo(PX, PY); else ctx.moveTo(PX, PY); pen = true; } else pen = false;
    }
  };
  // the part of the orbit in front of (front = true) or hidden behind the Earth
  const orbitPath = (front) => {
    let pen = false;
    for (let i = 0; i < ORBIT_N; i++) {
      proj(orbit, 3 * i, O.alt);
      const dx = PX - cx, dy = PY - cy;
      const hidden = PZ < 0 && dx * dx + dy * dy < R * R;
      if (hidden !== front) { if (pen) ctx.lineTo(PX, PY); else ctx.moveTo(PX, PY); pen = true; } else pen = false;
    }
  };
  // A small bird seen from above, head along +x. `spread` (0.5–1) is how far the
  // wings reach out: it shrinks as the wings beat up and down.
  const birdPath = (spread) => {
    const ty = 9 * spread, tx = -1.6 + 1.8 * (1 - spread);
    ctx.beginPath();
    ctx.moveTo(5.6, 0);
    ctx.quadraticCurveTo(5.2, -1.3, 3.6, -1.25);
    ctx.lineTo(2.2, -1.2);
    ctx.quadraticCurveTo(1.6, -ty * 0.64, tx, -ty);
    ctx.quadraticCurveTo(-1, -ty * 0.47, -1.8, -1.1);
    ctx.lineTo(-4.6, -0.8); ctx.lineTo(-7, -1.9); ctx.lineTo(-6.2, 0);
    ctx.lineTo(-7, 1.9); ctx.lineTo(-4.6, 0.8); ctx.lineTo(-1.8, 1.1);
    ctx.quadraticCurveTo(-1, ty * 0.47, tx, ty);
    ctx.quadraticCurveTo(1.6, ty * 0.64, 2.2, 1.2);
    ctx.lineTo(3.6, 1.25);
    ctx.quadraticCurveTo(5.2, 1.3, 5.6, 0);
    ctx.closePath();
  };
  const pool = []; // bird positions, reused every frame
  let nb = 0;
  const activity = (lon, lat) => {
    let a = 0;
    const cl = Math.cos(lat * RAD);
    for (let i = 0; i < nb; i++) {
      const b = pool[i], dx = (lon - b.lon) * cl, dy = lat - b.lat;
      a += b.alpha * Math.exp(-(dx * dx + dy * dy) / 6.5);
    }
    return Math.min(1, a * 0.45);
  };

  // ---------------------------------------------------------------- frame
  const draw = (p) => {
    const e = ease(p);
    setView(lerp(50, 8, e), lerp(38, 2, e));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // a descending pass: the satellite flies south with the birds
    const tSat = lerp(44, -64, p);

    // orbit behind the Earth
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(207,227,245,.18)";
    ctx.beginPath(); orbitPath(false); ctx.stroke();
    ctx.setLineDash([]);

    // atmosphere and ocean
    ctx.fillStyle = gAir;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.13, 0, 7); ctx.fill();
    ctx.fillStyle = gOcean;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();

    // graticule
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const line of grat) lineFront(line, 0, line.length / 3, 0.02);
    ctx.stroke();

    // land: points behind the limb are pulled onto it so outlines close cleanly
    ctx.beginPath();
    for (const ring of land) {
      if (ring.mx * ezx + ring.my * ezy + ring.mz * ezz < ring.cut) continue;
      const v = ring.v, n = ring.n;
      let visible = false;
      for (let i = 0; i < n; i++) {
        const X = v[3 * i], Y = v[3 * i + 1], Z = v[3 * i + 2];
        let x = X * exx + Y * exy + Z * exz, y = X * eyx + Y * eyy + Z * eyz;
        if (X * ezx + Y * ezy + Z * ezz >= 0) visible = true;
        else { const h = Math.sqrt(x * x + y * y) || 1e-9; x /= h; y /= h; }
        scratch[2 * i] = cx + R * x; scratch[2 * i + 1] = cy - R * y;
      }
      if (!visible) continue;
      ctx.moveTo(scratch[0], scratch[1]);
      for (let i = 1; i < n; i++) ctx.lineTo(scratch[2 * i], scratch[2 * i + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = "#2c5577";
    ctx.fill();
    ctx.strokeStyle = "rgba(107,149,184,.9)";
    ctx.lineWidth = 0.7;
    ctx.lineJoin = "round";
    ctx.stroke();

    // where each bird is at this point of the scroll
    nb = 0;
    for (const rt of routes) {
      rt.lead = Math.min(1, rt.head + p * 1.04);
      for (const f of rt.flock) {
        const s = rt.lead - f.lag;
        if (s <= 0 || s >= 1) continue;
        const q = along(rt, s);
        const n = Math.hypot(q.dlon, q.dlat) || 1;
        const b = pool[nb] || (pool[nb] = {});
        nb++;
        b.lon = q.lon - (q.dlat / n) * f.side;
        b.lat = q.lat + (q.dlon / n) * f.side;
        b.dlon = q.dlon; b.dlat = q.dlat;
        b.alpha = Math.min(1, s * 25, (1 - s) * 14);
        b.scale = f.scale;
        b.flap = s * rt.len * 1.1 + f.phase;
      }
    }

    // weather radar network: cells light up as the flocks pass over them
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = "rgba(143,224,234,.5)";
    for (const c of cells) {
      const v = c.v, n = v.length / 3;
      ctx.beginPath();
      let ok = true;
      for (let i = 0; i < n; i++) {
        proj(v, 3 * i, 1);
        if (PZ < 0.02) { ok = false; break; }
        if (i) ctx.lineTo(PX, PY); else ctx.moveTo(PX, PY);
      }
      if (!ok) continue;
      ctx.closePath();
      ctx.fillStyle = `rgba(111,211,224,${(0.05 + 0.34 * activity(c.site.lon, c.site.lat)).toFixed(3)})`;
      ctx.fill();
      ctx.stroke();
    }
    ctx.lineCap = "round";
    ctx.lineWidth = 1.1;
    for (const f of flux) {
      proj(f.a, 0, 1); const ax = PX, ay = PY, az = PZ;
      proj(f.b, 0, 1); const bx = PX, by = PY, bz = PZ;
      if (az < 0.05 || bz < 0.05) continue;
      const act = activity(f.lon, f.lat);
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const ux = bx - ax, uy = by - ay, ul = Math.hypot(ux, uy) || 1;
      const L = (R / 300) * (3 + 6 * act);
      const dx = (ux / ul) * L, dy = (uy / ul) * L, hx = (ux / ul) * 4, hy = (uy / ul) * 4;
      ctx.strokeStyle = `rgba(255,255,255,${(0.12 + 0.78 * act).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(mx - dx, my - dy); ctx.lineTo(mx + dx, my + dy);
      ctx.moveTo(mx + dx - hx - hy * 0.75, my + dy - hy + hx * 0.75);
      ctx.lineTo(mx + dx, my + dy);
      ctx.lineTo(mx + dx - hx + hy * 0.75, my + dy - hy - hx * 0.75);
      ctx.stroke();
    }
    // radar stations: a radome on a short mast, with a beam arc to one side
    const legs = new Path2D(), domes = new Path2D(), beams = new Path2D();
    for (const s of sites) {
      proj(s.v, 0, 1);
      if (PZ < 0.08) continue;
      const k = unit * (0.6 + 0.4 * PZ), x = PX, y = PY - 2 * k;
      legs.moveTo(x - 2.4 * k, y + 5.4 * k); legs.lineTo(x - 0.7 * k, y + 1.6 * k);
      legs.moveTo(x + 2.4 * k, y + 5.4 * k); legs.lineTo(x + 0.7 * k, y + 1.6 * k);
      domes.moveTo(x + 2.5 * k, y); domes.arc(x, y, 2.5 * k, 0, 7);
      const r1 = 5.2 * k;
      beams.moveTo(x + r1 * Math.cos(-1.25), y + r1 * Math.sin(-1.25)); beams.arc(x, y, r1, -1.25, -0.35);
    }
    ctx.lineWidth = Math.max(0.8, unit);
    ctx.strokeStyle = "rgba(216,246,250,.8)";
    ctx.stroke(legs);
    ctx.strokeStyle = "rgba(111,211,224,.85)";
    ctx.stroke(beams);
    ctx.fillStyle = "#e6fafc";
    ctx.fill(domes);
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = "rgba(8,22,41,.8)";
    ctx.stroke(domes);

    // satellite swath: recorded up to the satellite's position; older rows fade
    for (let j = 0; j < nCorners; j++) { proj(corners, 3 * j, 1); SX[j] = PX; SY[j] = PY; SZ[j] = PZ; }
    ctx.lineWidth = 0.5;
    ptr.fill(0);
    for (let band = 0; band < BANDS; band++) {
      const age0 = band * bandW, age1 = band === BANDS - 1 ? 1e9 : (band + 1) * bandW;
      const rLo = Math.max(0, Math.ceil((tSat + age0 - S.t0) / S.dt));
      const rHi = Math.min(rows - 1, Math.ceil((tSat + age1 - S.t0) / S.dt) - 1);
      if (rLo > rHi) continue;
      ctx.globalAlpha = 0.8 * Math.max(0.2, 1 - Math.min(FADE, (band + 0.5) * bandW) / 80);
      for (let ci = 0; ci < LEVELS; ci++) {
        const list = byColorArr[ci];
        let k = ptr[ci], added = false;
        while (k < list.length && ((list[k] / cols) | 0) < rLo) k++;
        ctx.beginPath();
        for (; k < list.length; k++) {
          const px = list[k], r = (px / cols) | 0;
          if (r > rHi) break;
          const i00 = r * CW + (px - r * cols), i10 = i00 + CW, i11 = i10 + 1, i01 = i00 + 1;
          if (SZ[i00] < 0.03 || SZ[i10] < 0.03 || SZ[i11] < 0.03 || SZ[i01] < 0.03) continue;
          ctx.moveTo(SX[i00], SY[i00]); ctx.lineTo(SX[i10], SY[i10]);
          ctx.lineTo(SX[i11], SY[i11]); ctx.lineTo(SX[i01], SY[i01]); ctx.closePath();
          added = true;
        }
        ptr[ci] = k;
        if (added) { ctx.fillStyle = ctx.strokeStyle = palette[ci]; ctx.fill(); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;

    // migration routes: the stretch already flown is brighter than the part ahead
    ctx.lineWidth = Math.max(1.2, R / 260);
    ctx.setLineDash([2, 5]);
    for (const rt of routes) {
      const cut = along(rt, clamp01(rt.lead)).i, n = rt.n;
      ctx.strokeStyle = "rgba(242,179,80,.75)";
      ctx.beginPath(); lineFront(rt.v, 0, cut, 0.02); ctx.stroke();
      ctx.strokeStyle = "rgba(242,179,80,.16)";
      ctx.beginPath(); lineFront(rt.v, Math.max(0, cut - 1), n, 0.02); ctx.stroke();
    }
    ctx.setLineDash([]);

    // the birds, seen from above; the wings beat as they travel, and each bird
    // casts a faint shadow on the ground below it
    for (let i = 0; i < nb; i++) {
      const b = pool[i];
      put(one, 0, b.lon, b.lat); proj(one, 0, 1);
      if (PZ < 0.03) continue;
      const x = PX, y = PY, z = PZ;
      put(one, 0, b.lon + b.dlon * 0.05, b.lat + b.dlat * 0.05); proj(one, 0, 1);
      const ang = Math.atan2(PY - y, PX - x);
      const spread = 0.5 + 0.5 * (0.5 + 0.5 * Math.cos(b.flap));
      const k = unit * b.scale * (0.55 + 0.45 * z);
      const c = Math.cos(ang) * k, s = Math.sin(ang) * k;
      ctx.globalAlpha = b.alpha;
      ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * (x + 1.8 * k), dpr * (y + 2.8 * k));
      birdPath(spread); ctx.fillStyle = "rgba(3,10,22,.38)"; ctx.fill();
      ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * x, dpr * y);
      birdPath(spread); ctx.fillStyle = "#f6c97a"; ctx.fill();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    // limb darkening
    ctx.fillStyle = gShade;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.restore();

    // satellite, its field of view and the front of its orbit
    track(one, 0, tSat, 0); proj(one, 0, O.alt);
    const sx = PX, sy = PY, sdx = sx - cx, sdy = sy - cy;
    const satVisible = PZ >= 0 || sdx * sdx + sdy * sdy > R * R;
    track(one, 0, tSat, -S.sw); proj(one, 0, 1); const lx = PX, ly = PY, lz = PZ;
    track(one, 0, tSat, S.sw); proj(one, 0, 1); const rx = PX, ry = PY, rz = PZ;
    if (satVisible && lz > 0.03 && rz > 0.03) {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.strokeStyle = "rgba(255,255,255,.25)";
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(lx, ly); ctx.lineTo(rx, ry); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(207,227,245,.55)";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); orbitPath(true); ctx.stroke();
    if (satVisible) {
      track(one, 0, tSat - 4, 0); proj(one, 0, O.alt);
      const k = Math.max(0.8, R / 330), a = Math.atan2(PY - sy, PX - sx), c = Math.cos(a) * k, s = Math.sin(a) * k;
      ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * sx, dpr * sy);
      ctx.fillStyle = "#4f86c6"; ctx.strokeStyle = "#cfe3f5"; ctx.lineWidth = 0.6;
      ctx.fillRect(-5, -25, 10, 17); ctx.strokeRect(-5, -25, 10, 17);
      ctx.fillRect(-5, 8, 10, 17); ctx.strokeRect(-5, 8, 10, 17);
      ctx.fillStyle = "#e8eef5";
      ctx.fillRect(-6, -5, 12, 10);
      ctx.fillRect(-0.75, -8, 1.5, 3); ctx.fillRect(-0.75, 5, 1.5, 3);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  // ---------------------------------------------------------------- scroll
  let target = 0, current = 0, drawn = -1, raf = 0, last = 0, shown = "";
  const render = (p) => {
    draw(p);
    drawn = p;
    const ps = p.toFixed(3);
    if (ps !== shown) { stage.style.setProperty("--p", ps); shown = ps; }
  };
  const readScroll = () => {
    const r = hero.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    target = span > 0 ? clamp01(-r.top / span) : 0;
  };
  // ease towards the scroll position by elapsed time (time constant 0.12 s)
  const tick = (now) => {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    current += (target - current) * (1 - Math.exp(-dt / 0.12));
    if (Math.abs(target - current) < 0.0004) current = target;
    if (current !== drawn) render(current);
    if (current !== target) raf = requestAnimationFrame(tick);
    else last = 0;
  };
  const onScroll = () => {
    readScroll();
    if (target !== current && !raf) raf = requestAnimationFrame(tick);
  };

  layout();
  if (still) {
    current = target = fixed !== null ? fixed : 0.55;
  } else {
    document.documentElement.classList.add("globe-scroll");
    readScroll();
    current = target;
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  render(current);
  window.addEventListener("resize", () => {
    if (layout()) {
      if (!still) { readScroll(); current = target; }
      render(current);
    } else if (!still) onScroll();
  });
})();
