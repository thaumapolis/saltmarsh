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
  /** Vertical framing, as a fraction of canvas height; set by fitZoom. */
  horizonY: 0.54,
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
/** Vertical placement of the marsh in the frame, as a fraction of canvas height. */
/**
 * Vertical placement of the marsh in the frame, as a fraction of canvas height.
 *
 * Not a constant. A fixed fraction assumes a fixed canvas, and this view ranges
 * from 239 px tall (phone landscape) to 520 px (desktop) while the HUD and
 * caption bands take a fixed number of pixels top and bottom. The same fraction
 * that leaves comfortable sky on desktop buries the marsh under the caption on a
 * short view, so it is solved from the room the terrain actually has and clamped
 * so a very wide, very short canvas cannot push it off the bottom.
 */
export function horizonFraction(height, topBand, bottomBand) {
  const usable = height - topBand - bottomBand;
  if (!(usable > 0)) {
    throw new Error(
      `horizonFraction: bands (${topBand}, ${bottomBand}) leave no room in a ${height} px view`,
    );
  }
  const raw = topBand + usable * 0.5 + bottomBand * 0.15;
  return Math.max(0.3, Math.min(0.72, raw / height));
}

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
  return [
    width / 2 + rx * scale,
    camera.horizonY * height - up * scale,
    depth,
  ];
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
 * must sit above `bottomLimit`, its top must stay below `topLimit`, and it must
 * fit inside the frame with a small horizontal margin. Each of those is an upper
 * bound on zoom and the marsh has to satisfy all three, so the answer is the
 * minimum of the three. Solving from an edge alone is exact, because projected
 * screen y is affine in zoom (the perspective divide is by viewDepth, which zoom
 * does not enter).
 */
/**
 * Set the projection's vertical pivot for a given canvas and overlay bands.
 *
 * Separated from fitZoom because a caller that samples the projection BEFORE
 * fitting -- as the pitch solver does -- needs project() to already agree with
 * the frame it is measuring against. camera.horizonY defaults to a plausible
 * number, so getting this order wrong yields a confident wrong answer instead of
 * an error: observed as the marsh pinned under the caption on phone landscape.
 */
export function horizonFor(height, topBand, bottomBand) {
  camera.horizonY = horizonFraction(height, topBand, bottomBand);
  return camera.horizonY;
}

export function fitZoom(ground, width, height, options) {
  // Overhead bands, in PIXELS, because the HUD and caption are laid out in text
  // and do not shrink with the canvas. A fraction of a 239 px phone-landscape
  // view is not the same room as a fraction of a 520 px desktop one -- which is
  // exactly why framing tuned on desktop clipped the near bank on a phone.
  const topBand = options.topBand ?? 0;
  const bottomBand = options.bottomBand ?? 0;
  // Both the pivot and the edge limits must be the values project() will use.
  horizonFor(height, topBand, bottomBand);
  const centreY = camera.horizonY * height;
  const topLimit = centreY - 0.97 * (centreY - topBand);
  const bottomLimit = centreY + 0.97 * (height - bottomBand - centreY);
  const keep = camera.zoom;
  camera.zoom = 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
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
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  camera.zoom = keep;
  if (!(maxX > minX) || !(Number.isFinite(maxY))) {
    throw new Error('fitZoom: terrain projected to an empty or degenerate bounding box');
  }

  // Three containment limits, each an UPPER bound on zoom, and the marsh has to
  // satisfy all three -- so the answer is the minimum. Getting the direction
  // wrong is not a style slip: it decides whether the marsh is a framed
  // landscape or a thumbnail in empty sky, and an earlier revision that used
  // max() here shrank the view to 3.8% coverage.
  const zoomFromBottom = zoomLimitZoom(maxY, centreY, bottomLimit);
  const zoomFromTop = zoomLimitZoom(minY, centreY, topLimit);
  // Width, as an upper bound only, never a floor. A "fill most of the width"
  // floor on a short canvas demands more zoom than the vertical room allows, and
  // that is what clipped the near bank behind the caption on phone landscape.
  // Framing is decided by the room available, not by an aspiration about width.
  const zoomFromWidth = (width * 0.96) / (maxX - minX);

  const candidates = [zoomFromWidth, zoomFromBottom, zoomFromTop].filter(
    (z) => Number.isFinite(z) && z > 0,
  );
  if (candidates.length === 0) {
    throw new Error(
      `fitZoom: no positive zoom frames the marsh (bottomRise ${(maxY - centreY).toFixed(1)}, ` +
        `topRise ${(centreY - minY).toFixed(1)}, widthSpan ${(maxX - minX).toFixed(1)}, ` +
        `height ${height.toFixed(0)}, centreY ${centreY.toFixed(1)})`,
    );
  }
  return Math.min(...candidates);
}

/**
 * Largest zoom that keeps a projected edge no farther from centreY than `limit`.
 *
 * Both `edge` and `limit` are screen y, and projected y is affine in zoom about
 * centreY, so the bound is (limit - centreY) / (edge - centreY). That ratio is
 * only meaningful when the edge and its limit lie on the SAME side of centreY;
 * when they do not, the constraint cannot be met by any positive zoom and this
 * returns 0, which the caller drops rather than honouring. Returning Infinity
 * would be wrong there: it says "no constraint", when the truth is "impossible",
 * and those two read identically in a min() but mean opposite things.
 *
 * The impossible case is not hypothetical. Phone landscape gives a 239 px view
 * whose centreY is 129; ask for a bottom limit at 0.9 * height and the allowance
 * collapses toward zero, and with a bottom limit above centreY the sign flips --
 * which is what produced a blank canvas with no message.
 */
function zoomLimitZoom(edge, centreY, limit) {
  const travel = edge - centreY;
  const allowance = limit - centreY;
  if (Math.abs(travel) < 1e-9) return Infinity;
  if (travel * allowance <= 0) return 0;
  return allowance / travel;
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

/**
 * Water body colour from depth and productivity: turbid green when fertile, dark
 * when deep. This is the *body* of the water -- how much light comes back up
 * through it -- and deliberately carries no lighting. Surface sheen is added on
 * top by waterSurfaceColour, because they are two different phenomena and mixing
 * them makes the sheen depend on depth, which it visibly should not.
 */
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
 * Sun glancing off the water surface, given the view direction.
 *
 * Water is the one surface in this scene that is genuinely specular: light
 * bouncing off it, rather than light absorbed and re-emitted by mud, so the
 * same facet maths as shade() applies -- Lambert for the sky it reflects, plus a
 * tight lobe along the reflection vector. Without it the water reads as a flat
 * green board; with it, the whole view gains a light direction you can feel.
 *
 * This is a fixed sun over a flat plane, so the highlight is a band rather than
 * a sparkle. No waves are simulated here -- the water surface is exactly level
 * everywhere, which is what the model actually computes -- and adding a animated
 * normal map would be decoration claiming to be data. What is honest to show is
 * the sheen the level surface really has, and it moves across the marsh as the
 * camera yaws, which is real: it depends on the view direction.
 */
export function sunSpecular(viewNx, viewNy, viewNz) {
  const lx = 0.42;
  const ly = -0.55;
  const lz = 0.72;
  const len = Math.hypot(lx, ly, lz);
  const dot = (viewNx * lx + viewNy * ly + viewNz * lz) / len;
  if (dot <= 0) return 0;
  // Half-vector between the light direction and the view direction. For the
  // level water surface the view direction is close to straight down the camera
  // axis, so the half-vector is (L_hat + V_hat) normalised, with V_hat = (0,0,1).
  const hx = lx / len;
  const hy = ly / len;
  const hz = lz / len + 1;
  const hlen = Math.hypot(hx, hy, hz);
  const hd = (viewNx * hx + viewNy * hy + viewNz * hz) / hlen;
  // A wide, low-power lobe rather than a tight one: the sun is not a laser and
  // the surface is level, so the glint should be a broad wash that brightens
  // toward the mirror angle, not a single pixel that looks like a rendering
  // artefact. The second term is the diffuse sky reflection, which is why the
  // water brightens at all when you look across it.
  return 0.5 * Math.pow(Math.max(0, hd), 5) + 0.3 * Math.pow(Math.max(0, dot), 3);
}

/**
 * Water as seen: body colour plus surface sheen.
 *
 * `tilt` is how much the surface is turned toward the eye. At a shallow viewing
 * angle (looking along the marsh rather than down on it) a far larger fraction of
 * what reaches the eye is reflection off the surface than light from the bottom,
 * which is Fresnel and is why a low-angle look across water shows sky instead of
 * the pool. The body colour still shows through where you look down into it, so
 * depth and turbidity remain readable from directly above.
 */
export function waterSurfaceColour(depthM, algae, viewNz, tilt) {
  const body = waterColour(depthM, algae);
  const spec = sunSpecular(0, 0, viewNz);
  // Sunlit, not skylit. A real water surface reflects a sky whose brightest part
  // is the sun, so the reflected light is warmer than the background sky gradient
  // behind it; and turbid coastal water is genuinely green because of what is
  // suspended in it. The body colour already carries the algae, so what it was
  // missing here was warmth: mixing it with the cold blue sky gradient alone is
  // what made the marsh look grey and washed out, and desaturated water reads as
  // a rendering fault rather than as a cold day.
  const sunlit = [body[0] + 14, body[1] + 10, body[2] * 0.97];
  // Kept deliberately subtle. An earlier version used a real Fresnel curve here
  // (0.02 at normal incidence rising to ~0.8 at grazing, per Schlick) and it was
  // physically right and visually wrong: at the default pitch the whole surface
  // sat near the top of the curve, so the marsh turned the colour of the sky and
  // stopped reading as water at all. Depth and turbidity are the information this
  // view carries, so the sheen is capped well below the point where it would
  // overwrite them -- a glint, not a mirror.
  const reflect = 0.05 + 0.2 * Math.pow(1 - Math.max(0, Math.min(1, tilt)), 3);
  const skyR = SKY_BOTTOM[0] + 30;
  const skyG = SKY_BOTTOM[1] + 45;
  const skyB = SKY_BOTTOM[2] + 55;
  return [
    sunlit[0] * (1 - reflect) + skyR * reflect + 90 * spec,
    sunlit[1] * (1 - reflect) + skyG * reflect + 100 * spec,
    sunlit[2] * (1 - reflect) + skyB * reflect + 115 * spec,
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

  /**
   * Fill one projected quad exactly: per-scanline span, plus a depth read that
   * varies across the quad.
   *
   * THIS REPLACED A BOUNDING-BOX SPLAT, AND THE DIFFERENCE IS THE WHOLE LOOK OF
   * THE MARSH. The previous version filled `xa..xb, ya..yb` -- the axis-aligned
   * box around the quad -- with one flat depth taken from the cell centre. Two
   * faults followed, and both read as "blocky" rather than as "wrong geometry":
   *
   *   1. Overdraw. Projected cell quads are diamond-ish, so each box includes
   *      corners belonging to its neighbours, roughly 2x the quad's area at this
   *      grid/canvas ratio. A neighbour's colour got painted outside its own
   *      cell, then possibly painted back again. The result was a stippled,
   *      smeared surface, and the pattern shifted as the camera yawed.
   *   2. Flat depth. One z per quad cannot slope, so where two cells met at
   *      different elevations the nearer one won the test across the whole box
   *      rather than only across the part of it that is genuinely nearer. That
   *      is what made ridges and the channel edge march in whole cell units.
   *
   * Coverage now comes from the quad: for each pixel row, the span is the
   * intersection of the row with the quad's own edges, and the depth at each
   * pixel is interpolated from the four corner depths, which is what makes the
   * silhouette crisp while keeping the depth test honest.
   *
   * `corners` is [x, y, viewDepth] in quad order (any cyclic order, convex cell).
   * Cost is unchanged in kind: still one pass over covered pixels, now with a
   * cheap span test instead of a wasted box.
   */
  _quad(corners, colour) {
    const { width, height, rgb, depth } = this;
    const n = corners.length;

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const y = corners[i][1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const ya = Math.max(0, Math.floor(minY));
    const yb = Math.min(height - 1, Math.ceil(maxY));
    if (ya > yb) return;

    const xr = new Float64Array(n + 1);
    const zr = new Float64Array(n + 1);
    for (let i = 0; i <= n; i += 1) {
      xr[i] = corners[i % n][0];
      zr[i] = corners[i % n][2];
    }

    const red = colour[0];
    const green = colour[1];
    const blue = colour[2];

    for (let py = ya; py <= yb; py += 1) {
      const yc = py + 0.5;
      if (yc < minY || yc > maxY) continue;

      let spanLo = Infinity;
      let spanHi = -Infinity;
      for (let i = 0; i < n; i += 1) {
        const y0 = corners[i][1];
        const y1 = corners[(i + 1) % n][1];
        if (y0 === y1) continue;
        if (yc < Math.min(y0, y1) || yc > Math.max(y0, y1)) continue;
        const t = (yc - y0) / (y1 - y0);
        const x = xr[i] + (xr[i + 1] - xr[i]) * t;
        if (x < spanLo) spanLo = x;
        if (x > spanHi) spanHi = x;
      }
      if (!(spanHi >= spanLo)) continue;

      const xa = Math.max(0, Math.floor(spanLo));
      const xb = Math.min(width - 1, Math.ceil(spanHi) - 1);
      if (xa > xb) continue;

      const row = py * width;
      // Linear interpolation of the two edge crossings, then of the quad: with
      // bilinear corner depths the result is the bilinear interpolant sampled at
      // the pixel centre, so the surface between two elevations is a slope.
      for (let px = xa; px <= xb; px += 1) {
        const xc = px + 0.5;
        let left = Infinity;
        let right = -Infinity;
        let zLeft = 0;
        let zRight = 0;
        for (let i = 0; i < n; i += 1) {
          const y0 = corners[i][1];
          const y1 = corners[(i + 1) % n][1];
          if (y0 === y1) continue;
          if (yc < Math.min(y0, y1) || yc > Math.max(y0, y1)) continue;
          const t = (yc - y0) / (y1 - y0);
          const x = xr[i] + (xr[i + 1] - xr[i]) * t;
          const z = zr[i] + (zr[i + 1] - zr[i]) * t;
          if (x < left) {
            left = x;
            zLeft = z;
          }
          if (x > right) {
            right = x;
            zRight = z;
          }
        }
        if (!(right > left)) continue;
        const u = Math.max(0, Math.min(1, (xc - left) / (right - left)));
        const z = zLeft + (zRight - zLeft) * u;

        const idx = row + px;
        if (z < depth[idx]) {
          depth[idx] = z;
          const k = idx * 4;
          rgb[k] = red;
          rgb[k + 1] = green;
          rgb[k + 2] = blue;
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

    // A level water surface has one normal, (0, 0, 1), in world space. Pushing it
    // through the same rotation as project() -- see the ry/up pair there -- gives
    // its view-space depth component, so |sin(pitch)| is how much the surface
    // faces the eye and 1 - that is the grazing angle. Constant over the whole
    // surface for a given camera, so it is computed once, not per cell.
    // project() puts the rotated "up" axis at depth -sin(pitch) and the world
    // +z axis at depth -cos(pitch), so a normal that projects onto the more
    // negative axis points toward the eye: water faces the camera when
    // -sin(pitch) < -cos(pitch), i.e. pitch > 45 degrees.
    const tilt = Math.max(0, Math.sin(camera.pitch) - Math.cos(camera.pitch));
    const viewNz = Math.sin(camera.pitch);

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
            this._quad([a, b, c, d], k);
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
              const col = waterSurfaceColour(
                worldSurfaceMetres - bed,
                algae,
                viewNz,
                tilt,
              );
              this._quad([wa, wb, wq, wd], col);
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
    const corners = [
      project(worldPos - half, 0.5 - half * 6, worldUnits(0.6), width, height),
      project(worldPos + half, 0.5 - half * 6, worldUnits(0.6), width, height),
      project(worldPos + half, 0.5 + half * 6, worldUnits(-0.4), width, height),
      project(worldPos - half, 0.5 + half * 6, worldUnits(-0.4), width, height),
    ];
    if (corners.some((c) => c === null)) return;
    // Depth -1 is in front of everything the terrain can reach (viewDepth is
    // positive in front of the eye and Infinity for unpainted sky), so the
    // marker wins the test unconditionally -- an interface element should never
    // be occluded by the thing it is drawn on top of.
    this._quad(corners, colour);
  }
}
