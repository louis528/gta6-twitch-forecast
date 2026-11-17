// gta6-twitch-ccu-forecast-01 — an hour-by-hour quantile forecast of a game's launch-day Twitch
// category viewers, built from the launch curves of comparable games.
//
// Model (see METHOD.md for the full write-up and the leave-one-out validation behind it):
//   Every comparable in the case file carries hourly viewer counts from 14 days before its own
//   release day to 3 days after. For each comparable we take its release day (UTC) and form the
//   log-ratios L_h = ln(v_h / v_1) of each hour h = 2..24 against its own first hour. A launch's
//   first hour is a poor anchor in absolute terms but a good one in relative terms: it already
//   contains the regions that unlocked first, and the ratio curve that follows — the overnight
//   dip while early regions sleep and the main market is still locked, then the climb through
//   the main unlocks to the prime-time overlap peak — is the shape big launches share.
//   For the target case we aggregate the comparables' L_h per hour with two weights. The
//   decisive one is a scale kernel on log hour-1 viewers: across the comparable set, log
//   hour-1 correlates with log peak ratio at about -0.94 — a launch whose first hour is
//   already large has, in relative terms, already happened (its day dips and recovers around
//   1), while a small first hour can precede a hundredfold climb — so a big launch is taught
//   mostly by big launches. The second is a similarity weight from each comparable's unlock
//   research (rolling midnight-local counts up, a single simultaneous unlock counts down,
//   early-access-contaminated curves, whose release day is post-peak decay, count least).
//   The forecast quantiles are read off that weighted distribution, blended with a normal
//   fit to its centre and spread so the 5% and 95% levels do not ride on two order statistics
//   of a ~40-launch sample. The result is anchored on the target's own hour-1 print p1:
//   q_tau(h) = p1 * exp(logq_tau(h)).
//   If a case carries no usable comparable for some hour, that hour falls back to the house
//   baseline's shape (flat at p1, spread 0.15 * sqrt(h - 1) in log space).
//
// The program is deterministic (no clock, no randomness, stable sorts), reads every *.in file
// in $MAKEFUN_INPUT_DIR (else /input) in name order, and writes one <id>.out per case to
// $MAKEFUN_OUTPUT_DIR (else /output). Node 22, standard library only, no network.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (more digits than the baseline's, same values). */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** The house baseline's log-spread per square-root hour; our floor and our fallback. */
const BASE_SIGMA = 0.15;
/** How far the aggregated centre is shrunk toward flat (0 log-ratio). 1 = no shrinkage. */
const SHRINK = 1.0;
/** Blend between the weighted empirical quantiles (1) and the normal fit (0), in log space. */
const EMPIRICAL_BLEND = 0.5;
/** The spread of an hour's log-ratio distribution is floored at this per square-root hour. */
const SIGMA_FLOOR = 0.1;
/** A multiplier on the measured spread: cross-launch samples understate one launch's own uncertainty. */
const SIGMA_MULT = 1.0;
/**
 * Scale conditioning — the strongest regularity in the comparable set (the correlation of
 * log hour-1 viewers with log peak ratio is about -0.94): a launch whose first hour is
 * already large has, in relative terms, already happened — its curve dips and recovers around
 * 1 — while a launch whose first hour is small has its unlock still ahead and can multiply
 * many times over by prime time. Comparables are kernel-weighted by the distance of their
 * log hour-1 viewers from the target's, with this width in log units.
 */
const SCALE_BW = 1.0;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}

interface Case {
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

const HOUR_MS = 3_600_000;

/** x rounded to 2 decimals (half up), as the baseline rounds. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * How much a comparable's release-day shape should count for a target that is a console-only,
 * rolling midnight-local launch with no early access (Grand Theft Auto VI's profile, and the
 * profile of the four practice launches). The case data carries the facts this reads: each
 * comparable's `unlock` research note (with its tier) and its `platforms`.
 */
function similarityWeight(g: Comparable): number {
  const text = `${g.unlock ?? ''}`.toLowerCase();
  const name = g.name.toLowerCase();
  // The target category's own pre-release history is in every case as a "comparable": it has
  // no release day to learn a shape from, so it never counts.
  if (text.includes('target-history') || name.includes('before release')) return 0;
  let w = 1;
  // An early-access launch's release day is the decay after a peak days earlier; its shape
  // would teach the model to fall all day, so it counts for little, not nothing.
  if (text.includes('early-access-contaminated') || text.includes('early access')) w *= 0.3;
  const rolling = text.includes('midnight local') || text.includes('rolling');
  const simultaneous = text.includes('simultaneous') || text.includes('global unlock');
  // A rolling midnight-local unlock produces the dip-then-climb UTC shape the target will
  // have; a single global unlock spikes at one fixed UTC hour instead.
  if (rolling && !simultaneous) w *= 1.5;
  if (simultaneous && !rolling) w *= 0.6;
  // Console-only launches share the target's platform profile.
  if (!`${g.platforms ?? ''}`.toLowerCase().includes('pc')) w *= 1.25;
  return w;
}

/**
 * A comparable's release-day curve as hour (1..24) -> mean viewers of that UTC hour, from its
 * hourly points. Points are hourly already; bucketing by whole hour and averaging keeps the
 * curve right even if a source ever samples finer.
 */
function releaseDayCurve(g: Comparable): Map<number, number> {
  const start = Date.parse(g.day_start);
  const sums = new Map<number, { total: number; n: number }>();
  for (const p of g.hourly) {
    const t = Date.parse(p.from);
    if (Number.isNaN(t) || !(p.viewers > 0)) continue;
    const idx = Math.floor((t - start) / HOUR_MS);
    if (idx < 0 || idx >= 24) continue;
    const acc = sums.get(idx + 1) ?? { total: 0, n: 0 };
    acc.total += p.viewers;
    acc.n += 1;
    sums.set(idx + 1, acc);
  }
  const curve = new Map<number, number>();
  for (const [h, acc] of sums) curve.set(h, acc.total / acc.n);
  return curve;
}

/** One weighted sample of a log-ratio. */
interface Sample {
  x: number;
  w: number;
}

/** The weighted quantile of samples at level tau: the first value whose cumulative weight reaches tau of the total. */
function weightedQuantile(samples: Sample[], tau: number): number {
  const sorted = [...samples].sort((a, b) => a.x - b.x);
  const total = sorted.reduce((s, e) => s + e.w, 0);
  let acc = 0;
  for (const e of sorted) {
    acc += e.w;
    if (acc >= tau * total) return e.x;
  }
  return sorted[sorted.length - 1].x;
}

/** The five forecast log-quantiles of one hour from its weighted log-ratio samples. */
function hourLogQuantiles(samples: Sample[], h: number): number[] {
  const median = weightedQuantile(samples, 0.5);
  // A robust spread: half the weighted inter-68% range, floored so early hours are not
  // overconfident and widened like the baseline's random walk when the sample is thin.
  const q16 = weightedQuantile(samples, 0.16);
  const q84 = weightedQuantile(samples, 0.84);
  const sigma = SIGMA_MULT * Math.max((q84 - q16) / 2, SIGMA_FLOOR * Math.sqrt(h - 1));
  return LEVELS.map((tau, j) => {
    const empirical = weightedQuantile(samples, tau);
    const normal = median + Z[j] * sigma;
    const blended = EMPIRICAL_BLEND * empirical + (1 - EMPIRICAL_BLEND) * normal;
    return SHRINK * blended + (1 - SHRINK) * 0;
  });
}

/** The house baseline's log-quantiles for one hour: flat centre, random-walk spread. */
function baselineLogQuantiles(h: number): number[] {
  return Z.map((z) => z * BASE_SIGMA * Math.sqrt(h - 1));
}

/** The forecast for one case: one row per hour the case asks for. */
function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);

  // Collect, per hour, the weighted log-ratio samples of every usable comparable.
  const byHour = new Map<number, Sample[]>();
  for (const g of c.comparables) {
    let w = similarityWeight(g);
    if (w <= 0) continue;
    const curve = releaseDayCurve(g);
    const v1 = curve.get(1);
    if (v1 === undefined || !(v1 > 0)) continue;
    // Scale kernel: distance of this comparable's log hour-1 from the target's.
    const dScale = (Math.log(p1) - Math.log(v1)) / SCALE_BW;
    w *= Math.exp(-0.5 * dScale * dScale);
    const logV1 = Math.log(v1);
    for (const [h, v] of curve) {
      if (h < 2 || h > 24) continue;
      const arr = byHour.get(h) ?? [];
      arr.push({ x: Math.log(v) - logV1, w });
      byHour.set(h, arr);
    }
  }

  return c.forecast.map(({ hour }) => {
    const samples = byHour.get(hour);
    const logq = samples !== undefined && samples.length >= 5 ? hourLogQuantiles(samples, hour) : baselineLogQuantiles(hour);
    // Exponentiate, keep the five quantiles non-decreasing, and keep every value inside the
    // contest's (0, 1e9] after rounding (a value that rounds to 0 would be an invalid case).
    let prev = 0;
    const q = logq.map((lq) => {
      const v = Math.min(1e9, Math.max(0.01, round2(p1 * Math.exp(lq))));
      const kept = Math.max(v, prev);
      prev = kept;
      return kept;
    });
    return { hour, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
