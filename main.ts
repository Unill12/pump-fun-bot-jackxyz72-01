import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Speak agent-fun/replay/v2 on stdin/stdout (Node 22.18+ runs the
// TypeScript as-is, no build step, no install).
await runBot(createBot());
