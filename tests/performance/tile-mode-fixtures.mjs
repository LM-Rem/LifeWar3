import {randomSource} from '../helpers/load-fixture.js';
export const tileKeys=t=>Array.from({length:1024},(_,i)=>[(t%32)*32+i%32,(t>>>5)*32+(i>>>5)]).filter(([x,y])=>x<1000&&y<1000).map(([x,y])=>y*1000+x);
export const mediumCases=[.05,.125,.25,.5].flatMap(density=>[1,4].flatMap(owners=>['sorted','shuffled'].map(order=>({id:`M${density*100}-C${owners}-${order}`,density,owners,order}))));
export function synthetic(spec,seed=91){
 const random=randomSource(seed),board=new Uint8Array(1000000);
 const tiles=[...Array.from({length:64},(_,i)=>(8+(i>>>3))*32+8+(i%8)),31,992,1023].map(tileKeys);
 const keys=tiles.flat();
 for(const k of keys)board[k]=random()<.5?0:1+Math.floor(random()*spec.owners);
 let generation=0;
 return {board,get generation(){return generation;},step(){
  generation++;const changed=[];
  for(const tile of tiles){
   if(spec.id==='SOLID'||spec.id==='STRIPES'){
    for(let i=0;i<tile.length;i++){const k=tile[i],value=spec.id==='SOLID'?generation%5:((Math.floor(i/64)+generation)%5);if(board[k]!==value){board[k]=value;changed.push(k);}}
   }else{
    const shuffled=[...tile];for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
    for(const k of shuffled.slice(0,Math.max(1,Math.round(tile.length*spec.density)))){board[k]=spec.owners===1?1-board[k]:(board[k]+1+Math.floor(random()*4))%5;changed.push(k);}
   }
  }
  if(spec.order==='sorted')changed.sort((a,b)=>a-b);
  return changed;
 }};
}
