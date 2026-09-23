import { randomSource } from '../helpers/load-fixture.js';
export function scenario(Game, id, seed = 91) {
  if (!['P01', 'P03', 'P04'].includes(id)) throw new Error(`Unknown scenario ${id}; implemented: P01, P03, P04`);
  const g = new Game([1, 2, 3, 4].map(i => ({ name: `P${i}` })), { now: () => 0, random: randomSource(seed), cardDrawTimes: [] });
  g.players.forEach(p => p.hp = 1e12);
  // Synthetic sustained load, NOT a legal card-duration or dormancy gameplay test.
  g.baseDormancyGenerations = g.minDormancyGenerations = 1e9; g.dormancyDecayPerMinute = 0;
  function add(key, owner) { g.board[key] = owner; g.alive.push(key); g.players[owner - 1].cells++; }
  if (id === 'P01') {
    for (let y = 30; y < 950 && g.alive.length < 24000; y += 8) for (let x = 30; x < 950 && g.alive.length < 24000; x += 8) {
      if (g.players.some(p => Math.hypot(p.x - x, p.y - y) < 60)) continue;
      const owner = (g.alive.length / 4) % 4 + 1;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) add((y + dy) * 1000 + x + dx, owner);
    }
  } else if (id === 'P03') {
    g.birthRule = new Set([1,2,3,4,5,6,7,8]); g.survivalRule = new Set([0,1,2,3,4,5,6,7,8]);
    for (let key = 0; key < 800000; key++) add(key, 1);
  } else {
    const random = randomSource(seed); g.birthRule = new Set([1,3,5,7]); g.survivalRule = new Set([1,3,5,7]);
    for (let key = 0; key < 1000000; key++) if (random() < .5) add(key, key % 4 + 1);
  }
  return g;
}
