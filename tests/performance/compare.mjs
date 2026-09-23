// Alternating, isolated-process A/B/C. Never run this alongside tests or browsers.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { percentile } from './statistics.mjs';
const { values } = parseArgs({ options: { rounds: { type: 'string', default: '5' }, generations: { type: 'string', default: '100' },
  warmup: { type: 'string', default: '30' }, 'trace-only': { type: 'boolean', default: false }, output: { type: 'string', default: 'artifacts/performance/t01-t04-ab' } } });
for (const key of ['rounds','generations','warmup']) if (!Number.isSafeInteger(+values[key]) || +values[key] < 1) throw new Error(`Invalid ${key}`);
const variants = [...(values['trace-only'] ? [] : [{ name: 'legacy', backend: 'legacy' }]), { name: 'current', backend: 'current' }, { name: 'traced', backend: 'current', trace: true }];
const summaries = [];
mkdirSync(values.output, { recursive: true });
for (const scenario of ['P01','P03','P04']) {
  const results = { legacy: [], current: [], traced: [] };
  for (let round = 0; round < +values.rounds; round++) {
    const order = round % 2 ? [...variants].reverse() : variants;
    for (const variant of order) {
      const output = `${values.output}/${scenario}-${variant.name}-${round + 1}`;
      const args = [fileURLToPath(new URL('./runner.mjs', import.meta.url)), '--scenario', scenario, '--backend', variant.backend,
        '--rounds', '1', '--generations', values.generations, '--warmup', values.warmup, '--output', output];
      if (variant.trace) args.push('--trace');
      const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) throw new Error(`Benchmark failed: ${scenario}/${variant.name}/${round + 1}`);
      results[variant.name].push(JSON.parse(readFileSync(`${output}/report.json`)).rounds[0]);
    }
  }
  const summary = { scenario, rounds: +values.rounds, generationsPerRound: +values.generations, warmup: +values.warmup };
  for (const variant of variants) {
    const rows = results[variant.name];
    summary[variant.name] = { medianMeanMs: percentile(rows.map(r => r.tickMs.mean), .5), medianP95Ms: percentile(rows.map(r => r.tickMs.p95), .5),
      perRoundMeanMs: rows.map(r => r.tickMs.mean), perRoundP99Ms: rows.map(r => r.tickMs.p99), maxMs: Math.max(...rows.map(r => r.tickMs.max)),
      deadlineMisses: rows.reduce((sum, r) => sum + r.deadlineMisses, 0) };
  }
  if (summary.legacy) summary.meanImprovementPercent = (1 - summary.current.medianMeanMs / summary.legacy.medianMeanMs) * 100;
  summary.traceOverheadPercent = (summary.traced.medianMeanMs / summary.current.medianMeanMs - 1) * 100;
  summaries.push(summary); writeFileSync(`${values.output}/summary.json`, JSON.stringify(summaries, null, 2));
  console.log('SUMMARY ' + JSON.stringify(summary));
}
