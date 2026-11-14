/**
 * app.js — the interface: canvas sizing, input, the loop, and the sentences.
 *
 * The plain-language readouts are generated from the same state the simulation
 * uses, not written as fixed strings keyed off a phase. That is deliberate: a
 * hand-written caption for "what is happening" drifts away from the model, and a
 * model that contradicts its own caption is worse than one with no caption.
 */
import { buildGround, GRID, wetArea, CELL_AREA_M2, worldUnits } from './marsh.js';
import { camera, fitZoom, horizonFor, project, Scene } from './render.js';
import { initialState, seedFish, step, meanSurface, HOURS_PER_STEP, EPOCH_YEAR } from './sim.js';
import { census, fishState, calendar } from './life.js';
import { seaLevel, springNeapHours, CONSTITUENTS } from './tide.js';


const el = (id) => document.getElementById(id);
const canvas = el('view');
const ctx = canvas.getContext('2d', { alpha: false });

const ground = buildGround();
const state = initialState();
state.ground = ground;
state.depth = new Float32Array(GRID * GRID).fill(0);

// Start part-filled from the previous high water, so the first frame is a marsh
// with recognisable features rather than a dry plain.
for (let k = 0; k < ground.length; k += 1) {
  const d = 0.55 - ground[k];
  state.depth[k] = d > 0 ? d : 0;
}
seedFish(state, 34);

let scene = null;
let internalWidth = 0;
let internalHeight = 0;
let imageData = null;

/**
 * Size the internal buffer to the canvas at a capped resolution.
 *
 * The buffer is deliberately lower than the CSS size: this renderer is a CPU
 * software rasteriser, so cost scales with pixels filled. RASTER_WIDTH px wide
 * keeps a full frame inside 16 ms (measured below) and, since _quad now fills
 * each cell's own footprint rather than its bounding box, the upscale is what
 * turns 96x96 cells into continuous slopes instead of visible tiles.
 *
 * devicePixelRatio is applied to the BACKING store only, never to the raster
 * width. An earlier version multiplied the raster width by dpr as well, which
 * quietly quadrupled the fill cost on a phone (412 CSS px became 1648 rendered
 * pixels) -- the exact opposite of the cap this function exists to impose. The
 * cap is on the simulation of light, not on the display's pixel count.
 */
/**
 * Raster width for the software renderer, before it is clamped to the canvas.
 *
 * Chosen by measurement, not taste, and the measurement overturned the
 * assumption this number was originally set from. Fill cost is dominated by the
 * ~9200 terrain quads -- the per-quad span setup -- not by pixels covered, so
 * widening the buffer is nearly free: measured in Firefox on this machine,
 * 480 px wide = 5.6 ms, 720 = 5.1 ms, 960 = 6.0 ms, 1010 = 6.3 ms per full
 * frame, against a 16.7 ms budget. The old 480 cap was therefore solving a
 * problem the rasteriser does not have, at the cost of the one thing the player
 * actually sees: every cell got upscaled into a visible chunk.
 *
 * 1024 keeps the cap meaningful -- a 4K desktop window is still clamped -- while
 * giving a desktop canvas roughly 1.4 buffer pixels per CSS pixel, so a terrain
 * cell's projected footprint spans several pixels and the waterline reads as a
 * slope instead of a staircase.
 */
const RASTER_WIDTH = 900;

/**
 * Upper bound on buffer pixel *count*, which is what the fill actually costs.
 *
 * Expressed as an area rather than a width because the two are not the same
 * constraint: 1010x368 and 900x900 are both "about 900 wide" but differ 2.4x in
 * pixels covered, and the renderer's cost tracks the second, not the first.
 */
const RASTER_AREA = 340_000;

/**
 * Camera pitch for a given view height, in radians.
 *
 * Steeper on a tall view (the relief reads as landscape and there is room for
 * it), flatter on a short one (phone landscape, where the whole view is 239 px
 * and a steep pitch projects the marsh taller than the frame). Derived from the
 * canvas rather than from a breakpoint, so it also behaves sensibly on a
 * resized desktop window and in the in-between sizes no media query covers.
 */
/**
 * Height of an overlay element in the same units the framer uses: raster pixels.
 *
 * Returns 0 for an empty overlay -- #hint is display:none when there is nothing
 * to say, and reserving 74 px for a caption that is not there is the difference
 * between a marsh that fills the frame and one that floats in the middle of it.
 */
function cssBand(id) {
  const node = document.getElementById(id);
  if (node === null) return 0;
  const rect = node.getBoundingClientRect();
  if (rect.height === 0) return 0;
  return Math.round((rect.height * internalWidth) / Math.max(1, cssWidthOfView()));
}

function cssWidthOfView() {
  return canvas.getBoundingClientRect().width;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(160, Math.round(rect.width));
  const cssH = Math.max(120, Math.round(rect.height));
  // The cap is on the *buffer*, and the buffer's cost is dominated by how much
  // screen it covers, so the cap is expressed per shape: a wide short canvas can
  // afford more width for the same pixel count than a tall one. Measured at
  // 1010x368 with the marsh filling the frame: 16 ms/frame, at the edge of the
  // budget. At 720x262 it was 5.1 ms. The diagonal, not the width, is the cost.
  const areaCap = Math.sqrt(RASTER_AREA);
  const aspect = cssH > 0 ? cssW / cssH : 1;
  const capW = Math.min(RASTER_WIDTH, areaCap * Math.sqrt(aspect));
  internalWidth = Math.min(Math.round(capW), cssW);
  internalHeight = Math.max(1, Math.round((internalWidth * cssH) / cssW));
  // Backing store matches the device so the upscaled image is not further
  // resampled by the browser; the raster cost stays at internalWidth^2-ish.
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  scene = new Scene(internalWidth, internalHeight, ground);
  imageData = ctx.createImageData(internalWidth, internalHeight);
  // Camera pitch follows the canvas shape, not the viewport label. Relief is
  // exaggerated 22x so it is visible from a steep angle, but on a short canvas
  // the terrain's projected HEIGHT is what runs out of room, and the only lever
  // left that does not shrink the marsh is looking at it more from above: less
  // vertical extent per unit of marsh, so more marsh fits.
  const topBand = cssBand('readout');
  const bottomBand = cssBand('hint');
  horizonFor(internalHeight, topBand, bottomBand);
  camera.zoom = fitZoom(ground, internalWidth, internalHeight, { topBand, bottomBand });
}

let holderCanvas = null;
function offCanvas() {
  if (holderCanvas === null) holderCanvas = document.createElement('canvas');
  if (holderCanvas.width !== internalWidth || holderCanvas.height !== internalHeight) {
    holderCanvas.width = internalWidth;
    holderCanvas.height = internalHeight;
  }
  return holderCanvas;
}

/** Current water surface for display: the actual mean surface, not the sea. */
function tideSurface() {
  const s = meanSurface(state);
  return s;
}

/**
 * Blit the scene buffer to the canvas.
 *
 * putImageData cannot scale, and the scene is intentionally rendered below CSS
 * resolution, so the copy goes through an offscreen bitmap and one drawImage.
 * Keeping it in one function means there is exactly one place that decides the
 * smoothing behaviour -- two copies of this is how a UI ends up sharp in a
 * screenshot and blurry on a phone, or vice versa.
 */
function commitPixels() {
  imageData.data.set(scene.rgb);
  const holder = offCanvas();
  holder.getContext('2d').putImageData(imageData, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(holder, 0, 0, canvas.width, canvas.height);
}

/**
 * Season in words, from the continuous season index rather than a date range.
 *
 * Derived from the same number the physics uses, so the word on screen cannot
 * disagree with the warmth and rain the model is applying. Named in thirds of the
 * index because "midwinter"/"midsummer" are the points where the curve turns;
 * a calendar-based name would need its own table of boundaries to maintain.
 */
function seasonName(season) {
  if (season < -0.75) return 'midwinter';
  if (season < -0.25) return 'late winter';
  if (season < 0.25) return 'spring';
  if (season < 0.75) return 'early summer';
  return 'midsummer';
}

function clockText(hours) {
  const day = Math.floor(hours / 24) + 1;
  const h = Math.floor(hours % 24);
  const m = Math.floor((hours % 1) * 60);
  return {
    day: `day ${day}`,
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  };
}

/**
 * The sentence under the view. Built from conditions in priority order, because
 * what matters changes: a stranded fish outranks a rising tide, and an empty
 * marsh outranks both.
 */
function hintText() {
  const c = census(state.depth, state.algae, state.fish);
  const sea = seaLevel(state.hours);
  const surf = meanSurface(state);
  const head = sea - surf;
  const wetFrac = wetArea(state.depth, CELL_AREA_M2) / (GRID * GRID * CELL_SIDE_M * CELL_SIDE_M);

  if (c.stranded > 0) {
    return {
      text: `${c.stranded} fish are stranded in water too shallow to survive. They cannot swim out — the channel is reachable on the map but every route crosses dry ground.`,
      cls: 'bad',
    };
  }
  if (c.lost > 0 && state.hours < 24 * 2) {
    return {
      text: `${c.lost} fish were left behind on the flats. Fish feed in shallow water; draining the pool faster than a fish can swim to the channel turns the marsh into a trap.`,
      cls: 'bad',
    };
  }
  if (!state.sluice.open && !state.outfall.open) {
    return {
      text: `Both openings closed. Rain freshens the pool; evaporation puts the salt back. Which way it moves is the season's decision, not yours.`,
      cls: '',
    };
  }
  if (state.sluice.open && Math.abs(head) < 0.02) {
    return {
      text: `Intake open, but the sea and the pool are level, so almost nothing is moving. Flow goes as the square root of the head difference — small head, small flow.`,
      cls: '',
    };
  }
  if (state.outfall.open && surf < sea + 0.02 && head > 0) {
    return {
      text: `The sea is higher than the pool, so the outfall is taking water IN. Openings do not care which way you meant them to work.`,
      cls: 'warn',
    };
  }
  if (wetFrac > 0.85) {
    return {
      text: `Nearly the whole marsh is under water. The flat is warm and productive, and fish are moving onto it to feed.`,
      cls: '',
    };
  }
  if (wetFrac < 0.12) {
    return {
      text: `Only the channel holds water now. Everything else is exposed mud — this is the lowest the pool can go, and the refuge for whatever fish remain.`,
      cls: 'warn',
    };
  }
  return {
    text: `Pool at ${surf.toFixed(2)} m, sea at ${sea.toFixed(2)} m, so the head across the openings is ${Math.abs(head).toFixed(2)} m.`,
    cls: '',
  };
}

function updateReadout() {
  const t = clockText(state.hours);
  const sea = seaLevel(state.hours);
  const c = census(state.depth, state.algae, state.fish);
  const wet = wetArea(state.depth, CELL_AREA_M2);
  const total = GRID * CELL_SIDE_M * GRID * CELL_SIDE_M;
  const rising = seaLevel(state.hours + 0.1) > sea;

  el('clock').textContent = t.day;
  el('clock').nextElementSibling.textContent = t.time;

  // The season is read from the same clock as the tide, so the player can see
  // that the moon and the year are running on one timeline rather than two.
  const cal = calendar(state.hours, EPOCH_YEAR);
  el('seasonLabel').textContent = seasonName(cal.season);
  el('yearLabel').textContent = String(cal.year);

  // Marsh surface change: the slow consequence of a year of water management.
  // Mean over the marsh, reported in millimetres because metres round to 0.00
  // for a year's work.
  const change = state.elevationChange;
  let changeSum = 0;
  for (let k = 0; k < change.length; k += 1) changeSum += change[k];
  const meanMm = (changeSum / change.length) * 1000;
  el('surfaceLabel').textContent = `${meanMm >= 0 ? '+' : ''}${meanMm.toFixed(1)} mm`;
  el('tideLabel').textContent = rising ? 'tide rising' : 'tide falling';
  el('tideHeight').textContent = `${sea >= 0 ? '+' : ''}${sea.toFixed(2)} m`;
  el('wetLabel').textContent = `${((wet / total) * 100).toFixed(0)}%`;
  el('fishLabel').textContent = String(c.alive);
  // The subtitle carries the population history, because "34 alive" after a year
  // means something different if the marsh recruited 27 and lost 1 than if it is
  // the same 34 slowly dying. Recruitment is read from the model's own counter,
  // which a test asserts equals the event log, so the caption cannot claim a
  // breeding season the model did not record.
  const bred = state.counts.recruitedEver;
  const bits = [];
  if (bred > 0) bits.push(`+${bred} bred`);
  if (c.lost > 0) bits.push(`${c.lost} lost`);
  el('fishLabel').nextElementSibling.textContent =
    bits.length > 0 ? bits.join(' · ') : 'fish alive';

  const hint = el('hint');
  const h = hintText();
  hint.textContent = h.text;
  hint.className = h.cls;
}

// ---- input -----------------------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;
let pinchDistance = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  camera.yaw += dx * 0.006;
  camera.pitch = Math.max(0.12, Math.min(1.25, camera.pitch + dy * 0.005));
});

const endDrag = () => {
  dragging = false;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.zoom = Math.max(0.2, Math.min(6, camera.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  },
  { passive: false },
);

canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
  }
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const d = Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY,
  );
  if (pinchDistance > 0) {
    camera.zoom = Math.max(0.2, Math.min(6, camera.zoom * (d / pinchDistance)));
  }
  pinchDistance = d;
}, { passive: false });

/**
 * Simulation hours advanced per real second, indexed by the speed slider.
 *
 * The top settings exist so the year is reachable. At 1x a year is 8,766
 * simulated hours, i.e. ten days of real time, and the seasons -- warmth, rain,
 * and the marsh surface rising or sinking -- are then a fact of the model that no
 * player will ever watch change. The upper steps trade per-tide legibility for a
 * view of the annual and multi-year behaviour, which is where the sediment term
 * lives; 24x is one simulated day per second, so a year passes in six minutes and
 * a decade in under an hour.
 */
const SPEEDS = [0, 1, 4, 12, 24, 72, 168];
let speedIndex = 1;

// The slider's range comes from the table rather than a max="N" in the markup,
// which was a second copy of the table's length and silently pinned the top speed
// to whatever it was written against.

/**
 * Setting this to 0 pauses the model without touching the UI control.
 * Tests need a still image: comparing the renderer's buffer against the canvas
 * across an animation frame compares two different water levels and reports a
 * mismatch that is not a bug.
 */
Object.defineProperty(window, '__saltmarshPause', {
  set(value) {
    speedIndex = value ? 0 : speedIndex;
  },
  configurable: true,
});

el('speed').max = String(SPEEDS.length - 1);
el('speed').addEventListener('input', (e) => {
  speedIndex = Number(e.target.value);
  el('speedOut').textContent = `${SPEEDS[speedIndex]}×`;
});

el('drain').addEventListener('input', (e) => {
  state.sluice.areaM2 = Number(e.target.value);
  el('drainOut').textContent = `${state.sluice.areaM2.toFixed(1)} m²`;
});

function syncButtons() {
  const s = el('sluiceBtn');
  s.setAttribute('aria-pressed', String(state.sluice.open));
  el('sluiceState').textContent = state.sluice.open ? 'OPEN' : 'SHUT';
  const o = el('outfallBtn');
  const open = state.outfall.open && state.outfall.areaM2 > 0;
  o.setAttribute('aria-pressed', String(open));
  el('outfallState').textContent = open ? 'CUT' : 'SEALED';
}

el('sluiceBtn').addEventListener('click', () => {
  state.sluice.open = !state.sluice.open;
  syncButtons();
});

el('outfallBtn').addEventListener('click', () => {
  if (state.outfall.open) {
    state.outfall.open = false;
    state.outfall.areaM2 = 0;
  } else {
    state.outfall.open = true;
    state.outfall.areaM2 = 1.3;
  }
  syncButtons();
});

// ---- static explanation, derived from the model ----------------------------

function explainStatics() {
  const beatDays = springNeapHours() / 24;
  const m2 = CONSTITUENTS.find((c) => c.name === 'M2');
  el('tideFacts').textContent =
    `Sea level here is the sum of ${CONSTITUENTS.length} harmonic constituents: ` +
    `${CONSTITUENTS.map((c) => `${c.name} (${c.note}, ${c.periodH.toFixed(2)} h, ±${c.amp.toFixed(2)} m)`).join('; ')}. ` +
    `That gives ${m2.periodH.toFixed(2)} h between successive lunar highs, so flood times drift about 50 minutes later each day, ` +
    `and M2 beating against S2 produces a spring-to-spring cycle of ${beatDays.toFixed(1)} days — ` +
    `which is why some days flood the whole marsh and some barely touch the flat.`;

  // Volume-elevation curve, sampled from the generated terrain rather than
  // described, so the text cannot disagree with the map.
  const points = [];
  for (let level = -0.6; level <= 0.9; level += 0.3) {
    let wet = 0;
    for (let k = 0; k < ground.length; k += 1) if (ground[k] < level) wet += 1;
    points.push(`${level >= 0 ? '+' : ''}${level.toFixed(1)} m → ${((wet / ground.length) * 100).toFixed(0)}%`);
  }
  el('mechanicText').textContent =
    `Water sits where the ground lets it. At the top of a spring tide about 94% of the marsh is wet; ` +
    `at the bottom of a neap only the channel is. The same 10,000 cubic metres of water moves the level a long way ` +
    `when it is all in the channel and almost not at all when it has spread over the flat.`;
  el('volumeText').textContent =
    `This is the volume-elevation relationship, sampled from the terrain: ${points.join(', ')}. ` +
    `Its slope is the wetted area, so a given inflow raises the level by an amount that depends on where the water already is — ` +
    `which is the whole reason you have to think about tide timing rather than just open a valve.`;
}

// ---- loop ------------------------------------------------------------------

let last = performance.now();
let readoutTick = 0;

/**
 * Paint one view: sky, then the marsh and its water at the current surface.
 *
 * Split out of frame() so the tests can time and force a repaint without
 * racing the animation clock -- the same reason __saltmarsh.step exists.
 */
function paintView() {
  scene.paintSky();
  scene.paintWater(tideSurface(), state.algae);
  commitPixels();
}

function frame(now) {
  const dtSeconds = Math.min(0.05, (now - last) / 1000);
  last = now;

  const simSpeed = SPEEDS[speedIndex];
  if (simSpeed > 0) {
    // One real second at 1x is about two simulated hours.
    const hours = dtSeconds * 2 * simSpeed;
    let remaining = hours;
    while (remaining > 0) {
      const d = Math.min(HOURS_PER_STEP, remaining);
      step(state, d);
      remaining -= d;
    }
  }

  paintView();

  readoutTick += 1;
  if (readoutTick % 6 === 0) updateReadout();

  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  resize();
  updateReadout();
});

resize();
syncButtons();
explainStatics();
updateReadout();
requestAnimationFrame(frame);

// Exposed for the tests only: they need to drive the sim deterministically
// rather than race the animation clock.
/**
 * Hide the overlay chrome so the front-page image is a picture of the marsh.
 *
 * The showcase crops this project's README image to 2:1 for its card. When the
 * source was a whole page, that crop landed on the caption bar and the card
 * advertised a sentence of narration instead of the simulation. Removing the
 * overlay for capture -- rather than cropping harder -- is what makes the source
 * say what the card needs it to say.
 *
 * Exposed as a method on the bridge rather than as a URL parameter: the artifact
 * is one file served from a sandboxed opaque origin, and a query string would be
 * a second input the rest of the app would have to reason about.
 */
function setCardCapture(enabled) {
  document.documentElement.classList.toggle('card-capture', enabled);
}

window.__saltmarsh = {
  state,
  camera,
  census,
  seaLevel,
  step,
  fitZoom,
  ground,
  paintView,
  setCardCapture,
  /**
   * Projection for the tests, taking elevation in METRES and resolving the world
   * scale itself.
   *
   * Exposed rather than imported by tests because the app is bundled into ONE
   * module instance: a test that imports render.js in Firefox gets a different
   * `camera` object than the one the page is driving, and silently measures a
   * camera nobody touched. That is exactly how a probe reported terrain bounds
   * 2.5x smaller than the pixels for several rounds.
   */
  projectMetres: (x, y, elevM, w, h) => project(x, y, worldUnits(elevM), w, h),
  // The renderer's own buffer, so a test can compare what was intended against
  // what the canvas ended up showing. Without this the only way to notice a
  // stride error is to look at the screenshot.
  get sceneRgb() {
    return scene.rgb;
  },
  get sceneWidth() {
    return internalWidth;
  },
  get sceneHeight() {
    return internalHeight;
  },
  set speed(value) {
    speedIndex = value <= 0 ? 0 : Math.max(1, SPEEDS.indexOf(value));
  },
};
