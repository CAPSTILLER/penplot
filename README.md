# Pen Plot

**Drawings → pen-plotter G-code for a 3D printer with a pen.** Built for Cap's Creality Ender-5 Pro with a side-mounted, spring-less pen. Live at **https://penplot.gearup.wtf**.

Pen Plot does **not** slice. It turns vector lines straight into moves:

```
pen up → dwell → travel → pen down → dwell → draw → pen up …
```

Every travel is a pen-up travel, so there are no slicer "drag lines". It never sends extrusion (`E`) moves and never heats. The only heater commands are `M104 S0` and `M140 S0`.

Everything runs in the browser. There's no server, no API keys, and no uploads. Profiles are saved in `localStorage`.

## Features

- **Printer profiles**: the Ender-5 Pro default (220 × 220 bed) plus editable custom profiles. Each profile holds:
  - pen X/Y offset from the nozzle
  - pen-down Z, pen lift (sets pen-up Z) and safe travel Z
  - draw, travel and Z speeds
  - `G4 P<ms>` dwell after pen down and after pen up
  - optional corner dwell or slow-down
  - editable start/end G-code with `{placeholders}`
- **Safety rules**:
  - After your start G-code, the first move always lifts to safe Z.
  - No Z below pen-down Z is ever emitted.
  - Any user start/end G-code line that heats or extrudes is commented out.
  - Every XY move is limited to the nozzle's travel limits.
- **Pen offset**: the file contains nozzle coordinates, while the preview shows the pen tip. The reachable pen area is the nozzle limits shifted by the offset, intersected with the bed. It shows up on the preview, and anything outside it is flagged and then clipped (default) or clamped.
- **Inputs**:
  - **SVG**: path, line, polyline, polygon, rect (including rounded), circle, ellipse and `<use>`, with nested transforms and viewBox/units respected. Curves are flattened to a tolerance.
  - **Image**: three trace modes. *Centerline* thins ink lines to single strokes, *Outline* uses marching-squares contours and *Edges* uses Sobel plus thinning. There's a threshold slider and an optional hatch fill (spacing in real mm).
  - **Text**: Hershey Roman Simplex, a single-stroke font, so letters are drawn once rather than as outlines.
  - **Placement**: move, scale, set width, rotate, mirror, and fit to the reachable area with a margin.
- **Optimization**: nearest-neighbor reordering, reversing strokes, starting loops at their nearest vertex, merging strokes whose ends touch, and dropping tiny segments and strokes. It shows pen-up travel before and after.
- **Preview**: a true-scale bed canvas. Pen-down lines are gold, pen-up travel is dashed cyan and the unreachable area is red. The playback scrubber shows the pen tip and the nozzle position.
- **Calibration**:
  - *Pen-height test*: a row of squares (8 by default), each one step lower in Z. Tap the first clean square to set pen-down Z. The export header lists each square's Z.
  - *Offset test*: a crosshair at bed center with X/Y labels inside a known square. Correct the offset by jogging the nozzle over the mark or by measuring the miss with a ruler.
- **Export**: a `.gcode` file whose comment header lists the settings, estimated time and exact line count.

## Develop

```bash
npm install
npm run dev      # local dev server
npm test         # vitest unit tests
npm run build    # tsc -b && vite build → dist/
```

`npm test` also regenerates `samples/sample.gcode` from `tests/fixtures/sample.svg`, then parses it back to check every pen rule.

## Deploy (Vercel)

Import the GitHub repo in Vercel and set framework **Vite**, root directory `.`, build `npm run build`, output `dist`. Then add the domain `penplot.gearup.wtf`. DNS is a DNS-only CNAME to `cname.vercel-dns.com`.

## Pen-on-printer tips

1. **Level the bed first.** With no spring, the pen can't absorb any tilt.
2. **Check homing clearance.** On the Ender-5, `G28` raises the bed to the nozzle. If the pen tip hangs below the nozzle and sits over the bed at the home position, homing will push the bed into the pen. Mount the pen so it clears at home, or home before fitting the pen.
3. Run the **pen-height test**, and tap the first square that draws cleanly all the way round.
4. Run the **offset test** so the drawing lands where the preview shows it.
5. The first move after homing always drops the bed to **safe Z** before any XY travel.

## Credits

The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards. The format of the Font data in this distribution was originally created by James Hurt, Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821 (mit-eddie!ci-dandelion!hurt). Font data is from [kamalmostafa/hershey-fonts](https://github.com/kamalmostafa/hershey-fonts) (`futural.jhf`), converted by `scripts/build-hershey.mjs`.

By Capstiller · [gearup.wtf](https://gearup.wtf)
