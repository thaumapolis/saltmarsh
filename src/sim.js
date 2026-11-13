/**
 * sim.js — one tick of the whole system, and the record of what happened.
 *
 * The coupling order is deliberate and is the reason the app can explain itself:
 *
 *   tide  ->  head across the sluice  ->  water exchange  ->  depth per cell
 *           ->  light per cell  ->  algae growth  ->  fish refuge/stranding
 *
 * Each step consumes the previous one's output. Nothing here polls the moon or
 * the fish directly; if a readout says "6 fish stranded", the cause is
 * reconstructible by walking back up this chain to the sluice setting that
 * drained the pool faster than the fish could leave it.
 *
 * Time: the model advances in hours of simulated time. One real second at 1x is
 * about one simulated hour, so a full lunar month takes roughly a day and a half
 * of play at 1x and is skippable at higher speeds.
 */
import { seaLevel, orificeFlow } from './tide.js';
import { stepWater, volumeAbove, wetArea, GRID, CELL_AREA_M2 } from './marsh.js';
import { algaeGrowth, fishState, habitatValue, LIMITS,
         seasonIndex, temperatureFactorForSeason, rainfallMmPerHForSeason,
         YEAR_DAYS } from './life.js';

export const HOURS_PER_STEP = 0.25;

/** Year the clock starts in, so the UI can show a calendar without a second counter. */
export const EPOCH_YEAR = 2026;

/**
 * Sediment, in metres of bed-level change per hour.
 *
 * This is the term that turns the game from a timing puzzle into management. A
 * flooded cell drops some of its suspended sediment, so it builds up; a cell left
 * dry too long is exposed to wind and grazing stock and loses elevation. Over a
 * year that is millimetres, which is small, and over a decade it is the difference
 * between a marsh that floods and a marsh that has become a channel.
 *
 * The rate is deliberately slow relative to a game session: elevation is the
 * long-horizon consequence, and making it fast would make the tide-driven
 * short-horizon decisions invisible by comparison. Real managed realignment
 * accretion is order 5-15 mm/yr on a regularly flooded marsh, which is what
 * ACCRETION_MAX_MM_PER_YEAR is calibrated to.
 */
const ACCRETION_MAX_MM_PER_YEAR = 9;
/** Metres lost per hour from a cell that has been dry continuously. */
const EROSION_MM_PER_YEAR = 6;
/** Hours of continuous exposure before a cell starts net losing elevation. */
const DRY_HOURS_BEFORE_EROSION = 24 * 12;

const MM_PER_HOUR = (rateMmPerYear) => rateMmPerYear / 1000 / (24 * 365.25);

/**
 * Evaporation in millimetres per hour of open water, by season.
 *
 * Calibrated to a temperate maritime annual total: the mean over the cosine year
 * below is ~0.76 mm/h, i.e. ~670 mm/yr, which is the range for pan evaporation
 * here. The seasonal swing is the part that matters to the player -- a sealed
 * pool in July loses about five times what it loses in January.
 */
export const EVAPORATION_MM_PER_H_MEAN = 0.076;
export function evaporationMmPerH(season) {
  return EVAPORATION_MM_PER_H_MEAN * (1 + 0.55 * season);
}

/** Initial state: pool half-full of a previous high tide, moderately fertile. */
export function initialState() {
  const ground = null; // filled by the caller, which owns the generated terrain
  return {
    hours: 0,
    depth: null,
    algae: new Float32Array(GRID * GRID).fill(0.22),
    nutrient: 0.35,
    /** Freshness 0 = fully saline, 1 = fully fresh. Drives what grows. */
    freshness: 0.1,
    /**
     * How strongly shallow water warms, scaling the warmth term of habitat value.
     * 0 = no thermal gradient (fish prefer deep), 1 = a flat that heats noticeably.
     */
    temperatureFactor: 1.0,
    /** Millimetres of rain per simulated hour; see RAIN_RATE. */
    rainfallMmPerH: 0.0,
    fish: [],
    ground,
    /**
     * Two openings, because a pool with only an intake has no decisions in it --
     * see the note on the drain. Both are areas in square metres; 0 means built
     * out (sealed), which is how the player lowers the pool permanently.
     */
    sluice: { open: false, areaM2: 2.4 },
    /**
     * Outfall through the sea bank, always open once cut. This is what creates
     * the trade-off: draining the pool exposes the marsh (which is what kills
     * fish if you are too fast) and lets rain and springs freshen it.
     * areaM2 = 0 until the player cuts it.
     */
    outfall: { open: false, areaM2: 0 },
    log: [],
    counts: { strandedEver: 0 },
    /**
     * Hours each cell has been continuously dry, for the erosion rule. Tracked
     * per cell rather than derived, because "how long has this flat been exposed"
     * is a property of the water history and cannot be recovered from the
     * current depth field.
     */
    dryHours: new Float32Array(GRID * GRID),
    /**
     * Net bed-level change so far, in metres, positive where the marsh has built
     * up. Held separately from `ground` so the app can show what the player's
     * water management has actually done to the marsh surface, and so the
     * original topography stays available for the view.
     */
    elevationChange: new Float32Array(GRID * GRID),
  };
}

/**
 * Seed fish in the deepest cells.
 *
 * Placed by depth rather than randomly, because that is what real fish do at
 * low water and because it makes the opening situation legible: they start in
 * the channel, which is the only thing that stays wet.
 */
export function seedFish(state, count) {
  const cells = [];
  for (let k = 0; k < state.ground.length; k += 1) {
    if (state.depth[k] > 0.3) cells.push([state.depth[k], k]);
  }
  cells.sort((a, b) => b[0] - a[0]);
  const fish = [];
  for (let n = 0; n < count && n < cells.length; n += 1) {
    fish.push({ cell: cells[n][1], alive: true, ageH: 0 });
  }
  state.fish = fish;
  return fish.length;
}

/**
 * Advance the system by one step.
 *
 * Returns nothing; mutates state. Events are appended to state.log with enough
 * context for the UI to say what happened in a sentence rather than a code.
 */
export function step(state, dtHours) {
  const hours = state.hours + dtHours;
  const sea = seaLevel(hours);

  // 0. The season, from the clock. Read every step rather than scheduled, so a
  // long-running session drifts through the year and the drivers below follow.
  const season = seasonIndex((hours / 24) % YEAR_DAYS);
  state.temperatureFactor = temperatureFactorForSeason(season);
  state.rainfallMmPerH = rainfallMmPerHForSeason(season);
  state.season = season;

  // 1. Exchange through the sluice. Head is sea level minus pool surface.
  //
  // FLOW IS CAPPED AT THE VOLUME THAT EQUALISES THE SURFACE, and that cap is not
  // cosmetic: it is the difference between a marsh and a bathtub. An orifice
  // moves volume proportional to sqrt(head), so it is stiff -- with a 0.9 m head
  // and a 2.4 m2 sluice, one 0.25 h step asks for ~2,350 m3, which raises the
  // pool surface by only ~2 mm. Applying that unconditionally means the head is
  // still positive at the end of every step, so an intake left open across a high
  // tide keeps admitting and a sealed pool climbs monotonically past the highest
  // tide it can be fed by (measured: +0.75 m and still rising, ~1.5 m by day 20).
  // Equalising within the step is the standard explicit fix for a stiff exchange
  // term and keeps the solver one-pass.
  let inflowM3 = 0;
  if (state.sluice.open) {
    const surface = meanSurface(state);
    const flow = orificeFlow(state.sluice.areaM2, sea - surface);
    // Spread the volume over the currently wet cells; a proper solver would
    // distribute by geometry, and doing it this way is honest about being a
    // simplification -- see note in stepWater.
    inflowM3 = limitedVolume(state, flow * dtHours * 3600, sea);
    applyVolume(state, inflowM3);
  }
  // Outfall: drains the pool to sea whenever the pool stands above the sea.
  let outflowM3 = 0;
  if (state.outfall.open && state.outfall.areaM2 > 0) {
    const surface = meanSurface(state);
    const flow = orificeFlow(state.outfall.areaM2, surface - sea);
    // flow > 0 means the pool stands above the sea and is draining. Convert to
    // this helper's convention: a drain is a negative change to pool volume.
    const requestedM3 = -flow * dtHours * 3600;
    outflowM3 = -limitedVolume(state, requestedM3, sea);
    if (outflowM3 !== 0) applyVolume(state, -outflowM3);
  }

  // Rain and evaporation, in metres over the wet surface. Small per hour, but
  // this is the term that lets a drained pool turn fresh while a sealed one
  // stays saline, so it is what gives the marsh a second axis than wet/dry.
  const wetNow = wetArea(state.depth, CELL_AREA_M2);
  const rainM = (state.rainfallMmPerH / 1000) * dtHours;
  if (wetNow > 0 && rainM !== 0) {
    applyVolume(state, rainM * wetNow);
  }

  // Evaporation, in metres off the wet surface. This term exists because the app
  // tells the player that a sealed pool "can only lose water to evaporation" --
  // and until now it did not, so that sentence described a mechanism the model
  // did not have and a sealed pool filled forever from rain with no offset.
  //
  // Pan evaporation in a temperate maritime climate is roughly 600-750 mm a year,
  // concentrated in the warm months; the mean below annualises to ~666 mm/yr. It
  // scales with the season because evaporation tracks available energy: the same
  // open water loses little in December and a lot in July. Net of rain, a sealed
  // marsh in a dry summer must fall, which is what makes "cut the outfall and let
  // it freshen" a decision with a seasonal cost rather than a free improvement.
  const evapM = evaporationMmPerH(state.season) / 1000 * dtHours;
  if (wetNow > 0 && evapM > 0) {
    applyVolume(state, -Math.min(evapM * wetNow, volumeAbove(state.depth, CELL_AREA_M2)));
  }

  state.hours = hours;

  // 2. Redistribute within the pool.
  stepWater(state.depth, state.ground, dtHours * 4);

  // 2b. Sediment. Regular flooding builds the marsh surface; prolonged exposure
  // loses it. This is the slow term that makes a season of decisions matter.
  stepSediment(state, dtHours);

  // 3. Biology, which reads depth and nothing else.
  let growth = 0;
  for (let k = 0; k < state.depth.length; k += 1) {
    const g = algaeGrowth(state.algae[k], state.depth[k], state.nutrient, dtHours);
    state.algae[k] = Math.max(0, Math.min(1.4, state.algae[k] + g));
    growth += g;
  }
  // Nutrient is consumed by production and replenished by flooding with the sea.
  state.nutrient = Math.max(0.02, Math.min(1, state.nutrient - growth * 0.00002 + (inflowM3 > 0 ? 0.0000004 * inflowM3 : 0)));

  // 4. Fish: move toward refuge, die if stranded.
  for (const f of state.fish) {
    if (!f.alive) continue;
    f.ageH += dtHours;
    moveFish(state, f);
    const st = fishState(state.depth[f.cell]);
    if (st === 'stranded') {
      f.alive = false;
      state.counts.strandedEver += 1;
      state.log.push({
        hours,
        kind: 'stranded',
        cell: f.cell,
        depthM: state.depth[f.cell],
      });
    }
  }

  // Freshness: freshened by rain on the wet area, restored by seawater inflow.
  // Volume-weighted rather than stepped, so it cannot overshoot [0,1].
  const totalWater = volumeAbove(state.depth, CELL_AREA_M2);
  if (totalWater > 0) {
    const freshInput = (rainM * wetNow) / totalWater;
    const saltInput = inflowM3 > 0 ? (inflowM3 / totalWater) * 0.55 : 0;
    state.freshness = Math.max(0, Math.min(1, state.freshness + freshInput - saltInput));
  }

  return { sea, inflowM3, outflowM3 };
}

/**
 * Clamp a volume change so it cannot carry the pool surface past `targetLevelM`.
 *
 * `deltaM3` is the change to the pool's water volume, signed as it will be handed
 * to applyVolume (positive floods the marsh, negative drains it). The bound is the
 * volume that would put the pool surface exactly at the target; past that the head
 * across the opening has reversed within the step and the flow should have stopped
 * or turned around. Ignoring this turns a stiff sqrt(head) orifice into an
 * unconditional pump: with a 0.9 m head a 2.4 m2 sluice asks for ~2,350 m3 in one
 * 0.25 h step, which lifts a 30,000 m2 marsh by only ~8 cm of head, so the head
 * never reverses and a sealed pool climbs past the highest tide forever.
 *
 * The two openings have opposite sign conventions in orificeFlow -- the sluice is
 * driven by (sea - surface) and the outfall by (surface - sea) -- so each call
 * site converts to this one convention explicitly. Getting that conversion wrong
 * silently blocks drainage rather than failing, which is exactly how this helper
 * first shipped: an outfall that refused to drain and a pool that reached 82 m.
 */
function limitedVolume(state, deltaM3, targetLevelM) {
  const surface = meanSurface(state);
  if (deltaM3 === 0) return 0;
  const capacity = wetArea(state.depth, CELL_AREA_M2) * Math.abs(targetLevelM - surface);
  if (deltaM3 > 0) {
    if (surface >= targetLevelM) return 0;
    return Math.min(deltaM3, capacity);
  }
  if (surface <= targetLevelM) return 0;
  return Math.max(deltaM3, -capacity);
}

/**
 * Bed-level change from flooding and exposure, in metres.
 *
 * Accretion is strongest where water is shallow and moving -- a thin sheet over a
 * flat drops its load, a deep still pool less so, and a fast deep channel barely
 * at all. So the same tidal regime that makes a good fish flat also raises it,
 * which is the real positive feedback in a grazing marsh: managed flooding builds
 * elevation, which makes the next flood shallower, which builds more.
 *
 * The effect on the water is applied to `ground`, so it feeds straight back into
 * the depth the fish see. That is the whole point: a marsh you neglect gets
 * lower, floods more often, and holds less food -- and none of that is a script.
 */
export function stepSediment(state, dtHours) {
  const accretePerH = MM_PER_HOUR(ACCRETION_MAX_MM_PER_YEAR);
  const erodePerH = MM_PER_HOUR(EROSION_MM_PER_YEAR);
  for (let k = 0; k < state.depth.length; k += 1) {
    const d = state.depth[k];
    if (d > 0.005) {
      state.dryHours[k] = 0;
      // Shallow, recently-wet water settles best; peak around 5-20 cm.
      const shallowness = Math.exp(-Math.pow((d - 0.12) / 0.16, 2));
      const deposit = accretePerH * shallowness * dtHours;
      state.ground[k] += deposit;
      state.elevationChange[k] += deposit;
      // Depth is ground-referenced, so raising the bed pushes water upward.
      // Clamped at zero rather than allowed to go negative: a cell cannot hold
      // negative water, and the displaced volume is what makes accretion feel
      // like land taking over the pool.
      const next = d - deposit;
      state.depth[k] = next > 0 ? next : 0;
    } else {
      state.dryHours[k] += dtHours;
      if (state.dryHours[k] > DRY_HOURS_BEFORE_EROSION) {
        const loss = erodePerH * dtHours;
        state.ground[k] -= loss;
        state.elevationChange[k] -= loss;
      }
    }
  }
}

/** Mean water surface elevation over wet cells, in metres. */
export function meanSurface(state) {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < state.depth.length; k += 1) {
    if (state.depth[k] > 0.02) {
      sum += state.ground[k] + state.depth[k];
      n += 1;
    }
  }
  return n === 0 ? -99 : sum / n;
}

/**
 * Add (or remove) a volume of water across the wet cells.
 *
 * Clamped so removal never drives depth negative, which would otherwise leak
 * volume out of a system that is supposed to conserve it -- the same failure
 * class that made the earlier water update non-conservative.
 */
function applyVolume(state, volumeM3) {
  const depth = state.depth;
  let wet = 0;
  for (let k = 0; k < depth.length; k += 1) if (depth[k] > 0.001) wet += 1;
  if (wet === 0) {
    if (volumeM3 < 0) {
      throw new Error('applyVolume: asked to drain an already empty pool');
    }
    // First water onto dry marsh: wet the lowest cells, or the inflow would
    // silently vanish.
    const order = Array.from(state.ground.keys()).sort((a, b) => state.ground[a] - state.ground[b]);
    const per = volumeM3 / (CELL_AREA_M2 * Math.max(1, order.length * 0.02));
    for (let n = 0; n < Math.floor(order.length * 0.02); n += 1) {
      depth[order[n]] += per;
    }
    return;
  }
  const perCell = volumeM3 / (wet * CELL_AREA_M2);
  for (let k = 0; k < depth.length; k += 1) {
    if (depth[k] <= 0.001) continue;
    const next = depth[k] + perCell;
    depth[k] = next > 0 ? next : 0;
  }
}

/**
 * Fish movement: swim to a wetter neighbouring cell when the current one is
 * becoming dangerous, but only if there is enough water to swim through.
 *
 * The constraint that produces the interesting failure is the second one: a fish
 * cannot cross a cell shallower than fishSwimDepth. So a pool drained quickly
 * traps fish on the shelf even though the channel is visible and close -- they
 * cannot get there. That is the honest version of "you flooded the marsh too
 * fast", and it is why the drain rate matters as much as the tide you picked.
 */
function moveFish(state, fish) {
  const { depth } = state;
  const k = fish.cell;
  const i = k % GRID;
  const j = (k / GRID) | 0;
  const here = depth[k];

  // Immobilised: too little water to move through. Not yet dead -- a fish in 5 cm
  // of water can still survive, and if the tide comes back it recovers. Keeping
  // "cannot move" and "dying" as different conditions is what lets the app say
  // which one is happening.
  if (here < LIMITS.fishSwimDepth) return;

  const neighbours = [];
  if (i > 0) neighbours.push(k - 1);
  if (i < GRID - 1) neighbours.push(k + 1);
  if (j > 0) neighbours.push(k - GRID);
  if (j < GRID - 1) neighbours.push(k + GRID);

  // Move to the best reachable habitat, not to the deepest water.
  //
  // This is what makes stranding possible at all. With a "seek depth" rule fish
  // sit in the channel, never enter the marsh, and cannot be left behind however
  // badly the player drains the pool -- measured, four strategies gave four very
  // different water levels and 40/40 survivors each time. Habitat-seeking is also
  // the true behaviour: fish come in on the tide to feed on the productive
  // shallows and accept the risk, which is exactly the risk the player controls.
  let best = k;
  let bestScore = habitatValue(here, state.algae[k], state.temperatureFactor);
  for (const n of neighbours) {
    const score = habitatValue(depth[n], state.algae[n], state.temperatureFactor);
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  fish.cell = best;
}
