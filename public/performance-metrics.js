// Bounded diagnostics only. No game state, tokens, names or command payloads.
export class PerformanceMetrics {
  constructor({ capacity = 16384, now = () => performance.now() } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) throw new Error('Invalid trace capacity');
    this.capacity = capacity; this.now = now; this.records = new Array(capacity); this.total = 0; this.epoch = 'initial';
  }
  record(name, value = 0, generation = null, stream = '', epoch = this.epoch) {
    this.records[this.total++ % this.capacity] = { name, value, generation, stream, epoch, atMs: this.now() };
  }
  duration(name, start, generation = null, stream = '') { this.record(name, this.now() - start, generation, stream); }
  resetEpoch(epoch) { this.epoch = String(epoch); this.record('epoch'); }
  export() {
    const count = Math.min(this.total, this.capacity), start = Math.max(0, this.total - this.capacity);
    const records = Array.from({ length: count }, (_, i) => this.records[(start + i) % this.capacity]);
    return { schemaVersion: 1, clock: 'local monotonic milliseconds; not cross-host comparable',
      capacity: this.capacity, total: this.total, droppedRecords: start, complete: start === 0, records,
      generations: summarizeGenerations(records), semantics: 'drawn means Canvas submitted, not physical presentation' };
  }
}
export function summarizeGenerations(records) {
  const groups = {};
  for (const r of records) {
    if (!['computedGeneration', 'sentGeneration', 'receivedGeneration', 'appliedGeneration', 'drawnGeneration'].includes(r.name)) continue;
    const key = `${r.epoch}/${r.stream}`;
    const group = groups[key] ??= {};
    const list = group[r.name] ??= [];
    if (list.at(-1) !== r.generation) list.push(r.generation);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => {
    const drawn = new Set(group.drawnGeneration || []);
    return [key, { ...group, receivedButNotDrawn: (group.receivedGeneration || []).filter(g => !drawn.has(g)),
      gaps: Object.fromEntries(Object.entries(group).map(([name, values]) => [name, values.slice(1).reduce((n, v, i) => n + Math.max(0, v - values[i] - 1), 0)])) }];
  }));
}
export const browserMetrics = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('trace') === '1'
  ? new PerformanceMetrics() : null;
if (browserMetrics) {
  window.lifeWarPerformance = { export: () => ({ ...browserMetrics.export(),
    serverSequences: 'remote confirmations of sent packets only; use server report for computation during backpressure', environment: {
    userAgent: navigator.userAgent, dpr: devicePixelRatio, viewport: [innerWidth, innerHeight], visibility: document.visibilityState } }) };
  document.addEventListener('visibilitychange', () => browserMetrics.record(`visibility.${document.visibilityState}`));
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver(list => { for (const entry of list.getEntries()) browserMetrics.record('longTask.ms', entry.duration); }).observe({ type: 'longtask', buffered: true });
  }
}
