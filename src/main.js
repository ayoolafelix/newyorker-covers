import * as THREE from 'three';

/*  Every New Yorker cover since 1925 — infinite draggable WebGL grid.
 *
 *  Grid model
 *  ----------
 *  There is no "page" to scroll. We keep one unbounded float `V` (vertical
 *  travel) and derive everything from it, so the field is genuinely endless
 *  and never needs the wrap trick the original pen used for 15 fixed cells.
 *
 *  Each column c gets its own parallax factor, so columns drift apart as you
 *  travel — that differential is the parallax. For column c:
 *
 *      Vy(c) = V * pf(c)                 pf in (1-PARALLAX, 1]
 *      r0    = floor(Vy / cellPitch)     first logical row in view
 *      y(r)  = (r0 + r) * cellPitch - Vy continuous, sub-cell smooth
 *      idx   = mod((r0 + r) * cols + c, total)
 *
 *  Because idx is a pure function of position, the same cover never shows up
 *  twice in one column, and mod keeps it inside the 5,104 available.
 *
 *  Covers show *fully*: the fragment shader letterboxes (contains) rather
 *  than crops, and every cell is the same size with a fixed gap, so the
 *  spacing between covers is uniform across all 5,104.
 */

const COVER_AR = 1600 / 2184;   // 0.7326 — the dominant cover aspect
const PARALLAX = 0.34;          // how much slower the right-hand columns run
const GAP = 14;                 // px, uniform in both axes
const MAX_TEXTURES = 150;       // GPU ceiling; evicted textures are disposed
const START_INDEX = 1200;       // begin somewhere interesting rather than 1925

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

/* contain(): map cell uv into image uv, leaving the letterbox transparent.
   Unlike the source pen's cover(), nothing is ever cropped. */
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
    if (cellR > imgR) sy = imgR / cellR;   // height-limited
    else              sx = cellR / imgR;   // width-limited
    vec2 disp = cell * vec2(sx, sy);
    vec2 off  = (cell - disp) * 0.5;
    if (p.x < off.x || p.y < off.y || p.x > off.x + disp.x || p.y > off.y + disp.y)
      return vec2(-1.0);
    return (p - off) / disp;
  }

  void main() {
    vec2 p = vUv * u_res;
    if (u_has < 0.5) { gl_FragColor = vec4(u_paper, 1.0); return; }
    vec2 uv = contain(u_res, u_size, p);
    if (uv.x < 0.0) { gl_FragColor = vec4(u_paper, 1.0); return; }
    gl_FragColor = vec4(texture2D(u_texture, uv).rgb, 1.0);
  }
`;

/* --------------------------------------------------------------------- boot */

const covers = await (await fetch('covers.json')).json();
const total = covers.length;
document.getElementById('count').textContent = total.toLocaleString('en-US');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

const scene  = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
camera.position.z = 1;

let vw = 0, vh = 0;

/* ------------------------------------------------------------- texture cache */

const texLoader = new THREE.TextureLoader();
const cache = new Map();          // coverIndex -> THREE.Texture (insertion order = LRU)
const inflight = new Set();

function textureFor(idx, plane) {
  const hit = cache.get(idx);
  if (hit) {                                  // refresh recency
    cache.delete(idx);
    cache.set(idx, hit);
    return hit;
  }
  if (!inflight.has(idx)) {
    inflight.add(idx);
    texLoader.load(covers[idx].thumb, (tex) => {
      inflight.delete(idx);
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      cache.set(idx, tex);
      // the plane may have been recycled onto a different cover while loading
      if (plane.idx === idx) {
        plane.tex = tex;
        plane.mat.uniforms.u_texture.value = tex;
        plane.mat.uniforms.u_has.value = 1;
        plane.mat.uniforms.u_size.value.set(tex.image.naturalWidth, tex.image.naturalHeight);
      }
      while (cache.size > MAX_TEXTURES) {
        const oldestKey = cache.keys().next().value;
        const oldest = cache.get(oldestKey);
        // never evict a texture currently on screen
        let inUse = false;
        for (const pl of planes) if (pl.tex === oldest) { inUse = true; break; }
        if (inUse) break;
        cache.delete(oldestKey);
        oldest.dispose();
      }
    }, undefined, () => { inflight.delete(idx); });
  }
  return null;
}

/* ---------------------------------------------------------------- the planes */

const geometry = new THREE.PlaneGeometry(1, 1);
const planes = [];
let cols = 0, rows = 0, cellW = 0, cellH = 0, cellPitchY = 0, spanX = 0;
let hovered = null;

const paper = new THREE.Color(0xf4f1ea);

function buildPlanes() {
  for (const p of planes) { scene.remove(p); p.mat.dispose(); }
  planes.length = 0;

  const margin = 2;
  const availW = vw - GAP * 2;
  cols = Math.max(2, Math.min(7, Math.round(availW / 300)));
  cellW = (availW - GAP * (cols - 1)) / cols;
  cellH = cellW / COVER_AR;                    // cell matches the cover shape
  cellPitchY = cellH + GAP;
  rows = Math.ceil(vh / cellPitchY) + margin;
  spanX = cols * cellW + GAP * (cols - 1);

  for (let c = 0; c < cols; c++) {
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
      const plane = { mesh, mat, col: c, row: r, idx: -1, tex: null, pf: 1, x: 0, y: 0, vis: false };
      scene.add(mesh);
      planes.push(plane);
    }
  }
}

/* -------------------------------------------------------------------- layout */

let V = 0, H = 0;          // unbounded travel
let tV = 0, tH = 0;        // targets
let cV = 0, cH = 0;        // smoothed
let diff = 0;
let firstPaint = true;

function parallaxFactor(c) {
  return 1 - PARALLAX * (cols > 1 ? c / (cols - 1) : 0);
}

function layout() {
  for (const p of planes) p.pf = parallaxFactor(p.col);

  for (const p of planes) {
    const vy = V * p.pf;
    const r0 = Math.floor(vy / cellPitchY);
    const logicalRow = r0 + p.row;
    const y = logicalRow * cellPitchY - vy;               // >= 0, < rows*pitch

    // horizontal wrap: panning sideways cycles the band
    const hx = ((H + GAP + p.col * (cellW + GAP)) % spanX + spanX) % spanX;
    const logicalCol = Math.round((hx - GAP) / (cellW + GAP));

    p.x = hx - GAP - vw / 2 + cellW / 2;
    p.y = vh / 2 - (y + cellH / 2);

    // with the horizontal band wrapping, several planes can share an x; only
    // the ones actually on screen may be hit-tested or drawn over each other
    p.vis = (p.x + cellW / 2 > 0 && p.x - cellW / 2 < vw &&
             p.y + cellH / 2 > 0 && p.y - cellH / 2 < vh);

    const idx = ((logicalRow * cols + logicalCol - START_INDEX) % total + total) % total;
    if (idx !== p.idx) {
      p.idx = idx;
      p.tex = null;
      p.mat.uniforms.u_has.value = 0;
      const t = textureFor(idx, p);
      if (t) {
        p.tex = t;
        p.mat.uniforms.u_texture.value = t;
        p.mat.uniforms.u_has.value = 1;
        p.mat.uniforms.u_size.value.set(t.image.naturalWidth, t.image.naturalHeight);
      }
    }
    p.mesh.position.x = p.x;
    p.mesh.position.y = p.y;
    p.mat.uniforms.u_res.value.set(cellW, cellH);
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
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  moved += Math.abs(dx) + Math.abs(dy);
  tH += dx * 0.9;
  tV += -dy * 1.35;
  vX = dx * 0.9; vY = -dy * 1.35;
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  if (moved < 5) handleClick(e);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { dragging = false; document.body.classList.remove('dragging'); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 18 : 1;
  tV += e.deltaY * k * 1.1;
  tH += e.deltaX * k * 0.8;
}, { passive: false });

/* click -> open the full-resolution file; hit test against the plane layout */
function handleClick(e) {
  if (!hovered) return;
  const c = covers[hovered.idx];
  window.open(c.full, '_blank', 'noopener');
}

canvas.addEventListener('pointermove', (e) => {
  if (dragging) return;
  const nx = e.clientX - vw / 2, ny = vh / 2 - e.clientY;
  let best = null, bestD = 1e9;
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
canvas.addEventListener('pointerleave', () => {
  hovered = null;
  credit.classList.remove('on');
});

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
}
addEventListener('resize', resize);
resize();

/* --------------------------------------------------------------------- loop */

const layers = [...document.querySelectorAll('.backdrop .layer')];
let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(48, now - last); last = now;

  // inertia after a flick
  if (!dragging) {
    tV += vY * (dt / 16.6) * 0.55;
    tH += vX * (dt / 16.6) * 0.55;
    vY *= 0.93; vX *= 0.93;
    if (Math.abs(vY) < 0.02) vY = 0;
    if (Math.abs(vX) < 0.02) vX = 0;
  }

  const prevV = cV, prevH = cH;
  cV += (tV - cV) * 0.085;
  cH += (tH - cH) * 0.085;
  cV = Math.round(cV * 100) / 100;
  cH = Math.round(cH * 100) / 100;
  V = cV; H = cH;

  diff = Math.max(Math.abs((tV - cV) * 0.0001), Math.abs((tH - cH) * 0.0001));

  if (V !== prevV || H !== prevH) layout();
  for (const p of planes) p.mat.uniforms.u_diff.value = diff;

  // backdrop layers drift at their own fractions of the travel
  for (const l of layers) {
    const depth = parseFloat(l.dataset.depth);
    l.style.transform = `translate3d(${(-cH * depth * 0.9).toFixed(2)}px, ${(-cV * depth).toFixed(2)}px, 0)`;
  }

  sCur.x += (sTgt.x - sCur.x) * 0.3;
  sCur.y += (sTgt.y - sCur.y) * 0.3;
  stalker.style.transform = `translate3d(${sCur.x - 7.5}px, ${sCur.y - 7.5}px, 0)`;

  renderer.render(scene, camera);

  if (firstPaint && cache.size > 8) {
    firstPaint = false;
    loaderEl.classList.add('done');
  }
}

// preload a screenful, then start rendering
let n = 0;
for (const p of planes) { if (n++ > 40) break; layout(); }
requestAnimationFrame(tick);
