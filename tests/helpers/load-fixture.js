// Test-only seed loader. No production commands may bypass deploy/playCard.
export function loadFixtureState(game, cells, { clear = true } = {}) {
  if (clear) { game.board.fill(0); game.alive.length = 0; game.changes.clear(); game.players.forEach(p => p.cells = 0); }
  for (const [key, owner] of cells) {
    if (!Number.isInteger(key) || key < 0 || key >= game.board.length || owner < 1 || owner > game.players.length) throw new Error('Invalid fixture cell');
    const old = game.board[key]; if (!old) game.alive.push(key); else game.players[old - 1].cells--;
    game.board[key] = owner; game.players[owner - 1].cells++;
  }
  game.rebuildDerivedState?.();
}
export function randomSource(seed) {
  let state = seed >>> 0, calls = 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; calls++; return state / 4294967296; };
  random.state = () => ({ state, calls }); return random;
}
