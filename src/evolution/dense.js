const vote = new Uint16Array([0,1,16,256,4096]);
export function denseCandidates() {
  const board=this.board,size=this.size,counts=this.counts,votes=this.votes;
  // Row-major arithmetic only; output ordering is reconstructed separately below.
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const k=y*size+x;
    if(x && x<size-1 && y && y<size-1) {
      const a=board[k-size-1],b=board[k-size],c=board[k-size+1],d=board[k-1],e=board[k+1],f=board[k+size-1],g=board[k+size],h=board[k+size+1];
      counts[k]=(a!==0)+(b!==0)+(c!==0)+(d!==0)+(e!==0)+(f!==0)+(g!==0)+(h!==0);
      votes[k]=vote[a]+vote[b]+vote[c]+vote[d]+vote[e]+vote[f]+vote[g]+vote[h];
    } else {
      let n=0,v=0;
      for(let yy=Math.max(0,y-1);yy<=Math.min(size-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(size-1,x+1);xx++) {
        if(xx===x&&yy===y)continue;const owner=board[yy*size+xx];if(owner)n++;v+=vote[owner];
      }
      counts[k]=n;votes[k]=v;
    }
  }
  return orderedCandidates.call(this);
}
function orderedCandidates() {
    const { board, marks, candidates, size } = this;
    let length = 0;
    const stamp = this.generation >>> 0;
    if (!stamp) marks.fill(0xffffffff);
    for (let liveIndex = 0; liveIndex < this.alive.length; liveIndex++) {
      const key = this.alive.keys[liveIndex], owner = board[key];
      if (!owner) continue;
      if (marks[key] !== stamp) { marks[key] = stamp; candidates[length++] = key; }
      const x = key % size, y = Math.floor(key / size), vote = 1 << ((owner - 1) * 4);
      // Interior has the same self/NW/N/NE/W/E/SW/S/SE visitation order.
      if (x > 0 && x < size-1 && y > 0 && y < size-1) {
        { const n = key - size - 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key - size; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key - size + 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key - 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key + 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key + size - 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key + size; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        { const n = key + size + 1; if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; } }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= size) continue;
          const n = key + dy * size + dx;
          if (marks[n] !== stamp) { marks[n] = stamp; candidates[length++] = n; }

        }
      }
    }
    return length;
}
