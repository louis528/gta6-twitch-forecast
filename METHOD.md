# Method — how this forecast is built

The task: for Grand Theft Auto VI's release day (2026-11-19, UTC), forecast five quantiles
(5/25/50/75/95%) of the Twitch category's concurrent viewers in each of hours 2–24, given
everything recorded up to the end of hour 1 — that hour's count included. Scoring is the mean
pinball loss on the log scale, so a 20% miss costs the same at 10,000 viewers as at 1,000,000,
and the winning move is to state the distribution you actually believe, hour by hour.

## The anchor: ratios to hour 1

The program never tries to predict the day's level from first principles. Hour 1's print
*p*₁ already contains the regions that unlocked first (for GTA VI: New Zealand 13 h before
the UTC day, central Europe 1 h before, the UK at its start), the pre-launch audience, and
the game's scale. What transfers from past launches is the day's **shape** — the ratio curve
*v_h / v*₁ — so for every comparable launch in the case file the program extracts its
release-day curve and works with the log-ratios *L_h* = ln(*v_h* / *v*₁), *h* = 2..24.

Those shapes have a common anatomy for a rolling midnight-local launch: a dip in the small
hours while the early regions sleep and the largest market is still locked, then a climb
through that market's unlock and daytime to the prime-time overlap in the evening.

## The strongest regularity: shape is a function of hour-1 scale

Across the 37 comparable launches with a usable release day, the correlation between
log hour-1 viewers and log (day peak / hour 1) is **−0.94**. Median ratio curves by hour-1
tercile make it plain:

| Hour-1 class | h2 | h4 | h6 | h9 | h12 | h15 | h18 | h20 | h22 | h24 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Small (164–26k) | 0.77 | 0.74 | 0.80 | 2.42 | 4.63 | 48.1 | 107.7 | 126.6 | 106.5 | 81.5 |
| Mid (27k–130k) | 0.85 | 0.65 | 0.93 | 0.87 | 0.97 | 1.36 | 1.64 | 1.90 | 2.01 | 1.59 |
| Big (132k–875k) | 0.92 | 0.70 | 0.67 | 0.51 | 0.57 | 0.76 | 0.98 | 1.03 | 1.15 | 0.96 |

A launch whose first hour is small has its unlock still ahead of it and can multiply a
hundredfold by prime time. A launch whose first hour is already large has, in relative
terms, already happened: its day dips to roughly half of hour 1 around midday UTC and
recovers to about hour 1 by the evening. The biggest launches on record:

| Comparable | Hour 1 | Peak hour | Peak / hour 1 |
|---|---:|---:|---:|
| ELDEN RING | 875,155 | 1 | 1.00 |
| Cyberpunk 2077 | 851,999 | 2 | 1.26 |
| Diablo IV | 533,455 | 18 | 1.26 |
| Hogwarts Legacy | 387,358 | 18 | 1.30 |
| The Last of Us Part II | 365,019 | 20 | 1.34 |
| Elden Ring Nightreign | 319,909 | 1 | 1.00 |
| Marvel Rivals | 165,939 | 22 | 1.61 |
| Starfield | 156,828 | 2 | 1.06 |
| Monster Hunter Wilds | 152,314 | 16 | 2.64 |
| Assassin's Creed Shadows | 146,993 | 23 | 1.05 |
| Call of Duty: Black Ops 6 | 139,097 | 22 | 2.74 |
| Borderlands 4 | 133,568 | 2 | 1.68 |

So each comparable is weighted by a Gaussian kernel on the distance between its log hour-1
and the target's (width 1.0 in log units): the forecast for a big launch is taught mostly by
big launches, and the same code teaches a small launch from small ones.

## The model, exactly

For each hour *h* = 2..24 the program pools the comparables' *L_h* with weights

- ×0.3 if the comparable's release day is early-access-contaminated (its "release day" is
  the decay after a peak days earlier — a misleading shape for a fresh launch);
- ×1.5 if it unlocked rolling midnight-local (and not at one simultaneous global time),
  ×0.6 if it unlocked simultaneously (a spike at one fixed UTC hour);
- ×1.25 if it is console-only, like the target;
- ×exp(−½·((ln *p*₁ − ln *v*₁) / 1.0)²) — the scale kernel above;

and reads the hour's five log-quantiles off that weighted sample, blending the weighted
empirical quantiles 50/50 with a normal fit (centre = weighted median; spread = half the
weighted inter-68% range, floored at 0.10·√(*h*−1) log units) so the 5% and 95% levels do
not ride on two order statistics of a ~40-launch sample. The forecast is
*q_τ*(*h*) = *p*₁ · exp(logq_τ(*h*)), kept non-decreasing and inside the contest's bounds.
An hour with fewer than five usable comparables falls back to the house baseline's shape.
The target category's own pre-release history, shipped in every case as a "comparable",
has no release day and is excluded from the shape pool by construction.

## Validation: leave-one-out over the comparable pool

There is no local grade, so the model was validated the honest way: each of the 37 usable
comparables became a pseudo-target in turn — a synthetic case with its own hour 1 as the
known print and the other launches as its comparables — and the program's forecasts were
scored against its actual release day, exactly as the contest scores (mean pinball loss on
the log scale). `tools/loo.mjs` reproduces this. Results (house baseline on the same
pseudo-targets in brackets):

| Set | This model | House baseline |
|---|---:|---:|
| All 37 pseudo-targets | **0.4145** | 0.9297 |
| Rolling midnight-local (8) | **0.2742** | 0.3881 |
| Big hour 1, ≥ 50k (20) | **0.2131** | 0.2509 |
| Rolling + big (6) — the target's regime | **0.1504** | 0.2264 |

Mean 90%-band coverage 0.857. For reference, the house baseline scores ≈ 0.387 on the four
practice cases; these pseudo-targets are a harder, wider set (it includes launches whose
first hour was a few hundred viewers, which no hour-1-anchored method can forecast well).

Things tried and rejected on the same validation, so the shipped model stays simple:

- *Maturity conditioning* (weighting by hour 1 relative to each launch's own pre-launch
  baseline): hurt everywhere (0.4291 rolling alone, 0.4908 combined with the scale kernel) —
  big launches have big baselines too, so the ratio mostly re-measures noise.
- *Unlock/platform similarity weights alone* (no scale kernel): 0.3858 rolling but 0.3911 on
  big hour-1 targets, where the flat baseline scores 0.2509 — the scale kernel is what makes
  the model safe in the target's regime.
- *Wider spreads* (σ × 1.15–1.3): coverage rose toward 0.90 but mean loss rose with it.
- *Scale-kernel widths* 0.7 and 1.4: both worse overall than 1.0.

## What this says about GTA VI's day

The program runs on the real case at the deadline, so the numbers below are the shapes it
will produce, read off the comparable classes — the one unknown is which class hour 1 lands
in, and the kernel interpolates smoothly between them:

- **If hour 1 is mid-sized (~50–150k):** a median that dips to ~0.65–0.85× in hours 3–6,
  crosses 1× around midday, and climbs to a peak of ~1.9–2.0× in hours 19–22.
- **If hour 1 is big (~300k+, the Elden Ring / Cyberpunk class — the expected case for the
  most anticipated launch on record, with Europe and the UK already in):** a median that
  dips to ~0.5–0.7× through the UTC morning and midday, recovers through the US unlocks
  (east coast 05:00Z, west coast 08:00Z) and the transatlantic build, and peaks around
  ~1.0–1.3× hour 1 in the 19:00–23:00Z overlap window.

Either way the distribution is wide — honestly so: at hour 20 the big class's own outcomes
span roughly 0.7× to 2.7× of hour 1 — and the 5–95% band says as much.

## Assumptions and limits

- Unlock timing as the contest states it: rolling midnight local, New Zealand first
  (2026-11-18T11:00Z), central Europe 23:00Z, UK 00:00Z, US east coast 05:00Z, west coast
  08:00Z; PS5 / Xbox Series X|S only, no PC launch, no paid early access. A surprise
  day-one PC release or a staggered delay would break the shape, not just move it.
- Comparables are SullyGnome hourly averages; the final's prints are means of minute reads.
  The measures differ slightly (an hourly average smooths within-hour spikes), which is one
  reason the spread is kept honest rather than tuned tight on the practice data.
- Category viewers include watch-party and discussion streams, in the comparables and in
  the target alike; the ratio approach cancels most of that.
- Data: SullyGnome.com hourly Twitch category averages, as shipped in the competition's
  case files (see the kit's `input/NOTICE.txt` for provenance).
