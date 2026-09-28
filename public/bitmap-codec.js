// Encoding 3: tile-local sparse updates or a complete occupancy/owner bitmap.
// Network order is deliberately independent of the simulation's alive order.
const SIZE=1000, TILES=1024, BITMAP=0x8001;
const tileOf=k=>((Math.floor(k/SIZE)>>>5)*32)+((k%SIZE)>>>5);
const localOf=k=>(Math.floor(k/SIZE)&31)*32+(k%SIZE&31);
const check=(ok,message)=>{if(!ok)throw new Error('board-protocol: bitmap '+message);};

export function planBitmap(keys,board) {
  const counts=new Uint16Array(TILES),tiles=[];
  for(let i=0;i<keys.length;i++)counts[tileOf(keys[i])]++;
  let payload=4,represented=0;
  for(let tile=0;tile<TILES;tile++){
    const count=counts[tile];if(!count)continue;
    const x=(tile&31)*32,y=(tile>>>5)*32,width=Math.min(32,SIZE-x),height=Math.min(32,SIZE-y);
    let live=0,bitmap=false,bytes=count*2;
    if(bytes>128){
      for(let row=0;row<height;row++)for(let col=0;col<width;col++)live+=board[(y+row)*SIZE+x+col]!==0;
      const packed=128+Math.ceil(live/4);if(packed<bytes){bitmap=true;bytes=packed;}
    }
    tiles.push({tile,count,x,y,width,height,live,bitmap,bytes});
    payload+=4+bytes;represented+=bitmap?width*height:count;
  }
  return {tiles,payload,represented};
}

export function writeBitmap(buffer,plan,keys,ownerAt,board) {
  const v=new DataView(buffer),bytes=new Uint8Array(buffer),offsets=new Uint32Array(TILES);
  let p=32;v.setUint16(p,plan.tiles.length,true);p+=4;
  for(const t of plan.tiles){
    v.setUint16(p,t.tile,true);v.setUint16(p+2,t.bitmap?BITMAP:t.count,true);p+=4;
    if(t.bitmap){
      let live=0;
      for(let row=0;row<t.height;row++)for(let col=0;col<t.width;col++){
        const owner=board[(t.y+row)*SIZE+t.x+col];if(!owner)continue;
        const local=row*32+col;bytes[p+(local>>>3)]|=1<<(local&7);
        bytes[p+128+(live>>>2)]|=(owner-1)<<((live&3)*2);live++;
      }
    }else offsets[t.tile]=p;
    p+=t.bytes;
  }
  for(let i=0;i<keys.length;i++){
    const key=keys[i],tile=tileOf(key),offset=offsets[tile];if(!offset)continue;
    v.setUint16(offset,localOf(key)+ownerAt(key)*1024,true);offsets[tile]+=2;
  }
}

export function readBitmap(buffer,count,snapshot) {
  const v=new DataView(buffer),bytes=new Uint8Array(buffer),entries=new Uint32Array(count);
  check(buffer.byteLength>=36,'header');
  const tileCount=v.getUint16(32,true);check(tileCount>0&&tileCount<=TILES&&v.getUint16(34,true)===0,'tile count');
  const seenTiles=new Uint8Array(TILES),seenLocals=new Uint8Array(1024);
  let p=36,n=0;
  for(let t=0;t<tileCount;t++){
    check(p+4<=bytes.length,'tile header');const tile=v.getUint16(p,true),mode=v.getUint16(p+2,true);p+=4;
    check(tile<TILES&&!seenTiles[tile],'tile duplicate');seenTiles[tile]=1;
    const x=(tile&31)*32,y=(tile>>>5)*32,width=Math.min(32,SIZE-x),height=Math.min(32,SIZE-y);
    if(mode===BITMAP){
      check(p+128<=bytes.length&&n+width*height<=count,'bitmap length/count');
      let live=0;
      for(let local=0;local<1024;local++){
        const occupied=(bytes[p+(local>>>3)]>>>(local&7))&1;
        if((local&31)>=width||(local>>>5)>=height)check(!occupied,'edge padding');
        live+=occupied;
      }
      const ownerBytes=Math.ceil(live/4),owners=p+128;
      check(owners+ownerBytes<=bytes.length,'owners truncated');
      if(live%4)check((bytes[owners+ownerBytes-1]>>((live%4)*2))===0,'owner padding');
      let index=0;
      for(let row=0;row<height;row++)for(let col=0;col<width;col++){
        const local=row*32+col,occupied=(bytes[p+(local>>>3)]>>>(local&7))&1;
        const owner=occupied?((bytes[owners+(index>>>2)]>>>((index++&3)*2))&3)+1:0;
        entries[n++]=(y+row)*SIZE+x+col+owner*1000000;
      }
      p=owners+ownerBytes;
    }else{
      check(mode>0&&mode<=1024&&p+mode*2<=bytes.length&&n+mode<=count,'sparse mode/count');seenLocals.fill(0);
      for(let i=0;i<mode;i++){
        const value=v.getUint16(p,true);p+=2;const local=value&1023,owner=value>>>10;
        check((local&31)<width&&(local>>>5)<height&&!seenLocals[local]&&owner<=4&&(!snapshot||owner>0),'sparse entry');
        seenLocals[local]=1;entries[n++]=(y+(local>>>5))*SIZE+x+(local&31)+owner*1000000;
      }
    }
  }
  check(n===count&&p===bytes.length,'trailing bytes/count');return entries;
}
