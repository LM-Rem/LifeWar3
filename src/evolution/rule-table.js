export function ruleMask(set) { let mask=0;for(let n=0;n<=8;n++)if(set.has(n))mask|=1<<n;return mask; }
export class LocalRuleIndex {
  constructor(size) {this.size=size;this.side=Math.ceil(size/32);this.signature='';this.active=false;}
  prepare(rules) {
    const compiled=rules.map(r=>({x:r.x,y:r.y,radius:r.radius,birth:ruleMask(r.birth),survival:ruleMask(r.survival)}));
    const signature=JSON.stringify(compiled);if(signature===this.signature)return;
    this.signature=signature;this.active=compiled.length>0;this.tiles=Array.from({length:this.side**2},()=>[]);
    for(const r of compiled)for(let y=Math.max(0,Math.floor((r.y-r.radius)/32));y<=Math.min(this.side-1,Math.floor((r.y+r.radius)/32));y++)
      for(let x=Math.max(0,Math.floor((r.x-r.radius)/32));x<=Math.min(this.side-1,Math.floor((r.x+r.radius)/32));x++)this.tiles[y*this.side+x].push(r);
  }
  at(key) {
    const x=key%this.size,y=Math.floor(key/this.size),list=this.tiles[Math.floor(y/32)*this.side+Math.floor(x/32)];
    for(let i=list.length-1;i>=0;i--){const r=list[i];if((r.x-x)**2+(r.y-y)**2<=r.radius**2)return r;}
    return null;
  }
}
