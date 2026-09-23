import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'current' }, seeds: { type: 'string', default: '5' }, generations: { type: 'string', default: '200' } } });
if (!['current', 'legacy'].includes(values.backend)) throw new Error('Only current and legacy backends exist in T01–T04');
for (const key of ['seeds', 'generations']) if (!Number.isSafeInteger(+values[key]) || +values[key] < 1) throw new Error(`Invalid ${key}`);
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('../fixtures/performance/production-20hz.json', import.meta.url));
const { Game: ReferenceGame } = await import('../reference/src/engine.js');
const { Game } = await import('../../src/engine.js');
const { replay } = await import('../helpers/replay.js');
const { randomSource } = await import('../helpers/load-fixture.js');
for (let seed = 1; seed <= +values.seeds; seed++) {
  const random = randomSource(seed), cells = [];
  for (let y = 400; y < 435; y++) for (let x = 400; x < 435; x++) if (random() < .45) cells.push([y * 1000 + x, random() < .5 ? 1 : 2]);
  console.log(JSON.stringify(replay({ ReferenceGame, Game: values.backend === 'legacy' ? ReferenceGame : Game, seed, cells, generations: +values.generations })));
}
