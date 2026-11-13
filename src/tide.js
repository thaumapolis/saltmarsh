/**
 * tide.js — the astronomical tide, and the head difference it produces.
 *
 * This is the part of the simulation the player does not control, and it is the
 * reason the game has a rhythm at all: whether opening the sluice moves water
 * in or out depends on a clock set by the moon. It is therefore derived from
 * real harmonic constituents rather than invented as a sine wave, because the
 * interesting behaviour comes from their interaction:
 *
 *   - M2 + S2 beat against each other, giving spring and neap tides roughly
 *     every 14.8 days. A single sine would repeat identically forever.
 *   - M2's period is 12h24m, not 12h, so successive high tides drift through the
 *     day and the marsh floods at a different hour each evening.
 *   - Adding the diurnal K1 makes the two daily highs unequal (declinational
 *     inequality), so one flood is much better than the other.
 *
 * All three of those are visible in-app, which is the point: the player is
 * reacting to a calendar, not to a random number.
 *
 * Amplitudes are illustrative of a small mesotidal coast, not survey data from
 * any particular site.
 */

/** name, amplitude in metres, period in hours. */
export const CONSTITUENTS = [
  { name: 'M2', amp: 0.6, periodH: 12.4206, note: 'lunar semidiurnal' },
  { name: 'S2', amp: 0.18, periodH: 12.0, note: 'solar semidiurnal' },
  { name: 'K1', amp: 0.14, periodH: 23.9345, note: 'lunisolar diurnal' },
];

const TWO_PI = Math.PI * 2;

/** Sea level relative to chart datum, in metres, at `hours` since the start. */
export function seaLevel(hours) {
  let h = 0;
  for (let i = 0; i < CONSTITUENTS.length; i += 1) {
    const c = CONSTITUENTS[i];
    h += c.amp * Math.sin((TWO_PI * hours) / c.periodH);
  }
  return h;
}

/**
 * Spring-neap cycle length in hours: the beat period of M2 and S2, i.e. how long
 * before the two semidiurnal constituents drift a full cycle in and out of phase.
 * Computed from the periods rather than hardcoded, so retuning an amplitude or
 * period cannot silently make the in-app "days to spring tide" readout wrong.
 */
export function springNeapHours() {
  const m2 = CONSTITUENTS.find((c) => c.name === 'M2');
  const s2 = CONSTITUENTS.find((c) => c.name === 'S2');
  if (m2 === undefined || s2 === undefined) {
    throw new Error('springNeapHours needs both M2 and S2 constituents');
  }
  return 1 / Math.abs(1 / m2.periodH - 1 / s2.periodH);
}

/**
 * The sluice. Flow through an opening driven by the head difference, using the
 * orifice equation Q = A * Cd * sqrt(2*g*|dh|) with the sign of the head.
 *
 * This is why the game is not "hold the button to fill the pond": the rate is
 * nonlinear in head difference, so a big spring head drains the pool fast and a
 * small neap head barely moves it. Sluice area is in square metres.
 */
export const GRAVITY = 9.81;
export const DISCHARGE_COEFF = 0.65;

/** Signed volumetric flow in cubic metres per second. Positive floods inland. */
export function orificeFlow(areaM2, headM) {
  const magnitude = areaM2 * DISCHARGE_COEFF * Math.sqrt(2 * GRAVITY * Math.abs(headM));
  return headM >= 0 ? magnitude : -magnitude;
}
