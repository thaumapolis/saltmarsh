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
 * Where fish actually want to be, as a per-cell score.
 *
 * THIS IS THE BIOLOGY THAT MAKES THE GAME A GAME.
 * The earlier version had fish sit in the deepest cell and flee upward, which
 * means they never enter the marsh and can never be stranded: the dramatic
 * fail state was unreachable no matter how the player operated the sluice, and
 * four strategies produced four different water levels and zero fish deaths.
 *
 * Real fish enter a saltmarsh on the flood for a reason -- the shallow, warm,
 * productive shallows are a nursery. They are not hiding from the tide, they
 * are feeding, and they accept the risk of being left behind because the food
 * is worth it. That is what the tide-pool trade-off actually is.
 *
 * So value is a balance, not a monotone preference for depth:
 *   + warmth and food where the water is shallow and the bed is productive
 *   - danger where depth is below the refuge threshold
 * The balance point, and therefore how boldly a fish sits on a flat, is the
 * single dial that decides whether the marsh is a larder or a trap.
 */
export function habitatValue(depthM, algae, temperatureF) {
  if (depthM <= 0.005) return -1;
  // Food: proportional to algal productivity on the bed.
  const food = Math.min(1.4, algae) * 0.9;
  // Warmth: shallow water heats up; a full-depth column stays near sea temperature.
  const warmth = Math.exp(-depthM / 0.18) * 0.5 * temperatureF;
  // Risk: sharp once depth falls under the refuge threshold, because that is
  // where a wading bird or a draining pool stops being survivable.
  const risk = depthM < LIMITS.fishRefugeDepth
    ? Math.pow((LIMITS.fishRefugeDepth - depthM) / LIMITS.fishRefugeDepth, 1.6) * 2.2
    : 0;
  return food + warmth - risk;
}

/**
 * The year. Everything here is a function of day-of-year rather than a table of
 * per-season constants, so the seasons cannot disagree with each other and a
 * change to the year length propagates by construction.
 *
 * Why an annual cycle at all: without one, every decision the player makes has
 * the same value forever, so the game is a single timing puzzle repeated. With
 * one, the *same* sluice operation is a good idea in June and a disaster in
 * August, because what the marsh needs and what the fish are doing both move
 * through the year. That gives management somewhere to go.
 */
export const YEAR_DAYS = 365.25;

/**
 * Day of year, 0..365.25, from elapsed simulated hours.
 *
 * Day 0 is mid-winter, so the phase is chosen once, here, and every seasonal
 * consumer reads the same curve. The app labels months from this too, so the
 * calendar in the UI cannot drift from the physics.
 */
export function dayOfYear(hours) {
  const days = hours / 24;
  return days - Math.floor(days / YEAR_DAYS) * YEAR_DAYS;
}

/**
 * Seasonal index, -1 (midwinter) .. +1 (midsummer), as a cosine of day-of-year.
 * Derived rather than scheduled: one number drives warmth, plant growth, and the
 * month label, so they are the same season by construction.
 */
export function seasonIndex(dayOfYearM) {
  return -Math.cos((2 * Math.PI * dayOfYearM) / YEAR_DAYS);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Month name and year number for the clock.
 *
 * Month boundaries come from dividing the year into twelve equal parts of the
 * cosine phase, which is approximate as a calendar goes -- it is a simulation of
 * seasons, not of the Gregorian reckoning. Stated here because the app shows this
 * string to the player next to a physically-derived tide, and the reader is
 * entitled to know which parts are which.
 */
export function calendar(hours, epochYear) {
  const doy = dayOfYear(hours);
  const yearNumber = epochYear + Math.floor(hours / 24 / YEAR_DAYS);
  const monthIndex = Math.min(11, Math.floor((doy / YEAR_DAYS) * 12));
  return { month: MONTH_NAMES[monthIndex], year: yearNumber, doy };
}

/**
 * How strongly shallow water warms above the sea, scaled by season.
 *
 * In winter a flat and a channel are close to the same temperature, so the
 * warmth incentive to enter the marsh nearly vanishes and fish hold the refuge.
 * In summer the flat is markedly warmer and food-rich, so they push onto it and
 * take the stranding risk. The player's drain therefore has different
 * consequences by season, which is the point.
 */
export function temperatureFactorForSeason(season) {
  return 0.25 + 0.75 * ((season + 1) / 2);
}

/**
 * Rainfall in millimetres per hour, by season.
 *
 * Calibrated so the mean over a year is RAINFALL_MM_PER_H_MEAN, which is
 * ~640 mm/yr: the figure for a temperate maritime marsh in southern England
 * (London's annual precipitation is reported as 615-716 mm depending on period
 * and station). The seasonal swing follows the real one -- wetter in the cold
 * half, drier in late summer -- without changing the annual total.
 *
 * The calibration matters more than it looks. An earlier version of this curve
 * peaked at 1.8 mm/h, which is ~15,800 mm/yr if sustained: twenty-five times the
 * real rate. Rain then beat evaporation in every season, so a sealed marsh filled
 * forever and could never be managed down -- the model was not wrong in its
 * structure, it was wrong in its units, and the symptom was a pool that rose past
 * the highest tide. Cross-check any rate written here against its annual total.
 */
export const RAINFALL_MM_PER_H_MEAN = 0.073;
export function rainfallMmPerHForSeason(season) {
  return RAINFALL_MM_PER_H_MEAN * (1 - 0.45 * season);
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
