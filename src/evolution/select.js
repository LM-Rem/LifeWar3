export class BackendSelector {
  constructor(mode='auto') {
    if(!['auto','sparse','dense','frontier'].includes(mode))throw new Error('Invalid evolution mode');
    this.mode=mode;this.current='sparse';this.since=0;this.switches=0;
  }
  select(game) {
    // Measured dense has no qualifying regime yet; auto deliberately stays sparse.
    const next=this.mode==='auto'?'sparse':this.mode;
    if(next!==this.current){this.current=next;this.since=game.generation;this.switches++;}
    return next;
  }
}
