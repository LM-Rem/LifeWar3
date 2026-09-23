export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export function summarize(values) {
  return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) };
}
export function rates(bytes, generations, hz, elapsedMs) {
  return { simulatedBytesPerSecond: generations ? bytes / (generations / hz) : 0,
    wallBytesPerSecond: elapsedMs > 0 ? bytes / (elapsedMs / 1000) : 0 };
}
export function candidateCount(game) {
  if (Number.isInteger(game.lastCandidateCount)) return game.lastCandidateCount;
  let count = 0; for (const mark of game.marks) if (mark === game.generation) count++;
  return count;
}
export function measure(game, { generations, hz, warmup = 0 }) {
  for (let i = 0; i < warmup && game.status === 'playing'; i++) { game.step(); game.changes.clear(); }
  const samples = [], start = performance.now(); let bytes = 0;
  for (let i = 0; i < generations && game.status === 'playing'; i++) {
    const before = game.generation, t = performance.now(); game.step(); const packet = game.packet();
    const tickMs = performance.now() - t;
    if (game.generation !== before + 1) throw new Error('Benchmark did not execute a generation');
    bytes += packet.byteLength;
    // Diagnostics deliberately outside the step+packet timing, included in wall throughput.
    samples.push({ generation: game.generation, tickMs, L: game.alive.length, C: candidateCount(game), D: game.changes.size, bytes: packet.byteLength });
    game.changes.clear();
  }
  const elapsedMs = performance.now() - start;
  return { requestedGenerations: generations, measuredGenerations: samples.length, warmup,
    status: game.status, earlyTermination: samples.length !== generations, emptyPopulation: !game.alive.length,
    tickMs: summarize(samples.map(s => s.tickMs)), L: summarize(samples.map(s => s.L)),
    C: summarize(samples.map(s => s.C)), D: summarize(samples.map(s => s.D)),
    deadlineMisses: samples.filter(s => s.tickMs > 1000 / hz).length, elapsedMs,
    ...rates(bytes, samples.length, hz, elapsedMs), memory: process.memoryUsage(), samples };
}
