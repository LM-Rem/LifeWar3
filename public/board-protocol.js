// All multibyte fields are little-endian. See docs/board-protocol-v2.md.
export const BOARD_SIZE=1000, CELL_COUNT=1000000, MAGIC=0x3252574c, HEADER_BYTES=32;
export const MAX_PACKET_BYTES=4*1024*1024;
const PACK=1048576, TILE_COUNT=1024;
const NATIVE_LITTLE_ENDIAN=new Uint8Array(Uint32Array.of(1).buffer)[0]===1;
const read24=(v,p)=>v.getUint16(p,true)+v.getUint8(p+2)*65536;
const write24=(v,p,n)=>{v.setUint16(p,n&65535,true);v.setUint8(p+2,n>>>16);};
const tileOf=k=>(Math.floor(k/1000)>>>5)*32+((k%1000)>>>5);
const localOf=k=>(Math.floor(k/1000)&31)*32+(k%1000&31);
const keyOf=(tile,local)=>((tile>>>5)*32+(local>>>5))*1000+(tile%32)*32+(local&31);
const validLocal=(tile,local)=>(tile%32)*32+(local&31)<1000&&(tile>>>5)*32+(local>>>5)<1000;
const check=(condition,message)=>{if(!condition)throw new Error('board-protocol: '+message);};

export function encodeBoardV2({keys,ownerAt,board,previous,generation,baseGeneration,roomEpoch,snapshot=false,forceOrdered=false,allowVarint=false}) {
  const count=keys.length;
  check(count<=CELL_COUNT&&Number.isInteger(roomEpoch)&&roomEpoch>0&&roomEpoch<=0xffffffff&&Number.isInteger(generation)&&generation>=0&&generation<=0xffffffff,'encoder bounds');
  check(snapshot||(Number.isInteger(baseGeneration)&&baseGeneration>=0&&baseGeneration<=generation&&generation-baseGeneration<=1),'encoder base');
  let encoding=0,births=0,counts,tiles=[],payload=3*count;
  // Tiled metadata cannot beat ordered24 for tiny updates. Snapshots must keep
  // every live key in order, so adding a dense image cannot reduce their size.
  if(!snapshot&&!forceOrdered&&previous&&count>=64){
    counts=new Uint16Array(TILE_COUNT);
    for(let i=0;i<count;i++){const key=keys[i];const tile=tileOf(key);if(!counts[tile])tiles.push(tile);counts[tile]++;
      if(!previous[key]&&ownerAt(key))births++;
    }
    const bytes=4+tiles.length*4+tiles.reduce((n,t)=>n+Math.min(counts[t]*2,1024),0)+births*3;
    if(bytes<payload){encoding=1;payload=bytes;}
  }
  // Encoding 2 preserves the original sequence, including negative key deltas.
  // Negotiate separately: earlier v2 clients only understand encodings 0/1.
  if(allowVarint&&count){
    let last=0,bytes=0;
    for(let i=0;i<count;i++){const key=keys[i];const delta=key-last;last=key;
      bytes+=delta>=-8&&delta<8?1:delta>=-1024&&delta<1024?2:delta>=-131072&&delta<131072?3:4;
    }
    if(bytes<payload){encoding=2;payload=bytes;}
  }
  const buffer=new ArrayBuffer(HEADER_BYTES+payload),v=new DataView(buffer);
  v.setUint32(0,MAGIC,true);v.setUint8(4,2);v.setUint8(5,encoding);v.setUint16(6,+snapshot,true);
  v.setUint32(8,roomEpoch,true);v.setUint32(12,generation,true);v.setUint32(16,snapshot?0xffffffff:baseGeneration,true);
  v.setUint32(20,payload,true);v.setUint32(24,count,true);v.setUint32(28,encoding===1?births:0,true);
  let p=HEADER_BYTES;
  if(!encoding){for(let i=0;i<count;i++){const key=keys[i];write24(v,p,key+ownerAt(key)*PACK);p+=3;}return buffer;}
  if(encoding===2){
    const bytes=new Uint8Array(buffer);let last=0;
    for(let i=0;i<count;i++){const key=keys[i];const delta=key-last;let value=((delta<<1)^(delta>>31))*8+ownerAt(key);last=key;
      while(value>=128){bytes[p++]=(value&127)|128;value>>>=7;}bytes[p++]=value;
    }
    return buffer;
  }
  v.setUint16(p,tiles.length,true);p+=4;
  const offsets=new Uint32Array(TILE_COUNT),bytes=new Uint8Array(buffer);let represented=0,sparse=false;
  for(const tile of tiles){
    const dense=counts[tile]>512;
    v.setUint16(p,tile,true);v.setUint16(p+2,dense?0x8000:counts[tile],true);p+=4;
    if(dense){
      const x=(tile&31)*32,y=(tile>>>5)*32,width=Math.min(32,1000-x),height=Math.min(32,1000-y);
      // ArrayBuffer starts zeroed, including the right/bottom padding.
      for(let row=0;row<height;row++){const key=(y+row)*1000+x;bytes.set(board.subarray(key,key+width),p+row*32);}
      p+=1024;represented+=width*height;
    }
    else{sparse=true;offsets[tile]=p;p+=counts[tile]*2;represented+=counts[tile];}
  }
  if(sparse||births)for(let i=0;i<count;i++){const key=keys[i];
    if(sparse){const tile=tileOf(key);if(counts[tile]<=512){v.setUint16(offsets[tile],localOf(key)+ownerAt(key)*1024,true);offsets[tile]+=2;}}
    if(births&&!previous[key]&&ownerAt(key)){write24(v,p,key);p+=3;}
  }
  v.setUint32(24,represented,true);return buffer;
}

// Validate the complete message before callers change either board or Map.
export function decodeBoardPacket(buffer) {
  check(buffer instanceof ArrayBuffer&&buffer.byteLength>=8&&buffer.byteLength<=MAX_PACKET_BYTES,'length');
  const v=new DataView(buffer),type=v.getUint32(0,true);
  if(type<=1){
    check((buffer.byteLength-8)%4===0,'v1 length');const count=(buffer.byteLength-8)/4;check(count<=CELL_COUNT,'v1 count');
    // Reuse the v1 payload on little-endian hosts; validation must not double
    // its retained queue memory. The fallback preserves LE wire semantics.
    const entries=NATIVE_LITTLE_ENDIAN?new Uint32Array(buffer,8,count):new Uint32Array(count);
    for(let i=0;i<count;i++){const value=NATIVE_LITTLE_ENDIAN?entries[i]:v.getUint32(8+i*4,true);check(Math.floor(value/CELL_COUNT)<=4,'owner');if(!NATIVE_LITTLE_ENDIAN)entries[i]=value;}
    return {version:1,snapshot:!!type,generation:v.getUint32(4,true),entries,memoryBytes:NATIVE_LITTLE_ENDIAN?0:entries.byteLength};
  }
  check(type===MAGIC&&buffer.byteLength>=HEADER_BYTES,'magic/header');
  const version=v.getUint8(4),encoding=v.getUint8(5),flags=v.getUint16(6,true),roomEpoch=v.getUint32(8,true),generation=v.getUint32(12,true),baseGeneration=v.getUint32(16,true);
  const payload=v.getUint32(20,true),count=v.getUint32(24,true),insertCount=v.getUint32(28,true),snapshot=flags===1;
  check(version===2&&encoding<=2&&flags<=1&&roomEpoch!==0,'version/flags/epoch');
  check(payload===buffer.byteLength-HEADER_BYTES&&count<=CELL_COUNT&&insertCount<=count,'length/count');
  check(snapshot?baseGeneration===0xffffffff&&encoding!==1:baseGeneration<=generation&&generation-baseGeneration<=1,'base generation');
  const tiled=encoding===1;
  const entries=new Uint32Array(count),seen=count&&(tiled?insertCount:count>=4096)?new Uint8Array(CELL_COUNT):null;
  const smallSeen=!tiled&&!seen?new Set():null;
  let p=HEADER_BYTES,n=0;
  const add=(key,owner)=>{check(n<count&&key>=0&&key<CELL_COUNT&&owner<=4&&(!snapshot||owner>0),'entry');
    if(!tiled){check(seen?!seen[key]:!smallSeen.has(key),'duplicate');smallSeen?.add(key);}
    if(seen)seen[key]=owner+1;entries[n++]=key+owner*CELL_COUNT;};
  let insertions;
  if(!encoding){
    check(insertCount===0&&payload===3*count,'ordered length');
    for(let i=0;i<count;i++){const value=read24(v,p);p+=3;add(value%PACK,Math.floor(value/PACK));}
  }else if(encoding===2){
    check(insertCount===0&&payload>=count&&payload<=4*count,'varint length');
    let last=0;
    for(let i=0;i<count;i++){
      let value=0,shift=0,byte;
      do{
        check(p<buffer.byteLength&&shift<=21,'varint truncation/overflow');byte=v.getUint8(p++);
        check(shift<21||byte<8,'varint overflow');value|=(byte&127)<<shift;shift+=7;
      }while(byte&128);
      check(shift===7||byte!==0,'noncanonical varint');
      const zigzag=value>>>3,delta=(zigzag>>>1)^-(zigzag&1),key=last+delta;
      add(key,value&7);last=key;
    }
  }else{
    check(payload>=4,'tile header');const tileCount=v.getUint16(p,true);check(tileCount>0&&tileCount<=TILE_COUNT&&v.getUint16(p+2,true)===0,'tile count');p+=4;
    const seenTiles=new Uint8Array(TILE_COUNT),seenLocals=new Uint8Array(1024);
    for(let t=0;t<tileCount;t++){
      check(p+4<=buffer.byteLength,'tile truncation');const tile=v.getUint16(p,true),mode=v.getUint16(p+2,true);p+=4;
      check(tile<TILE_COUNT&&!seenTiles[tile],'tile duplicate');seenTiles[tile]=1;
      if(mode===0x8000){
        check(p+1024<=buffer.byteLength,'dense truncation');
        const x=(tile&31)*32,y=(tile>>>5)*32,width=Math.min(32,1000-x),height=Math.min(32,1000-y);
        check(n+width*height<=count,'entry');
        for(let row=0;row<32;row++){
          const key=(y+row)*1000+x,validWidth=row<height?width:0;
          for(let col=0;col<validWidth;col++){
            const owner=v.getUint8(p++);check(owner<=4,'owner');
            if(seen)seen[key+col]=owner+1;entries[n++]=key+col+owner*CELL_COUNT;
          }
          for(let col=validWidth;col<32;col++)check(v.getUint8(p++)===0,'padding');
        }
      }else{
        check(mode>0&&mode<=1024&&p+mode*2<=buffer.byteLength,'sparse count');
        seenLocals.fill(0);
        for(let i=0;i<mode;i++){const value=v.getUint16(p,true);p+=2;const local=value%1024;check(validLocal(tile,local)&&!seenLocals[local],'tile coordinate/duplicate');seenLocals[local]=1;add(keyOf(tile,local),Math.floor(value/1024));}
      }
    }
    check(n===count&&p+insertCount*3===buffer.byteLength,'tile length/count');insertions=new Uint32Array(insertCount);
    for(let i=0;i<insertCount;i++){const key=read24(v,p);p+=3;check(key<CELL_COUNT&&seen[key]>=2&&seen[key]<=5,'insertion/duplicate');insertions[i]=key+(seen[key]-1)*CELL_COUNT;seen[key]+=8;}
  }
  check(n===count&&p===buffer.byteLength,'trailing bytes');
  return {version,encoding,snapshot,roomEpoch,generation,baseGeneration,entries,insertions,insertionFlags:tiled?seen:null,
    memoryBytes:entries.byteLength+(insertions?.byteLength??0)+(tiled?(seen?.byteLength??0):0)};
}

// Existing cells retain their Map position. Deaths commute; births must follow
// the sender's first-touch order, not tile or row order.
export function orderedBoardEntries(packet,board) {
  if(packet.encoding!==1)return packet.entries;
  let births=0,n=0;const result=new Uint32Array(packet.entries.length);
  // Indexed traversal avoids iterator overhead in million-entry dense packets.
  for(let i=0;i<packet.entries.length;i++){const value=packet.entries[i],key=value%CELL_COUNT,owner=(value/CELL_COUNT)>>>0;
    if(owner&&!board[key]){check((packet.insertionFlags?.[key]??0)>8,'missing insertion');births++;}
    else{check((packet.insertionFlags?.[key]??0)<=8,'unexpected insertion');if(board[key]!==owner)result[n++]=value;}
  }
  check(births===packet.insertions.length,'insertion baseline');
  result.set(packet.insertions,n);return result.subarray(0,n+packet.insertions.length);
}
