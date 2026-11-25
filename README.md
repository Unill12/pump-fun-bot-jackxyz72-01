# pump-fun-bot-jackxyz72-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Unill12/pump-fun-bot-jackxyz72-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Unill12/pump-fun-bot-jackxyz72-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A floor-aware launch sniper and dip rider for pump.fun bonding curves on the agent-fun/replay/v2 harness. It buys young curves with real early buyer flow, pyramids into strength as the real SOL reserve grows, and rides the few runners with a trailing stop while cutting the rest fast.

## Strategy

A pump.fun curve's price can never fall below its create price (virtual SOL is floored at the 30 SOL seed and virtual tokens are capped at total supply), so buying near the floor caps the downside. The bot:

- **Snipes launches** in the first slots after `CreateEvent` that show organic flow: several distinct non-creator buyers, no creator dump, low sell ratio, capped run-up.
- **Pyramids into strength**: adds while the price steps up and net SOL keeps flowing in, up to the stake cap (each buy is also capped at 1% of the curve's real SOL reserve).
- **Rides dips**: a coin that peaked 2x+ and retraced back near its floor with fresh inflow is bought again for the second leg (leg is off by default in `TUNING`).
- **Exits** on a full take-profit, a trailing stop once armed, a stop vs cost, a creator sell, staleness, a floor retrace after a run, or a time limit that does not apply while the position is up.

## Run it

```sh
node main.ts
```

`main.ts` speaks agent-fun/replay/v2 on stdin/stdout (Node 22.18+ runs the TypeScript as-is, no build, no install). `strategy.ts` holds the strategy; `vendor/makefun-bot.ts` is the kit's wire shim.

## Local grading

With the competition kit unpacked at `<kit>`:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z8qf6ayd&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
