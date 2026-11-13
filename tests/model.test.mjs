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
import { algaeGrowth, fishState, habitatValue, LIMITS } from '../src/life.js';
import { initialState, seedFish, step, meanSurface } from '../src/sim.js';

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

console.log('');
if (failures > 0) {
  console.error(`FAILED ${failures} of ${checks} checks`);
  process.exit(1);
}
console.log(`all ${checks} model checks passed`);
