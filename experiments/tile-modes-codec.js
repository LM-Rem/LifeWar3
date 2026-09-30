// EXPERIMENT ONLY. Encoding 250 is never advertised by production.
// Forked bitmap reader/writer keeps legacy validation comparable; see validation report.
import {planBitmap as legacyPlan,visitBitmap as legacyVisit} from '../public/bitmap-codec.js';
import {encodeBoardV2,decodeBoardPacket} from '../public/board-protocol.js';
export const SOLID=0x8003, RLE=0x8004, MASK=0x8005;
// Network order is deliberately independent of the simulation's alive order.
const SIZE=1000, TILES=1024, BITMAP=0x8001, PALETTE=0x8002;
const tileOf=k=>((Math.floor(k/SIZE)>>>5)*32)+((k%SIZE)>>>5);
const localOf=k=>(Math.floor(k/SIZE)&31)*32+(k%SIZE&31);
const check=(ok,message)=>{if(!ok)throw new Error('board-protocol: bitmap '+message);};

export function planModes(keys,board,{solid=false,rle=false,mask=false}={}) {
  const plan=legacyPlan(keys,board,true);
  plan.payload=4;plan.represented=0;
  for(const t of plan.tiles){
    t.mode=t.bitmap?(t.palette?PALETTE:BITMAP):t.count;
    const maskBytes=128+Math.ceil(t.count*3/8);
    if(mask&&maskBytes<t.bytes){t.mode=MASK;t.bytes=maskBytes;}
    if(solid||rle){
      const runs=[];let owner=-1,length=0,aborted=false;
      scan:for(let row=0;row<t.height;row++)for(let col=0;col<t.width;col++){
        const value=board[(t.y+row)*SIZE+t.x+col];
        if(value===owner)length++;
        else{
          if(length)runs.push((length-1)|(owner<<10));owner=value;length=1;
          // Once two states are seen SOLID is impossible. Stop when RLE also
          // cannot beat the current candidate; later runs only add bytes.
          if(runs.length&&(!rle||2+2*(runs.length+1)>=t.bytes)){aborted=true;break scan;}
        }
      }
      if(!aborted){
        runs.push((length-1)|(owner<<10));
        if(solid&&runs.length===1&&1<t.bytes){t.mode=SOLID;t.bytes=1;t.solidOwner=owner;}
        else if(rle&&2+2*runs.length<t.bytes){t.mode=RLE;t.bytes=2+2*runs.length;t.runs=runs;}
      }
    }
    plan.payload+=4+t.bytes;
    plan.represented+=t.mode<=1024||t.mode===MASK?t.count:t.width*t.height;
  }
  return plan;
}

export function writeBitmap(buffer,plan,keys,ownerAt,board) {
  const v=new DataView(buffer),bytes=new Uint8Array(buffer),offsets=new Uint32Array(TILES);
  plan.tilesById=Object.fromEntries(plan.tiles.map(t=>[t.tile,t]));
  let p=32;v.setUint16(p,plan.tiles.length,true);p+=4;
  for(const t of plan.tiles){
    v.setUint16(p,t.tile,true);v.setUint16(p+2,t.mode,true);p+=4;
    if(t.mode===SOLID){bytes[p]=t.solidOwner;}
    else if(t.mode===RLE){v.setUint16(p,t.runs.length,true);for(let i=0;i<t.runs.length;i++)v.setUint16(p+2+2*i,t.runs[i],true);}
    else if(t.mode===MASK){offsets[t.tile]=p;}
    else if(t.mode>1024){
      let live=0;const colors=[];
      if(t.palette){bytes[p+128]=t.mask;for(let o=1;o<=4;o++)if(t.mask&(1<<(o-1)))colors.push(o);}
      for(let row=0;row<t.height;row++)for(let col=0;col<t.width;col++){
        const owner=board[(t.y+row)*SIZE+t.x+col];if(!owner)continue;
        const local=row*32+col;bytes[p+(local>>>3)]|=1<<(local&7);
        if(t.palette){if(t.bits)bytes[p+129+(live>>>3)]|=colors.indexOf(owner)<<(live&7);}
        else bytes[p+128+(live>>>2)]|=(owner-1)<<((live&3)*2);
        live++;
      }
    }else offsets[t.tile]=p;
    p+=t.bytes;
  }
  for(let i=0;i<keys.length;i++){
    const key=keys[i],tile=tileOf(key),offset=offsets[tile];if(!offset)continue;
    if(plan.tilesById[tile].mode===MASK){bytes[offset+(localOf(key)>>>3)]|=1<<(localOf(key)&7);}
    else{v.setUint16(offset,localOf(key)+ownerAt(key)*1024,true);offsets[tile]+=2;}
  }
  for(const t of plan.tiles)if(t.mode===MASK){
    const offset=offsets[t.tile];let n=0;
    for(let row=0;row<t.height;row++)for(let col=0;col<t.width;col++){
      const local=row*32+col;if(!(bytes[offset+(local>>>3)]&(1<<(local&7))))continue;
      const bit=n++*3,value=board[(t.y+row)*SIZE+t.x+col]<<(bit&7),at=offset+128+(bit>>>3);
      bytes[at]|=value&255;if((bit&7)>5)bytes[at+1]|=value>>>8;
    }
  }
}

// Validate the entire payload before exposing indexes to the renderer.
export function readBitmap(buffer,count,snapshot,compact=false,allowPalette=false) {
  const v=new DataView(buffer),bytes=new Uint8Array(buffer);
  check(buffer.byteLength>=36,'header');
  const tileCount=v.getUint16(32,true);check(tileCount>0&&tileCount<=TILES&&v.getUint16(34,true)===0,'tile count');
  const tiles=new Uint32Array(tileCount*3),seenTiles=new Uint8Array(TILES),seenLocals=new Uint8Array(1024);
  let p=36,n=0;
  for(let t=0;t<tileCount;t++){
    check(p+4<=bytes.length,'tile header');const tile=v.getUint16(p,true),mode=v.getUint16(p+2,true);p+=4;
    check(tile<TILES&&!seenTiles[tile],'tile duplicate');seenTiles[tile]=1;
    tiles.set([tile,mode,p],t*3);
    const x=(tile&31)*32,y=(tile>>>5)*32,width=Math.min(32,SIZE-x),height=Math.min(32,SIZE-y);
    if(mode===SOLID){
      check(p<bytes.length&&bytes[p]<=4&&n+width*height<=count,'solid owner/count');p++;n+=width*height;
    }else if(mode===RLE){
      check(p+2<=bytes.length,'rle header');const runs=v.getUint16(p,true);p+=2;
      check(runs>0&&runs<=width*height&&p+runs*2<=bytes.length,'rle length');let area=0,last=-1;
      for(let i=0;i<runs;i++){const value=v.getUint16(p,true);p+=2;const owner=value>>>10;check(owner<=4&&owner!==last,'rle owner/canonical');last=owner;area+=(value&1023)+1;check(area<=width*height,'rle overrun');}
      check(area===width*height&&n+area<=count,'rle area/count');n+=area;
    }else if(mode===MASK){
      check(p+128<=bytes.length,'mask header');let changed=0;
      for(let local=0;local<1024;local++)if(bytes[p+(local>>>3)]&(1<<(local&7))){check((local&31)<width&&(local>>>5)<height,'mask edge');changed++;}
      const ownerBytes=Math.ceil(changed*3/8),at=p+128;
      check(changed>0&&n+changed<=count&&at+ownerBytes<=bytes.length,'mask length/count');
      for(let i=0;i<changed;i++){const bit=i*3,index=at+(bit>>>3),owner=((bytes[index]|((bytes[index+1]??0)<<8))>>>(bit&7))&7;check(owner<=4&&(!snapshot||owner>0),'mask owner');}
      if((changed*3)%8)check(bytes[at+ownerBytes-1]>>>((changed*3)%8)===0,'mask padding');
      p=at+ownerBytes;n+=changed;
    }else if(mode===BITMAP||mode===PALETTE){
      check(p+128<=bytes.length&&n+width*height<=count,'bitmap length/count');
      let live=0;
      for(let row=0;row<32;row++)for(let byte=0;byte<4;byte++){
        const mask=bytes[p+row*4+byte];
        if(row>=height||byte*8>=width)check(!mask,'edge padding');
        live+=POPCOUNT[mask];
      }
      let bits=2,owners=p+128;
      if(mode===PALETTE){
        check(allowPalette&&owners<bytes.length,'palette capability/truncation');
        const mask=bytes[owners++],colors=POPCOUNT[mask];
        check(mask>0&&mask<16&&colors<=2&&live>0,'palette mask');bits=colors-1;
      }
      const ownerBytes=Math.ceil(live*bits/8);
      check(owners+ownerBytes<=bytes.length,'owners truncated');
      if((live*bits)%8)check((bytes[owners+ownerBytes-1]>>((live*bits)%8))===0,'owner padding');
      n+=width*height;p=owners+ownerBytes;
    }else{
      check(mode>0&&mode<=1024&&p+mode*2<=bytes.length&&n+mode<=count,'sparse mode/count');seenLocals.fill(0);
      for(let i=0;i<mode;i++){
        const value=v.getUint16(p,true);p+=2;const local=value&1023,owner=value>>>10;
        check((local&31)<width&&(local>>>5)<height&&!seenLocals[local]&&owner<=4&&(!snapshot||owner>0),'sparse entry');
        seenLocals[local]=1;
      }
      n+=mode;
    }
  }
  check(n===count&&p===bytes.length,'trailing bytes/count');
  const bitmap={buffer,tiles};
  if(compact)return bitmap;
  const entries=new Uint32Array(count);let i=0;visitBitmap(bitmap,(key,owner)=>{entries[i++]=key+owner*1000000;});return entries;
}
const POPCOUNT=Uint8Array.from({length:256},(_,n)=>{let count=0;while(n){n&=n-1;count++;}return count;});

// The buffer/index pair comes only from readBitmap's full validation above.
export function visitBitmap({buffer,tiles},visit) {
  const bytes=new Uint8Array(buffer),v=new DataView(buffer);
  for(let t=0;t<tiles.length;t+=3){
    const tile=tiles[t],mode=tiles[t+1],p=tiles[t+2],x=(tile&31)*32,y=(tile>>>5)*32;
    if(mode===SOLID||mode===RLE){
      const width=Math.min(32,SIZE-x),height=Math.min(32,SIZE-y);let cell=0;
      const fill=(length,owner)=>{for(let i=0;i<length;i++,cell++)visit((y+Math.floor(cell/width))*SIZE+x+cell%width,owner);};
      if(mode===SOLID)fill(width*height,bytes[p]);
      else{const runs=v.getUint16(p,true);for(let i=0;i<runs;i++){const value=v.getUint16(p+2+i*2,true);fill((value&1023)+1,value>>>10);}}
    }else if(mode===MASK){
      let n=0;for(let local=0;local<1024;local++)if(bytes[p+(local>>>3)]&(1<<(local&7))){const bit=n++*3,at=p+128+(bit>>>3),owner=((bytes[at]|((bytes[at+1]??0)<<8))>>>(bit&7))&7;visit((y+(local>>>5))*SIZE+x+(local&31),owner);}
    }else if(mode===BITMAP||mode===PALETTE){
      const width=Math.min(32,SIZE-x),height=Math.min(32,SIZE-y);let live=0;
      const colors=[];if(mode===PALETTE)for(let o=1;o<=4;o++)if(bytes[p+128]&(1<<(o-1)))colors.push(o);
      for(let row=0;row<height;row++)for(let col=0;col<width;col++){
        const local=row*32+col,occupied=(bytes[p+(local>>>3)]>>>(local&7))&1;
        let owner=0;
        if(occupied){owner=mode===PALETTE?colors[colors.length===1?0:(bytes[p+129+(live>>>3)]>>>(live&7))&1]:((bytes[p+128+(live>>>2)]>>>((live&3)*2))&3)+1;live++;}
        visit((y+row)*SIZE+x+col,owner);
      }
    }else for(let i=0;i<mode;i++){
      const value=v.getUint16(p+i*2,true),local=value&1023;visit((y+(local>>>5))*SIZE+x+(local&31),value>>>10);
    }
  }
}


export function encodeExperimental(options,modes={solid:true,rle:true,mask:true}) {
  const baseline=encodeBoardV2({...options,allowBitmap:true,allowPalette:true,allowVarint:true});
  if(!options.keys.length)return baseline;
  const plan=planModes(options.keys,options.board,modes);
  if(32+plan.payload>=baseline.byteLength)return baseline;
  const buffer=new ArrayBuffer(32+plan.payload),v=new DataView(buffer);
  new Uint8Array(buffer,0,32).set(new Uint8Array(baseline,0,32));v.setUint8(5,250);
  v.setUint32(20,plan.payload,true);v.setUint32(24,plan.represented,true);v.setUint32(28,0,true);
  writeBitmap(buffer,plan,options.keys,options.ownerAt,options.board);return buffer;
}
export function decodeExperimental(buffer) {
  check(buffer instanceof ArrayBuffer&&buffer.byteLength>=32&&buffer.byteLength<=4*1024*1024,'packet length');
  const v=new DataView(buffer);if(v.getUint8(5)!==250)return decodeBoardPacket(buffer,{compactBitmap:true});
  const snapshot=v.getUint16(6,true)===1,generation=v.getUint32(12,true),baseGeneration=v.getUint32(16,true),count=v.getUint32(24,true);
  check(v.getUint32(0,true)===0x3252574c&&v.getUint8(4)===2&&v.getUint16(6,true)<=1&&v.getUint32(8,true)>0,'packet header');
  check(v.getUint32(20,true)===buffer.byteLength-32&&count<=1000000&&v.getUint32(28,true)===0,'packet count');
  check(snapshot?baseGeneration===0xffffffff:baseGeneration<=generation&&generation-baseGeneration<=1,'packet generation');
  return {version:2,encoding:250,snapshot,generation,baseGeneration,roomEpoch:v.getUint32(8,true),entryCount:count,bitmap:readBitmap(buffer,count,snapshot,true,true)};
}
export function applyExperimental(packet,board) {
  if(packet.snapshot)board.fill(0);
  if(packet.bitmap)(packet.encoding===250?visitBitmap:legacyVisit)(packet.bitmap,(key,owner)=>{board[key]=owner;});
  else for(const value of packet.entries)board[value%1000000]=Math.floor(value/1000000);
}
