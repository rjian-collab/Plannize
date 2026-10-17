// Cloth / Genie-style "sucked into the button" panel animation.
//
// macOS does this with a private mesh transform (CAMeshTransform): the
// window is a grid of vertices, the leading edge funnels into the Dock icon
// while the trailing edge holds, then everything slides through. clip-path
// can only cut an outline (which is why the earlier attempt looked torn),
// so this rasterizes the panel to a bitmap and draws it as a warped WebGL
// mesh instead, generalized so the panel CORNER nearest the button leads,
// plus smooth fan-shaped pleats + lighting so it gathers like fabric.
const ClothFX = (() => {
  const GX = 56, GY = 56; // dense enough that the fold waves don't alias into blotches
  const VERTS = (GX + 1) * (GY + 1);
  const DELAY = 0.45;   // far corner starts moving at 45% — Genie's overlapping phases
  const DRIFT = 0.12;   // whole cloth slides slightly from the start, so nothing looks pinned
  const PLEATS = 6;     // folds across the panel's angular width, as seen from the button
  const FOCAL = 1400;   // mild perspective for the fold depth
  const LIGHT = normalize3(-0.35, -0.55, 1);
  const DURATION = { close: 650, open: 700 };
  // Jelly settle at the end of an open: kicks in when the unfold is ~80%
  // done, swells past full size and springs back with a damped wobble.
  const JELLY = {
    start: 0.8,    // fraction of the open's main motion when the wobble begins
    amp: 0.05,     // peak overshoot (5%)
    lag: 0.9,      // rad phase lag of the trailing axis — the out-of-phase wobble
    period: 230,   // ms per oscillation
    decay: 150,    // ms e-folding time of the damping
    ripple: 90,    // ms delay across the panel, so it jiggles instead of pulsing rigidly
    settle: 450,   // ms after the last vertex starts before swapping to the real panel
  };
  const SNAPSHOT_TIMEOUT = 350; // ms; past this, fall back rather than keep the user waiting
  const WATCHDOG_SLACK = 400;   // ms beyond the animation's length before forcing it to finish

  let canvas = null, gl = null, prog = null, loc = null;
  let bufPos = null, bufUV = null, bufShade = null, bufIdx = null, idxCount = 0;
  const pos2 = new Float32Array(VERTS * 2);
  const shade = new Float32Array(VERTS);
  const X = new Float32Array(VERTS), Y = new Float32Array(VERTS), Z = new Float32Array(VERTS);
  let cssText = null;
  let current = null;

  function normalize3(x, y, z) { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a, b, v) => { const s = clamp01((v - a) / (b - a)); return s * s * (3 - 2 * s); };
  const easeInOutQuad = (s) => (s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2);

  // ---------- WebGL setup ----------

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function initGL() {
    if (gl) return true;
    canvas = document.createElement('canvas');
    canvas.className = 'cloth-canvas';
    document.body.appendChild(canvas);
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) { canvas.remove(); canvas = null; return false; }
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, `
        attribute vec2 aPos; attribute vec2 aUV; attribute float aShade;
        uniform vec2 uRes;
        varying vec2 vUV; varying float vShade;
        void main() {
          vec2 c = aPos / uRes * 2.0 - 1.0;
          gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
          vUV = aUV; vShade = aShade;
        }`));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D uTex; uniform float uAlpha;
        varying vec2 vUV; varying float vShade;
        void main() {
          vec4 c = texture2D(uTex, vUV); // premultiplied
          float lit = min(vShade, 1.0);
          float hi = max(vShade - 1.0, 0.0);
          c.rgb = c.rgb * lit + vec3(hi) * c.a; // fold shadows darken, crests catch a little light
          gl_FragColor = c * uAlpha;
        }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      console.warn('ClothFX shader setup failed:', e);
      gl = null; canvas.remove(); canvas = null;
      return false;
    }
    loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      aShade: gl.getAttribLocation(prog, 'aShade'),
      uRes: gl.getUniformLocation(prog, 'uRes'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
    };

    const uv = new Float32Array(VERTS * 2);
    for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) {
      const k = j * (GX + 1) + i;
      uv[2 * k] = i / GX; uv[2 * k + 1] = j / GY;
    }
    const idx = new Uint16Array(GX * GY * 6);
    let n = 0;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const a = j * (GX + 1) + i, b = a + 1, c = a + GX + 1, d = c + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = c;
      idx[n++] = b; idx[n++] = d; idx[n++] = c;
    }
    idxCount = n;
    bufUV = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufUV); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    bufPos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.bufferData(gl.ARRAY_BUFFER, pos2.byteLength, gl.DYNAMIC_DRAW);
    bufShade = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufShade); gl.bufferData(gl.ARRAY_BUFFER, shade.byteLength, gl.DYNAMIC_DRAW);
    bufIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    return true;
  }

  // ---------- Snapshot: DOM -> bitmap via SVG <foreignObject> ----------
  // A clone (not a screen capture) so it works for a panel that isn't
  // visible yet (opening) as well as one that is (closing).

  async function loadCss() {
    if (cssText !== null) return cssText;
    try { cssText = await (await fetch('styles.css')).text(); } catch { cssText = ''; }
    return cssText;
  }

  function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async function snapshot(el) {
    const css = await loadCss();
    const rect = el.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
    const scale = Math.min(window.devicePixelRatio || 1, 2);

    const clone = el.cloneNode(true);
    // cloneNode copies attributes, not live form state — sync what the user typed
    const src = el.querySelectorAll('input, textarea');
    const dst = clone.querySelectorAll('input, textarea');
    src.forEach((s, i) => {
      const d = dst[i];
      if (s.type === 'checkbox' || s.type === 'radio') {
        if (s.checked) d.setAttribute('checked', ''); else d.removeAttribute('checked');
      } else if (s.tagName === 'TEXTAREA') d.textContent = s.value;
      else if (s.type !== 'file') d.setAttribute('value', s.value);
    });
    if (el.scrollTop) {
      const inner = document.createElement('div');
      inner.style.transform = `translateY(${-el.scrollTop}px)`;
      while (clone.firstChild) inner.appendChild(clone.firstChild);
      clone.appendChild(inner);
    }
    clone.style.cssText += `;position:relative;left:0;top:0;margin:0;opacity:1;transform:none;clip-path:none;` +
      `width:${W}px;height:${H}px;max-height:none;overflow:hidden;`;

    const markup = new XMLSerializer().serializeToString(clone);
    const ff = getComputedStyle(document.body).fontFamily;
    // backdrop-filter can't render inside an SVG image, so the ~14% of
    // background the real panel lets through would show up sharp instead of
    // blurred and read as see-through. Stacking the panel colour twice
    // (~98% opaque) matches how solid the blurred glass actually looks.
    const snapCss =
      `.snap-root{font-family:${ff};color:var(--text);width:${W}px;height:${H}px;}` +
      `.snap-root>.jelly-panel{background:linear-gradient(var(--panel-bg),var(--panel-bg)),var(--panel-bg);}`;
    const styles = (css + snapCss).replace(/]]>/g, '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${effectiveTheme()}" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}">` +
      `<style><![CDATA[${styles}]]></style>` +
      `<foreignObject x="0" y="0" width="${W}" height="${H}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" class="snap-root">${markup}</div>` +
      `</foreignObject></svg>`;

    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    return { img, rect: { left: rect.left, top: rect.top, width: W, height: H } };
  }

  // ---------- Geometry ----------

  function prepare(rect, target) {
    const T = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    const corners = [
      [rect.left, rect.top], [rect.left + rect.width, rect.top],
      [rect.left + rect.width, rect.top + rect.height], [rect.left, rect.top + rect.height],
    ];
    let lead = 0, best = Infinity;
    corners.forEach((c, i) => { const d = Math.hypot(c[0] - T.x, c[1] - T.y); if (d < best) { best = d; lead = i; } });
    const L = corners[lead], F = corners[(lead + 2) % 4];
    const span = Math.hypot(F[0] - L[0], F[1] - L[1]);

    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let Dx = T.x - cx, Dy = T.y - cy, dl = Math.hypot(Dx, Dy);
    if (dl < 1) { Dx = L[0] - cx; Dy = L[1] - cy; dl = Math.hypot(Dx, Dy); }
    Dx /= dl; Dy /= dl;
    const Nx = -Dy, Ny = Dx;

    const inside = T.x > rect.left && T.x < rect.left + rect.width && T.y > rect.top && T.y < rect.top + rect.height;
    const lam = new Float32Array(VERTS), phi = new Float32Array(VERTS);
    let phiMin = Infinity, phiMax = -Infinity;
    for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) {
      const k = j * (GX + 1) + i;
      const px = rect.left + (i / GX) * rect.width, py = rect.top + (j / GY) * rect.height;
      // lead corner = 0, opposite corner = 1: Genie's leading/trailing edge, but corner-anchored
      lam[k] = clamp01(Math.hypot(px - L[0], py - L[1]) / span);
      // angle around the button, so pleats fan out from it and converge into it
      const ax = px - T.x, ay = py - T.y;
      phi[k] = Math.atan2(ax * Nx + ay * Ny, -(ax * Dx + ay * Dy));
      if (phi[k] < phiMin) phiMin = phi[k];
      if (phi[k] > phiMax) phiMax = phi[k];
    }
    const phiSpan = inside ? 2 * Math.PI : Math.max(0.2, phiMax - phiMin);
    if (inside) phiMin = -Math.PI;

    const minSide = Math.min(rect.width, rect.height);
    return {
      rect, T, lam, phi, phiMin, cx, cy, Dx, Dy,
      kWave: (2 * Math.PI * PLEATS) / phiSpan,
      hw: Math.min(Math.max(target.w * 0.25, 6), 36),
      hh: Math.min(Math.max(target.h * 0.25, 5), 20),
      amp: minSide * 0.05,
      rampLen: minSide * 0.3,
    };
  }

  // Damped jelly wobble about the panel centre: it swells past full size,
  // with width and height oscillating out of phase (the axis it mostly
  // travelled along leads) so it wobbles rather than just pulsing. Axis-
  // aligned on purpose — stretching along a diagonal travel direction turns
  // the rectangle into a parallelogram, which reads as a tilt, not jelly.
  // Each vertex starts a little later the closer it is to the lead corner
  // (the last part to leave the button), so the wobble ripples across.
  function applyJelly(G, jt) {
    const { lam, cx, cy, Dx, Dy } = G;
    const xLeads = Math.abs(Dx) >= Math.abs(Dy);
    for (let k = 0; k < VERTS; k++) {
      const tau = jt - (1 - lam[k]) * JELLY.ripple;
      if (tau <= 0) continue;
      const env = JELLY.amp * Math.exp(-tau / JELLY.decay);
      const w = (2 * Math.PI * tau) / JELLY.period;
      const lead = 1 + env * Math.sin(w), lag = 1 + env * Math.sin(w - JELLY.lag);
      X[k] = cx + (X[k] - cx) * (xLeads ? lead : lag);
      Y[k] = cy + (Y[k] - cy) * (xLeads ? lag : lead);
    }
  }

  function computeFrame(G, t, vw, vh, jt) {
    const { rect, T, lam, phi, phiMin, kWave, hw, hh, amp, rampLen } = G;
    for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) {
      const k = j * (GX + 1) + i;
      const u = i / GX, v = j / GY;
      const px = rect.left + u * rect.width, py = rect.top + v * rect.height;

      const s = clamp01((t - lam[k] * DELAY) / (1 - DELAY));
      let e = easeInOutQuad(s);
      e = 1 - (1 - e) * (1 - DRIFT * t);

      // each point heads for its matching spot inside a tiny rect at the button
      const qx = T.x + (u - 0.5) * 2 * hw, qy = T.y + (v - 0.5) * 2 * hh;
      let bx = px + (qx - px) * e, by = py + (qy - py) * e;

      // pleats: appear as a region starts being gathered, fade out right at
      // the nozzle, shrink toward the button so the folds converge into it
      const f = smooth(0, 0.3, e) * (1 - smooth(0.82, 1, e));
      const rx = bx - T.x, ry = by - T.y, r = Math.hypot(rx, ry) || 1;
      const a = amp * f * Math.min(1, r / rampLen);
      // two harmonics so folds vary in width/depth like fabric, instead of
      // evenly spaced pleats that read as folded paper
      const ph = kWave * (phi[k] - phiMin);
      const ph2 = ph * 1.6 + 1.3;
      const wave = (Math.sin(ph) + 0.35 * Math.sin(ph2)) / 1.35;
      const shift = a * 0.3 * (Math.cos(ph) + 0.35 * Math.cos(ph2)) / 1.35;
      bx += (-ry / r) * shift; by += (rx / r) * shift;

      X[k] = bx; Y[k] = by; Z[k] = a * wave;
    }

    if (jt >= 0) applyJelly(G, jt);

    const cxv = vw / 2, cyv = vh / 2;
    for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) {
      const k = j * (GX + 1) + i;
      const kl = j * (GX + 1) + Math.max(0, i - 1), kr = j * (GX + 1) + Math.min(GX, i + 1);
      const ku = Math.max(0, j - 1) * (GX + 1) + i, kd = Math.min(GY, j + 1) * (GX + 1) + i;
      const ux = X[kr] - X[kl], uy = Y[kr] - Y[kl], uz = Z[kr] - Z[kl];
      const wx = X[kd] - X[ku], wy = Y[kd] - Y[ku], wz = Z[kd] - Z[ku];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-6) { nx = 0; ny = 0; nz = 1; } else { nx /= nl; ny /= nl; nz /= nl; }
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const d = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / LIGHT[2]; // 1.0 when flat
      shade[k] = Math.min(1.25, Math.max(0.62, d));

      const sc = FOCAL / (FOCAL - Z[k]);
      pos2[2 * k] = cxv + (X[k] - cxv) * sc;
      pos2[2 * k + 1] = cyv + (Y[k] - cyv) * sc;
    }
  }

  // ---------- Drawing ----------

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }

  function draw(G, t, tex, jt = -1) {
    const vw = window.innerWidth, vh = window.innerHeight;
    computeFrame(G, t, vw, vh, jt);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos2);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufUV);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufShade);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, shade);
    gl.enableVertexAttribArray(loc.aShade);
    gl.vertexAttribPointer(loc.aShade, 1, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform2f(loc.uRes, vw, vh);
    gl.uniform1f(loc.uAlpha, 1 - smooth(0.86, 1, t)); // melt away once it's inside the button

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_SHORT, 0);
  }

  function clearCanvas() {
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    canvas.classList.remove('active');
  }

  // ---------- Public ----------

  // Stops whatever is running and returns where it was, so a close that
  // interrupts an open can start from the same shape instead of jumping.
  function cancel() {
    if (!current) return null;
    const job = current;
    current = null;
    clearTimeout(job.watchdog);
    if (job.raf) cancelAnimationFrame(job.raf);
    if (job.tex && gl) gl.deleteTexture(job.tex);
    clearCanvas();
    job.resolve && job.resolve('cancelled');
    return { el: job.el, t: job.lastT, direction: job.direction };
  }

  // direction 'close': t 0 -> 1 (rest -> inside the button); 'open': 1 -> 0.
  // Resolves true when finished, 'cancelled' if superseded, false if the
  // effect isn't available here (caller should fall back).
  async function play({ el, target, direction, fromT, onStart, onEnd }) {
    cancel();
    // rAF and image decoding pause while the page isn't being rendered
    // (window minimized/hidden) — the panel would never appear. Skip.
    if (document.hidden || !initGL()) return false;
    const job = { el, direction, lastT: null, raf: 0, tex: null, resolve: null, watchdog: 0 };
    current = job;

    let snap;
    try {
      snap = await Promise.race([
        snapshot(el),
        new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot timed out')), SNAPSHOT_TIMEOUT)),
      ]);
    } catch (e) {
      if (current !== job) return 'cancelled';
      console.warn('ClothFX snapshot failed:', e);
      current = null;
      return false;
    }
    if (current !== job) return 'cancelled';

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap.img);
    } catch (e) {
      console.warn('ClothFX texture upload failed:', e);
      gl.deleteTexture(tex); current = null; return false;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    job.tex = tex;

    const G = prepare(snap.rect, target);
    const startT = fromT != null ? fromT : (direction === 'close' ? 0 : 1);
    const endT = direction === 'close' ? 1 : 0;
    const dur = DURATION[direction] * Math.abs(endT - startT);
    // Jelly only on a fresh open (not when resuming mid-way from an interrupt).
    const jellyAt = direction === 'open' && fromT == null ? dur * JELLY.start : null;
    const total = jellyAt != null ? jellyAt + JELLY.ripple + JELLY.settle : dur;

    sizeCanvas();
    canvas.classList.add('active');

    return new Promise((resolve) => {
      job.resolve = resolve;
      let t0 = null, first = true;
      const complete = () => {
        if (current !== job) return;
        clearTimeout(job.watchdog);
        if (job.raf) cancelAnimationFrame(job.raf);
        if (first) { first = false; onStart && onStart(); }
        onEnd && onEnd();
        current = null;
        gl.deleteTexture(tex);
        clearCanvas();
        resolve(true);
      };
      const step = (now) => {
        if (current !== job) return;
        if (t0 === null) t0 = now;
        const elapsed = now - t0;
        const p = dur > 0 ? Math.min(1, elapsed / dur) : 1;
        const t = startT + (endT - startT) * p;
        job.lastT = t;
        draw(G, t, tex, jellyAt != null ? elapsed - jellyAt : -1);
        if (first) { first = false; onStart && onStart(); } // same frame as the first mesh draw — no flicker
        if (elapsed < total) { job.raf = requestAnimationFrame(step); return; }
        complete();
      };
      job.raf = requestAnimationFrame(step);
      // If frames stop coming (window minimized mid-animation), jump to the
      // end on wall-clock time rather than leaving the panel stuck invisible.
      job.watchdog = setTimeout(complete, total + WATCHDOG_SLACK);
    });
  }

  // Warm the stylesheet cache so the first animation doesn't wait on a fetch.
  loadCss();

  return { play, cancel };
})();
