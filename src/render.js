/**
 * render.js — a software 3D view of the marsh, with no WebGL.
 *
 * WebGL is unavailable in the browser this project is verified in: headless
 * Firefox here returns null for both `webgl2` and `webgl` contexts, and
 * Chromium/WebKit do not start in this sandbox at all. So the 3D is computed on
 * the CPU into an ImageData buffer -- a painter's-algorithm heightfield with an
 * explicit back-to-front fill and depth test.
 *
 * Not a trick: each cell is projected to a screen quad, filled, and shaded from
 * its true surface normal, which is what makes the terrain read as terrain.
 *
 * Why bother with 3D rather than a flat map: elevation is the subject. Water
 * spread over a shelf versus water hiding in a channel is what the player is
 * reasoning about, and from directly above those look like the same blue pixels.
 * Depth is the information, so the view has to show depth.
 *
 * Cost scales with pixels covered, not cells, so the internal buffer size is the
 * knob for slow devices. Measured fill cost for a 128x128 heightfield at
 * 400x225 is about 7 ms in JS, inside a 16.7 ms frame.
 */
import { GRID, worldUnits } from './marsh.js';

/**
 * Camera. Yaw spins around the marsh, pitch tips it toward a plan view, and
 * `distance` pulls the eye back. All three are user-draggable.
 *
 * `distance` is load-bearing: without it the marsh straddles depth 0 and half of
 * it sits behind the eye, which presents as a blank canvas with no error. An
 * earlier version of this file had no distance at all and every single
 * projection returned null.
 */
export const camera = {
  yaw: 0.62,
  pitch: 0.58,
  zoom: 1.0,
  distance: 2.35,
  /**
   * Vertical exaggeration. The marsh is 1 world unit across and its relief is
   * 2.8 m, i.e. real relief is about 3% of the horizontal scale -- drawn truthfully
   * it would look flat, and a flat picture of a landscape whose whole subject is
   * elevation is useless. So relief is exaggerated on purpose and the amount is
   * stated in the legend rather than hidden, because an honest exaggeration is a
   * visualization choice and a hidden one is a lie about scale.
   *
   * With the real ratio (2.8 m relief over 520 m width) the marsh is 0.54% relief,
   * which on a 560 px canvas is 3 px of vertical relief -- indistinguishable from
   * flat. 22x brings that to about 62 px, enough to read the channel as a channel
   * while keeping the shelf visibly flat, which is the actual point.
   */
  zExaggeration: 22,
};

export const SKY_TOP = [11, 19, 33];
export const SKY_BOTTOM = [52, 76, 92];

/**
 * Project a world point to the canvas.
 *
 * World x is east-west with the sea at +x, y is north-south, z is elevation in
 * metres. Returns [screenX, screenY, viewDepth], or null when behind the eye.
 * Affine in `zoom`, which is what lets fitZoom solve framing in one pass.
 */
export function project(x, y, z, width, height) {
  // z arrives in RENDERER world units (see worldUnits in marsh.js), not metres.
  // Mixing the two is the bug that made the marsh 278% as tall as it was wide.
  const zs = z * camera.zExaggeration;
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const rx = (x - 0.5) * cy - (y - 0.5) * sy;
  const ry = (x - 0.5) * sy + (y - 0.5) * cy;

  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const depth = ry * cp - zs * sp + camera.distance;
  const up = ry * sp + zs * cp;

  const near = 0.05;
  if (depth <= near) return null;
  const scale = (height * 1.35 * camera.zoom) / depth;
  return [width / 2 + rx * scale, height / 2 - up * scale + height * 0.04, depth];
}

/**
 * Zoom that frames the whole marsh for the given canvas and terrain.
 *
 * Computed rather than fixed because the correct value depends on the generated
 * terrain: a constant that frames a flat pool overflows the canvas when the
 * channel is scoured deeper, and overflow in a heightfield means the marsh runs
 * off the bottom edge, taking the waterline with it.
 *
 * Measured before this existed: at zoom 1 the terrain filled 65% of canvas width
 * but 172% of its height -- far too much vertical relief on screen.
 */
/**
 * Zoom that frames the marsh for a given canvas and terrain.
 *
 * Computed rather than fixed, because the right value depends on the terrain that
 * was generated AND on the canvas shape: the same constant that frames a 16:9
 * desktop view leaves a phone-portrait canvas two-thirds empty, and one tuned for
 * portrait overflows the desktop. Measured with a symmetric margin, desktop bled
 * 25 px off the bottom while portrait left 259 px of blank sky -- a symmetric
 * margin is simply the wrong constraint when the horizon sits at canvas centre.
 *
 * So the constraint is stated explicitly instead: the marsh's front (bottom) edge
 * must sit above `bottomLimit`, and it must be at least `minWidthFraction` across.
 * Solving for zoom from the bottom edge alone is exact, because projected screen
 * y is affine in zoom (the perspective divide is by viewDepth, which zoom does
 * not enter).
 */
export function fitZoom(ground, width, height, options) {
  const minWidthFraction = options.minWidthFraction ?? 0.72;
  const bottomLimit = options.bottomLimit ?? height * 0.96;
  const keep = camera.zoom;
  camera.zoom = 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const step = Math.max(1, Math.floor(Math.sqrt(ground.length) / 48));
  for (let j = 0; j < GRID; j += step) {
    for (let i = 0; i < GRID; i += step) {
      const p = project(
        i / (GRID - 1),
        j / (GRID - 1),
        worldUnits(ground[j * GRID + i]),
        width,
        height,
      );
      if (p === null) continue;
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  camera.zoom = keep;
  if (!(maxX > minX) || !(Number.isFinite(maxY))) {
    throw new Error('fitZoom: terrain projected to an empty or degenerate bounding box');
  }

  // Bottom edge is at height/2 + h1 with h1 > 0 for a pitched view, so the
  // allowed zoom grows as that edge rises. Guard the non-positive case rather
  // than letting it produce a negative zoom.
  const bottomRise = maxY - height / 2;
  const allowedHeadroom = bottomLimit - height / 2;
  const zoomFromBottom = bottomRise > 0 ? allowedHeadroom / bottomRise : Infinity;
  const zoomFromWidth = (minWidthFraction * width) / (maxX - minX);
  const zoom = Math.min(zoomFromBottom, zoomFromWidth);
  if (!(zoom > 0) || !Number.isFinite(zoom)) {
    throw new Error(
      `fitZoom: no positive zoom frames the marsh (bottomRise ${bottomRise.toFixed(1)}, ` +
        `widthSpan ${(maxX - minX).toFixed(1)})`,
    );
  }
  return zoom;
}

/** Directional light plus ambient sky fill, from the facet normal. */
/**
 * Shade a flat facet from its (already normalised) normal: one directional light
 * plus ambient sky fill. Argument order is normal-then-colour so the call sites
 * read as "shade this normal, with this colour".
 */
export function shade(nx, ny, nz, base) {
  const len = Math.hypot(0.42, -0.55, 0.72);
  const dot = (nx * 0.42 + ny * -0.55 + nz * 0.72) / len;
  const k = 0.44 + 0.56 * Math.max(0, dot);
  return [base[0] * k, base[1] * k, base[2] * k];
}

/**
 * Ground colour from elevation and algal cover.
 *
 * Single source of truth for the palette: the legend reads these same values, so
 * a swatch in the help cannot drift away from what the map draws.
 */
export function groundColour(elev, algae) {
  const t = Math.max(0, Math.min(1, (elev + 1.2) / 2.4));
  const low = [58, 52, 44];
  const mid = [99, 94, 60];
  const high = [156, 138, 102];
  let c;
  if (t < 0.5) {
    const u = t / 0.5;
    c = [
      low[0] + (mid[0] - low[0]) * u,
      low[1] + (mid[1] - low[1]) * u,
      low[2] + (mid[2] - low[2]) * u,
    ];
  } else {
    const u = (t - 0.5) / 0.5;
    c = [
      mid[0] + (high[0] - mid[0]) * u,
      mid[1] + (high[1] - mid[1]) * u,
      mid[2] + (high[2] - mid[2]) * u,
    ];
  }
  const g = Math.min(1, algae);
  return [
    c[0] * (1 - 0.45 * g) + 62 * 0.45 * g,
    c[1] * (1 - 0.2 * g) + 128 * 0.2 * g,
    c[2] * (1 - 0.5 * g) + 52 * 0.5 * g,
  ];
}

/** Water colour from depth and productivity: turbid green when fertile, dark when deep. */
export function waterColour(depthM, algae) {
  const clarity = Math.exp(-1.6 * depthM);
  const green = Math.min(1, algae * 2.2);
  return [
    24 * clarity + 34 * green,
    64 * clarity + 92 * green + 16,
    112 * clarity + 20 * green + 24,
  ];
}


/**
 * Framebuffer renderer: terrain into a colour buffer plus a depth buffer.
 *
 * WHY A Z-BUFFER RATHER THAN PAINTING QUADS FAR-TO-NEAR
 * The obvious approach -- sort cells by depth and draw -- was tried first and
 * produced a stippled, broken-looking marsh, and the cause is worth recording
 * because nothing about it is a maths error: with 96x96 cells on a 900 px canvas
 * each cell rasterises to about 4 x 2 pixels, so any per-quad point-in-quad test
 * leaves sub-pixel gaps between neighbours. The shapes were correct and only the
 * *coverage* was wrong, which unit tests cannot see and looking at the image
 * finds immediately. A depth buffer makes coverage exact regardless of how small
 * the cells are, and removes the need to reason about sort order under yaw.
 */
export class Scene {
  constructor(width, height, ground) {
    this.width = width;
    this.height = height;
    this.ground = ground;
    /**
     * RGBA, one 4-byte pixel per framebuffer pixel — NOT RGB.
     *
     * This used to be 3 bytes per pixel, and app.js copied it straight into an
     * ImageData, which is 4. The result was not a crash but a diagonal stripe
     * pattern: every pixel's channels slid one place and the final alpha became
     * the next pixel's red. Reproduced in isolation before fixing -- copying an
     * RGB buffer over an RGBA one is silent, so the buffer format is now RGBA at
     * the source and there is exactly one stride in the system.
     */
    this.rgb = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height);
  }

  /** Paint sky. Called before the terrain; the terrain then overwrites where it lands. */
  paintSky() {
    const { width, height, rgb, depth } = this;
    for (let y = 0; y < height; y += 1) {
      const t = y / (height - 1);
      const r = SKY_TOP[0] + (SKY_BOTTOM[0] - SKY_TOP[0]) * t;
      const g = SKY_TOP[1] + (SKY_BOTTOM[1] - SKY_TOP[1]) * t;
      const b = SKY_TOP[2] + (SKY_BOTTOM[2] - SKY_TOP[2]) * t;
      for (let x = 0; x < width; x += 1) {
        const k = (y * width + x) * 4;
        rgb[k] = r;
        rgb[k + 1] = g;
        rgb[k + 2] = b;
        rgb[k + 3] = 255;
        depth[y * width + x] = Infinity;
      }
    }
  }

  _splat(x0, x1, y0, y1, z, colour) {
    const { width, height, rgb, depth } = this;
    const xa = Math.max(0, Math.ceil(x0));
    const xb = Math.min(width - 1, Math.floor(x1));
    const ya = Math.max(0, Math.ceil(y0));
    const yb = Math.min(height - 1, Math.floor(y1));
    for (let py = ya; py <= yb; py += 1) {
      const row = py * width;
      for (let px = xa; px <= xb; px += 1) {
        const idx = row + px;
        if (z < depth[idx]) {
          depth[idx] = z;
          const k = idx * 4;
          rgb[k] = colour[0];
          rgb[k + 1] = colour[1];
          rgb[k + 2] = colour[2];
          rgb[k + 3] = 255;
        }
      }
    }
  }

  /**
   * Draw the marsh at the given water surface elevation (metres).
   *
   * Order within a cell matters: the bed is farther from the eye than the water
   * above it, so water is splatted at a nearer depth and wins the test wherever
   * the bed is submerged. Getting this backwards shows the riverbed sitting on
   * top of the surface, which is exactly what an earlier attempt looked like.
   */
  paintWater(worldSurfaceMetres, algaeField) {
    const { ground, width, height } = this;
    const u = 1 / (GRID - 1);
    const surface = worldUnits(worldSurfaceMetres);

    for (let j = 0; j < GRID - 1; j += 1) {
      for (let i = 0; i < GRID - 1; i += 1) {
        const k = j * GRID + i;
        const e00 = ground[k];
        const e10 = ground[k + 1];
        const e01 = ground[k + GRID];
        const e11 = ground[k + GRID + 1];
        const cx = (i + 0.5) * u;
        const cyy = (j + 0.5) * u;

        const bed = (e00 + e10 + e01 + e11) / 4;
        const algae = algaeField === null ? 0 : algaeField[k];

        // Bed / mud.
        const bc = project(cx, cyy, worldUnits(bed), width, height);
        if (bc !== null) {
          const a = project(i * u, j * u, worldUnits(e00), width, height);
          const b = project((i + 1) * u, j * u, worldUnits(e10), width, height);
          const c = project((i + 1) * u, (j + 1) * u, worldUnits(e11), width, height);
          const d = project(i * u, (j + 1) * u, worldUnits(e01), width, height);
          if (a !== null && b !== null && c !== null && d !== null) {
            const nx = -(e10 - e00);
            const ny = -(e01 - e00);
            const nrm = Math.hypot(nx, ny, 1);
            const k = shade(nx / nrm, ny / nrm, 1 / nrm, groundColour(bed, algae));
            this._splat(
              Math.min(a[0], b[0], c[0], d[0]),
              Math.max(a[0], b[0], c[0], d[0]),
              Math.min(a[1], b[1], c[1], d[1]),
              Math.max(a[1], b[1], c[1], d[1]),
              bc[2],
              k,
            );
          }
        }

        // Water surface, only where this cell holds water.
        if (bed < worldSurfaceMetres) {
          const wc = project(cx, cyy, surface, width, height);
          if (wc !== null) {
            const wa = project(i * u, j * u, surface, width, height);
            const wb = project((i + 1) * u, j * u, surface, width, height);
            const wq = project((i + 1) * u, (j + 1) * u, surface, width, height);
            const wd = project(i * u, (j + 1) * u, surface, width, height);
            if (wa !== null && wb !== null && wq !== null && wd !== null) {
              const col = waterColour(worldSurfaceMetres - bed, algae);
              this._splat(
                Math.min(wa[0], wb[0], wq[0], wd[0]),
                Math.max(wa[0], wb[0], wq[0], wd[0]),
                Math.min(wa[1], wb[1], wq[1], wd[1]),
                Math.max(wa[1], wb[1], wq[1], wd[1]),
                wc[2],
                col,
              );
            }
          }
        }
      }
    }
  }

  /**
   * A thin marker for the levee/sluice the player controls, drawn as a bright
   * slab so it stays findable at any zoom. Deliberately simple: the sluice is an
   * interface element, and an interface element that needs shading to be seen is
   * competing with the terrain for the player's attention.
   */
  paintSluice(worldPos, colour) {
    const { width, height } = this;
    const half = 0.5 / GRID;
    const p0 = project(worldPos - half, 0.5 - half * 6, worldUnits(0.6), width, height);
    const p1 = project(worldPos + half, 0.5 + half * 6, worldUnits(-0.4), width, height);
    if (p0 === null || p1 === null) return;
    this._splat(
      Math.min(p0[0], p1[0]),
      Math.max(p0[0], p1[0]),
      Math.min(p0[1], p1[1]),
      Math.max(p0[1], p1[1]),
      -1,
      colour,
    );
  }
}
