# Every New Yorker Cover, 1925–2026

All **5,104** covers the magazine has published since its first issue on
21 February 1925, as an infinite draggable WebGL grid.

## Layout

Grid behaviour is adapted from
[Jesper Landberg's "Infinite scrollable and draggable (WebGL) grid"](https://codepen.io/ReGGae/pen/eYGyLrP)
(MIT). The parallax treatment and custom cursor follow
[nemutas/draggable](https://nemutas.github.io/draggable/).

Two deliberate departures from the original pen:

- **It is genuinely infinite.** The pen wrapped 15 fixed cells. Here one
  unbounded float `V` drives the field and every cover index is derived from
  position, so there are 5,104 items and no seams. Vertical travel is
  self-wrapping; horizontal travel wraps the column band.
- **Covers are never cropped.** The pen's fragment shader used `cover()`,
  which fills the cell and cuts the artwork off. This uses `contain()`, so each
  cover is shown whole. Every cell is identical and the gap is a fixed
  `GAP`, so spacing is uniform across the whole archive.

Parallax comes from giving each column its own factor
`pf = 1 - 0.34 * c/(cols-1)`, so columns drift apart as you travel.

## Why the archive ships alongside WebP thumbs

`public/archive/` holds the full-resolution files (2.6 GB) exactly as
scraped. `public/covers/` holds 280px WebP copies (86 MB) that the grid
actually renders — a 1600×2184 RGBA texture is ~14 MB, so ~60 visible covers
would otherwise need ~840 MB of VRAM. Click any cover to open the full-size
file.

## Data provenance

Covers were scraped from `newyorker.com`'s own public issue pages. Cover
credits are *not* included: they are not present on the issue pages, and the
`/culture/cover-story/` pages that do carry artist names exist only
sporadically (2020 and 2026 have them, 2012 and earlier do not).

These covers are copyrighted commissioned artwork. This is an archive for
personal use; republishing the images is not covered by that. Condé Nast
licenses cover art commercially.

## Commands

```bash
npm install
npm run dev        # local dev
npm run build      # -> dist/
npm run preview    # serve the build

./scripts/thumbs.sh [srcDir] [dstDir] [width] [quality]   # regenerate thumbs
```

`scripts/thumbs.sh` shells out to `cwebp` and `sips` (macOS). The 18 covers
that ship as GIF need `sips` first, since `cwebp` cannot read GIF input.
