// Theme switch as water: ripples spread from the toggle and the new theme
// floods in behind the leading wave.
//
// This is actual computation, not a clip-path. A 2D wave equation runs on
// the GPU every frame (WebGL2, ping-pong float textures, Hugo Elias scheme:
// h' = (sum of 4 neighbours)/2 - h_prev, damped). A point source at the
// toggle oscillates for a while and emits rings, which reflect off the
// window edges and interfere. The page (both themes, rasterized) is then
// drawn *through* that water surface: every pixel is refracted by the local
// slope, glints come from Blinn-Phong specular against a top-left light,
// caustics brighten where waves focus (negative Laplacian of the height),
// and steep slopes get a faint rim sheen. The colour boundary is the
// leading wavefront, offset by the local wave height so it rides the
// ripples. Everything runs on the GPU so it stays smooth on weak machines —
// unlike the earlier backdrop-filter attempt, which filtered on the CPU.
const RippleFX = (() => {
  const SIM_SCALE = 0.5;          // simulation cells per CSS pixel
  const WAVE_SPEED = Math.SQRT1_2; // cells per step for this scheme (c^2 = 1/2)
  const WAVELENGTH = 36;          // cells (~72 CSS px)
  const OMEGA = (2 * Math.PI * WAVE_SPEED) / WAVELENGTH;
  const SOURCE_RADIUS = 4.5;      // cells
  const SOURCE_AMP = 0.045;       // height injected per step at the source peak (it resonates, so small)
  const DAMPING = 0.9992, DAMPING_CALM = 0.992;
  const SPONGE_CELLS = 36;        // absorbing border width — ~1 wavelength, or long waves partly reflect

  const REVEAL_MS = 2100;         // leading wave travels to the far corner in this time
  const SOURCE_MS = 1100;         // how long the source keeps emitting rings
  const CALM_MS = 600;            // ripples keep playing out after the flood completes
  const FADE_IN_MS = 160, FADE_OUT_MS = 420;
  const MAX_STEPS_PER_FRAME = 40;
  const DPR_CAP = 1.5;

  // Look (render shader)
  const LOOK = {
    slope: 5.0,     // height gradient -> surface normal
    refract: 16.0,  // px of image shift at a fully tilted normal
    caustic: 3.5,   // brightening where waves focus
    rim: 0.15,      // sheen on steep slopes
    diffuse: 1.6,   // light/shadow banding across wave slopes
    wobble: 34.0,   // px the colour edge moves per unit wave height
    feather: 9.0,   // px softness of the colour edge
  };

  let busy = false;
  let cssText = null;

  // ---------- Page snapshots (DOM -> image, per theme) ----------

  async function loadCss() {
    if (cssText !== null) return cssText;
    try { cssText = await (await fetch('styles.css')).text(); } catch { cssText = ''; }
    return cssText;
  }

  function syncForms(src, dst) {
    const s = src.querySelectorAll('input, textarea'), d = dst.querySelectorAll('input, textarea');
    s.forEach((el, i) => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) d[i].setAttribute('checked', ''); else d[i].removeAttribute('checked');
      } else if (el.tagName === 'TEXTAREA') d[i].textContent = el.value;
      else if (el.type !== 'file') d[i].setAttribute('value', el.value);
    });
  }

  // Renders the live <body> in the given theme without touching the page:
  // the theme is set on the snapshot's own root, so both themes can be
  // captured before anything visibly changes.
  async function snapshotPage(theme, W, H, dpr) {
    const css = await loadCss();
    const sy = window.scrollY;
    const clone = document.body.cloneNode(true);
    syncForms(document.body, clone);
    clone.querySelectorAll('script, canvas').forEach((n) => n.remove());
    clone.style.cssText += `;margin:0;opacity:1;transition:none;width:${W}px;min-height:${H}px;` +
      (sy ? `transform:translateY(${-sy}px);` : '');
    // The header's right padding can come from env(titlebar-area-*) (room
    // for the native window buttons). Those values don't exist inside the
    // SVG <foreignObject> snapshot, so it fell back to the plain padding and
    // the whole button row jumped right for the length of the animation.
    // Freeze the on-screen padding into the clone instead.
    const liveHdr = document.querySelector('.app-header, .nav');
    const cloneHdr = clone.querySelector('.app-header, .nav');
    if (liveHdr && cloneHdr) {
      const cs = getComputedStyle(liveHdr);
      cloneHdr.style.paddingLeft = cs.paddingLeft;
      cloneHdr.style.paddingRight = cs.paddingRight;
    }
    if (sy) { // keep the sticky header pinned like it is on screen
      // Hardcoding one class name here means any app that doesn't happen to
      // call its sticky header ".app-header" (e.g. IELTS Speaking Coach uses
      // ".nav") silently gets no compensation: the header scrolls off with
      // the rest of the snapshot instead of staying pinned, then visibly
      // snaps back into place once the real (position:sticky) DOM returns.
      const hdr = clone.querySelector('.app-header, .nav');
      if (hdr) hdr.style.transform = `translateY(${sy}px)`;
    }
    const markup = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}" width="${Math.round(W * dpr)}" height="${Math.round(H * dpr)}" viewBox="0 0 ${W} ${H}">` +
      `<style><![CDATA[${css.replace(/]]>/g, '')}]]></style>` +
      `<foreignObject x="0" y="0" width="${W}" height="${H}">${markup}</foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    return img;
  }

  // ---------- WebGL2 ----------

  const VS_SIM = `#version 300 es
    in vec2 aPos; out vec2 vUV;
    void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // Screen convention: y down (matches the page images and CSS px). The sim
  // texture uses the same numbers for its coordinates, so sampling it at a
  // screen uv lines up with where drops were injected.
  const VS_SCREEN = `#version 300 es
    in vec2 aPos; out vec2 vUV;
    void main() { vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS_SIM = `#version 300 es
    precision highp float;
    uniform sampler2D uState; uniform vec2 uTexel, uSource;
    uniform float uSourceR, uSourceH, uDamping, uSponge;
    in vec2 vUV; out vec4 o;
    void main() {
      vec2 s = texture(uState, vUV).rg; // r = height now, g = height one step ago
      float sum = texture(uState, vUV + vec2(uTexel.x, 0.0)).r + texture(uState, vUV - vec2(uTexel.x, 0.0)).r
                + texture(uState, vUV + vec2(0.0, uTexel.y)).r + texture(uState, vUV - vec2(0.0, uTexel.y)).r;
      // Absorbing border: waves die out as they reach the window edges
      // instead of bouncing back and interfering into a standing-wave grid,
      // so the pattern stays clean rings spreading outward, like open water.
      vec2 cell = vUV / uTexel;
      vec2 size = 1.0 / uTexel;
      float edgeDist = min(min(cell.x, size.x - cell.x), min(cell.y, size.y - cell.y));
      float sponge = mix(0.93, 1.0, smoothstep(0.0, uSponge, edgeDist));
      vec2 toSrc = (vUV - uSource) / uTexel;
      sponge = mix(sponge, 1.0, exp(-dot(toSrc, toSrc) / 1600.0)); // don't smother the source (it sits near the top edge)
      float h = (sum * 0.5 - s.g) * uDamping * sponge;
      vec2 d = (vUV - uSource) / uTexel; // distance to the source, in cells
      h += uSourceH * exp(-dot(d, d) / (uSourceR * uSourceR));
      o = vec4(h, s.r, 0.0, 1.0);
    }`;

  const FS_RENDER = `#version 300 es
    precision highp float;
    uniform sampler2D uSim, uOld, uNew;
    uniform vec2 uSimTexel, uRes, uOrigin;
    uniform float uFront, uAlpha, uFeather, uWobble, uRefract, uSlope, uCaustic, uRim, uDiffuse;
    in vec2 vUV; out vec4 o;
    float Hs(vec2 uv) { return texture(uSim, uv).r; }
    void main() {
      vec2 px = vUV * uRes;
      float dist = length(px - uOrigin);
      float gain = 1.0 + dist / 650.0; // offsets 2D spreading loss so far rings still read
      vec2 e = uSimTexel * 1.5;
      float hc = Hs(vUV);
      float hl = Hs(vUV - vec2(e.x, 0.0)), hr = Hs(vUV + vec2(e.x, 0.0));
      float hu = Hs(vUV - vec2(0.0, e.y)), hd = Hs(vUV + vec2(0.0, e.y));
      vec2 grad = vec2(hr - hl, hd - hu) / 3.0 * gain;
      vec3 n = normalize(vec3(-grad * uSlope, 1.0));

      // refraction: look at the page through the tilted surface
      vec2 suv = clamp((px + n.xy * uRefract) / uRes, vec2(0.0), vec2(1.0));
      float edge = uFront + hc * gain * uWobble;
      float wet = 1.0 - smoothstep(edge - uFeather, edge + uFeather, dist);
      vec4 c = mix(texture(uOld, suv), texture(uNew, suv), wet); // premultiplied

      // light: glints (tight + soft specular), caustics, rim sheen — each
      // minus its value on flat water so a calm surface adds nothing
      vec3 L = normalize(vec3(-0.35, -0.55, 1.0));
      vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));
      float nh = max(dot(n, Hv), 0.0);
      float glint = pow(nh, 220.0) * 1.2 + pow(nh, 30.0) * 0.12;
      float glintFlat = pow(Hv.z, 220.0) * 1.2 + pow(Hv.z, 30.0) * 0.12;
      float lap = (hl + hr + hu + hd - 4.0 * hc) / 2.25 * gain;
      float caustic = clamp(-lap * uCaustic, -0.2, 0.5);
      float rim = (1.0 - n.z) * uRim;
      float light = max(glint - glintFlat, 0.0) + max(caustic, 0.0) + rim;

      // diffuse shading: slopes facing the light brighten, slopes facing
      // away darken — what makes ripples visible over a white page, where
      // white glints alone disappear
      float diffuse = (dot(n, L) - L.z) * uDiffuse;
      c.rgb *= (1.0 + min(caustic, 0.0)) * (1.0 + diffuse);
      c.rgb += vec3(light);
      c.a = max(c.a, clamp(light, 0.0, 0.85));
      o = c * uAlpha;
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  function createRenderer(canvas, W, H, oldImg, newImg) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const cbf = gl.getExtension('EXT_color_buffer_float');
    const cbhf = cbf ? null : gl.getExtension('EXT_color_buffer_half_float');
    const floatLinear = gl.getExtension('OES_texture_float_linear');
    let internal, type;
    if (cbf && floatLinear) { internal = gl.RGBA32F; type = gl.FLOAT; }
    else if (cbf || cbhf) { internal = gl.RGBA16F; type = gl.HALF_FLOAT; }
    else return null;

    let sim, rnd;
    try {
      sim = program(gl, VS_SIM, FS_SIM);
      rnd = program(gl, VS_SCREEN, FS_RENDER);
    } catch (e) { console.warn('RippleFX shader error:', e); return null; }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one oversized triangle
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const SW = Math.max(2, Math.round(W * SIM_SCALE)), SH = Math.max(2, Math.round(H * SIM_SCALE));
    const makeTarget = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, SW, SH, 0, gl.RGBA, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); // edges reflect the waves
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb };
    };
    let a = makeTarget(), b = makeTarget();
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;

    const nearest = gl.createSampler();
    gl.samplerParameteri(nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const linear = gl.createSampler();
    gl.samplerParameteri(linear, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(linear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    [nearest, linear].forEach((s) => {
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });

    const imageTex = (img) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      return t;
    };
    const oldTex = imageTex(oldImg), newTex = imageTex(newImg);

    return {
      // One simulation step; `sourceH` is how much the source pushes this step.
      step(sourceUV, sourceH, damping) {
        gl.useProgram(sim.p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
        gl.viewport(0, 0, SW, SH);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.bindSampler(0, nearest);
        gl.uniform1i(sim.u.uState, 0);
        gl.uniform2f(sim.u.uTexel, 1 / SW, 1 / SH);
        gl.uniform2f(sim.u.uSource, sourceUV[0], sourceUV[1]);
        gl.uniform1f(sim.u.uSourceR, SOURCE_RADIUS);
        gl.uniform1f(sim.u.uSourceH, sourceH);
        gl.uniform1f(sim.u.uDamping, damping);
        gl.uniform1f(sim.u.uSponge, SPONGE_CELLS);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [a, b] = [b, a];
      },
      render({ origin, front, alpha }) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(rnd.p);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        [[a.tex, 'uSim'], [oldTex, 'uOld'], [newTex, 'uNew']].forEach(([t, name], i) => {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.bindSampler(i, linear);
          gl.uniform1i(rnd.u[name], i);
        });
        gl.uniform2f(rnd.u.uSimTexel, 1 / SW, 1 / SH);
        gl.uniform2f(rnd.u.uRes, W, H);
        gl.uniform2f(rnd.u.uOrigin, origin.x, origin.y);
        gl.uniform1f(rnd.u.uFront, front);
        gl.uniform1f(rnd.u.uAlpha, alpha);
        gl.uniform1f(rnd.u.uFeather, LOOK.feather);
        gl.uniform1f(rnd.u.uWobble, LOOK.wobble);
        gl.uniform1f(rnd.u.uRefract, LOOK.refract);
        gl.uniform1f(rnd.u.uSlope, LOOK.slope);
        gl.uniform1f(rnd.u.uCaustic, LOOK.caustic);
        gl.uniform1f(rnd.u.uRim, LOOK.rim);
        gl.uniform1f(rnd.u.uDiffuse, LOOK.diffuse);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      destroy() {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext(); // free GPU memory right away — this machine is short on RAM
      },
    };
  }

  // ---------- Timeline ----------

  function plan(origin, W, H) {
    const far = Math.max(
      Math.hypot(origin.x, origin.y), Math.hypot(W - origin.x, origin.y),
      Math.hypot(origin.x, H - origin.y), Math.hypot(W - origin.x, H - origin.y));
    // steps until the colour edge (half a wavelength behind the first crest)
    // has passed the farthest corner
    const revealSteps = Math.ceil((far * SIM_SCALE + WAVELENGTH * 0.5 + LOOK.feather * SIM_SCALE) / WAVE_SPEED);
    const stepsPerMs = revealSteps / REVEAL_MS;
    return {
      revealSteps, stepsPerMs,
      sourceSteps: Math.round(SOURCE_MS * stepsPerMs),
      totalSteps: revealSteps + Math.round(CALM_MS * stepsPerMs),
      periodSteps: (2 * Math.PI) / OMEGA,
    };
  }

  function sourceHeight(step, P) {
    if (step >= P.sourceSteps) return 0;
    // quick attack (one period) so the first ring is strong, quick release
    const env = Math.min(1, step / P.periodSteps) * Math.min(1, (P.sourceSteps - step) / P.periodSteps);
    return SOURCE_AMP * env * Math.sin(OMEGA * step);
  }

  const frontAt = (steps) => (steps * WAVE_SPEED - WAVELENGTH * 0.5) / SIM_SCALE;

  async function play({ origin, fromTheme, toTheme, apply }) {
    if (busy) return true;
    busy = true;
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    let canvas = null, R = null;
    try {
      let imgs;
      try {
        imgs = await Promise.race([
          Promise.all([snapshotPage(fromTheme, W, H, dpr), snapshotPage(toTheme, W, H, dpr)]),
          new Promise((_, rej) => setTimeout(() => rej(new Error('snapshot timed out')), 2000)),
        ]);
      } catch (e) { console.warn('RippleFX snapshot failed:', e); return false; }

      canvas = document.createElement('canvas');
      canvas.className = 'ripple-canvas';
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      document.documentElement.appendChild(canvas); // outside <body>, which gets faded out
      R = createRenderer(canvas, W, H, imgs[0], imgs[1]);
      if (!R) { canvas.remove(); return false; }

      await runTimeline(R, origin, W, H, apply);
      return true;
    } finally {
      if (R) R.destroy();
      if (canvas) canvas.remove();
      busy = false;
    }
  }

  function runTimeline(R, origin, W, H, apply) {
    const P = plan(origin, W, H);
    const sourceUV = [origin.x / W, origin.y / H];
    const body = document.body;
    const prevTransition = body.style.transition;
    body.style.transition = `opacity ${FADE_IN_MS}ms ease`;
    body.style.opacity = '0';

    return new Promise((resolve) => {
      let t0 = null, done = 0, applied = false, fadeOutAt = null, finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (!applied) { apply(); applied = true; }
        body.style.opacity = '';
        setTimeout(() => { body.style.transition = prevTransition; }, FADE_OUT_MS);
        resolve();
      };
      const frame = (now) => {
        if (finished) return;
        if (t0 === null) t0 = now;
        const el = now - t0;

        const target = Math.floor(el * P.stepsPerMs);
        for (let n = 0; done < target && n < MAX_STEPS_PER_FRAME; n++, done++) {
          R.step(sourceUV, sourceHeight(done, P), done > P.revealSteps ? DAMPING_CALM : DAMPING);
        }
        // switch the live page once it's fully hidden behind the canvas
        if (!applied && el >= FADE_IN_MS) { apply(); applied = true; }

        let alpha = Math.min(1, el / FADE_IN_MS);
        if (fadeOutAt === null && done >= P.totalSteps) {
          fadeOutAt = el;
          body.style.transition = `opacity ${FADE_OUT_MS}ms ease`;
          body.style.opacity = ''; // live page (new theme) fades back in as the water fades out
        }
        if (fadeOutAt !== null) alpha = Math.max(0, 1 - (el - fadeOutAt) / FADE_OUT_MS);

        R.render({ origin, front: frontAt(done), alpha });
        if (fadeOutAt !== null && alpha <= 0) { finish(); return; }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      // If frames stop (window minimized mid-flood), don't strand the page invisible.
      const watchdog = setTimeout(finish, FADE_IN_MS + REVEAL_MS + CALM_MS + FADE_OUT_MS + 2500);
    });
  }

  loadCss();

  return { play, get busy() { return busy; } };
})();
