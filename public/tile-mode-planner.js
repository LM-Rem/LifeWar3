// Reuse one legacy plan. New candidates only lower its payload cost.
import {planBitmap,SOLID,RLE,MASK} from './bitmap-codec.js';
export function planTileModes(keys,board) {
  const plan=planBitmap(keys,board,true);plan.payload=4;plan.represented=0;plan.hasMask=false;
  for(const t of plan.tiles){
    const area=t.width*t.height,maskBytes=128+Math.ceil(t.count*3/8);
    if(maskBytes<t.bytes){t.mode=MASK;t.bytes=maskBytes;}
    // Legacy planner counted all live cells for these tiles already.
    if(t.count>64&&(t.live===0||(t.live===area&&(t.mask&(t.mask-1))===0))){
      t.mode=SOLID;t.bytes=1;t.solidOwner=t.live?32-Math.clz32(t.mask):0;
    }else{
      const maxRuns=Math.min(32,Math.floor((t.bytes-3)/2));
      if(maxRuns>0){
        const runs=[];let owner=-1,length=0,scanned=0,aborted=false;
        scan:for(let row=0;row<t.height;row++)for(let col=0;col<t.width;col++){
          const value=board[(t.y+row)*1000+t.x+col];scanned++;
          if(value===owner)length++;
          else{
            if(length)runs.push((length-1)|(owner<<10));owner=value;length=1;
            // Noisy prefix: skip speculative RLE. This only forgoes possible
            // savings; the legacy representation remains exact and no larger.
            if(runs.length>=maxRuns||(scanned<=32&&runs.length>=8)){aborted=true;break scan;}
          }
        }
        if(!aborted){
          runs.push((length-1)|(owner<<10));
          if(runs.length===1){t.mode=SOLID;t.bytes=1;t.solidOwner=owner;}
          else if(2+2*runs.length<t.bytes){t.mode=RLE;t.bytes=2+2*runs.length;t.runs=runs;}
        }
      }
    }
    plan.hasMask ||= t.mode===MASK;
    plan.payload+=4+t.bytes;
    plan.represented+=t.mode===MASK?t.count:(t.mode===SOLID||t.mode===RLE||t.bitmap)?area:t.count;
  }
  return plan;
}
