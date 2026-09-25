import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync} from 'node:fs';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},output:{type:'string',default:'artifacts/performance/minimap-layers'}}});
const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');
const browser=await chromium.launch({headless:true,executablePath:v.executable});
try{
 const page=await browser.newPage();const results=await page.evaluate(()=>{
  const rows=[];
  for(const width of [180,197,360])for(const owners of [1,4])for(const bg of ['#08141a','#345167']){
   const make=()=>{const c=document.createElement('canvas');c.width=c.height=width;return c;};
   const direct=make(),layer=make(),merged=make();const a=direct.getContext('2d'),b=layer.getContext('2d'),c=merged.getContext('2d');
   for(const ctx of [a,c]){ctx.fillStyle=bg;ctx.fillRect(0,0,width,width);}
   const colors=['#67f5d1a6','#ff796ca6','#ac98ffa6','#f4cc75a6'];
   for(let i=0;i<10000;i++){const k=i*7919%1000000;for(const ctx of [a,b]){ctx.fillStyle=colors[i%owners];ctx.fillRect(k%1000*width/1000,Math.floor(k/1000)*width/1000,1,1);}}
   c.drawImage(layer,0,0);const x=a.getImageData(0,0,width,width).data,y=c.getImageData(0,0,width,width).data;
   let differentChannels=0,maxError=0;for(let i=0;i<x.length;i++){if(x[i]!==y[i])differentChannels++;maxError=Math.max(maxError,Math.abs(x[i]-y[i]));}
   rows.push({width,owners,bg,differentChannels,maxError});
  }return rows;
 });
 mkdirSync(v.output,{recursive:true});writeFileSync(v.output+'/report.json',JSON.stringify({browser:browser.version(),pixelMatch:results.every(r=>!r.differentChannels),scope:'Transparent cell layer then source-over composition versus original per-cell background composition; exact RGBA comparison.',results},null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
