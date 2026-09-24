import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { environment } from './environment.mjs';
import { measure } from './statistics.mjs';
import { scenario } from './scenarios.mjs';
const { values } = parseArgs({ options: { profile: { type: 'string', default: 'quick' }, scenario: { type: 'string', default: 'P01' },
  mode: { type: 'string' }, locals: { type: 'string', default: '0' }, population: { type: 'string' }, backend: { type: 'string', default: 'current' }, baseline: { type: 'string' }, output: { type: 'string' }, generations: { type: 'string' }, rounds: { type: 'string' }, warmup: { type: 'string' },
  trace: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('runner.mjs --profile smoke|quick|full --scenario P01|P03|P04 --backend current|legacy|baseline [--baseline DIR/] [--mode auto|sparse|dense|alternate] [--locals 0..8] [--population N] [--trace] [--generations N] [--rounds N] [--warmup N] [--output DIR]'); process.exit(0);
}
const profiles = { smoke: [10, 20, 1], quick: [20, 300, 3], full: [100, 1000, 5] };
if (!profiles[values.profile] || !['current', 'legacy', 'baseline'].includes(values.backend)) throw new Error('Invalid profile/backend; use --help');
if (values.backend === 'baseline' && !values.baseline) throw new Error('--baseline DIR/ is required');
if(values.mode&&!['auto','sparse','dense','alternate'].includes(values.mode))throw new Error('Invalid evolution mode');
if(!Number.isInteger(+values.locals)||+values.locals<0||+values.locals>8)throw new Error('Invalid local-rule count');
let [warmup, generations, rounds] = profiles[values.profile];
warmup = +(values.warmup ?? warmup); generations = +(values.generations ?? generations); rounds = +(values.rounds ?? rounds);
if (![warmup, generations, rounds].every(Number.isSafeInteger) || warmup < 0 || generations < 1 || rounds < 1) throw new Error('Invalid sample counts');
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('../fixtures/performance/production-20hz.json', import.meta.url));
const sourceBase = values.backend === 'baseline' ? new URL(values.baseline, pathToFileURL(process.cwd() + '/')) : new URL(values.backend === 'legacy' ? '../reference/' : '../../', import.meta.url);
const { Game, RULES } = await import(new URL('src/engine.js', sourceBase));
const { instrumentGame, PerformanceMetrics } = await import('../../src/metrics.js');
const report = { schemaVersion: 1, evolutionMode: values.mode ?? process.env.LIFEWAR_EVOLUTION ?? 'auto', localRules: +values.locals, requestedPopulation: values.population ?? null, backendUsed: values.backend, trace: values.trace, scenario: values.scenario, environment: environment(), rules: RULES,
  synthetic: 'frozen time, fixed rule, HP 1e12, dormancy threshold 1e9; not legal card durations',
    timing: 'step+packet only; C diagnostics outside tick timing but included in wall throughput; no network/browser', sourceHashes: {}, rounds: [] };
report.harnessHashes = {};
for (const rel of ['src/metrics.js', 'src/performance-config.js', 'public/performance-metrics.js', 'tests/performance/runner.mjs',
  'tests/performance/statistics.mjs', 'tests/performance/scenarios.mjs', 'tests/helpers/load-fixture.js', 'tests/fixtures/performance/production-20hz.json']) {
  report.harnessHashes[rel] = createHash('sha256').update(readFileSync(new URL('../../' + rel, import.meta.url))).digest('hex');
}
for (const rel of [...readdirSync(new URL('src/',sourceBase),{recursive:true}).filter(name=>name.endsWith('.js')).map(name=>'src/'+name.replaceAll('\\','/')), 'public/cards.js','public/cards.json','public/territory.js']) {
  const base = sourceBase;
  report.sourceHashes[rel] = createHash('sha256').update(readFileSync(new URL(rel, base))).digest('hex');
}
report.referenceManifestHash = createHash('sha256').update(readFileSync(new URL('../reference/manifest.json', import.meta.url))).digest('hex');
for (let round = 0; round < rounds; round++) {
  const game = scenario(Game, values.scenario);
  if(values.population){
    const target=+values.population;if(!Number.isInteger(target)||target<1||target>game.alive.length)throw new Error('Invalid population');
    const old=[...game.alive];for(let i=target;i<old.length;i++){const k=old[i];game.players[game.board[k]-1].cells--;game.board[k]=0;}game.alive.length=target;game.rebuildDerivedState?.();
  }
  game.localRules=Array.from({length:+values.locals},(_,i)=>({x:400+i*25,y:450,radius:80,birth:new Set([3]),survival:new Set([2,3]),endsAt:1e12}));
  if(values.mode&&game.backendSelector){
    if(values.mode==='alternate'){const step=game.step.bind(game);game.step=(...args)=>{game.backendSelector.mode=game.generation%2?'dense':'sparse';return step(...args);};}
    else game.backendSelector.mode=values.mode;
  }
  const metrics = values.trace ? new PerformanceMetrics({ capacity: 100000 }) : null;
  if (metrics) instrumentGame(game, metrics);
  const result = measure(game, { generations, warmup, hz: RULES.hz });
  report.rounds.push({ ...result, trace: metrics?.export() ?? null });
  console.log(JSON.stringify({ round: round + 1, backend: values.backend, trace: values.trace, scenario: values.scenario,
    tickMs: result.tickMs, L: result.L, C: result.C, D: result.D, deadlineMisses: result.deadlineMisses }));
  if (result.earlyTermination || result.emptyPopulation) throw new Error('Invalid load: early termination or empty population');
}
if (values.output) { mkdirSync(values.output, { recursive: true }); writeFileSync(`${values.output}/report.json`, JSON.stringify(report, null, 2) + '\n'); }
