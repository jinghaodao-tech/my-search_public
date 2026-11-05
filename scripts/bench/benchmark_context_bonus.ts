import { performance } from 'node:perf_hooks';
import { currentContextBonus, currentContextBonusNaive } from './context_bonus.js';

const sizes = [1_000, 10_000, 50_000];
const results = [];
for (const size of sizes) {
  const tokens = Array.from({ length: size }, (_, index) => index % 13 === 0 ? 'sqlite' : index % 17 === 0 ? 'locking' : `term${index % 101}`);
  const terms = ['sqlite', 'locking', 'mechanism', 'concurrent'];
  const run = (operation: () => number) => {
    const timings: number[] = [];
    for (let iteration = 0; iteration < 7; iteration += 1) {
      const started = performance.now();
      operation();
      timings.push(performance.now() - started);
    }
    return Number(timings.slice(2).sort((left, right) => left - right)[Math.floor((timings.length - 2) / 2)]!.toFixed(3));
  };
  const naive = run(() => currentContextBonusNaive(tokens, terms, 1.2, 50));
  const sliding = run(() => currentContextBonus(tokens, terms, 1.2, 50));
  results.push({ tokens: size, naiveMedianMs: naive, slidingMedianMs: sliding, speedup: Number((naive / Math.max(sliding, 1e-9)).toFixed(2)) });
}
console.log(JSON.stringify({ methodology: '7 measurements per method; first two warmups discarded; median of remaining five; same token input, window=50, maxBonus=1.2', results }, null, 2));
