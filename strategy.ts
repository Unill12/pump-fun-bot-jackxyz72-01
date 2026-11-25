// Floor-aware launch sniper + dip rider for pump.fun bonding curves.
//
// The curve math does the heavy lifting: a pump.fun price can never print
// below its create price, because virtual SOL is floored at the 30 SOL seed
// and virtual tokens are capped at total supply. Buying a young curve close
// to that floor therefore caps the loss at a few percent, while the upside
// is the run to several multiples that a small share of launches make.
//
// So the bot only buys launches that already show organic demand — several
// distinct non-creator buyers, the creator not dumping, most of the early
// flow still buying — then pyramids while the real SOL reserve keeps growing
// and the price keeps stepping up, and lets the rare runner ride under a
// trailing stop. Everything else is cut fast: creator dump, staleness, a
// retrace back to the floor after a run, or the hold timer expiring while
// the position is flat. There is also a dip leg for a coin that peaked 2x+
// and fell back near its floor with fresh inflow; it is off by default.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout; the kit shim
// in vendor/ owns the wire, this file only decides.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports in one SOL
const CURVE_FEE = 0.0125; // pump.fun takes 1.25% of every fill, each way
const BPS = 10_000;

export interface Tuning {
  snipe: {
    ageSlots: number; // buy only this soon after CreateEvent
    reserveMin: number; // real SOL on the curve, lower bound (SOL)
    reserveMax: number; // real SOL on the curve, upper bound (SOL)
    buyersMin: number; // distinct non-creator buyers so far
    buyersMax: number; // too many buyers = already crowded
    tradesMin: number; // trades seen so far
    devBuyMax: number; // creator buys in the create slot, max (SOL)
    skipDevDump: boolean; // refuse coins whose creator sold
    sellRatioBps: number; // others' sells, max share of others' buys
    runupMaxBps: number; // price already this far above create: skip
    flowMin: number; // net SOL inflow over the flow window, min (SOL)
    flowSpan: number; // flow window (slots)
  };
  sizing: {
    stake: number; // total SOL the bot will ever put in one coin
    minBuy: number; // smallest single buy (SOL)
    addsMax: number; // pyramid buys after the first, max
    addSize: number; // SOL per pyramid buy
    addStepBps: number; // price must have stepped up this far since last buy
    addGap: number; // slots between buys on the same coin
    addFlowMin: number; // net inflow over the flow window for an add (SOL)
    slipBps: number; // max slippage on every order
  };
  exit: {
    takeBps: number; // full exit when value is this far above basis
    stopBps: number; // full exit when value is this far below basis
    trailArmBps: number; // trailing stop arms once value is this far up
    trailDropBps: number; // trailing stop fires on this drop from the best
    holdMax: number; // slots, then exit unless the position is up
    holdUpBps: number; // "up" for the hold timer
    onDevDump: boolean; // exit when the creator sells
    floorBps: number; // exit when price falls back to this far above create
    floorArmBps: number; // arm the floor exit once value is this far up
    staleSlots: number; // exit after this long without a trade
  };
  dip: {
    enabled: boolean;
    peakBps: number; // peak multiple above 1x the coin must have hit
    buyBps: number; // buy only this far above the create price
    ageMax: number; // dip leg stays live this long after create
    flowMin: number; // net inflow over the flow window for a dip buy (SOL)
    stake: number; // SOL for a dip buy
  };
}

export const TUNING: Tuning = {
  snipe: {
    ageSlots: 12,
    reserveMin: 0.5,
    reserveMax: 60,
    buyersMin: 5,
    buyersMax: 40,
    tradesMin: 8,
    devBuyMax: 1,
    skipDevDump: true,
    sellRatioBps: 5000,
    runupMaxBps: 6000,
    flowMin: 0,
    flowSpan: 10,
  },
  sizing: {
    stake: 1,
    minBuy: 0.005,
    addsMax: 6,
    addSize: 0.4,
    addStepBps: 300,
    addGap: 1,
    addFlowMin: 0,
    slipBps: 10000,
  },
  exit: {
    takeBps: 60000,
    stopBps: 8000,
    trailArmBps: 2000,
    trailDropBps: 2400,
    holdMax: 600,
    holdUpBps: 2000,
    onDevDump: true,
    floorBps: 500,
    floorArmBps: 2000,
    staleSlots: 150,
  },
  dip: {
    enabled: false,
    peakBps: 10000,
    buyBps: 2500,
    ageMax: 900,
    flowMin: 0.2,
    stake: 0.15,
  },
};

// One curve the bot has seen, in first-seen order.
interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  bornSlot: number;
  floorQ: number; // virtual SOL at create (lamports)
  floorT: number; // virtual tokens at create
  devBuySol: number; // creator buys in the create slot
  devDumped: boolean; // the creator sold at least once
  trades: number;
  buyers: Set<Pubkey>; // distinct non-creator buyers
  boughtSol: number; // all buys (SOL)
  soldSol: number; // sells by non-creators (SOL)
  lastTradeSlot: number;
  tape: { slot: number; buy: boolean; sol: number; who: Pubkey }[];
  peakBps: number; // best multiple over create, in bps (10000 = 1x)
  buys: number; // buys sent so far
  spentSol: number; // SOL sent in buys so far
  lastPrice: number; // price at the last buy
  lastSlot: number; // slot of the last buy
  retired: boolean; // no more entries for this coin
  finished: boolean; // curve completed
  dipped: boolean; // the dip leg already bought this coin once
}

// One open position, as the bot tracks it.
interface Open {
  openedSlot: number;
  feesSol: number; // tx fees paid on fills for this position (SOL)
  bestSol: number; // best net close value seen (SOL)
  floorArmed: boolean;
}

// What selling the whole position nets after the curve fee, in lamports.
function closeValue(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  return ((tokens * vq) / (vt + tokens)) * (1 - CURVE_FEE);
}

export function createBot(t: Tuning = TUNING): Bot {
  const coins = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, Open>();
  const selling = new Set<Pubkey>();

  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          creator: e.creator,
          bornSlot: e.slot,
          floorQ: Number(e.virtual_quote_reserves),
          floorT: Number(e.virtual_token_reserves),
          devBuySol: 0,
          devDumped: false,
          trades: 0,
          buyers: new Set(),
          boughtSol: 0,
          soldSol: 0,
          lastTradeSlot: e.slot,
          tape: [],
          peakBps: BPS,
          buys: 0,
          spentSol: 0,
          lastPrice: 0,
          lastSlot: 0,
          retired: false,
          finished: false,
          dipped: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / SOL;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        const multBps = Math.floor((price / (c.floorQ / c.floorT)) * BPS);
        if (multBps > c.peakBps) c.peakBps = multBps;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.tape.push({ slot: e.slot, buy: e.is_buy, sol, who: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.boughtSol += sol;
          if (isDev && e.slot === c.bornSlot) c.devBuySol += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devDumped = true;
        } else {
          c.soldSol += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.finished = true;
          c.retired = true;
        }
      }
    }
  }

  // Net SOL flow and distinct non-creator buyers over the recent window.
  function windowFlow(c: Coin, slot: number): { net: number; buyers: number } {
    const from = slot - t.snipe.flowSpan;
    let drop = 0;
    while (drop < c.tape.length && c.tape[drop]!.slot <= from) drop++;
    if (drop > 0) c.tape.splice(0, drop);
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (const tick of c.tape) {
      if (tick.buy) {
        net += tick.sol;
        if (tick.who !== c.creator) buyers.add(tick.who);
      } else {
        net -= tick.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      ingest(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / SOL;
      const marks = new Map<Pubkey, { vq: number; vt: number }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: Number(m.virtual_quote_reserves), vt: Number(m.virtual_token_reserves) });
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (flatten / write-off): forget the position.
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const o = open.get(f.mint);
        if (f.status !== 'rejected' && o !== undefined) {
          o.feesSol += Number(f.tx_fee_lamports) / SOL;
        }
        if (f.side === 'buy' && f.status === 'filled' && o === undefined) {
          open.set(f.mint, {
            openedSlot: f.slot,
            feesSol: Number(f.tx_fee_lamports) / SOL,
            bestSol: 0,
            floorArmed: false,
          });
        }
      }
      for (const mint of [...selling]) {
        if (!pendingSide(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingSide(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      // ---- exits first: one full sell per position at most ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let o = open.get(mint);
        if (o === undefined) {
          o = { openedSlot: state.slot, feesSol: tx, bestSol: 0, floorArmed: false };
          open.set(mint, o);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: Number(cv.virtual_quote_reserves), vt: Number(cv.virtual_token_reserves) };
        }
        const value = closeValue(Number(pos.token_amount), mk.vq, mk.vt) / SOL - tx;
        const basis = Number(pos.cost_lamports) / SOL + o.feesSol;
        if (value > o.bestSol) o.bestSol = value;
        if (c !== undefined && basis > 0) {
          const upBps = Math.floor((value / basis - 1) * BPS);
          if (upBps >= t.exit.floorArmBps) o.floorArmed = true;
        }
        let exit = false;
        if (basis > 0) {
          if (value >= basis * (1 + t.exit.takeBps / BPS)) exit = true;
          if (value <= basis * (1 - t.exit.stopBps / BPS)) exit = true;
          if (
            o.bestSol >= basis * (1 + t.exit.trailArmBps / BPS) &&
            value <= o.bestSol * (1 - t.exit.trailDropBps / BPS)
          ) {
            exit = true;
          }
        }
        if (
          state.slot - o.openedSlot >= t.exit.holdMax &&
          !(basis > 0 && value >= basis * (1 + t.exit.holdUpBps / BPS))
        ) {
          exit = true;
        }
        if (c !== undefined) {
          if (t.exit.onDevDump && c.devDumped) exit = true;
          if (state.slot - c.lastTradeSlot >= t.exit.staleSlots) exit = true;
          if (o.floorArmed) {
            const createPrice = c.floorQ / c.floorT;
            const nowPrice = mk.vq / mk.vt;
            if (nowPrice <= createPrice * (1 + t.exit.floorBps / BPS)) exit = true;
          }
        }
        if (!exit) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: t.sizing.slipBps,
        });
        selling.add(mint);
        if (c !== undefined) c.retired = true;
      }

      // ---- entries: pyramid into held coins, snipe new launches ----
      let free = Number(state.freeCashLamports()) / SOL - tx * orders.length;
      let openCount = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.retired || c.finished) continue;
        const age = state.slot - c.bornSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devDumped && t.snipe.skipDevDump) {
          if (c.buys === 0) c.retired = true;
          continue;
        }
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const price = vq / vt;
        const createPrice = c.floorQ / c.floorT;
        const runupBps = Math.floor((price / createPrice - 1) * BPS);
        const rq = Number(curve.real_quote_reserves) / SOL;
        if (c.buys > 0) {
          // Pyramid: only while the price keeps stepping up on fresh inflow.
          if (c.buys > t.sizing.addsMax) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || pendingSide(state, c.mint, 'buy')) continue;
          if (state.slot - c.lastSlot < t.sizing.addGap) continue;
          if (runupBps < Math.floor((c.lastPrice / createPrice - 1) * BPS) + t.sizing.addStepBps) continue;
          if (windowFlow(c, state.slot).net < t.sizing.addFlowMin) continue;
          const maxAdd = Number(state.maxBuyLamports(c.mint)) / SOL;
          const room = t.sizing.stake - c.spentSol;
          const amount = Math.min(t.sizing.addSize, room, maxAdd);
          if (amount < t.sizing.minBuy || free < amount + tx) continue;
          orders.push({
            side: 'buy',
            mint: c.mint,
            quote_lamports: BigInt(Math.floor(amount * SOL)),
            max_slippage_bps: t.sizing.slipBps,
          });
          free -= amount + tx;
          c.buys += 1;
          c.spentSol += amount;
          c.lastPrice = price;
          c.lastSlot = state.slot;
          continue;
        }
        // First buy: leg A (snipe a fresh launch) or leg B (dip after a 2x peak).
        const fl = windowFlow(c, state.slot);
        let stake = 0;
        if (age <= t.snipe.ageSlots) {
          if (openCount >= state.hello.caps.max_open_positions) continue;
          if (rq < t.snipe.reserveMin || rq > t.snipe.reserveMax) continue;
          if (c.devBuySol > t.snipe.devBuyMax) continue;
          if (c.trades < t.snipe.tradesMin || c.buyers.size < t.snipe.buyersMin || c.buyers.size > t.snipe.buyersMax) continue;
          if (c.boughtSol > 0 && c.soldSol > (c.boughtSol * t.snipe.sellRatioBps) / BPS) continue;
          if (runupBps > t.snipe.runupMaxBps) continue;
          if (fl.net < t.snipe.flowMin) continue;
          stake = t.sizing.stake;
        } else if (
          t.dip.enabled &&
          !c.dipped &&
          age <= t.dip.ageMax &&
          c.peakBps >= BPS + t.dip.peakBps
        ) {
          if (openCount >= state.hello.caps.max_open_positions) continue;
          if (rq < t.snipe.reserveMin || rq > t.snipe.reserveMax) continue;
          if (runupBps > t.dip.buyBps) continue;
          if (fl.net < t.dip.flowMin) continue;
          if (c.buyers.size < t.snipe.buyersMin) continue;
          stake = t.dip.stake;
          c.dipped = true;
        } else {
          if (age > Math.max(t.snipe.ageSlots, t.dip.ageMax)) c.retired = true;
          continue;
        }
        const maxBuy = Number(state.maxBuyLamports(c.mint)) / SOL;
        const amount = Math.min(stake, maxBuy);
        if (amount < t.sizing.minBuy || free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: BigInt(Math.floor(amount * SOL)),
          max_slippage_bps: t.sizing.slipBps,
        });
        free -= amount + tx;
        c.buys += 1;
        c.spentSol += amount;
        c.lastPrice = price;
        c.lastSlot = state.slot;
        openCount += 1;
      }
      return orders;
    },
  };
}
