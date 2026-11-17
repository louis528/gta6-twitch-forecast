// Leave-one-out validation for the forecast model in ../main.ts.
//
// Every comparable in a practice case's pool becomes a pseudo-target in turn: a synthetic case
// whose `known` is that launch's own hour 1 and whose `comparables` are the rest of the pool,
// exactly the shape the real final case has. The model (run as a black box, the way the grader
// runs it) forecasts hours 2..24; we score the mean pinball loss on the log scale against the
// launch's actual release-day hours, and score the house baseline (flat at hour 1, spread
// 0.15 * sqrt(h - 1)) on the same pseudo-targets for reference.
//
// Usage: node tools/loo.mjs [practice-case.in ...]   (default: the kit's four practice cases;
// their comparable pools are the same 38 launches, so the first file's pool is used)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', 'main.ts');
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOUR_MS = 3_600_000;

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('pass at least one practice case .in file (the kit input/ directory)');
}
const seedCase = JSON.parse(readFileSync(files[0], 'utf8'));
const pool = seedCase.comparables;

/** A comparable's release-day curve, hour (1..24) -> mean viewers (same bucketing as main.ts). */
function releaseDayCurve(g) {
  const start = Date.parse(g.day_start);
  const sums = new Map();
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
  const curve = new Map();
  for (const [h, acc] of sums) curve.set(h, acc.total / acc.n);
  return curve;
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Build the synthetic cases and their actuals. */
const cases = [];
const actuals = new Map();
for (const g of pool) {
  const curve = releaseDayCurve(g);
  const v1 = curve.get(1);
  if (v1 === undefined || !(v1 > 0)) continue;
  const scored = [...curve.keys()].filter((h) => h >= 2 && h <= 24);
  if (scored.length < 18) continue;
  const start = Date.parse(g.day_start);
  const id = `loo-${cases.length}`;
  // The launch's own pre-release history, as a real case carries it: whole-hour means from 14
  // days before the release day up to the checkpoint (hour 1 included).
  const ownHourly = g.hourly
    .filter((p) => Date.parse(p.from) < start + HOUR_MS)
    .map((p) => ({ from: p.from, viewers: p.viewers, channels: p.channels ?? null, reads: 1 }));
  const synth = {
    schema: 'makefun/twitch-ccu-case/v1',
    id,
    game: { name: g.name, twitch_id: 'loo' },
    day_start: g.day_start,
    checkpoint: iso(start + HOUR_MS),
    levels: LEVELS,
    known: [{ hour: 1, from: iso(start), until: iso(start + HOUR_MS), viewers: v1, channels: null, reads: 1 }],
    forecast: Array.from({ length: 23 }, (_, i) => ({
      hour: i + 2,
      from: iso(start + (i + 1) * HOUR_MS),
      until: iso(start + (i + 2) * HOUR_MS),
    })),
    history: ownHourly.map((p) => ({ at: p.from, viewers: p.viewers, channels: p.channels })),
    history_hourly: ownHourly,
    streams: null,
    categories_hourly: null,
    comparables: pool.filter((o) => o !== g),
    notes: `leave-one-out pseudo-target for ${g.name}`,
  };
  cases.push({ id, name: g.name, unlock: g.unlock ?? '', platforms: g.platforms ?? '', synth });
  actuals.set(id, curve);
}

const inDir = mkdtempSync(join(tmpdir(), 'loo-in-'));
const outDir = mkdtempSync(join(tmpdir(), 'loo-out-'));
for (const c of cases) writeFileSync(join(inDir, `${c.id}.in`), JSON.stringify(c.synth));
execFileSync('node', [MAIN], {
  env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
  stdio: 'inherit',
});

/** Mean pinball loss on the log scale, plus coverage and typical miss, of one forecast. */
function score(qByHour, curve) {
  let loss = 0;
  let items = 0;
  let covered = 0;
  let hours = 0;
  let absLog = 0;
  for (const [h, q] of qByHour) {
    const y = curve.get(h);
    if (y === undefined) continue;
    const ly = Math.log(Math.max(1, y));
    hours += 1;
    absLog += Math.abs(ly - Math.log(q[2]));
    if (q[0] <= y && y <= q[4]) covered += 1;
    for (let j = 0; j < 5; j += 1) {
      const d = ly - Math.log(q[j]);
      loss += 2 * Math.max(LEVELS[j] * d, (LEVELS[j] - 1) * d);
      items += 1;
    }
  }
  return { loss: loss / items, coverage: covered / hours, miss: Math.exp(absLog / hours) - 1, hours };
}

const baselineQ = (p1) =>
  new Map(
    Array.from({ length: 23 }, (_, i) => {
      const h = i + 2;
      return [h, Z.map((z) => Math.max(1, p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1))))];
    }),
  );

let modelSum = 0;
let baseSum = 0;
let n = 0;
const rows = [];
for (const c of cases) {
  const out = JSON.parse(readFileSync(join(outDir, `${c.id}.out`), 'utf8'));
  const qByHour = new Map(out.hours.map((r) => [r.hour, r.q]));
  const curve = actuals.get(c.id);
  const m = score(qByHour, curve);
  const b = score(baselineQ(curve.get(1)), curve);
  const gtaLike = /midnight local|rolling/i.test(c.unlock) && !/simultaneous|global unlock/i.test(c.unlock);
  rows.push({ name: c.name, model: m.loss, base: b.loss, cov: m.coverage, miss: m.miss, gtaLike, v1: curve.get(1) });
  modelSum += m.loss;
  baseSum += b.loss;
  n += 1;
}

rows.sort((a, b) => b.model - a.model);
console.log('worst 6 pseudo-targets for the model:');
for (const r of rows.slice(0, 6)) console.log(`  ${r.name.slice(0, 46).padEnd(46)} model ${r.model.toFixed(3)}  baseline ${r.base.toFixed(3)}`);
console.log('best 3:');
for (const r of rows.slice(-3)) console.log(`  ${r.name.slice(0, 46).padEnd(46)} model ${r.model.toFixed(3)}  baseline ${r.base.toFixed(3)}`);
const like = rows.filter((r) => r.gtaLike);
const big = rows.filter((r) => r.v1 >= 50000);
const mean = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
console.log(`\n${n} pseudo-targets:  model mean loss ${mean(rows, 'model').toFixed(4)}   baseline ${mean(rows, 'base').toFixed(4)}`);
console.log(`rolling-midnight subset (${like.length}):  model ${mean(like, 'model').toFixed(4)}   baseline ${mean(like, 'base').toFixed(4)}`);
console.log(`big hour-1 subset, v1 >= 50k (${big.length}):  model ${mean(big, 'model').toFixed(4)}   baseline ${mean(big, 'base').toFixed(4)}`);
const bigLike = rows.filter((r) => r.gtaLike && r.v1 >= 50000);
if (bigLike.length > 0) console.log(`rolling + big (${bigLike.length}):  model ${mean(bigLike, 'model').toFixed(4)}   baseline ${mean(bigLike, 'base').toFixed(4)}`);
console.log(`model mean 90% coverage ${mean(rows, 'cov').toFixed(3)}, mean typical miss ${(100 * mean(rows, 'miss')).toFixed(1)}%`);
