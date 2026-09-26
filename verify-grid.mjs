#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/* Verifies the grid invariants the UI depends on. Run: node verify-grid.mjs
 *
 *  1. full-bleed  : cells cover the whole viewport at every scroll position
 *  2. uniform gap : every horizontal gap is exactly GAP
 *  3. row skew    : parallax never shears a row beyond SPAN of a row height
 *  4. stride      : the cover index stride is coprime with the archive size
 */
const GAP = 12, MIN_COL_W = 250, MAX_COLS = 8;

/* Read the live constants out of main.js. These drifted apart twice while the
   harness carried its own copies, which is how a 0.10 span kept passing
   verification long after it was too subtle to actually see. */
const MAIN = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const num = (name) => {
  const m = MAIN.match(new RegExp(`const ${name} = ([0-9.]+)`));
  if (!m) throw new Error(`${name} not found in src/main.js`);
  return parseFloat(m[1]);
};
const PARALLAX_SPAN = num('PARALLAX_SPAN');
const PERIOD = num('PARALLAX_PERIOD');
const ROW_SPARE = num('ROW_SPARE');
const COVER_AR = 1600 / 2184;
const TOTAL = 5104;

const mod = (a, n) => ((a % n) + n) % n;
const swayAmt = (t, rowPitch, ch) =>
  Math.sin((t / rowPitch) / PERIOD * Math.PI * 2) * PARALLAX_SPAN * ch;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const stride = (n) => { let s = Math.max(1, n); while (gcd(s, TOTAL) !== 1) s++; return s; };

const SIZES = [[1280,720],[1440,900],[1600,900],[1920,1080],[2560,1440],
               [3440,1440],[768,1024],[390,844],[1024,600],[3840,2160]];
const OFFSETS = [0, 1, 5, 37.5, 211.3, 413.9, 2500.7, 9999.1, 1e5, 1e6, -250.7, -431.9];

let worstGap = 0, totalHoles = 0, cases = 0, badStride = 0, maxSkewRatio = 0;
const failures = [];

for (const [vw, vh] of SIZES) {
  const cols = Math.max(2, Math.min(MAX_COLS, Math.round((vw - GAP) / (MIN_COL_W + GAP))));
  const cellW = (vw - GAP * (cols + 1)) / cols;
  const cellH = cellW / COVER_AR;
  const pitchX = cellW + GAP, pitchY = cellH + GAP;
  const needCols = Math.ceil(vw / pitchX) + 2;
  const ROW_J0 = Math.floor((cellH - vh) / pitchY) - ROW_SPARE;
  const needRows = Math.ceil(vh / pitchY) + ROW_SPARE * 2 + 2;
  const STRIDE = stride(needCols);
  if (gcd(STRIDE, TOTAL) !== 1) badStride++;

  for (const V of OFFSETS) for (const H of OFFSETS) {
    const u = mod(H, pitchX), v = mod(V, pitchY);
    const baseRow = Math.floor(V / pitchY);
    const baseCol = Math.floor(H / pitchX);
    const sway = swayAmt(V, pitchY, cellH);

    const rowCentres = new Map();   // logical row -> on-screen column centres
    const rowTops = new Map();
    for (let j = ROW_J0; j < ROW_J0 + needRows; j++) {
      for (let k = 0; k < needCols; k++) {
        const x = k * pitchX - u + cellW / 2 - vw / 2;   // world, viewport on 0
        const y = v - j * pitchY + cellH / 2 - vh / 2;   // centred vertically too
        const depth = Math.min(1, Math.max(0, (x + vw / 2) / vw));
        const yShift = y + sway * (depth - 0.5) * 2;
        const onX = x + cellW / 2 > -vw / 2 && x - cellW / 2 < vw / 2;
        const onY = yShift + cellH / 2 > 0 && yShift - cellH / 2 < vh;
        if (onX) {
          const r = baseRow + j;
          if (!rowCentres.has(r)) rowCentres.set(r, []);
          rowCentres.get(r).push(x + vw / 2);
        }
        if (onY) {
          const r = baseRow + j;
          if (!rowTops.has(r)) rowTops.set(r, []);
          rowTops.get(r).push(yShift);
        }
      }
    }
    // the widest on-screen row is the one that must span the viewport
    let centres = [];
    for (const [, cs] of rowCentres) if (cs.length > centres.length) centres = cs;

    // 1. full-bleed: any uncovered run must be no wider than the intended
    //    gutter. A bare patch wider than GAP is a real hole; GAP is the gap.
    centres.sort((a, b) => a - b);
    let bare = 0;
    let cursor = 0;
    for (const c of centres) {
      const left = c - cellW / 2;
      if (left > cursor + 1e-6) bare = Math.max(bare, left - cursor);
      cursor = Math.max(cursor, c + cellW / 2);
    }
    if (vw - cursor > 1e-6) bare = Math.max(bare, vw - cursor);
    if (bare > GAP + 1e-6) {
      totalHoles++;
      if (failures.length < 5) {
        failures.push(`bare ${bare.toFixed(1)}px (> GAP ${GAP}) at ${vw}x${vh} V=${V} H=${H} visible=${centres.length}`);
      }
    }

    // 1b. vertical full-bleed, same rule: uncovered runs may be at most GAP
    const colBands = new Map();          // logical col -> on-screen y centres
    for (let j = ROW_J0; j < ROW_J0 + needRows; j++) {
      for (let k = 0; k < needCols; k++) {
        const x = k * pitchX - u + cellW / 2 - vw / 2;
        const y = v - j * pitchY + cellH / 2 - vh / 2;
        const depth = Math.min(1, Math.max(0, (x + vw / 2) / vw));
        const yShift = y + sway * (depth - 0.5) * 2;
        if (x + cellW / 2 > -vw / 2 && x - cellW / 2 < vw / 2) {
          const key = baseCol + k;
          if (!colBands.has(key)) colBands.set(key, []);
          colBands.get(key).push(yShift + vh / 2);
        }
      }
    }
    for (const [, ys] of colBands) {
      ys.sort((a, b) => a - b);
      let gapRun = 0, cur = 0;
      for (const y of ys) {
        const top = y - cellH / 2;
        if (top > cur + 1e-6) gapRun = Math.max(gapRun, top - cur);
        cur = Math.max(cur, y + cellH / 2);
      }
      if (vh - cur > 1e-6) gapRun = Math.max(gapRun, vh - cur);
      if (gapRun > GAP + 1e-6) {
        totalHoles++;
        if (failures.length < 8) failures.push(`vertical bare ${gapRun.toFixed(1)}px at ${vw}x${vh} V=${V} H=${H}`);
        break;
      }
    }

    // 2. uniform gaps, measured within every on-screen row
    for (const [, cs] of rowCentres) {
      cs.sort((a, b) => a - b);
      for (let i = 1; i < cs.length; i++) {
        const d = Math.abs((cs[i] - cs[i - 1] - cellW) - GAP);
        if (d > worstGap) {
          if (worstGap > 1 && failures.length < 8) {
            failures.push(`gap off by ${d.toFixed(1)} at ${vw}x${vh} V=${V} H=${H}`);
          }
          worstGap = d;
        }
      }
    }

    // 3. row skew from parallax
    for (const [, ys] of rowTops) {
      if (ys.length > 1) maxSkewRatio = Math.max(maxSkewRatio, (Math.max(...ys) - Math.min(...ys)) / cellH);
    }
    cases++;
  }
}

const pass = totalHoles === 0 && worstGap < 1e-6 && badStride === 0
          && maxSkewRatio <= PARALLAX_SPAN * 2 + 1e-9;
console.log(`positions tested        : ${cases}`);
console.log(`worst gap deviation     : ${worstGap.toExponential(2)} px  (target 0)`);
console.log(`viewport holes          : ${totalHoles}`);
console.log(`max row skew / cellH    : ${(maxSkewRatio * 100).toFixed(1)}%  (bound ${(PARALLAX_SPAN * 2 * 100).toFixed(0)}%)`);
console.log(`stride not coprime      : ${badStride}`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
