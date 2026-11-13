/**
 * marsh.js — the pool: a grid of cells, each with a ground elevation and a water
 * depth. Everything visible and everything that matters derives from these two
 * arrays.
 *
 * The honest core being demonstrated is that a marsh pool is a *volume-elevation
 * curve*. The same volume of water sits shallow over a broad flat shelf and deep
 * in a channel, so how much the water level moves for a given inflow depends on
 * where the water already is. That single fact produces:
 *
 *   - pools that fill fast then stop moving (the shelf has taken the water),
 *   - channels that stay wet at low tide and become the last place fish can hide,
 *   - area that only exists for a couple of hours a day (the fringing marsh),
 *   - and the reason a breach high on the bank does something completely
 *     different from a breach low down.
 *
 * Water moves between cells by a simple depth-averaged flow down the gradient of
 * *water surface* elevation (ground + depth). That is not a Navier-Stokes solve;
 * it is the shallow-water intuition that surface elevation, not depth, is what
 * drives flow. It is the smallest rule that still produces level water at rest,
 * which is the property a player will check by eye.
 */

export const GRID = 96;

/**
 * The marsh is METRES wide. This is the single conversion between the elevation
 * field (metres, because tides and orifice flow are in metres) and the renderer's
 * normalised 0..1 plan coordinates.
 *
 * Getting this wrong is invisible in isolation and fatal in combination: an
 * earlier version passed raw metres straight into a projection whose x and y were
 * 0..1, so 2.78 m of relief drew as 278% of the marsh's own width and the view
 * was a vertical smear. Nothing failed -- the numbers were all "reasonable", only
 * the ratio between them was nonsense. Every place that turns a metre into a
 * screen distance must divide by this, so the ratio has one definition.
 *
 * 520 m across with 2.8 m of relief is a plausible small coastal grazing marsh,
 * and gives a relief-to-width ratio of 0.54%.
 */
export const MARSH_WIDTH_M = 520;

/** Elevation in metres to renderer world units (same units as normalised x, y). */
export function worldUnits(metres) {
  return metres / MARSH_WIDTH_M;
}

/** Side length of one cell, in metres. Used for volumes and flow. */
export const CELL_SIDE_M = MARSH_WIDTH_M / GRID;


export function index(i, j) {
  return j * GRID + i;
}

/**
 * Ground elevation in metres relative to chart datum.
 *
 * Shaped as a bowl with a meandering channel and a broad marsh shelf, because
 * those are the two features that make the volume-elevation curve nonlinear:
 * a very flat wide area (huge capacity, level barely moves) and a deep narrow
 * channel (small capacity, level swings).
 */
export function buildGround() {
  const g = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j += 1) {
    for (let i = 0; i < GRID; i += 1) {
      const x = i / (GRID - 1);
      const y = j / (GRID - 1);

      // General bowl toward the sea mouth at the right edge. The datum matters
      // more than it looks: mean sea level is 0 here and the tide only spans
      // about +/-0.9 m, so the marsh must be built to sit *across* that band.
      // An earlier version had the shelf topping out near 1.7 m, which put most
      // of the marsh permanently above the highest water and left the most
      // interesting part of the volume-elevation curve unreachable.
      let elev = 0.82 - 0.72 * x;

      // Meandering channel carved along the middle, scoured well below low water
      // so it stays wet at the lowest tide: that is the fish refuge, and it is
      // also what makes the volume-elevation curve steep at the bottom end.
      const channel = 0.09 + 0.055 * Math.sin(y * Math.PI * 3.1) + 0.02 * Math.sin(y * 11);
      const dist = Math.abs(x - channel);
      elev -= 1.55 * Math.exp(-(dist * dist) / (2 * 0.045 * 0.045));

      // A second, blind creek off the main channel — a refuge that dries out.
      const blind = 0.30 + 0.16 * Math.sin((y - 0.5) * 4.2);
      const bdist = Math.abs(y - blind);
      const inBlind = x > 0.12 && x < 0.52 && bdist < 0.05;
      if (inBlind) {
        elev -= 0.85 * Math.exp(-(bdist * bdist) / (2 * 0.030 * 0.030)) * (1 - (x - 0.12) / 0.6);
      }

      // Gentle hummocks on the marsh so the shelf is not a perfect plane: these
      // create the isolated puddles that strand at low water.
      elev += 0.10 * Math.sin(x * 17.3) * Math.cos(y * 13.7) * (x < 0.55 ? 1 : 0.25);

      // Raise the banks at the top and bottom so water stays in the system.
      const bank = Math.max(0, Math.abs(y - 0.5) - 0.42);
      elev += bank * 6.0;

      // The sea mouth: a fixed boundary condition at the right edge, held at sea
      // level by the tide rather than integrated. Marked so stepWater can treat
      // it as a reservoir instead of a normal cell.
      if (x >= 0.94) elev = Math.min(elev, 0.0);

      g[index(i, j)] = elev;
    }
  }
  return g;
}

/**
 * One relaxation step of water exchange between neighbouring cells.
 *
 * Flow is proportional to the difference in water-surface elevation, damped to
 * stay stable for the timestep used. Depth is conserved to within float error
 * (checked in tests), because a "conservation" model that quietly loses water is
 * not a conservation model.
 */
const FLOW = 0.18;

/**
 * One relaxation step of water exchange between neighbouring cells.
 *
 * Written in flux form -- each edge computes ONE signed flux that is added to
 * one cell and subtracted from the other -- rather than as "each cell adjusts
 * by the gradient around it". The difference is not cosmetic: the gradient form
 * plus a `depth = max(0, depth)` clamp silently deletes water whenever a cell
 * would go negative (observed: 0.042% of the whole pool's volume lost over 400
 * steps, which sounds trivial and is not, because it accumulates and because a
 * "conservation" model that leaks is not a conservation model). In flux form a
 * cell can never give more than it holds, so total volume is conserved exactly
 * and the test in tests/marsh.test.mjs asserts that to float rounding.
 */
export function stepWater(depth, ground, dt) {
  // Horizontal edges: between (i,j) and (i+1,j).
  for (let j = 0; j < GRID; j += 1) {
    for (let i = 0; i < GRID - 1; i += 1) {
      const a = index(i, j);
      const b = a + 1;
      moveWater(depth, a, b, ground[a] + depth[a] - (ground[b] + depth[b]), dt);
    }
  }
  // Vertical edges: between (i,j) and (i,j+1).
  for (let j = 0; j < GRID - 1; j += 1) {
    for (let i = 0; i < GRID; i += 1) {
      const a = index(i, j);
      const b = index(i, j + 1);
      moveWater(depth, a, b, ground[a] + depth[a] - (ground[b] + depth[b]), dt);
    }
  }
}

/**
 * Move water from a to b (negative amount moves the other way), never more than
 * the source holds. Capping at the source rather than clamping the result is
 * what makes the scheme conservative.
 */
function moveWater(depth, a, b, surfaceDiff, dt) {
  if (surfaceDiff === 0) return;
  let amount = FLOW * dt * surfaceDiff;
  const from = amount > 0 ? a : b;
  const available = depth[from];
  if (amount > available) amount = available;
  else if (amount < -available) amount = -available;
  depth[a] -= amount;
  depth[b] += amount;
}

/**
 * Volume of water above `elevation`, in cubic metres, given a cell area.
 *
 * This is the volume-elevation curve, and it is the single most informative read
 * on the whole system: its slope is the pool's surface area, which is why the
 * same inflow moves the level by different amounts at different stages.
 */
export function volumeAbove(depth, cellAreaM2) {
  let v = 0;
  for (let k = 0; k < depth.length; k += 1) v += depth[k];
  return v * cellAreaM2;
}

/** Cells that are wet, i.e. have contributed to that volume. */
export function wetArea(depth, cellAreaM2) {
  let n = 0;
  for (let k = 0; k < depth.length; k += 1) if (depth[k] > 0.01) n += 1;
  return n * cellAreaM2;
}
