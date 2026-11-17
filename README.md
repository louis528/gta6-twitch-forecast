# gta6-twitch-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/louis528/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/louis528/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

An hour-by-hour quantile forecast of Grand Theft Auto VI's launch-day Twitch viewers. The program reads the case it is given — hour 1's viewer count plus the hourly curves of 40+ comparable game launches — and writes five quantiles (5/25/50/75/95%) for each of hours 2–24. It anchors on hour 1 and borrows the day's *shape* from comparable launches, weighted toward the ones whose first hour was as large as this one's: across past launches, the correlation between log hour-1 viewers and log peak ratio is −0.94, the strongest regularity in the data. Full method, the comparables table and leave-one-out validation (mean pinball loss 0.150 on the target's regime vs the house baseline's 0.226): [METHOD.md](METHOD.md).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

(`input/` is any directory of `<id>.in` case files, e.g. the competition kit's practice cases; each run writes one `<id>.out` per case. Node 22, standard library only, deterministic.)

---

<sub>Entered on [make.fun](https://make.fun/?ref=4gf5580c&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
