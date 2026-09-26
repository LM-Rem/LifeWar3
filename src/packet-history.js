// Bounded, shared per-room history. Every entry is one original generation.
export class PacketHistory {
  constructor({ maxGenerations = 32, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.maxGenerations = maxGenerations; this.maxBytes = maxBytes; this.frames = new Map(); this.bytes = 0;
  }
  add(generation, packets) {
    if (this.frames.has(generation)) this.remove(generation);
    const bytes = [...packets.values()].reduce((sum, packet) => sum + packet.byteLength, 0);
    this.frames.set(generation, { packets, bytes }); this.bytes += bytes;
    while (this.frames.size > this.maxGenerations || this.bytes > this.maxBytes) this.remove(this.frames.keys().next().value);
  }
  remove(generation) { this.bytes -= this.frames.get(generation).bytes; this.frames.delete(generation); }
  after(generation, through, version) {
    if (!Number.isSafeInteger(generation) || through - generation > this.maxGenerations) return null;
    const result = [];
    for (let g = generation + 1; g <= through; g++) {
      const packet = this.frames.get(g)?.packets.get(version);
      if (!packet) return null;
      result.push(packet);
    }
    return result;
  }
}
