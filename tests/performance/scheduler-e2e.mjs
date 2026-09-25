import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},rounds:{type:'string',default:'3'},generations:{type:'string',default:'100'},output:{type:'string',default:'artifacts/performance/scheduler-minimap/e2e'}}});
for(const k of ['rounds','generations'])assert.ok(Number.isInteger(+v[k])&&+v[k]>0);
mkdirSync(v.output,{recursive:true});const results=[];
const variants=[{clients:0,scheduler:'interval'},{clients:0,scheduler:'deadline'},{clients:1,scheduler:'deadline'},{clients:4,scheduler:'interval'},{clients:4,scheduler:'deadline'}];
for(let round=0;round<+v.rounds;round++)for(const variant of round%2?[...variants].reverse():variants){
 const output=`${v.output}/${variant.scheduler}-${variant.clients}-${round+1}`;
 const args=[fileURLToPath(new URL('./end-to-end.mjs',import.meta.url)),'--variant','current-v1','--scenario','P01','--scheduler',variant.scheduler,'--clients',String(variant.clients),'--generations',v.generations,'--output',output];
 for(const k of ['playwright','executable'])if(v[k])args.push('--'+k,v[k]);
 const p=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});assert.equal(p.status,0,'run failed');
 const report=JSON.parse(readFileSync(output+'/report.json'));results.push({round:round+1,...report.summary});
 assert.ok(results.every(r=>r.warmBoardHash===report.summary.warmBoardHash&&r.finalBoardHash===report.summary.finalBoardHash));
 writeFileSync(v.output+'/summary.json',JSON.stringify(results,null,2));
}
