// Tactical overview: reuse the world texture, never replay per-cell strokes.
export class MinimapCache {
  invalidate() { this.revision = -1; this.state = null; }
  beginPacket() {}
  change() {}
  draw(field, paintBackground, paintBases) {
    const w = field.minimap.width;
    this.canvas ??= document.createElement('canvas');
    this.background ??= document.createElement('canvas');
    const resized = this.canvas.width !== w || this.canvas.height !== w;
    if (resized) {
      this.canvas.width = this.canvas.height = w;
      this.background.width = this.background.height = w;
    }
    const backgroundChanged = resized || this.state !== field.state || this.me !== field.me || this.territories !== field.territories;
    if (backgroundChanged) {
      paintBackground(this.background.getContext('2d'));
      this.state = field.state; this.me = field.me; this.territories = field.territories;
    }
    if (backgroundChanged || this.revision !== field.boardRevision) {
      const c = this.canvas.getContext('2d');
      c.drawImage(this.background, 0, 0);
      if (field.state) {
        c.save(); c.globalAlpha = .8; c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(field.world, 0, 0, w, w); c.restore();
        paintBases(c);
      }
      this.revision = field.boardRevision;
    }
    field.mctx.drawImage(this.canvas, 0, 0);
  }
}
