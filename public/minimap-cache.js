// Cache the opaque composition, preserving fractional 1x1 strokes and Map order.
export class MinimapCache {
  constructor() { this.invalid = true; this.dirty = new Set(); }
  // Cell changes invalidate the composition, not the background or canvas storage.
  invalidate() { this.full = true; this.indexed = false; this.dirty.clear(); }
  beginPacket(field, count, snapshot) {
    // Avoid maintaining an index for dense updates; build it lazily for local edits.
    if (snapshot || count > 4096) { this.invalidate(); return; }
    if (count && !this.invalid && !this.full && !this.indexed) {
      this.members = Array.from({length:this.side ** 2}, () => new Set());
      for (const key of field.cells.keys()) for (const tile of this.tiles(key)) this.members[tile].add(key);
      this.indexed = true;
    }
  }
  tiles(key) {
    const x = key % 1000 * this.scale, y = Math.floor(key / 1000) * this.scale;
    const result = [];
    for (let ty = Math.max(0, Math.floor((y - 1) / 16)); ty <= Math.min(this.side - 1, Math.floor((y + 2) / 16)); ty++)
      for (let tx = Math.max(0, Math.floor((x - 1) / 16)); tx <= Math.min(this.side - 1, Math.floor((x + 2) / 16)); tx++) result.push(ty * this.side + tx);
    return result;
  }
  change(key, oldOwner, owner) {
    if (this.invalid || this.full) return;
    for (const tile of this.tiles(key)) {
      if (!owner) this.members[tile].delete(key);
      else if (!oldOwner) this.members[tile].add(key);
      this.dirty.add(tile);
    }
  }
  draw(field, paintBackground, paintBases, paintCell) {
    const w = field.minimap.width;
    const signature = JSON.stringify([field.me, field.state?.nodes.map(n => [n.x,n.y,n.owner]), field.state?.players.map(p => [p.x,p.y,p.eliminated])]);
    if (this.invalid || this.width !== w || this.signature !== signature || this.territories !== field.territories) {
      this.width = w; this.scale = w / 1000; this.side = Math.ceil(w / 16); this.signature = signature; this.territories = field.territories;
      this.canvas ??= document.createElement('canvas');
      if (this.canvas.width !== w || this.canvas.height !== w) this.canvas.width = this.canvas.height = w;
      this.context = this.canvas.getContext('2d'); this.indexed = false;
      this.background ??= document.createElement('canvas');
      if (this.background.width !== w || this.background.height !== w) this.background.width = this.background.height = w;
      paintBackground(this.background.getContext('2d'));
      this.invalid = false; this.full = true;
    }
    const c = this.context;
    if (this.full || this.dirty.size > this.side ** 2 / 2) {
      c.drawImage(this.background, 0, 0);
      if (field.state) { for (const [key, owner] of field.cells) paintCell(c, key, owner); paintBases(c); }
    } else for (const tile of this.dirty) {
      const x = tile % this.side * 16, y = Math.floor(tile / this.side) * 16, width = Math.min(16,w-x), height = Math.min(16,w-y);
      c.save(); c.beginPath(); c.rect(x,y,width,height); c.clip();
      c.drawImage(this.background,0,0);
      if (field.state) { for (const key of this.members[tile]) paintCell(c,key,field.cells.get(key)); paintBases(c); }
      c.restore();
    }
    this.full = false; this.dirty.clear(); field.mctx.drawImage(this.canvas,0,0);
  }
}
