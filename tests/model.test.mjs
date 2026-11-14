/**
 * tests/model.test.mjs — the model's behavioural contract, no browser.
 *
 * These assert the properties that make the thing a simulation rather than an
 * animation, and that a future refactor could silently break: conservation,
 * flow direction, stability, and the specific trade-off the game is built on.
 * They deliberately do NOT assert parameter values, because a parameter change
 * that preserves all of these is a legitimate tuning change.
 *
 * Run: node tests/model.test.mjs
 */
import { buildGround, GRID, CELL_AREA_M2, worldUnits, volumeAbove, stepWater } from '../src/marsh.js';
import { seaLevel, springNeapHours, orificeFlow } from '../src/tide.js';
import { algaeGrowth, fishState, habitatValue, LIMITS,
         dayOfYear, seasonIndex, temperatureFactorForSeason, rainfallMmPerHForSeason,
         calendar, YEAR_DAYS, freshnessFactor, FRESHNESS, BREEDING } from '../src/life.js';
import { initialState, seedFish, step, meanSurface, recruitFish, evaporationMmPerH } from '../src/sim.js';

let failures = 0;
let checks = 0;
function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

function freshState({ fill = 0.55, fish = 34, outfallArea = 0 } = {}) {
  const s = initialState();
  s.ground = buildGround();
  s.depth = new Float32Array(GRID * GRID);
  for (let k = 0; k < s.depth.length; k += 1) {
    const d = fill - s.ground[k];
    s.depth[k] = d > 0 ? d : 0;
  }
  seedFish(s, fish);
  s.outfall = { open: outfallArea > 0, areaM2: outfallArea };
  return s;
}

console.log('tide');
{
  ok(Math.abs(seaLevel(0)) < 1e-9, 'sea level is 0 at t=0', seaLevel(0));
  const span = Math.max(...Array.from({ length: 3000 }, (_, i) => seaLevel(i * 0.05)));
  const floor = Math.min(...Array.from({ length: 3000 }, (_, i) => seaLevel(i * 0.05)));
  ok(span > 0.8 && span < 1.1, 'spring high water is ~+0.9 m', span.toFixed(3));
  ok(floor < -0.8 && floor > -1.1, 'spring low water is ~-0.9 m', floor.toFixed(3));

  // Semidiurnal inequality: M2 is 12h24m, so successive highs differ in height.
  const beat = springNeapHours();
  ok(beat / 24 > 14 && beat / 24 < 16, 'spring-neap beat is 14-16 days', (beat / 24).toFixed(2));

  // The beat must be derived from the constituents, not hardcoded: it is
  // computed from M2/S2 periods, so it changes when they do. Asserted by
  // checking the value follows 1/|1/P_M2 - 1/P_S2| for the shipped periods.
  const expected = 1 / Math.abs(1 / 12.4206 - 1 / 12.0);
  ok(Math.abs(beat - expected) < 1e-6, 'beat is computed from the constituent periods',
    `${beat.toFixed(4)} vs ${expected.toFixed(4)}`);
}

console.log('orifice flow');
{
  ok(orificeFlow(2, 0) === 0, 'no head, no flow');
  const inFlow = orificeFlow(2, 0.5);
  const outFlow = orificeFlow(2, -0.5);
  ok(inFlow > 0, 'positive head floods inward', inFlow);
  ok(outFlow < 0, 'negative head drains outward', outFlow);
  ok(Math.abs(inFlow + outFlow) < 1e-9, 'flow is antisymmetric in head');
  ok(Math.abs(orificeFlow(2, 1) - inFlow * Math.SQRT2) < 1e-6,
    'flow scales as sqrt(head), not linearly', `${orificeFlow(2, 1).toFixed(3)} vs ${(inFlow * Math.SQRT2).toFixed(3)}`);
}

console.log('marsh water');
{
  const g = buildGround();
  const d = new Float32Array(GRID * GRID).fill(0.3);
  const before = volumeAbove(d, CELL_AREA_M2);
  for (let n = 0; n < 600; n += 1) stepWater(d, g, 0.05);
  const after = volumeAbove(d, CELL_AREA_M2);
  const drift = Math.abs(after - before) / before;
  ok(drift < 1e-6, 'closed water update conserves volume to float precision', `drift ${drift.toExponential(2)}`);

  // A uniform field must be stationary: if water is already level, nothing may
  // move. Float32 means "exactly equal" is the wrong assertion, so the tolerance
  // is float noise, not a tuned threshold -- 1e-6 m is a nanometre of a marsh.
  const flat = new Float32Array(GRID * GRID).fill(0);
  const level = new Float32Array(GRID * GRID).fill(0.3);
  for (let n = 0; n < 20; n += 1) stepWater(level, flat, 0.05);
  ok(Math.max(...level) - Math.min(...level) < 1e-6,
    'a level surface is stationary (no numerical drift)',
    `spread ${(Math.max(...level) - Math.min(...level)).toExponential(2)}`);

  // Uneven depth must spread outward and conserve volume, without needing to
  // reach perfect flatness -- this scheme is a diffuser and reaches equilibrium
  // slowly at the edges. The contract is monotone decay of the gradient plus
  // conservation, both of which a wrong scheme can violate while still looking
  // plausible for a few frames.
  const w = new Float32Array(GRID * GRID).fill(0);
  for (let k = 0; k < w.length; k += 1) w[k] = (k % GRID) < GRID / 2 ? 0.4 : 0.1;
  // Measure the gradient, not max-minus-min. The domain edges are closed, so the
  // extreme columns keep their original depths forever and max-minus-min stays
  // pinned at 0.300 even while the interior visibly equalises -- an earlier
  // version of this test asserted on that and reported a broken diffuser. The L2
  // norm of the depth gradient actually decays (2.94 -> 0.53 over 4000 steps).
  const gradientNorm = (field) => {
    let acc = 0;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID - 1; i += 1) {
        const d = field[j * GRID + i] - field[j * GRID + i + 1];
        acc += d * d;
      }
    }
    return Math.sqrt(acc);
  };
  const gradBefore = gradientNorm(w);
  const vBefore = volumeAbove(w, CELL_AREA_M2);
  let monotone = true;
  let prev = gradBefore;
  for (let n = 0; n < 500; n += 1) {
    stepWater(w, flat, 0.05);
    const grad = gradientNorm(w);
    if (grad > prev + 1e-9) monotone = false;
    prev = grad;
  }
  const gradAfter = gradientNorm(w);
  ok(gradAfter < gradBefore * 0.5, 'the depth gradient decays toward level', `${gradBefore.toFixed(3)} -> ${gradAfter.toFixed(3)}`);
  ok(monotone, 'the gradient never grows (the scheme does not amplify)');
  ok(Math.abs(volumeAbove(w, CELL_AREA_M2) - vBefore) / vBefore < 1e-6,
    'volume conserved across the whole diffusion');
  ok(Math.min(...w) >= 0, 'no negative depths appear');

  // Relief must be small relative to width or the 3D view is meaningless.
  const gmin = Math.min(...g);
  const gmax = Math.max(...g);
  const ratio = (gmax - gmin) / (520);
  ok(ratio > 0.002 && ratio < 0.02, 'relief is a plausible fraction of marsh width', ratio.toFixed(4));
}

console.log('light, fish state and habitat');
{
  ok(algaeGrowth(0.5, 0, 0.5, 1) < 0, 'algae on dry mud declines', algaeGrowth(0.5, 0, 0.5, 1));
  ok(algaeGrowth(0.5, 0.05, 0.9, 1) > algaeGrowth(0.5, 0.9, 0.9, 1),
    'shallow water grows more algae than deep (light limitation)');
  ok(fishState(0.01) === 'stranded' && fishState(0.1) === 'exposed' && fishState(0.5) === 'safe',
    'fish state classifies by depth');

  // The heart of the game: a productive flat must beat a deep, dark channel,
  // otherwise fish never leave the refuge and can never be stranded.
  const shallow = habitatValue(0.15, 0.9, 1);
  const deep = habitatValue(1.2, 0.05, 1);
  ok(shallow > deep, 'a productive shallow flat beats a deep unproductive channel', `${shallow.toFixed(3)} vs ${deep.toFixed(3)}`);
  ok(habitatValue(0.01, 1.0, 1) < 0, 'a nearly-dry cell is negative even when food-rich');
  ok(LIMITS.fishSwimDepth < LIMITS.fishRefugeDepth, 'swim depth is below refuge depth');
}

console.log('the trade-off (this is the game)');
{
  const run = (strategy, days = 14) => {
    const s = freshState({ outfallArea: 1.3 });
    for (let n = 0; n < 24 * 4 * days; n += 1) {
      const sea = seaLevel(s.hours);
      const surf = meanSurface(s);
      switch (strategy) {
        case 'sealed': s.sluice.open = false; s.outfall.areaM2 = 0; break;
        case 'reckless': s.sluice.open = sea > surf; break;
        default: throw new Error(`unknown strategy ${strategy}`);
      }
      step(s, 0.25);
    }
    return s;
  };
  const sealed = run('sealed');
  const reckless = run('reckless');
  const sealedLost = sealed.fish.filter((f) => !f.alive).length;
  const recklessLost = reckless.fish.filter((f) => !f.alive).length;

  ok(sealedLost === 0, 'keeping the pool connected and full loses no fish', sealedLost);
  ok(recklessLost > 0, 'opening the sluice whenever the sea is higher strands fish', recklessLost);
  ok(recklessLost > sealedLost, 'the two strategies measurably differ');

  // The deaths must be stranding, recorded by the model itself rather than
  // inferred by the test from a snapshot of a moving field.
  ok(sealed.counts.strandedEver === 0, 'sealed pool logs no stranding events');
  ok(reckless.log.length === recklessLost,
    'every death is recorded as one stranding event', `${reckless.log.length} log vs ${recklessLost} deaths`);
  const tooDeep = reckless.log.filter((e) => e.depthM >= LIMITS.fishSwimDepth);
  ok(tooDeep.length === 0, 'every logged stranding happened below the swim-depth threshold',
    tooDeep.length ? `e.g. ${tooDeep[0].depthM.toFixed(3)} m` : '');

  // Draining must actually lower the water, or the test above proves nothing.
  ok(meanSurface(reckless) < meanSurface(sealed),
    'the reckless pool ends lower than the sealed one',
    `${meanSurface(reckless).toFixed(2)} vs ${meanSurface(sealed).toFixed(2)}`);
}

console.log('numerical health');
{
  const s = freshState({ outfallArea: 1.3 });
  for (let n = 0; n < 24 * 4 * 30; n += 1) {
    s.sluice.open = seaLevel(s.hours) > meanSurface(s);
    step(s, 0.25);
  }
  let bad = 0;
  for (let k = 0; k < s.depth.length; k += 1) {
    if (!Number.isFinite(s.depth[k]) || s.depth[k] < 0) bad += 1;
    if (!Number.isFinite(s.algae[k]) || s.algae[k] < 0) bad += 1;
  }
  ok(bad === 0, '30 simulated days produce no NaN, no negative depth, no negative algae', bad);
  const surf = meanSurface(s);
  const seaMax = Math.max(...Array.from({ length: 2400 }, (_, i) => seaLevel(i * 0.25)));
  ok(surf < seaMax + 0.05, 'pool surface never exceeds the highest tide it can be fed by', `${surf.toFixed(2)} vs ${seaMax.toFixed(2)}`);
  ok(worldUnits(1) === 1 / 520, 'metres convert to world units by the marsh width');
}

console.log('seasons');
{
  // The calendar and the physics must be the same number. Asserted against the
  // year length rather than against expected strings, so changing YEAR_DAYS
  // cannot leave a passing test that describes a different year.
  ok(Math.abs(dayOfYear(0)) < 1e-9, 'the clock starts at day 0', dayOfYear(0));
  ok(Math.abs(dayOfYear(24 * YEAR_DAYS) - dayOfYear(0)) < 1e-6,
    'day of year wraps at the year boundary', dayOfYear(24 * YEAR_DAYS));

  // Seasons are a continuous cycle, not a lookup: midwinter and midsummer are
  // half a year apart and at opposite extremes.
  const midwinter = seasonIndex(0);
  const midsummer = seasonIndex(YEAR_DAYS / 2);
  ok(midwinter < -0.99 && midsummer > 0.99,
    'season index spans -1 at midwinter to +1 at midsummer',
    `${midwinter.toFixed(3)} .. ${midsummer.toFixed(3)}`);
  ok(Math.abs(seasonIndex(YEAR_DAYS) - seasonIndex(0)) < 1e-6,
    'the season is periodic in the year', seasonIndex(YEAR_DAYS));

  // Warmth and rain must disagree seasonally, or the year has only one axis.
  ok(temperatureFactorForSeason(midsummer) > temperatureFactorForSeason(midwinter),
    'shallow water warms more in summer than in winter');
  ok(rainfallMmPerHForSeason(midwinter) > rainfallMmPerHForSeason(midsummer),
    'the wet season is the cold one', 
    `${rainfallMmPerHForSeason(midwinter).toFixed(2)} vs ${rainfallMmPerHForSeason(midsummer).toFixed(2)}`);

  // The summer incentive to enter the marsh must actually be larger, because
  // that is what makes stranding a summer hazard rather than an all-year constant.
  const summerWarm = habitatValue(0.08, 0.9, temperatureFactorForSeason(midsummer));
  const winterWarm = habitatValue(0.08, 0.9, temperatureFactorForSeason(midwinter));
  ok(summerWarm > winterWarm,
    'a shallow flat is a more attractive habitat in summer',
    `${summerWarm.toFixed(3)} vs ${winterWarm.toFixed(3)}`);

  const jan = calendar(0, 2026);
  const sixMonths = calendar(24 * YEAR_DAYS / 2, 2026);
  ok(jan.year === 2026 && sixMonths.year === 2026, 'year number holds within a year');
  ok(calendar(24 * YEAR_DAYS, 2026).year === 2027, 'year number increments after a year');
  ok(jan.month !== sixMonths.month, 'the month label moves through the year',
    `${jan.month} vs ${sixMonths.month}`);
  const months = new Set();
  for (let n = 0; n < 12; n += 1) {
    months.add(calendar((24 * YEAR_DAYS * n) / 12, 2026).month);
  }
  ok(months.size === 12, 'twelve distinct month labels are produced', months.size);
}

console.log('sediment');
{
  // Accretion must be a real, slow, signed response to flooding -- not a constant
  // applied everywhere, which would be indistinguishable from nothing.
  // A marsh, not a lake. freshState's default fill of 0.55 sits well above the
  // ground's maximum elevation, which fills every cell to several metres -- a
  // regime with no flats at all, where an accretion kernel tuned to 5-20 cm sheets
  // correctly reports that nothing accretes. Fill at the top of the ground range
  // so the flats exist and the kernel has something to act on.
  const s = freshState({ fill: 0.0, outfallArea: 0 });
  const before = Array.from(s.elevationChange);
  for (let n = 0; n < 24 * 4 * 120; n += 1) {
    s.sluice.open = seaLevel(s.hours) > meanSurface(s);
    step(s, 0.25);
  }
  const built = Array.from(s.elevationChange);
  ok(before.every((v) => v === 0), 'elevation change starts at zero');
  ok(built.some((v) => v > 0), 'regularly flooded cells accrete sediment');

  // Rate bound derived from the documented calibration (order 5-15 mm/yr for a
  // regularly flooded marsh), asserted in millimetres so a units slip in
  // MM_PER_HOUR -- metres for millimetres, a factor of 1000 -- fails here rather
  // than publishing a marsh that grows a metre in a season.
  const maxGainMm = Math.max(...built) * 1000;
  const expectedMm = (9 * 120) / 365.25;
  ok(maxGainMm > 0.5 * expectedMm && maxGainMm < 1.5 * expectedMm,
    `accretion over 120 days matches the calibrated rate (expected ~${expectedMm.toFixed(2)} mm)`,
    `${maxGainMm.toFixed(2)} mm`);

  // Accretion must be uneven, or it is a constant and the marsh is not responding
  // to anything: the point is that shallow flats build faster than deep water.
  const gainers = built.filter((v) => v > 1e-6).length;
  ok(gainers > 10 && gainers < built.length,
    'accretion is concentrated on flats, not spread uniformly over the marsh',
    `${gainers} of ${built.length} cells`);

  // A cell that stays wet the whole time must not erode, and the dry-hours
  // tracker must reset when water returns, or erosion would fire on a flooded cell.
  let badDry = 0;
  for (let k = 0; k < s.depth.length; k += 1) {
    if (s.depth[k] > 0.005 && s.dryHours[k] !== 0) badDry += 1;
  }
  ok(badDry === 0, 'a wet cell has no accumulated dry hours', badDry);

  // Erosion must be conditional on duration, not on exposure alone: a cell that
  // dried for one day out of the twelve should not be losing ground.
  const e = freshState({ outfallArea: 0 });
  for (let n = 0; n < 24 * 4 * 3; n += 1) step(e, 0.25);
  const erodedShort = Array.from(e.elevationChange).some((v) => v < 0);
  ok(!erodedShort, 'three days of exposure does not erode the marsh', erodedShort);

  // And the sign must be able to go negative given real neglect.
  let everNegative = false;
  const g = freshState({ fill: 0.0, outfallArea: 2.2 });
  for (let n = 0; n < 24 * 4 * 30 * 6; n += 1) {
    g.sluice.open = false;
    step(g, 0.25);
  }
  everNegative = Array.from(g.elevationChange).some((v) => v < 0);
  ok(everNegative, 'a marsh drained for six months loses elevation');
  ok(Array.from(g.depth).every((d) => Number.isFinite(d) && d >= 0),
    'long-horizon sediment change keeps the depth field finite and non-negative');
}

console.log('productivity and salt');
{
  // Freshness must change an outcome. It was computed for a long time and read by
  // nothing, which made the rain and outfall terms decoration.
  const wet = 0.1;
  const atOptimum = algaeGrowth(0.5, wet, 0.6, 1, FRESHNESS.optimum);
  const atSea = algaeGrowth(0.5, wet, 0.6, 1, 0);
  const atFresh = algaeGrowth(0.5, wet, 0.6, 1, 1);
  ok(atOptimum > atSea && atOptimum > atFresh,
    'algal growth peaks in brackish water, not in the sea or in fresh',
    `opt ${atOptimum.toFixed(4)} sea ${atSea.toFixed(4)} fresh ${atFresh.toFixed(4)}`);
  ok(freshnessFactor(FRESHNESS.optimum) > 0.99, 'the factor is 1 at the optimum');
  ok(freshnessFactor(0.5) < 1 && freshnessFactor(0.5) > 0.5,
    'the factor is a mild penalty away from the optimum, not an off switch',
    freshnessFactor(0.5).toFixed(3));
  // Freshening cannot create growth in the dark: it scales the light-limited rate.
  const darkBrackish = algaeGrowth(0.5, 30, 1, 1, FRESHNESS.optimum);
  const darkSea = algaeGrowth(0.5, 30, 1, 1, 0);
  ok(darkBrackish < 0 && darkSea < 0,
    'deep dark water loses algae whatever the freshness', `${darkBrackish.toFixed(5)} ${darkSea.toFixed(5)}`);

  // Evaporation must concentrate salt: water leaves, salt stays, so a sealed
  // pool freshens in wet weather and re-salinises as it evaporates. Without this
  // the model freshened to 1.00 and stayed there, i.e. a pond.
  const before = freshState({ fill: -0.2, fish: 0, outfallArea: 0 });
  before.freshness = 0.6;
  let minFresh = 0.6;
  for (let n = 0; n < 24 * 4 * 200; n += 1) {
    step(before, 0.25);
    minFresh = Math.min(minFresh, before.freshness);
  }
  ok(before.freshness >= 0 && before.freshness <= 1,
    'freshness stays in [0,1] over 200 days of rain and evaporation', before.freshness.toFixed(3));
  ok(minFresh < 0.6,
    'evaporation re-salinises a sealed pool rather than only diluting it',
    `started 0.600, reached ${minFresh.toFixed(3)}, ended ${before.freshness.toFixed(3)}`);
}

console.log('recruitment');
{
  // Without recruitment the population could only shrink: measured over three
  // years every strategy lost all 34 fish and finished at zero, so the long
  // horizon added nothing to manage. A well-run marsh must sustain its stock.
  const good = freshState({ fill: 0.55, outfallArea: 0 });
  for (let n = 0; n < 24 * 4 * 365; n += 1) {
    good.sluice.open = seaLevel(good.hours) > meanSurface(good);
    step(good, 0.25);
  }
  const aliveGood = good.fish.filter((f) => f.alive).length;
  ok(good.counts.recruitedEver > 0, 'a habitable marsh recruits fish', good.counts.recruitedEver);
  ok(aliveGood > 34, 'a well-run marsh grows beyond its starting stock', `${aliveGood} > 34`);
  ok(aliveGood <= BREEDING.carryingCapacity,
    'the population is held by the carrying capacity', `${aliveGood} <= ${BREEDING.carryingCapacity}`);

  // A barren marsh must not invent fish. Food is set on only a handful of cells,
  // which is the case that exercises the food-cell floor: with no food anywhere
  // the candidate search finds nothing and a different guard fires first, so a
  // zero-food test would pass even with the floor deleted. Measured: while a pool
  // is draining, 1-39 wet food cells occur for over a thousand steps with a valid
  // candidate among them, so this range is real and not a contrivance.
  const barren = freshState({ fill: 0.55, fish: 20, outfallArea: 0 });
  barren.algae.fill(0);
  let seeded = 0;
  for (let k = 0; k < barren.depth.length && seeded < 5; k += 1) {
    if (barren.depth[k] > 0.06) {
      barren.algae[k] = 1;
      seeded += 1;
    }
  }
  // Same generous dt as the case below, so the only difference between the two is
  // how many cells carry food. Otherwise "too few cells" could pass merely
  // because the window was too short to produce anything.
  const scarce = recruitFish(barren, 24 * 30);
  ok(scarce === 0, 'a marsh with food on too few cells does not recruit', `${seeded} food cells, added ${scarce}`);

  // Above the floor, the same marsh does recruit -- otherwise the guard above is
  // just "never recruit" and proves nothing.
  const fertile = freshState({ fill: 0.55, fish: 20, outfallArea: 0 });
  fertile.algae.fill(0);
  let seededMany = 0;
  for (let k = 0; k < fertile.depth.length && seededMany < 400; k += 1) {
    if (fertile.depth[k] > 0.06) {
      fertile.algae[k] = 1;
      seededMany += 1;
    }
  }
  // Enough elapsed time to earn a fish: the rate is ~0.00035 per fish per hour,
  // so a single day of one call accrues ~0.11 and correctly adds nothing. A
  // one-day positive control would fail for a reason unrelated to the guard.
  const plentiful = recruitFish(fertile, 24 * 30);
  ok(plentiful > 0, 'a marsh with food on enough cells does recruit', `${seededMany} food cells, added ${plentiful}`);

  // The counter must equal the log, so the readout cannot claim births the model
  // did not record.
  const logged = good.log.filter((e) => e.kind === 'recruited').reduce((a, e) => a + e.count, 0);
  ok(logged === good.counts.recruitedEver,
    'the recruitment counter agrees with the event log',
    `counter ${good.counts.recruitedEver} vs log ${logged}`);

  // And a drained marsh must still be unable to recover quickly, which is what
  // makes a bad drain cost something.
  const drained = freshState({ fill: 0.55, outfallArea: 2.2 });
  for (let n = 0; n < 24 * 4 * 365; n += 1) {
    drained.sluice.open = false;
    step(drained, 0.25);
  }
  ok(drained.fish.filter((f) => f.alive).length === 0,
    'a marsh cut off and drained through the outfall loses its whole stock',
    drained.counts.strandedEver);
}

console.log('');
if (failures > 0) {
  console.error(`FAILED ${failures} of ${checks} checks`);
  process.exit(1);
}
console.log(`all ${checks} model checks passed`);
