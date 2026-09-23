import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PerformanceMetrics } from '../public/performance-metrics.js';
export { PerformanceMetrics };
export function instrumentGame(game, metrics, stream = '') {
  if (!metrics) return game;
  const epoch = String(game.startedAt);
  // Inline engine/dormancy markers must carry the same room/epoch as wrappers.
  game.metrics = {
    now: () => metrics.now(),
    record: (name, value, generation) => metrics.record(name, value, generation, stream, epoch),
    duration: (name, start, generation) => metrics.record(name, metrics.now() - start, generation, stream, epoch)
  };
  for (const [object, method, label] of [[game, 'step', 'step.ms'], [game, 'expireCardEffects', 'expire.ms'],
    [game, 'resolveObjectives', 'objectives.ms'], [game.dormancy, 'update', 'dormancy.ms'],
    [game.dormancy, 'scan', 'dormancy.scan.ms'], [game.dormancy, 'exactCandidates', 'dormancy.exact.ms'],
    [game, 'packet', 'packet.ms'], [game, 'state', 'state.ms'], [game, 'checkVictory', 'victory.ms'], [game, 'checkCardDraw', 'cards.ms']]) {
    const original = object[method];
    object[method] = function(...args) {
      const start = metrics.now();
      try { return original.apply(this, args); }
      finally { metrics.record(label, metrics.now() - start, game.generation, stream, epoch); }
    };
  }
  return game;
}
export function startEventLoopMetrics() {
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  return { export: () => ({ meanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : null,
    p95Ms: histogram.percentile(95) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 }), close: () => histogram.disable() };
}
