import { performance } from "node:perf_hooks";
import { getCards, loadCards } from "../cards_engine.js";

const iterations = Number(process.env.BENCH_ITERATIONS ?? 50);
const query = process.env.BENCH_QUERY ?? "demo";
const originalConsoleTime = console.time;
const originalConsoleTimeEnd = console.timeEnd;

console.time = () => undefined;
console.timeEnd = () => undefined;

function measure(label: string, fn: () => unknown) {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const elapsedMs = performance.now() - started;
  return {
    label,
    iterations,
    totalMs: Number(elapsedMs.toFixed(2)),
    avgMs: Number((elapsedMs / iterations).toFixed(2)),
  };
}

const cardCount = loadCards().length;
const results = [
  measure("loadCards", () => loadCards()),
  measure("getCards:q", () => getCards({ q: query })),
  measure("getCards:active", () => getCards({ archived: false })),
];

console.log(JSON.stringify({ ok: true, cardCount, query, results }, null, 2));

console.time = originalConsoleTime;
console.timeEnd = originalConsoleTimeEnd;
