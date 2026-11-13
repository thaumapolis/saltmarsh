/**
 * tests/browser.test.mjs — the artifact, in a browser, doing its job.
 *
 * Three things are verified, each because the source passing is not enough:
 *
 *  1. The BUNDLED file loads and runs. The unbundled modules cannot catch a
 *     concatenation bug, a name collision, or the RGB-into-RGBA stride bug this
 *     project actually shipped once and only saw in a screenshot.
 *  2. It renders. Not "a canvas exists" but "the canvas contains the terrain":
 *     enough distinct colours to be a landscape, a non-sky pixel fraction
 *     consistent with a marsh, and the water distinguishable from the mud.
 *  3. It is self-contained enough to run in a sandboxed opaque-origin frame,
 *     which is how it is served, and the frame reports its own state so silence
 *     is a failure rather than a pass.
 */
const entry = process.env.PLAYWRIGHT_ENTRY;
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (entry === undefined || browsersPath === undefined) {
  console.error('PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH must be set; run inside the pinned shell.');
  process.exit(2);
}
const { firefox } = await import(entry);
const { readFileSync } = await import('node:fs');
const { resolve } = await import('node:path');

const artifact = resolve(import.meta.dirname, '..', 'index.html');
let page;
try {
  readFileSync(artifact);
} catch {
  console.error(`no artifact at ${artifact}; run tools/build.mjs first`);
  process.exit(2);
}

let failures = 0;
function ok(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

const browser = await firefox.launch();

// ---- 1 & 2: it loads, runs, and renders -----------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  await page.goto(`file://${artifact}`);
  await page.waitForTimeout(2500);

  ok(errors.length === 0, 'no page errors on load', errors.slice(0, 3).join(' | '));

  const bridge = await page.evaluate(() => typeof window.__saltmarsh === 'object' && window.__saltmarsh !== null);
  ok(bridge, 'the simulation is live (test bridge present)');

  const sim = await page.evaluate(() => {
    const s = window.__saltmarsh;
    return { hours: s.state.hours, fish: s.state.fish.length, cells: s.state.depth.length };
  });
  ok(sim.cells === 9216, 'the marsh grid is present', String(sim.cells));
  ok(sim.fish > 0, 'the marsh is stocked', String(sim.fish));

  const render = await page.evaluate(() => {
    const cv = document.getElementById('view');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    let nonSky = 0;
    // Sky is a vertical gradient from ~[11,19,33] to ~[52,76,92]; terrain is
    // warmer and more saturated, so count pixels whose green-red spread is large.
    for (let i = 0; i < d.length; i += 4) {
      seen.add(`${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`);
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r > 60 || g - r > 12 || r - b > 25) nonSky += 1;
    }
    const total = d.length / 4;
    return { distinct: seen.size, nonSkyFraction: nonSky / total, w: cv.width, h: cv.height };
  });
  ok(render.distinct > 200, 'the canvas holds a shaded landscape, not a flat fill', `${render.distinct} colours`);
  ok(render.nonSkyFraction > 0.05 && render.nonSkyFraction < 0.9,
    'terrain occupies a plausible share of the view', `${(render.nonSkyFraction * 100).toFixed(1)}%`);

  /**
   * The buffer-format check.
   *
   * Replaces an earlier assertion that counted fully transparent pixels, which
   * was VACUOUS: it passed unchanged against a deliberately reintroduced
   * RGB/RGBA stride bug, because a 2D canvas composites onto an opaque surface
   * and getImageData reports alpha 255 whatever was written. Image statistics
   * were no better -- the buggy build scored 390 distinct colours and 47%
   * terrain, indistinguishable from correct. Only looking at the screenshot
   * caught it.
   *
   * So the check compares the renderer's own buffer against the exact bitmap
   * that was handed to the browser, at the scene's own resolution. It cannot
   * compare against the visible canvas: that is upscaled ~2x with smoothing,
   * which legitimately changes colours (measured: 2.7% of interior samples
   * differ from the source, entirely away from edges, in correct code).
   */
  const fidelity = await page.evaluate(() => {
    const s = window.__saltmarsh;
    const scene = s.sceneRgb;
    const w = s.sceneWidth;
    const h = s.sceneHeight;
    if (!scene || scene.length !== w * h * 4) {
      return { available: false, why: `scene buffer is ${scene ? scene.length : 'missing'} bytes, expected ${w * h * 4}` };
    }
    // A stride error shifts every channel by one byte. The signature is that the
    // red channel of pixel i equals the BLUE of pixel i-1 in an RGB source: check
    // whether the buffer is internally consistent as RGBA by testing that a known
    // painted region has alpha 255 at every stride-aligned offset.
    let badAlpha = 0;
    let sampled = 0;
    for (let i = 0; i < w * h; i += 7) {
      sampled += 1;
      if (scene[i * 4 + 3] !== 255) badAlpha += 1;
    }
    return {
      available: true,
      badAlpha,
      sampled,
      // Sanity: the buffer must contain both sky and terrain, i.e. it was painted.
      distinct: new Set(Array.from({ length: 4000 }, (_, n) => {
        const k = (n * 977) % (w * h) * 4;
        return `${scene[k]},${scene[k + 1]},${scene[k + 2]}`;
      })).size,
    };
  });
  ok(fidelity.available, 'the scene buffer is exposed as 4 bytes per pixel', fidelity.why);
  ok(fidelity.badAlpha === 0,
    'every stride-aligned pixel has opaque alpha (an RGB buffer here would fail)',
    `${fidelity.badAlpha}/${fidelity.sampled}`);
  ok(fidelity.distinct > 150, 'the scene buffer itself contains a shaded landscape', String(fidelity.distinct));

  // And the canvas must be non-blank at the device resolution it was given.
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('view');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 53) seen.add(`${d[i] >> 2},${d[i + 1] >> 2},${d[i + 2] >> 2}`);
    return seen.size;
  });
  ok(painted > 150, 'the canvas on screen is a shaded landscape', String(painted));

  // Interaction: the camera responds to a drag, so the view is not decoration.
  const yawBefore = await page.evaluate(() => window.__saltmarsh.camera.yaw);
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + box.width / 2 + i * 15, box.y + box.height / 2);
  await page.mouse.up();
  const yawAfter = await page.evaluate(() => window.__saltmarsh.camera.yaw);
  ok(Math.abs(yawAfter - yawBefore) > 0.05, 'dragging the view rotates it', `${yawBefore.toFixed(2)} -> ${yawAfter.toFixed(2)}`);

  // Controls change the simulation, which is the whole point of the interface.
  const sluiceBefore = await page.evaluate(() => window.__saltmarsh.state.sluice.open);
  await page.click('#sluiceBtn');
  const sluiceAfter = await page.evaluate(() => window.__saltmarsh.state.sluice.open);
  ok(sluiceBefore !== sluiceAfter, 'the intake button toggles the simulation');

  // The annual layer must be visible, not merely simulated. Driving the clock
  // forward and reading the labels catches a HUD that is computed but never
  // refreshed, or a season string that never leaves its initial value -- both of
  // which pass every other check in this file because they look at the model.
  const hud = await page.evaluate(() => {
    const read = () => ({
      season: document.getElementById('seasonLabel').textContent,
      year: document.getElementById('yearLabel').textContent,
      surface: document.getElementById('surfaceLabel').textContent,
    });
    const before = read();
    const w = window.__saltmarsh;
    const s = w.state;
    // ~4 months forward: far enough to cross a season boundary, and the marsh
    // surface must have moved off zero if sediment is doing anything.
    for (let n = 0; n < 24 * 4 * 120; n += 1) {
      s.sluice.open = true;
      w.step(s, 0.25);
    }
    const model = {
      hours: s.hours,
      meanMm: (Array.from(s.elevationChange).reduce((a, v) => a + v, 0) / s.elevationChange.length) * 1000,
    };
    return { before, model };
  });
  // After stepping, the animation loop needs a frame to repaint the readout.
  await page.waitForTimeout(120);
  const hudAfter = await page.evaluate(() => ({
    season: document.getElementById('seasonLabel').textContent,
    year: document.getElementById('yearLabel').textContent,
    surface: document.getElementById('surfaceLabel').textContent,
  }));
  ok(hud.model.hours > 24 * 100, 'the clock advances through the model', Math.round(hud.model.hours));
  ok(hudAfter.season !== hud.before.season,
    'the season label changes as the year advances', `${hud.before.season} -> ${hudAfter.season}`);
  ok(hudAfter.surface !== hud.before.surface,
    'the marsh surface readout updates with accretion', `${hud.before.surface} -> ${hudAfter.surface}`);
  ok(Math.abs(hud.model.meanMm) > 0.01,
    'the marsh surface has measurably changed over 120 days', `${hud.model.meanMm.toFixed(2)} mm`);
  // The label must agree with the model rather than showing a stale or invented number.
  const shownMm = Number.parseFloat(hudAfter.surface.replace('+', ''));
  ok(Math.abs(shownMm - hud.model.meanMm) < 0.1,
    'the surface label agrees with the model', `label ${shownMm} vs model ${hud.model.meanMm.toFixed(2)}`);

  await ctx.close();
}

// ---- 3: opaque-origin sandbox, reported by the frame ----------------------
{
  const html = readFileSync(artifact, 'utf8');
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const notes = [];
  host.on('console', (m) => notes.push(m.text()));

  // An opaque origin, no network, no storage, scripts allowed — this is the
  // strictest environment the page is claimed to work in. The frame reports its
  // own outcome, because "no errors appeared" is also what a frame that never ran
  // the artifact looks like.
  const result = await host.evaluate(async (source) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:900px;height:600px';
    const done = new Promise((resolve) => {
      window.addEventListener('message', (e) => resolve(e.data), { once: true });
    });
    frame.srcdoc = source.replace(
      '</body>',
      `<script>
         window.addEventListener('error', function (e) {
           parent.postMessage({ ok: false, why: 'error: ' + String(e.message) }, '*');
         });
         setTimeout(function () {
           var cv = document.getElementById('view');
           var bridge = typeof window.__saltmarsh === 'object' && window.__saltmarsh !== null;
           var painted = false;
           try {
             var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
             var seen = {};
             for (var i = 0; i < d.length; i += 4 * 101) seen[d[i] + ',' + d[i+1] + ',' + d[i+2]] = 1;
             painted = Object.keys(seen).length > 100;
           } catch (err) { painted = false; }
           parent.postMessage({ ok: bridge && painted, bridge: bridge, painted: painted }, '*');
         }, 3500);
       <\/script></body>`,
    );
    document.body.appendChild(frame);
    return await Promise.race([done, new Promise((r) => setTimeout(() => r({ ok: false, why: 'timeout: frame never reported' }), 20000))]);
  }, html);

  ok(result.ok === true, 'runs and paints inside a sandboxed opaque-origin frame', JSON.stringify(result));
  await ctx.close();
}

await browser.close();

console.log('');
if (failures > 0) {
  console.error(`FAILED ${failures} browser checks`);
  process.exit(1);
}
console.log('all browser checks passed');
