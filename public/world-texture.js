export class WorldTexture {
  constructor(context, colors, size = 1000) {
    this.context = context; this.size = size; this.image = context.createImageData(size, size);
    this.words = new Uint32Array(this.image.data.buffer);
    const bytes = new Uint8Array((colors.length + 1) * 4);
    colors.forEach((c, i) => { const n = parseInt(c.slice(1), 16); bytes.set([n >> 16, (n >> 8) & 255, n & 255, 255], (i + 1) * 4); });
    this.palette = new Uint32Array(bytes.buffer); this.side = Math.ceil(size / 32);
    this.dirty = new Set(); this.full = false;
  }
  reset() { this.words.fill(0); this.dirty.clear(); this.full = true; }
  set(key, owner) {
    this.words[key] = this.palette[owner];
    if (!this.full) this.dirty.add(Math.floor(key / this.size / 32) * this.side + Math.floor(key % this.size / 32));
  }
  flush() {
    if (this.full || this.dirty.size > this.side * this.side / 4) this.context.putImageData(this.image, 0, 0);
    else for (const tile of this.dirty) this.context.putImageData(this.image, 0, 0, tile % this.side * 32, Math.floor(tile / this.side) * 32, 32, 32);
    this.dirty.clear(); this.full = false;
  }
}
