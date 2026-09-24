export function sparseCandidates() {
    const { board, counts, votes, marks, candidates, size } = this;
    let length = 0;
    const stamp = this.generation >>> 0;
    if (!stamp) marks.fill(0xffffffff);
    for (let liveIndex = 0; liveIndex < this.alive.length; liveIndex++) {
      const key = this.alive.keys[liveIndex], owner = board[key];
      if (!owner) continue;
      if (marks[key] !== stamp) { marks[key] = stamp; counts[key] = 0; votes[key] = 0; candidates[length++] = key; }
      const x = key % size, y = Math.floor(key / size), vote = 1 << ((owner - 1) * 4);
      // Interior has the same self/NW/N/NE/W/E/SW/S/SE visitation order.
      if (x > 0 && x < size-1 && y > 0 && y < size-1) {
        { const n = key - size - 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key - size; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key - size + 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key - 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key + 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key + size - 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key + size; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        { const n = key + size + 1; if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; } counts[n]++; votes[n] += vote; }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= size) continue;
          const n = key + dy * size + dx;
          if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; }
          counts[n]++; votes[n] += vote;
        }
      }
    }
    return length;
}
