// Task-completion celebration.
//
// 1. lift  — a clone of the card flies to the centre of the window and grows.
// 2. seal  — a magic circle (procedural SVG: rings, petals, cross, nodes and a
//            band of irregular glyph blobs) bursts out from the card's centre
//            behind it, spins one full turn while its glow builds up, then
//            collapses to 1/5 of its size.
// 3. burst — as the collapse ends the card shatters (in brief slow motion)
//            into ~100 Voronoi shards cut from a raster snapshot of the card.
//            About 40% become translucent crystal butterflies that flutter off
//            along irregular, curving paths; the rest dissolve into glints.
//            Everything fades out quickly.
//
// Everything stays translucent: the page behind is only lightly dimmed (no
// blur), the circle and butterflies are drawn additively in dark mode.
// Shards and butterflies are pre-rendered sprites blitted on one canvas, so
// a frame is ~100 drawImage calls — cheap on any GPU. Click to skip.
const CompleteFX = (() => {
  const T = {
    lift: 450,        // card flies to centre
    appear: 250,      // circle grows from a point
    spin: 1200,       // one full turn while brightening (0.75x speed)
    contract: 380,    // circle collapses to 1/5 size, then the card breaks
    morph: 200,       // shard -> butterfly
    fly: 1500,        // butterflies flutter outward (includes morph) — leisurely
    fade: 250,        // quick fade-out
  };
  const SHARDS = 100;
  const BUTTERFLY_SHARE = 0.4; // the other shards dissolve into glints
  // Bullet-time at the shatter: the burst runs at SLOW_RATE for SLOW_HOLD ms
  // (real time), then eases back to full speed over SLOW_RAMP ms.
  const SLOW_RATE = 0.12, SLOW_HOLD = 220, SLOW_RAMP = 280;
  // real ms since the burst -> animation ms since the burst
  function warp(x) {
    if (x <= 0) return x;
    if (x < SLOW_HOLD) return SLOW_RATE * x;
    const u = x - SLOW_HOLD;
    const base = SLOW_RATE * SLOW_HOLD;
    if (u < SLOW_RAMP) return base + SLOW_RATE * u + (1 - SLOW_RATE) * u * u / (2 * SLOW_RAMP);
    return base + (SLOW_RATE + 1) / 2 * SLOW_RAMP + (u - SLOW_RAMP);
  }
  const SLOW_LOST = SLOW_HOLD + SLOW_RAMP - warp(SLOW_HOLD + SLOW_RAMP); // extra real ms the slow-mo adds
  let busy = false;
  let cssText = null;

  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutBack = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const clamp01 = (t) => Math.max(0, Math.min(1, t));

  // ---------- Magic circle (SVG, viewBox -100..100) ----------

  function polar(r, a) { return [r * Math.cos(a), r * Math.sin(a)]; }
  const f = (n) => n.toFixed(2);

  // An irregular rounded blob outline — the "glyphs" on the outer band are
  // just these, no real writing.
  function blobPath(cx, cy, rx, ry, rot) {
    const n = 7 + Math.floor(Math.random() * 4);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const k = rand(0.55, 1.15);
      const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
      pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    // closed Catmull-Rom -> cubic Bézier, so the lumps are smooth
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ` +
           `${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return d + 'Z';
  }

  function glyphBand(r, h) {
    let d = '';
    let a = 0;
    while (a < Math.PI * 2 - 0.05) {
      const w = rand(2.2, 5.5);             // blob width along the ring (units)
      const da = w / r;
      const [x, y] = polar(r + rand(-0.6, 0.6), a + da / 2);
      d += blobPath(x, y, w / 2, h / 2 * rand(0.75, 1), a + da / 2 + Math.PI / 2);
      a += da + (Math.random() < 0.18 ? rand(0.05, 0.1) : rand(0.012, 0.03)); // words and letters
    }
    return d;
  }

  // Lens ("vesica") pointing from r0 to r1 along angle a, half-width w.
  function lens(r0, r1, w, a) {
    const L = (r1 - r0) / 2;
    const R = (L * L + w * w) / (2 * w);    // arc radius through tips and widest point
    const [x0, y0] = polar(r0, a), [x1, y1] = polar(r1, a);
    return `M${f(x0)},${f(y0)}A${f(R)},${f(R)} 0 0 1 ${f(x1)},${f(y1)}A${f(R)},${f(R)} 0 0 1 ${f(x0)},${f(y0)}Z`;
  }

  function ringPath(r) {
    return `M${f(r)},0A${f(r)},${f(r)} 0 1 1 ${f(-r)},0A${f(r)},${f(r)} 0 1 1 ${f(r)},0Z`;
  }

  function diamonds(cx, cy, sizes) {
    return sizes.map((s) => `M${f(cx)},${f(cy - s)}L${f(cx + s)},${f(cy)}L${f(cx)},${f(cy + s)}L${f(cx - s)},${f(cy)}Z`).join('');
  }

  function node(cx, cy, kind) {
    const circ = (r) => `M${f(cx + r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx - r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx + r)},${f(cy)}Z`;
    let out = circ(12) + circ(9.5);
    if (kind === 'eye') {
      out += circ(7.2) + diamonds(cx, cy, [5.2, 3.6, 2.0]);
      for (let i = 0; i < 20; i++) {          // tick ring
        const a = (i / 20) * Math.PI * 2;
        out += `M${f(cx + Math.cos(a) * 7.4)},${f(cy + Math.sin(a) * 7.4)}L${f(cx + Math.cos(a) * 9.1)},${f(cy + Math.sin(a) * 9.1)}`;
      }
    } else {
      out += circ(6.5);
    }
    return out;
  }

  function buildCircleSvg() {
    const inner = [];
    // outer frame
    inner.push(ringPath(98), ringPath(96.2), ringPath(84.5), ringPath(83));
    // four petals on the diagonals, three nested outlines each
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2;
      inner.push(lens(8, 82, 26, a), lens(12, 78, 22, a), lens(16, 74, 18, a));
    }
    // cross on the axes: double bars + trapezoid caps
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      const c = Math.cos(a), s = Math.sin(a);
      const P = (along, across) => [along * c - across * s, along * s + across * c];
      const bar = (w) => { const p1 = P(14, -w), p2 = P(62, -w), p3 = P(62, w), p4 = P(14, w);
        return `M${f(p1[0])},${f(p1[1])}L${f(p2[0])},${f(p2[1])}M${f(p3[0])},${f(p3[1])}L${f(p4[0])},${f(p4[1])}`; };
      inner.push(bar(5), bar(3));
      const t = [P(64, -7), P(78, -13), P(78, 13), P(64, 7)];
      inner.push(`M${t.map((p) => f(p[0]) + ',' + f(p[1])).join('L')}Z`);
      const t2 = [P(67, -4.5), P(75, -8.5), P(75, 8.5), P(67, 4.5)];
      inner.push(`M${t2.map((p) => f(p[0]) + ',' + f(p[1])).join('L')}Z`);
    }
    // small triangles between petals and cross (outer + inner outline)
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) * Math.PI / 4;
      const tri = (r0, r1, spread) => {
        const p = [polar(r1, a - spread), polar(r1, a + spread), polar(r0, a)];
        return `M${p.map((q) => f(q[0]) + ',' + f(q[1])).join('L')}Z`;
      };
      inner.push(tri(68, 80, 0.07), tri(71, 78, 0.04));
    }
    // six nodes + centre
    const nodes = [
      [Math.PI * 1.25, 46, 'plain'], [Math.PI * 1.75, 46, 'eye'],
      [Math.PI, 50, 'eye'], [0, 50, 'plain'],
      [Math.PI * 0.75, 46, 'plain'], [Math.PI * 0.25, 46, 'eye'],
    ];
    nodes.forEach(([a, r, kind]) => { const [x, y] = polar(r, a); inner.push(node(x, y, kind)); });
    inner.push(node(0, 0, 'eye'));

    const main = inner.join('');
    const glyphs = glyphBand(90.3, 6.2);
    // inner "handwriting" arcs between the frame and the petals
    let scribble = '';
    for (let k = 0; k < 4; k++) {
      let a = k * Math.PI / 2 + 0.22;
      const end = a + Math.PI / 2 - 0.44;
      while (a < end) {
        const w = rand(1.2, 3.2), da = w / 78;
        const [x, y] = polar(78.5, a + da / 2);
        scribble += blobPath(x, y, w / 2, rand(1.4, 2.4), a + Math.PI / 2);
        a += da + rand(0.008, 0.03);
      }
    }
    return { main, glyphs, scribble };
  }

  function makeCircleEl(size) {
    const { main, glyphs, scribble } = buildCircleSvg();
    const dark = isDark();
    const stroke = '#8feeff'; // same cyan in both themes
    const glow = '#3fd4ff';
    const wrap = document.createElement('div');
    wrap.className = 'complete-circle';
    wrap.style.width = wrap.style.height = size + 'px';
    const layer = (cls, d, sw, color, extra = '') =>
      `<svg class="${cls}" viewBox="-100 -100 200 200" width="${size}" height="${size}" ${extra}>` +
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
    // two rotating groups: body (petals/cross/nodes/scribbles) and the outer
    // glyph band, which counter-rotates. Each has a crisp layer and a blurred
    // glow twin (static raster, so rotating it is compositor-only).
    wrap.innerHTML =
      `<div class="cc-rot cc-body">${layer('cc-glow', main + scribble, 2.6, glow)}${layer('cc-line', main + scribble, 0.55, stroke)}</div>` +
      `<div class="cc-rot cc-band">${layer('cc-glow', glyphs, 2.2, glow)}${layer('cc-line', glyphs, 0.5, stroke)}</div>`;
    wrap.classList.toggle('dark', dark);
    return wrap;
  }

  // ---------- Card snapshot (for the shards) ----------

  async function loadCss() {
    if (cssText !== null) return cssText;
    try { cssText = await (await fetch('styles.css')).text(); } catch { cssText = ''; }
    return cssText;
  }

  async function snapshotCard(card, w, h, scale) {
    const css = await loadCss();
    const clone = card.cloneNode(true);
    clone.style.cssText += `;margin:0;transform:none;transition:none;animation:none;width:${w}px;height:${h}px;box-sizing:border-box;`;
    const markup = new XMLSerializer().serializeToString(clone);
    const theme = isDark() ? 'dark' : 'light';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}" width="${Math.ceil(w * scale)}" height="${Math.ceil(h * scale)}" viewBox="0 0 ${w} ${h}">` +
      `<style><![CDATA[${css.replace(/]]>/g, '')} body{margin:0;background:none}]]></style>` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    return img;
  }

  // ---------- Voronoi shards ----------

  // Cells of a jittered-grid Voronoi diagram over [0,w]x[0,h], by clipping
  // the rectangle against the bisector half-plane of every other seed.
  function voronoi(w, h, count) {
    const cols = Math.max(2, Math.round(Math.sqrt(count * w / h)));
    const rows = Math.max(2, Math.round(count / cols));
    const seeds = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      seeds.push([(c + rand(0.1, 0.9)) * w / cols, (r + rand(0.1, 0.9)) * h / rows]);
    }
    return seeds.map((s, i) => {
      let poly = [[0, 0], [w, 0], [w, h], [0, h]];
      for (let j = 0; j < seeds.length && poly.length; j++) {
        if (j === i) continue;
        const o = seeds[j];
        const nx = o[0] - s[0], ny = o[1] - s[1];
        const c = (nx * (o[0] + s[0]) + ny * (o[1] + s[1])) / 2; // keep n·p <= c
        const out = [];
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], q = poly[(k + 1) % poly.length];
          const dp = nx * p[0] + ny * p[1] - c, dq = nx * q[0] + ny * q[1] - c;
          if (dp <= 0) out.push(p);
          if ((dp < 0) !== (dq < 0) && dp !== dq) {
            const t = dp / (dp - dq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
          }
        }
        poly = out;
      }
      return { seed: s, poly };
    }).filter((c) => c.poly.length >= 3);
  }

  function renderShard(cell, img, w, h, dpr, dark) {
    const xs = cell.poly.map((p) => p[0]), ys = cell.poly.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)) - 2, y0 = Math.floor(Math.min(...ys)) - 2;
    const x1 = Math.ceil(Math.max(...xs)) + 2, y1 = Math.ceil(Math.max(...ys)) + 2;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil((x1 - x0) * dpr));
    cv.height = Math.max(1, Math.ceil((y1 - y0) * dpr));
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.translate(-x0, -y0);
    g.beginPath();
    cell.poly.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath();
    g.save();
    g.clip();
    if (img) g.drawImage(img, 0, 0, w, h);
    else { g.fillStyle = dark ? 'rgba(60,70,120,0.6)' : 'rgba(255,255,255,0.6)'; g.fillRect(0, 0, w, h); }
    // the card is at peak glow when it breaks
    g.fillStyle = 'rgba(140,235,255,0.28)';
    g.fillRect(0, 0, w, h);
    g.restore();
    g.strokeStyle = 'rgba(190,245,255,0.95)';
    g.lineWidth = 1.1;
    g.stroke();
    return { cv, ox: x0, oy: y0, cw: x1 - x0, ch: y1 - y0 };
  }

  // ---------- Butterfly sprite (one right wing; mirrored for the left) ----------

  function makeWingSprite(tint, dark) {
    const S = 96, dpr = 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    // body axis at x = 8, head toward y = 0; wing spans to the right
    const bx = 8;
    const fore = new Path2D();
    // swept-back, pointed forewing (crystal-butterfly silhouette, not a petal)
    fore.moveTo(bx, 40);
    fore.bezierCurveTo(bx + 18, 22, bx + 50, 6, bx + 84, 2);
    fore.bezierCurveTo(bx + 74, 16, bx + 64, 32, bx + 44, 44);
    fore.bezierCurveTo(bx + 26, 50, bx + 10, 48, bx, 44);
    fore.closePath();
    const hind = new Path2D();
    hind.moveTo(bx, 46);
    hind.bezierCurveTo(bx + 24, 46, bx + 50, 52, bx + 46, 68);
    hind.bezierCurveTo(bx + 42, 80, bx + 26, 92, bx + 14, 90); // trailing tail point
    hind.bezierCurveTo(bx + 14, 80, bx + 8, 72, bx + 6, 64);
    hind.bezierCurveTo(bx + 4, 68, bx, 56, bx, 48);
    hind.closePath();

    const grad = g.createLinearGradient(bx, 20, bx + 76, 70);
    grad.addColorStop(0, `rgba(${tint.join(',')},${dark ? 0.55 : 0.6})`);
    grad.addColorStop(0.6, `rgba(${tint.map((c) => Math.min(255, c + 60)).join(',')},${dark ? 0.32 : 0.4})`);
    grad.addColorStop(1, `rgba(255,255,255,${dark ? 0.45 : 0.5})`);
    const edge = dark ? 'rgba(220,250,255,0.95)' : `rgba(${tint.map((c) => c * 0.55 | 0).join(',')},0.9)`;

    g.shadowColor = `rgba(${tint.join(',')},0.9)`;
    g.shadowBlur = 10;
    g.fillStyle = grad;
    g.fill(fore);
    g.fill(hind);
    g.shadowBlur = 0;
    g.strokeStyle = edge;
    g.lineWidth = 1.3;
    g.stroke(fore);
    g.stroke(hind);
    // veins
    g.lineWidth = 0.6;
    g.strokeStyle = dark ? 'rgba(230,252,255,0.55)' : `rgba(${tint.map((c) => c * 0.6 | 0).join(',')},0.45)`;
    [[bx + 78, 5], [bx + 64, 26], [bx + 42, 42]].forEach(([x, y]) => { g.beginPath(); g.moveTo(bx, 42); g.quadraticCurveTo(bx + 24, 26, x, y); g.stroke(); });
    [[bx + 40, 68], [bx + 18, 86]].forEach(([x, y]) => { g.beginPath(); g.moveTo(bx, 48); g.quadraticCurveTo(bx + 18, 58, x, y); g.stroke(); });
    // facet highlight — the "crystal" glint
    g.globalCompositeOperation = 'source-atop';
    const hl = g.createLinearGradient(bx + 10, 0, bx + 50, 50);
    hl.addColorStop(0.35, 'rgba(255,255,255,0)');
    hl.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    hl.addColorStop(0.62, 'rgba(255,255,255,0)');
    g.fillStyle = hl;
    g.fillRect(0, 0, S, S);
    return { cv, S, bx };
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }

  // ---------- Timeline ----------

  async function play(card, { accent } = {}) {
    if (busy) return false;
    busy = true;
    const dark = isDark();
    const W = innerWidth, H = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = card.getBoundingClientRect();
    const scale = Math.min(1.6, (W * 0.62) / r.width, (H * 0.45) / r.height);
    const cw = r.width * scale, ch = r.height * scale;
    const cx = W / 2, cy = H / 2;

    // snapshot in parallel with the lift (needed only at the burst)
    const snapPromise = snapshotCard(card, r.width, r.height, scale * dpr).catch(() => null);

    const overlay = document.createElement('div');
    overlay.className = 'complete-overlay';
    overlay.title = '點一下跳過';
    const dim = document.createElement('div');
    dim.className = 'complete-dim' + (dark ? ' dark' : '');
    overlay.appendChild(dim);

    const circleSize = Math.min(Math.max(cw, ch) * 1.45, Math.min(W, H) * 0.92);
    const circle = makeCircleEl(circleSize);
    circle.style.left = (cx - circleSize / 2) + 'px';
    circle.style.top = (cy - circleSize / 2) + 'px';
    overlay.appendChild(circle);

    const clone = card.cloneNode(true);
    clone.classList.add('complete-clone');
    clone.style.left = r.left + 'px';
    clone.style.top = r.top + 'px';
    clone.style.width = r.width + 'px';
    clone.style.height = r.height + 'px';
    const flare = document.createElement('div');
    flare.className = 'complete-flare dark'; // cyan glow in both themes
    clone.appendChild(flare);
    overlay.appendChild(clone);

    const canvas = document.createElement('canvas');
    canvas.className = 'complete-canvas';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    card.style.visibility = 'hidden';

    const tint = hexToRgb(accent);
    const baseTint = [90, 220, 255]; // same crystal cyan in both themes
    const mixTint = tint ? baseTint.map((c, i) => Math.round(c * 0.7 + tint[i] * 0.3)) : baseTint;
    const wings = [makeWingSprite(baseTint, true), makeWingSprite(mixTint, true)];
    const glint = document.createElement('canvas');
    glint.width = glint.height = 28;
    {
      const gg = glint.getContext('2d');
      const rg = gg.createRadialGradient(14, 14, 0, 14, 14, 14);
      rg.addColorStop(0, 'rgba(235,255,255,1)');
      rg.addColorStop(0.35, `rgba(${baseTint.join(',')},0.6)`);
      rg.addColorStop(1, `rgba(${baseTint.join(',')},0)`);
      gg.fillStyle = rg;
      gg.fillRect(0, 0, 28, 28);
    }

    const tContract = T.lift + T.appear + T.spin;
    const tBurst = tContract + T.contract;
    const tEnd = tBurst + T.fly + T.fade + SLOW_LOST; // real time
    const g = canvas.getContext('2d');

    let shards = null;
    const prepareShards = (img) => {
      const cells = voronoi(r.width, r.height, SHARDS);
      shards = cells.map((cell) => {
        const spr = renderShard(cell, img, r.width, r.height, scale * dpr, dark);
        // centre of the shard in card coordinates -> screen
        const sx = cell.seed[0], sy = cell.seed[1];
        const px = cx - cw / 2 + sx * scale, py = cy - ch / 2 + sy * scale;
        const fly = Math.random() < BUTTERFLY_SHARE;
        const k = Math.min(1.4, Math.max(0.8, cw / 380));
        return {
          spr, sx, sy, px, py, fly,
          // irregular flight: random start direction, a slow random turn and
          // a sinuous weave, with a burst of speed that settles into a glide
          x: px, y: py, lastLt: 0,
          dir: fly ? rand(0, Math.PI * 2) : Math.atan2(py - cy, px - cx) + rand(-0.6, 0.6),
          turn: rand(-0.0016, 0.0016),
          weaveAmp: rand(0.3, 0.8), weaveRate: rand(0.004, 0.008), weavePhase: rand(0, Math.PI * 2),
          v0: (fly ? rand(0.18, 0.45) : rand(0.08, 0.2)) * k, vMin: rand(0.06, 0.13) * k,
          spin: rand(-0.012, 0.012),
          wing: wings[Math.random() < 0.5 ? 0 : 1],
          size: rand(0.28, 0.6) * Math.min(1.4, Math.max(0.8, cw / 380)),
          flapRate: rand(0.011, 0.018), flapPhase: rand(0, Math.PI * 2),
          delay: rand(0, 60),
        };
      });
    };

    return new Promise((resolve) => {
      let t0 = null, finished = false, circleGone = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        overlay.remove();
        card.style.visibility = '';
        busy = false;
        resolve(true);
      };
      overlay.addEventListener('click', finish);
      const watchdog = setTimeout(finish, tEnd + 2500);

      const place = (el, t) => {
        const k = easeOutCubic(t);
        const x = r.left + (cx - cw / 2 - r.left) * k;
        const y = r.top + (cy - ch / 2 - r.top) * k;
        const s = 1 + (scale - 1) * k;
        el.style.transform = `translate(${x - r.left}px, ${y - r.top}px) scale(${s})`;
      };

      const frame = (now) => {
        if (finished) return;
        if (t0 === null) t0 = now;
        const t = now - t0;
        const tb = t >= tBurst ? warp(t - tBurst) : 0; // animation time since the burst (slowed at first)

        // 1. lift
        dim.style.opacity = String(Math.min(1, t / T.lift) * (t < tBurst ? 1 : Math.max(0, 1 - tb / (T.fly + T.fade))));
        if (t < tBurst) place(clone, clamp01(t / T.lift));

        // 2 + 3. circle: grow, then spin one turn while brightening
        const tc = t - T.lift;
        if (tc >= 0 && !circleGone) {
          const grow = easeOutBack(clamp01(tc / T.appear));
          const spinT = clamp01((tc - T.appear) / T.spin);
          const turn = easeInOut(spinT) * 360;
          const bright = Math.pow(spinT, 1.6);
          let op = 0.4 + 0.6 * bright;
          let s = Math.max(0.001, grow);
          if (t >= tContract) { // gathers in: accelerating collapse to 1/5 size
            const k = clamp01((t - tContract) / T.contract);
            s = 1 - 0.8 * k * k * k;
          }
          if (t >= tBurst) { // released with the shatter: flashes outward and dissolves
            const k = clamp01(tb / 260);
            s = 0.2 + 0.35 * easeOutCubic(k);
            op = 1 - k;
            if (k >= 1) { circleGone = true; circle.remove(); }
          }
          circle.style.opacity = String(Math.min(1, clamp01(tc / 80)) * op);
          circle.style.transform = `scale(${s})`;
          circle.querySelector('.cc-body').style.transform = `rotate(${turn}deg)`;
          circle.querySelector('.cc-band').style.transform = `rotate(${-turn * 0.6}deg)`;
          circle.querySelectorAll('.cc-glow').forEach((el) => { el.style.opacity = String(0.15 + 0.85 * bright); });
          if (t < tBurst) flare.style.opacity = String(bright * 0.85);
        }

        // 4. burst
        if (t >= tBurst && clone.isConnected) {
          if (!shards) { finishWhenReady(); return; }
          clone.remove();
        }
        if (shards && t >= tBurst) drawParticles(tb);

        if (t >= tEnd) { finish(); return; }
        requestAnimationFrame(frame);
      };

      // The snapshot is almost always ready long before the burst; if it
      // isn't, hold on the peak until it is (bounded by the watchdog).
      const finishWhenReady = () => {
        snapPromise.then((img) => {
          if (!shards) prepareShards(img);
          t0 = performance.now() - tBurst;
          requestAnimationFrame(frame);
        });
      };
      snapPromise.then((img) => { if (!shards) prepareShards(img); });

      // Integrates a particle's path from its last position up to lt (animation
      // ms), in small steps so the curve doesn't depend on the frame rate.
      const advance = (p, lt) => {
        while (p.lastLt < lt) {
          const dt = Math.min(8, lt - p.lastLt);
          const tm = p.lastLt + dt / 2;
          const ang = p.dir + p.turn * tm + p.weaveAmp * Math.sin(tm * p.weaveRate + p.weavePhase);
          const v = p.v0 * Math.exp(-tm / 800) + (p.fly ? p.vMin : 0);
          p.x += Math.cos(ang) * v * dt;
          p.y += Math.sin(ang) * v * dt - (p.fly ? 0.012 * dt : 0); // a slight upward drift
          p.heading = ang;
          p.lastLt += dt;
        }
        if (p.heading === undefined) p.heading = p.dir;
      };

      const drawParticles = (tb) => {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        const fadeStart = T.fly;
        for (const p of shards) {
          const lt = Math.max(0, tb - p.delay);
          advance(p, lt);
          const { x, y } = p;
          const alpha = tb < fadeStart ? 1 : Math.max(0, 1 - (tb - fadeStart) / T.fade);
          if (alpha <= 0) continue;
          const m = clamp01(lt / T.morph); // 0 = shard, 1 = butterfly (or gone)

          if (m < 1) { // shard: spins, shrinks and fades as the butterfly takes over
            const sprite = p.spr;
            g.globalAlpha = alpha * (1 - easeOutCubic(m));
            const s = scale * (1 - (p.fly ? 0.55 : 0.8) * m);
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.translate(x, y);
            g.rotate(p.spin * lt);
            g.scale(s, s);
            g.drawImage(sprite.cv, sprite.ox - p.sx, sprite.oy - p.sy, sprite.cw, sprite.ch);
          }
          if (!p.fly) { // leftover shard ends as a brief glint
            const gl = m > 0.4 ? Math.max(0, 1 - (lt - T.morph * 0.4) / 380) : 0;
            if (gl > 0) {
              g.setTransform(dpr, 0, 0, dpr, 0, 0);
              g.globalAlpha = alpha * gl * 0.9;
              g.drawImage(glint, x - 7, y - 7, 14, 14);
            }
            continue;
          }
          if (m > 0) {
            const heading = p.heading + Math.PI / 2; // sprite's head points to -y
            const flap = 0.18 + 0.82 * Math.abs(Math.cos(lt * p.flapRate + p.flapPhase));
            const s = p.size * easeOutBack(m);
            const w = p.wing;
            g.globalAlpha = alpha * Math.min(1, m * 1.6);
            for (const side of [1, -1]) {
              g.setTransform(dpr, 0, 0, dpr, 0, 0);
              g.translate(x, y);
              g.rotate(heading);
              g.scale(s * flap * side, s);
              g.drawImage(w.cv, -w.bx, -w.S / 2, w.S, w.S);
            }
          }
        }
        g.globalAlpha = 1;
      };

      requestAnimationFrame(frame);
    });
  }

  loadCss();
  return { play, get busy() { return busy; } };
})();
