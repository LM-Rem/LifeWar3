export class CircleIndex {
  constructor(size,capacity=128){this.size=size;this.capacity=capacity;this.cache=new Map();}
  keys(x,y,radius){
    const id=`${x}/${y}/${radius}`;if(this.cache.has(id))return this.cache.get(id);
    const keys=[];
    for(let yy=Math.max(0,y-radius);yy<=Math.min(this.size-1,y+radius);yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(this.size-1,x+radius);xx++)
      if((x-xx)**2+(y-yy)**2<=radius**2)keys.push(yy*this.size+xx);
    if(this.cache.size>=this.capacity)this.cache.delete(this.cache.keys().next().value);
    const result=Uint32Array.from(keys);this.cache.set(id,result);return result;
  }
}
