// Stable, reusable storage. No swap-remove: iteration order is observable.
export class OrderedCells {
  constructor(capacity) { this.keys = new Uint32Array(capacity); this.length = 0; }
  push(key) { if (this.length === this.keys.length) throw new RangeError('Cell capacity exceeded'); this.keys[this.length++] = key; }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this.keys[i]; }
  compact(board) { let n = 0; for (let i = 0; i < this.length; i++) { const k = this.keys[i]; if (board[k]) this.keys[n++] = k; } this.length = n; }
}
