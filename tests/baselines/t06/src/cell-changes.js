// Map-compatible first-touch order and last-write value; zero is a real deletion.
export class CellChanges {
  constructor(capacity) {
    this.order = new Uint32Array(capacity); this.owners = new Uint8Array(capacity);
    this.stamps = new Uint32Array(capacity); this.epoch = 1; this.size = 0;
  }
  set(key, owner) {
    if (this.stamps[key] !== this.epoch) { this.stamps[key] = this.epoch; this.order[this.size++] = key; }
    this.owners[key] = owner; return this;
  }
  has(key) { return this.stamps[key] === this.epoch; }
  get(key) { return this.has(key) ? this.owners[key] : undefined; }
  clear() { this.size = 0; this.epoch = (this.epoch + 1) >>> 0; if (!this.epoch) { this.stamps.fill(0); this.epoch = 1; } }
  *keys() { for (let i = 0; i < this.size; i++) yield this.order[i]; }
  *values() { for (const key of this.keys()) yield this.owners[key]; }
  *[Symbol.iterator]() { for (let i = 0; i < this.size; i++) { const k = this.order[i]; yield [k, this.owners[k]]; } }
}
