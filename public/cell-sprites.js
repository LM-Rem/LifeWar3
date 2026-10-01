import { drawCell } from './theme-palette.js';

// Visible tile atlas: round cells without drawing every cell on every frame.
// The overview keeps the existing 1px world texture and its bounded cost.
export class CellSprites {
  constructor() { this.tiles = new Map(); }
  invalidate() { this.tiles.clear(); }
  set(key) { this.tiles.delete(Math.floor(key / 1000 / 32) * 32 + Math.floor(key % 1000 / 32)); }
  draw(field, bounds, colors) {
    const [left, right, top, bottom] = bounds, ctx = field.ctx, z = field.camera.zoom;
    for (let ty = Math.floor(top / 32); ty <= Math.min(31, Math.floor(bottom / 32)); ty++) {
      for (let tx = Math.floor(left / 32); tx <= Math.min(31, Math.floor(right / 32)); tx++) {
        const key = ty * 32 + tx;
        let tile = this.tiles.get(key);
        if (!tile) {
          tile = document.createElement('canvas'); tile.width = tile.height = 256;
          const c = tile.getContext('2d');
          for (let y = 0; y < 32 && ty * 32 + y < 1000; y++) for (let x = 0; x < 32 && tx * 32 + x < 1000; x++) {
            const owner = field.board[(ty * 32 + y) * 1000 + tx * 32 + x];
            if (owner) { c.fillStyle = colors[owner - 1]; drawCell(c, x * 8 + .65, y * 8 + .65, 6.7, 6.7, true); }
          }
          this.tiles.set(key, tile);
        }
        const [x, y] = field.screen(tx * 32, ty * 32);
        ctx.drawImage(tile, x, y, 32 * z, 32 * z);
      }
    }
    // Camera exploration cannot accumulate a whole high-resolution world.
    while (this.tiles.size > 128) this.tiles.delete(this.tiles.keys().next().value);
  }
}
