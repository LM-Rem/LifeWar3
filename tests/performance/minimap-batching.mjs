import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync} from 'node:fs';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},output:{type:'string',default:'artifacts/performance/2026-09-25/batching'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const browser=await chromium.launch({headless:true,executablePath:values.executable});
try{
 const page=await browser.newPage();
 const results=await page.evaluate(()=>{
  const out=[];
  for(const width of [180,197,360])for(const pattern of ['overlap','dispersed','four-colors']){
   const cells=Array.from({length:10000},(_,i)=>({key:pattern==='overlap'?i:i*7919%1000000,owner:pattern==='four-colors'?i%4:0}));
   let reference;
   for(const mode of ['rect','same-color-path','disjoint-path']){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=width;
    const c=canvas.getContext('2d');c.fillStyle='#08141a';c.fillRect(0,0,width,width);
    const colors=['#67f5d1a6','#ff796ca6','#ac98ffa6','#f4cc75a6'];
    let owner=-1,occupied=new Set(),batches=0;
    const flush=()=>{if(owner>=0){c.fill();batches++;}c.beginPath();occupied.clear();};
    const start=performance.now();
    for(const cell of cells){
     const x=cell.key%1000*width/1000,y=Math.floor(cell.key/1000)*width/1000;
     if(mode==='rect'){c.fillStyle=colors[cell.owner];c.fillRect(x,y,1,1);continue;}
     const pixels=[];for(let py=Math.floor(y);py<Math.ceil(y+1);py++)for(let px=Math.floor(x);px<Math.ceil(x+1);px++)pixels.push(py*width+px);
     if(owner!==cell.owner||(mode==='disjoint-path'&&pixels.some(p=>occupied.has(p)))){flush();owner=cell.owner;c.fillStyle=colors[owner];}
     c.rect(x,y,1,1);for(const p of pixels)occupied.add(p);
    }
    if(mode!=='rect')flush();
    const submitMs=performance.now()-start,data=c.getImageData(0,0,width,width).data;
    if(!reference)reference=data;
    let differentChannels=0,maxError=0;for(let i=0;i<data.length;i++){if(data[i]!==reference[i])differentChannels++;maxError=Math.max(maxError,Math.abs(data[i]-reference[i]));}
    out.push({width,pattern,mode,differentChannels,maxError,batches,submitMs});
   }
  }return out;
 });
 mkdirSync(values.output,{recursive:true});writeFileSync(`${values.output}/report.json`,JSON.stringify({browser:browser.version(),scope:'fractional Canvas primitive equivalence experiment; timing exploratory only',results},null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
