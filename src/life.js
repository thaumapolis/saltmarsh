/**
 * life.js — what lives in the water, and why the water is the way it is.
 *
 * Everything here responds to the hydrology in marsh.js rather than running
 * alongside it. That coupling is the actual subject of the project:
 *
 *   - Nutrients wash in with the tide and are eaten by algae, so fertility is a
 *     function of how much seawater you admitted, not a dial.
 *   - Algae need light *and* water. Deep enough to float, shallow enough for
 *     light. A pool that is deep all day is darker than one that floods and drains.
 *   - Fish need depth to be safe from birds, and shallows to feed. So a fish sits
 *     in the channel at low water and moves onto the flat when it floods -- and if
 *     you drain the pool too fast, it gets stranded in a puddle and dies. That is
 *     not a scripted fail state, it is the consequence of depth < minimum depth.
 *
 * The stranded-fish event is the thing I most want players to cause by accident
 * and then understand: the same sluice operation that feeds the marsh can kill
 * the fish in it, depending on the tide you timed it against.
 */

/** One cohort of organisms occupying one cell. */
export const LIMITS = {
  /** Metres of water a fish needs to avoid being caught from the bank. */
  fishRefugeDepth: 0.25,
  /** Metres of water a fish needs before it can move at all. */
  fishSwimDepth: 0.06,
  /** Algae grow fastest in bright shallow water; light decays with depth. */
  lightAttenuation: 2.4,
};

/**
 * Light available at a cell's bottom, as a fraction of surface light.
 * Beer-Lambert: I = exp(-kz). Uses actual depth, so the same algae crop in a
 * 10 cm sheet and a 1 m pool differ by an order of magnitude.
 */
export function lightAt(depthM) {
  return Math.exp(-LIMITS.lightAttenuation * depthM);
}

/**
 * Net algal growth in one cell for one step.
 *
 * Growth is light- and nutrient-limited (Liebig-minimum: the scarcer of the two
 * controls), reduced by respiration, and capped by self-shading. Losses are
 * grazing and washout, both applied by the caller, because washout is a
 * hydrological event and belongs to the water update.
 */
export function algaeGrowth(biomass, depthM, nutrient, dt) {
  if (depthM <= 0) return -biomass * 0.05 * dt; // stranding on dry mud: die-off
  const light = lightAt(depthM);
  const growthRate = 0.55 * Math.min(light, nutrient / (0.18 + nutrient));
  const respiration = 0.12;
  const net = growthRate - respiration;
  return biomass * net * dt * (1 - biomass / 1.4);
}

/**
 * Whether a fish in this cell is safe, stranded, or mobile-but-exposed.
 *
 * Returns a label rather than a boolean because the app has to *say* what
 * happened in plain language, and a boolean would leave the explanation to be
 * written separately from the rule -- where it would drift out of date.
 */
export function fishState(depthM) {
  if (depthM < LIMITS.fishSwimDepth) return 'stranded';
  if (depthM < LIMITS.fishRefugeDepth) return 'exposed';
  return 'safe';
}

/**
 * Trophic accounting for the whole pool. Computed from the grid on demand rather
 * than tracked incrementally, so the readout cannot disagree with the simulation
 * it describes: there is no second number to go stale.
 *
 * `fish` is a list of {cell, alive}. Dead fish stay in the list with alive=false
 * so the app can count what the marsh lost, and when.
 */
export function census(depth, algaeField, fish) {
  let safe = 0;
  let exposed = 0;
  let stranded = 0;
  let alive = 0;
  let lost = 0;
  for (const f of fish) {
    if (!f.alive) {
      lost += 1;
      continue;
    }
    alive += 1;
    const state = fishState(depth[f.cell]);
    if (state === 'safe') safe += 1;
    else if (state === 'exposed') exposed += 1;
    else stranded += 1;
  }
  let algae = 0;
  let grazedArea = 0;
  for (let k = 0; k < algaeField.length; k += 1) {
    if (depth[k] > 0.01) {
      algae += algaeField[k];
      if (algaeField[k] > 0.15) grazedArea += 1;
    }
  }
  return { algae, grazedArea, safe, exposed, stranded, alive, lost };
}
