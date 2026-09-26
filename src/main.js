import * as THREE from 'three';

/*  Every New Yorker cover since 1925 — infinite draggable WebGL grid.
 *
 *  Grid model
 *  ----------
 *  One unbounded float V (vertical travel) and H (horizontal) drive
 *  everything, so the field is endless: no page, no seams, no cell budget.
 *
 *  Uniform spacing is a hard requirement, so the layout is derived from a
 *  single pitch:
 *
 *      pitchX = cellW + GAP      pitchY = cellH + GAP
 *
 *  Every cell is cellW x cellH and every gap is exactly GAP. The column band
 *  is `renderCols` pitches wide and renderCols = cols + 2, so bandW > vw and
 *  the band always covers the viewport — which is what keeps the wrap seam
 *  off-screen. (Wrapping on cols*cellW + GAP*(cols-1) instead makes the band
 *  one GAP narrower than its own content: the seam gap goes to zero and
 *  columns touch.)
 *
 *  cellH = cellW / COVER_AR matches the cover's own proportions, so with
 *  contain() in the shader each cover fills its cell with no letterbox on the
 *  5,000+ issues that share the 1600x2184 ratio.
 *
 *  Parallax: each column carries a depth d = col/(renderCols-1) and travels
 *  at rate 1 - PARALLAX*d, so columns drift apart vertically as you move.
 *  Cell size never changes, so the spacing stays uniform while it does.
 *
 *  Textures are prefetched in a ring around the viewport, lowest-priority
 *  distance first, so moving in any direction lands on an already-loaded
 *  cover instead of an empty cell.
 */

const COVER_AR = 1600 / 2184;   // dominant cover aspect across the archive
const PARALLAX = 0.42;          // vertical rate spread between near and far columns
const GAP = 14;                 // uniform, both axes
const MIN_COL_W = 300;

const MAX_TEXTURES = 320;       // ~137 MB of VRAM at 280x382 RGBA
const MAX_INFLIGHT = 10;
const PRE_ROWS = 6;             // prefetch rows above and below the viewport

const START_INDEX = 1200;       // open somewhere interesting rather than 1925

const canvas   = document.getElementById('gl');
const readout  = document.getElementById('rDate');
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

/* contain(): map cell uv into image uv, letterboxing the remainder.
   The source pen used cover(), which crops the artwork off at the edges. */
const FRAG = /* glsl */`
  precision mediump float;
  uniform vec2 u_res;
  uniform vec2 u_size;
  uniform float u_has;
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
    gl_FragColor = vec4(texture2D(u_texture, uv).rgb, 1.0);
  }
`;

/* --------------------------------------------------------------------- boot */

const covers = await (await fetch('covers.json')).json();
const total = covers.length;
document.getElementById('count').textContent = total.toLocaleString('en-US');

/* Row stride for the cover index. Must be coprime with `total`, otherwise a
   column would revisit covers before working through the whole archive. */
function coprimeStride(n) {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  let s = Math.max(n, 1);
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
const cache   = new Map();      // idx -> texture, insertion order == LRU
const pending = new Map();      // idx -> priority (lower == more urgent)
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
    if (onScreen) break;        // stop rather than pull a visible texture
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
      if (firstPaint && cache.size > 12) {
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
let cols = 0, renderCols = 0, rows = 0;
let cellW = 0, cellH = 0, pitchX = 0, pitchY = 0, bandW = 0, STRIDE = 1;
let hovered = null;

const paper = new THREE.Color(0xf4f1ea);

function buildPlanes() {
  for (const p of planes) { scene.remove(p); p.mat.dispose(); }
  planes.length = 0;

  const availW = vw - GAP * 2;
  cols = Math.max(2, Math.min(7, Math.round(availW / MIN_COL_W)));
  cellW = (availW - GAP * (cols - 1)) / cols;
  cellH = cellW / COVER_AR;
  pitchX = cellW + GAP;
  pitchY = cellH + GAP;

  // two extra columns so the band is always wider than the viewport; that is
  // what keeps the wrap seam outside the visible area
  renderCols = cols + 2;
  bandW = renderCols * pitchX;
  rows = Math.ceil(vh / pitchY) + 2;
  STRIDE = coprimeStride(renderCols);

  for (let c = 0; c < renderCols; c++) {
    for (let r = 0; r < rows; r++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          u_diff:   { value: 0 },
          u_res:    { value: new THREE.Vector2(cellW, cellH) },
          u_size:   { value: new THREE.Vector2(COVER_AR, 1) },
          u_texture:{ value: null },
          u_has:    { value: 0 },
          u_paper:  { value: paper },
        },
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.scale.set(cellW, cellH, 1);
      const depth = renderCols > 1 ? c / (renderCols - 1) : 0;
      const plane = {
        mesh, mat, col: c, row: r, idx: -1, tex: null,
        depth, rate: 1 - PARALLAX * depth,
        x: 0, y: 0, vis: false,
      };
      scene.add(mesh);
      planes.push(plane);
    }
  }
}

/* -------------------------------------------------------------------- layout */

let V = 0, H = 0, tV = 0, tH = 0, cV = 0, cH = 0, diff = 0;
let firstPaint = true;

/* Wrap on the pitch so gaps stay identical across the seam. */
const wrapBand = (u) => ((u % bandW) + bandW) % bandW;

function indexFor(logicalRow, bandCol) {
  return ((logicalRow * STRIDE + bandCol - START_INDEX) % total + total) % total;
}

function layout() {
  for (const p of planes) {
    const vy = V * p.rate;
    const r0 = Math.floor(vy / pitchY);
    const logicalRow = r0 + p.row;
    const y = logicalRow * pitchY - vy;                 // [0, rows*pitchY)

    const u = wrapBand(H + p.col * pitchX);
    const bandCol = Math.min(renderCols - 1, Math.floor(u / pitchX));

    p.x = u + cellW / 2 - bandW / 2 + vw / 2;
    p.y = vh / 2 - (y + cellH / 2);
    p.vis = (p.x + cellW / 2 > 0 && p.x - cellW / 2 < vw &&
             p.y + cellH / 2 > 0 && p.y - cellH / 2 < vh);

    p.mesh.position.x = p.x;
    p.mesh.position.y = p.y;

    const idx = indexFor(logicalRow, bandCol);
    if (idx !== p.idx) {
      p.idx = idx;
      const t = cache.get(idx);
      if (t) { touch(idx); bind(p, t); }
      else {
        p.tex = null;
        p.mat.uniforms.u_has.value = 0;
        request(idx, 0);
      }
    }
  }
}

/* Prefetch a ring around the viewport so movement in any direction is warm. */
let lastPrefetch = 0;
function prefetch(now) {
  if (now - lastPrefetch < 120) return;
  lastPrefetch = now;
  for (let c = 0; c < renderCols; c++) {
    const rate = 1 - PARALLAX * (renderCols > 1 ? c / (renderCols - 1) : 0);
    const vy = V * rate;
    const r0 = Math.floor(vy / pitchY);
    const u = wrapBand(H + c * pitchX);
    const bandCol = Math.min(renderCols - 1, Math.floor(u / pitchX));
    for (let j = -PRE_ROWS; j < rows + PRE_ROWS; j++) {
      const logicalRow = r0 + j;
      const y = logicalRow * pitchY - vy;
      if (y + cellH < -cellH || y > vh + cellH) continue;   // offscreen ring
      request(indexFor(logicalRow, bandCol), 1 + Math.abs(j - rows / 2));
    }
  }
}

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
    tH += dx * 0.9;
    tV += -dy * 1.35;
    vX = dx * 0.9; vY = -dy * 1.35;
    return;
  }
  // hover: pick the visible plane under the cursor
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
      const c = covers[best.idx];
      readout.textContent = c.d;
      credit.textContent = 'open full size';
      credit.href = c.full;
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
  if (moved < 5 && hovered) window.open(covers[hovered.idx].full, '_blank', 'noopener');
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
  tV += e.deltaY * k * 2.0;
  tH += e.deltaX * k * 1.2;
}, { passive: false });

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
    tV += vY * (dt / 16.6) * 0.55;
    tH += vX * (dt / 16.6) * 0.55;
    vY *= 0.93; vX *= 0.93;
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
  for (const p of planes) p.mat.uniforms.u_diff.value = diff;

  if (V !== pv || H !== ph) layout();
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
