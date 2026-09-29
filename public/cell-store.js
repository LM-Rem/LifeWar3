// Dense-key linked list: Map-compatible iteration order without boxed entries.
// Owners live in the authoritative client board; this only tracks membership.
// Legacy protocols retain sender insertion order. Negotiated bitmap packets
// retain incidental application order only; rendering uses board/world texture.
export class CellStore {
  constructor(board) {
    this.board = board; this.next = new Uint32Array(board.length); this.previous = new Uint32Array(board.length);
    this.head = 0; this.tail = 0; this.size = 0;
  }
  has(key) { return this.head === key + 1 || this.previous[key] !== 0; }
  get(key) { return this.has(key) ? this.board[key] : undefined; }
  set(key, owner) {
    if (!this.has(key)) {
      const id = key + 1;
      this.previous[key] = this.tail;
      if (this.tail) this.next[this.tail - 1] = id; else this.head = id;
      this.tail = id; this.size++;
    }
    this.board[key] = owner; return this;
  }
  delete(key) {
    if (!this.has(key)) return false;
    const before = this.previous[key], after = this.next[key];
    if (before) this.next[before - 1] = after; else this.head = after;
    if (after) this.previous[after - 1] = before; else this.tail = before;
    this.next[key] = this.previous[key] = 0; this.size--; return true;
  }
  clear() { this.next.fill(0); this.previous.fill(0); this.head = this.tail = this.size = 0; }
  *keys() { for (let id = this.head; id; id = this.next[id - 1]) yield id - 1; }
  *entries() { for (const key of this.keys()) yield [key, this.board[key]]; }
  [Symbol.iterator]() { return this.entries(); }
}

// Bitmap connections need membership/count, not a historical linked-list order.
export class BoardCells {
  constructor(board,size=0){this.board=board;this.size=size;}
  has(key){return this.board[key]!==0;}
  get(key){return this.board[key]||undefined;}
  set(key,owner){if(!this.board[key])this.size++;this.board[key]=owner;return this;}
  delete(key){if(!this.board[key])return false;this.size--;this.board[key]=0;return true;}
  clear(){this.board.fill(0);this.size=0;}
  *keys(){for(let key=0;key<this.board.length;key++)if(this.board[key])yield key;}
  *entries(){for(const key of this.keys())yield [key,this.board[key]];}
  [Symbol.iterator](){return this.entries();}
}
