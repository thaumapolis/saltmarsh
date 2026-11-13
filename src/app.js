/**
 * app.js — the interface: canvas sizing, input, the loop, and the sentences.
 *
 * The plain-language readouts are generated from the same state the simulation
 * uses, not written as fixed strings keyed off a phase. That is deliberate: a
 * hand-written caption for "what is happening" drifts away from the model, and a
 * model that contradicts its own caption is worse than one with no caption.
 */
import { buildGround, GRID, wetArea, CELL_AREA_M2, worldUnits } from './marsh.js';
import { camera, fitZoom, Scene } from './render.js';
import { initialState, seedFish, step, meanSurface, HOURS_PER_STEP } from './sim.js';
import { census, fishState } from './life.js';
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
 * software rasteriser, so cost scales with pixels filled. 480 px wide keeps a
 * full frame comfortably inside 16 ms and upscales acceptably for a landscape,
 * where softness reads as distance rather than as a mistake.
 */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(160, Math.round(rect.width));
  const cssH = Math.max(120, Math.round(rect.height));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  internalWidth = Math.min(480, Math.round(cssW));
  internalHeight = Math.max(1, Math.round((internalWidth * cssH) / cssW));
  scene = new Scene(internalWidth, internalHeight, ground);
  imageData = ctx.createImageData(internalWidth, internalHeight);
  camera.zoom = fitZoom(ground, internalWidth, internalHeight, {});
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
      text: `Both openings closed. The pool is cut off from the sea and can only lose water to evaporation.`,
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
  el('tideLabel').textContent = rising ? 'tide rising' : 'tide falling';
  el('tideHeight').textContent = `${sea >= 0 ? '+' : ''}${sea.toFixed(2)} m`;
  el('wetLabel').textContent = `${((wet / total) * 100).toFixed(0)}%`;
  el('fishLabel').textContent = String(c.alive);
  el('fishLabel').nextElementSibling.textContent =
    c.lost > 0 ? `${c.alive} alive · ${c.lost} lost` : 'fish alive';

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

const SPEEDS = [0, 1, 4, 12];
let speedIndex = 1;

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

  scene.paintSky();
  scene.paintWater(tideSurface(), state.algae);
  commitPixels();

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
window.__saltmarsh = { state, camera, census, seaLevel, step, fitZoom, ground };
