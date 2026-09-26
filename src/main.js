import * as THREE from 'three';

/*  Every New Yorker cover since 1925 — infinite, draggable, full-bleed grid.
 *
 *  Architecture note
 *  -----------------
 *  The previous version gave each column its own scroll rate so the columns
 *  would drift apart. That drift is unbounded: after a few thousand pixels
 *  the columns no longer shared rows, so the lattice came apart, the band
 *  stopped covering the viewport, and part of the screen went black.
 *
 *  This version keeps the grid a RIGID lattice. One offset drives every cell,
 *  so row alignment, uniform spacing and full-bleed coverage are structural
 *  rather than tuned. Parallax is applied afterwards as a bounded offset, so
 *  it can never take the grid apart.
 *
 *  Placement
 *  ---------
 *      pitchX = cellW + GAP        pitchY = cellH + GAP
 *      u = H mod pitchX            v = V mod pitchY
 *      k in [0, needCols)          x = k*pitchX - u + cellW/2
 *      j in [0, needRows)          y = j*pitchY - v + cellH/2
 *
 *  needCols/needRows are ceil(viewport/pitch) + 2, which guarantees the drawn
 *  cells cover the viewport for every value of u and v, so there is never a
 *  bare patch at any scroll position. The integer cell index comes from
 *  floor(H/pitchX) + k, so the same cell always resolves to the same cover.
 *
 *  Spacing
 *  -------
 *  Every gap is exactly GAP because every x difference is exactly pitchX.
 *  cellH = cellW / COVER_AR matches the covers' own 1600x2184 proportion, so
 *  the contain() in the fragment shader leaves no letterbox.
 *
 *  Parallax
 *  --------
 *  Three layers, all bounded so alignment survives:
 *    1. background planes at fixed differential rates (nemutas technique),
 *    2. a per-column lead/lag as a triangle wave, capped at PARALLAX_SPAN
 *       (10% of a row) so columns separate without ever losing their rows,
 *    3. depth dimming in the shader — farther columns render darker.
 *
 *  Latency
 *  -------
 *  Covers are prefetched in a wide ring around the viewport, nearest row
 *  first, into a 600-entry LRU that refuses to evict anything on screen.
 *  Warming starts before first paint, so moving in any direction lands on a
 *  resident texture.
 */

const COVER_AR = 1600 / 2184;
const GAP = 12;
const MIN_COL_W = 250;
const MAX_COLS = 8;

const PARALLAX_SPAN = 0.10;   // max column lead/lag, as a fraction of a row
const PARALLAX_PERIOD = 3;    // rows of travel per full lead/lag cycle

const MAX_TEXTURES = 600;
const MAX_INFLIGHT = 24;
const PRE_ROWS = 8;
const WARM_ON_BOOT = 260;
const ROW_STEP = 2;           // content advances twice per row of travel

const START_INDEX = 1200;

const canvas   = document.getElementById('gl');
const credit   = document.getElementById('credit');
const stalker  = document.getElementById('stalker');
const loaderEl = document.getElementById('loader');

/* ------------------------------------------------------------------ shaders */

const VERT = /* glsl */`
  precision mediump float;
  uniform float u_diff;
  varying vec2 vUv;
  void main() {
    vec3 pos = position;
    pos.y *= 1.0 - u_diff;
    pos.x *= 1.0 - u_diff;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

/* contain() — map cell uv into image uv and letterbox the remainder.
   The source pen used cover(), which crops the artwork at the cell edges. */
const FRAG = /* glsl */`
  precision mediump float;
  uniform vec2 u_res;
  uniform vec2 u_size;
  uniform float u_has;
  uniform float u_dim;
  uniform vec3 u_paper;
  uniform sampler2D u_texture;
  varying vec2 vUv;

  vec2 contain(vec2 cell, vec2 img, vec2 p) {
    float cellR = cell.x / cell.y;
    float imgR  = img.x  / img.y;
    float sx = 1.0, sy = 1.0;
    if (cellR > imgR) sy = imgR / cellR;
    else              sx = cellR / imgR;
    vec2 disp = cell * vec2(sx, sy);
    vec2 off  = (cell - disp) * 0.5;
    if (p.x < off.x || p.y < off.y || p.x > off.x + disp.x || p.y > off.y + disp.y)
      return vec2(-1.0);
    return (p - off) / disp;
  }

  void main() {
    if (u_has < 0.5) { gl_FragColor = vec4(u_paper, 1.0); return; }
    vec2 uv = contain(u_res, u_size, vUv * u_res);
    if (uv.x < 0.0) { gl_FragColor = vec4(u_paper, 1.0); return; }
    vec3 c = texture2D(u_texture, uv).rgb * u_dim;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/* --------------------------------------------------------------------- boot */

const covers = await (await fetch('covers.json')).json();
const total = covers.length;

/* Cover credits are only published for 2017 onward, so this map is sparse by
   necessity. Absent key means the publisher carries no credit for that cover. */
let ARTISTS = {};
try { ARTISTS = await (await fetch('artists.json')).json(); } catch { /* optional */ }

/* Row stride forced coprime with the archive size, so a column works through
   all 5,104 covers before it repeats. */
function coprimeStride(n) {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  let s = Math.max(1, n);
  while (gcd(s, total) !== 1) s++;
  return s;
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

const scene  = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
camera.position.z = 1;

let vw = 0, vh = 0;

/* ------------------------------------------------------- texture pool (LRU) */

const texLoader = new THREE.TextureLoader();
const cache   = new Map();
const pending = new Map();
let inflight = 0;

function touch(idx) {
  const t = cache.get(idx);
  cache.delete(idx);
  cache.set(idx, t);
}

function bind(plane, tex) {
  plane.tex = tex;
  plane.mat.uniforms.u_texture.value = tex;
  plane.mat.uniforms.u_has.value = 1;
  plane.mat.uniforms.u_size.value.set(tex.image.naturalWidth, tex.image.naturalHeight);
}

function evict() {
  while (cache.size > MAX_TEXTURES) {
    const key = cache.keys().next().value;
    const tex = cache.get(key);
    let onScreen = false;
    for (const p of planes) if (p.tex === tex) { onScreen = true; break; }
    if (onScreen) break;
    cache.delete(key);
    tex.dispose();
  }
}

function pump() {
  while (inflight < MAX_INFLIGHT && pending.size) {
    let best = null, bestP = Infinity;
    for (const [k, p] of pending) if (p < bestP) { bestP = p; best = k; }
    pending.delete(best);
    inflight++;
    texLoader.load(covers[best].thumb, (tex) => {
      inflight--;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      cache.set(best, tex);
      for (const p of planes) if (p.idx === best) bind(p, tex);
      evict();
      pump();
      if (firstPaint && cache.size > 20) {
        firstPaint = false;
        loaderEl.classList.add('done');
      }
    }, undefined, () => { inflight--; pump(); });
  }
}

function request(idx, priority) {
  if (cache.has(idx)) { touch(idx); return; }
  const cur = pending.get(idx);
  if (cur === undefined || priority < cur) pending.set(idx, priority);
  pump();
}

/* ---------------------------------------------------------------- the planes */

const geometry = new THREE.PlaneGeometry(1, 1);
const planes = [];
let cols = 0, needCols = 0, needRows = 0, ROW_J0 = 0;
let cellW = 0, cellH = 0, pitchX = 0, pitchY = 0, STRIDE = 1;
let hovered = null;

const paper = new THREE.Color(0xf4f1ea);

function buildPlanes() {
  for (const p of planes) { scene.remove(p); p.mat.dispose(); }
  planes.length = 0;

  // exact edge-to-edge fit: cols cells and cols+1 gaps span the viewport
  cols = Math.max(2, Math.min(MAX_COLS, Math.round((vw - GAP) / (MIN_COL_W + GAP))));
  cellW = (vw - GAP * (cols + 1)) / cols;
  cellH = cellW / COVER_AR;
  pitchX = cellW + GAP;
  pitchY = cellH + GAP;

  needCols = Math.ceil(vw / pitchX) + 2;
  // +3 rows, drawn from j = -1: one extra above and below, so the parallax
  // sway (bounded by PARALLAX_SPAN * cellH) can never uncover an edge
  ROW_J0 = -1;
  needRows = Math.ceil(vh / pitchY) + 3;
  STRIDE = coprimeStride(needCols);

  for (let j = ROW_J0; j < ROW_J0 + needRows; j++) {
    for (let k = 0; k < needCols; k++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          u_diff:   { value: 0 },
          u_res:    { value: new THREE.Vector2(cellW, cellH) },
          u_size:   { value: new THREE.Vector2(COVER_AR, 1) },
          u_texture:{ value: null },
          u_has:    { value: 0 },
          u_dim:    { value: 1 },
          u_paper:  { value: paper },
        },
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.scale.set(cellW, cellH, 1);
      mesh.position.z = 0;
      const plane = { mesh, mat, k, j, idx: -1, tex: null, x: 0, y: 0, vis: false };
      scene.add(mesh);
      planes.push(plane);
    }
  }
}

/* -------------------------------------------------------------------- layout */

let V = 0, H = 0, tV = 0, tH = 0, cV = 0, cH = 0, diff = 0;
let firstPaint = true;

const mod = (a, n) => ((a % n) + n) % n;

/* Smooth sway for the per-column lead/lag. Starts at 0 when travel is 0, so
   the grid sits at rest exactly; a triangle wave would start at full offset
   and pull the first column off the top edge. */
function swayAmount(travel, rowPitch, cellH) {
  return Math.sin((travel / rowPitch) / PARALLAX_PERIOD * Math.PI * 2) * PARALLAX_SPAN * cellH;
}

function layout() {
  const u = mod(H, pitchX);
  const v = mod(V, pitchY);
  const baseCol = Math.floor(H / pitchX);
  const sway = swayAmount(V, pitchY, cellH);

  // Content advances on half-row boundaries, not whole rows. With a full-row
  // step the visible set stays frozen for ~357px of travel, which reads as
  // "the same covers over and over"; halving the step halves the stall and
  // each advance still lands on a disjoint block (STRIDE >= needCols).
  const rowUnit = ROW_STEP * Math.floor(V / pitchY) + Math.floor(v / (pitchY / ROW_STEP));

  for (const p of planes) {
    // both axes are centred on the viewport: the camera spans -vw/2..vw/2 and
    // -vh/2..vh/2, so without these terms the lattice sits off to one side
    const x = p.k * pitchX - u + cellW / 2 - vw / 2;
    const y = p.j * pitchY - v + cellH / 2 - vh / 2;

    // depth 0 at the left edge of the screen, 1 at the right
    const depth = Math.min(1, Math.max(0, x / vw));
    const yShift = sway * (depth - 0.5) * 2;   // bounded, cannot break rows

    p.x = x;
    p.y = y + yShift;
    // world coords are centred on the viewport, so test against -vw/2..vw/2
    p.vis = (x + cellW / 2 > -vw / 2 && x - cellW / 2 < vw / 2 &&
             p.y + cellH / 2 > -vh / 2 && p.y - cellH / 2 < vh / 2);
    p.depth = depth;

    p.mesh.position.x = x;
    p.mesh.position.y = p.y;
    p.mat.uniforms.u_res.value.set(cellW, cellH);
    p.mat.uniforms.u_dim.value = 0.72 + 0.28 * depth;   // far columns dimmer

    const idx = (((rowUnit + p.j) * STRIDE + (baseCol + p.k) - START_INDEX) % total + total) % total;
    if (idx !== p.idx) {
      p.idx = idx;
      const t = cache.get(idx);
      if (t) { touch(idx); bind(p, t); }
      else {
        p.tex = null;
        p.mat.uniforms.u_has.value = 0;
        request(idx, 0);                      // on-screen always wins
      }
    }
  }
}

/* prefetch a ring around the viewport so movement is always onto a hit */
let lastPrefetch = 0;
function prefetch(now) {
  if (now - lastPrefetch < 100) return;
  lastPrefetch = now;
  const v = mod(V, pitchY);
  const baseCol = Math.floor(H / pitchX);
  const rowUnit = ROW_STEP * Math.floor(V / pitchY) + Math.floor(v / (pitchY / ROW_STEP));
  for (let j = ROW_J0 - PRE_ROWS; j < ROW_J0 + needRows + PRE_ROWS; j++) {
    const y = j * pitchY - v + cellH / 2 - vh / 2;
    if (y + cellH / 2 < -vh / 2 - cellH || y - cellH / 2 > vh / 2 + cellH) continue;
    const row = rowUnit + j;
    for (let k = -1; k <= needCols; k++) {
      const idx = ((row * STRIDE + (baseCol + k) - START_INDEX) % total + total) % total;
      request(idx, 1 + Math.abs(j));
    }
  }
}

/* warm the pool before the user touches anything */
for (let i = 0; i < WARM_ON_BOOT; i++) request((START_INDEX + i * 7) % total, 50 + i);

/* --------------------------------------------------------------------- input */

let dragging = false, lastX = 0, lastY = 0, vX = 0, vY = 0, moved = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; moved = 0;
  lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    tH += dx;
    tV += -dy;
    vX = dx; vY = -dy;
    return;
  }
  const nx = e.clientX - vw / 2, ny = vh / 2 - e.clientY;
  let best = null, bestD = Infinity;
  for (const p of planes) {
    if (!p.vis) continue;
    const dx = Math.abs(nx - p.x), dy = Math.abs(ny - p.y);
    if (dx <= cellW / 2 && dy <= cellH / 2) {
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (best !== hovered) {
    hovered = best;
    if (best) {
      credit.textContent = 'click for full size';
      credit.href = covers[best.idx].full;
      credit.classList.add('on');
    } else {
      credit.classList.remove('on');
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  if (moved < 5 && hovered) openPane(hovered.idx);
});
canvas.addEventListener('pointercancel', () => {
  dragging = false;
  document.body.classList.remove('dragging');
});
canvas.addEventListener('pointerleave', () => {
  hovered = null;
  credit.classList.remove('on');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 18 : 1;
  tV += e.deltaY * k * 1.6;
  tH += e.deltaX * k * 1.0;
}, { passive: false });

/* --------------------------------------------------------------------- pane */

const pane      = document.getElementById('pane');
const paneScrim = document.getElementById('paneScrim');
const paneImg   = document.getElementById('paneImg');
const paneDate  = document.getElementById('paneDate');
const paneArtist= document.getElementById('paneArtist');
const paneTitle = document.getElementById('paneTitle');
const paneMeta  = document.getElementById('paneMeta');
const paneLink  = document.getElementById('paneLink');
const paneCap   = document.getElementById('paneCaption');
let lastFocus = null;

/* Sample the cover's dominant colour and tint the pane with it.
   Works from the 280px WebP (~20 KB), not the multi-MB original, and caches
   per cover so stepping through the archive is instant on revisit. */
const colourCache = new Map();
let sampleCanvas = null;

function dominantColour(url) {
  return new Promise((resolve) => {
    if (colourCache.has(url)) return resolve(colourCache.get(url));
    const img = new Image();
    img.onload = () => {
      let hex = '#121216';
      try {
        const W = 28, H = 38;
        if (!sampleCanvas) sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = W; sampleCanvas.height = H;
        const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        const { data } = ctx.getImageData(0, 0, W, H);
        // quantise to 4-bit-per-channel buckets and take the most common,
        // ignoring near-white paper and near-black ink so one of those
        // dominating a line drawing cannot swamp the actual artwork colour
        const bins = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 128) continue;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx > 238 && mn > 228) continue;   // paper
          if (mx < 26) continue;               // ink
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const cur = bins.get(key);
          if (cur) { cur.n++; cur.r += r; cur.g += g; cur.b += b; }
          else bins.set(key, { n: 1, r, g, b });
        }
        let best = null;
        for (const v of bins.values()) if (!best || v.n > best.n) best = v;
        if (best) {
          const r = Math.round(best.r / best.n);
          const g = Math.round(best.g / best.n);
          const b = Math.round(best.b / best.n);
          // darken heavily and desaturate a little: the pane has to keep
          // white text legible whatever colour the artwork is
          const k = 0.16;
          const mix = (c, to) => Math.round(c * k + to * (1 - k));
          hex = `rgb(${mix(r, 18)} ${mix(g, 18)} ${mix(b, 24)})`;
          pane.style.setProperty('--pane-glow',
            `rgba(${r}, ${g}, ${b}, .30)`);
        }
      } catch { /* tainted canvas or decode failure: keep the default */ }
      colourCache.set(url, hex);
      resolve(hex);
    };
    img.onerror = () => resolve('#121216');
    img.src = url;
  });
}

function openPane(idx) {
  const c = covers[idx];
  const credit = ARTISTS[c.d];
  lastFocus = document.activeElement;

  paneImg.src = c.full;
  paneImg.alt = `The New Yorker cover, ${c.t}`;
  paneCap.textContent = credit && credit.title ? `\u201c${credit.title}\u201d` : '';
  paneDate.textContent = c.t;

  // with no published credit, show the cover and nothing invented
  paneMeta.hidden = !credit;
  if (credit) {
    paneArtist.textContent = credit.artist;
    paneTitle.textContent  = credit.title || '\u2014';
  }
  paneLink.href = c.src;

  pane.style.setProperty('--pane-bg', '#121216');
  pane.style.setProperty('--pane-glow', 'rgba(255,255,255,.06)');
  dominantColour(c.thumb).then((col) => pane.style.setProperty('--pane-bg', col));

  pane.classList.add('open');
  pane.setAttribute('aria-hidden', 'false');
  paneScrim.hidden = false;
  requestAnimationFrame(() => paneScrim.classList.add('on'));
  document.getElementById('paneClose').focus();
}

function closePane() {
  pane.classList.remove('open');
  pane.setAttribute('aria-hidden', 'true');
  paneScrim.classList.remove('on');
  setTimeout(() => { paneScrim.hidden = true; }, 380);
  if (lastFocus) lastFocus.focus?.();
}

document.getElementById('paneClose').addEventListener('click', closePane);
paneScrim.addEventListener('click', closePane);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pane.classList.contains('open')) closePane();
  // arrow keys step through the archive while the pane is open
  if (!pane.classList.contains('open')) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const cur = hovered ? hovered.idx : (paneIdx ?? 0);
  const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + total) % total;
  paneIdx = next;
  openPane(next);
});
let paneIdx = null;

/* ------------------------------------------------------------------ stalker */

let sCur = { x: innerWidth / 2, y: innerHeight / 2 };
let sTgt = { x: innerWidth / 2, y: innerHeight / 2 };
addEventListener('pointermove', (e) => { sTgt.x = e.clientX; sTgt.y = e.clientY; });

/* ------------------------------------------------------------------- resize */

function resize() {
  vw = window.innerWidth;
  vh = window.innerHeight;
  renderer.setSize(vw, vh);
  camera.left = -vw / 2; camera.right = vw / 2;
  camera.top = vh / 2;   camera.bottom = -vh / 2;
  camera.updateProjectionMatrix();
  buildPlanes();
  layout();
}
addEventListener('resize', resize);
resize();

/* --------------------------------------------------------------------- loop */

const layers = [...document.querySelectorAll('.backdrop .layer')];
let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(48, now - last); last = now;

  if (!dragging) {
    tV += vY * (dt / 16.6) * 0.5;
    tH += vX * (dt / 16.6) * 0.5;
    vY *= 0.92; vX *= 0.92;
    if (Math.abs(vY) < 0.02) vY = 0;
    if (Math.abs(vX) < 0.02) vX = 0;
  }

  const pv = cV, ph = cH;
  cV += (tV - cV) * 0.085;
  cH += (tH - cH) * 0.085;
  cV = Math.round(cV * 100) / 100;
  cH = Math.round(cH * 100) / 100;
  V = cV; H = cH;

  diff = Math.max(Math.abs((tV - cV) * 0.0001), Math.abs((tH - cH) * 0.0001));
  if (V !== pv || H !== ph) layout();
  for (const p of planes) p.mat.uniforms.u_diff.value = diff;

  prefetch(now);

  for (const l of layers) {
    const depth = parseFloat(l.dataset.depth);
    l.style.transform =
      `translate3d(${(-cH * depth * 0.9).toFixed(2)}px, ${(-cV * depth).toFixed(2)}px, 0)`;
  }

  sCur.x += (sTgt.x - sCur.x) * 0.3;
  sCur.y += (sTgt.y - sCur.y) * 0.3;
  stalker.style.transform = `translate3d(${sCur.x - 7.5}px, ${sCur.y - 7.5}px, 0)`;

  renderer.render(scene, camera);
}

requestAnimationFrame(tick);
