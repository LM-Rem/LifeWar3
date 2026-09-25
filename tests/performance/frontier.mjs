// Serial independent-process benchmark. Reconstructs the pre-T09 working tree
// from T11 evolution files plus the current T13 engine with only T09 hooks removed.
import {mkdirSync,cpSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {summarize} from './statistics.mjs';
const root='artifacts/performance/t09',base=root+'/pre-t09';
mkdirSync(base,{recursive:true});
cpSync('src',base+'/src',{recursive:true,filter:s=>!s.endsWith('frontier.js')});
mkdirSync(base+'/public',{recursive:true});
for(const f of ['cards.js','cards.json','territory.js','board-protocol.js'])cpSync('public/'+f,base+'/public/'+f);
writeFileSync(base+'/package.json','{"type":"module"}');
for(const f of ['backend.js','dense.js','select.js','rule-table.js'])writeFileSync(base+'/src/evolution/'+f,execFileSync('git',['show','9d4e9c2:src/evolution/'+f]));
let engine=readFileSync(base+'/src/engine.js','utf8');
for(const line of ['    this.frontier?.change(this,key,oldOwner,newOwner);','    this.frontier?.invalidate();']){
 if(!engine.includes(line))throw Error('Expected T09 hook missing: '+line);
 engine=engine.replace(line+'\n','').replace(line+'\r\n','');
}
writeFileSync(base+'/src/engine.js',engine);
// T13 was committed as aee889e. Verify the reconstructed input independently;
// only Git's LF/CRLF conversion may differ from that commit.
for(const dir of ['src','public'])for(const f of readdirSync(base+'/'+dir,{recursive:true}).filter(f=>/\.(js|json)$/.test(f))){
 const rel=dir+'/'+f.replaceAll('\\','/');
 if(readFileSync(base+'/'+rel,'utf8').replaceAll('\r\n','\n')!==execFileSync('git',['show','aee889e:'+rel],{encoding:'utf8'}).replaceAll('\r\n','\n'))throw Error('Baseline differs from T13: '+rel);
}
const manifest={provenance:'Reconstructed pre-T09: 9d4e9c2 evolution modules, current T13 working-tree engine minus two T09 hooks; not a committed T13 revision.',hashes:{}};
for(const f of readdirSync(base,{recursive:true}).filter(f=>/\.(js|json)$/.test(f)))manifest.hashes[f]=createHash('sha256').update(readFileSync(base+'/'+f)).digest('hex');
writeFileSync(base+'/manifest.json',JSON.stringify(manifest,null,2));
const output=[];
for(let round=0;round<5;round++)for(const scenario of ['P01','P03','P04']){
 const modes=['pre-t09','sparse','frontier','dense'];if(round%2)modes.reverse();
 for(const mode of modes){
  const dir=`${root}/${scenario}-${mode}-${round}`;
  const args=['tests/performance/runner.mjs','--scenario',scenario,'--warmup','30','--generations','100','--rounds','1','--output',dir];
  if(mode==='pre-t09')args.push('--backend','baseline','--baseline',base+'/');else args.push('--mode',mode);
  execFileSync(process.execPath,args,{windowsHide:true,stdio:'pipe'});
  const report=JSON.parse(readFileSync(dir+'/report.json'));output.push({scenario,mode,round,report:dir+'/report.json',data:report.rounds[0]});
  console.log(scenario,mode,round,report.rounds[0].tickMs.mean.toFixed(3));
 }
}
const summary=[];
for(const scenario of ['P01','P03','P04'])for(const mode of ['pre-t09','sparse','frontier','dense']){
 const rows=output.filter(r=>r.scenario===scenario&&r.mode===mode),samples=rows.flatMap(r=>r.data.samples);
 summary.push({scenario,mode,tickMs:summarize(samples.map(s=>s.tickMs)),deadlineMisses:rows.reduce((n,r)=>n+r.data.deadlineMisses,0),processMeans:rows.map(r=>r.data.tickMs.mean),frontier:rows.map(r=>r.data.frontier),reports:rows.map(r=>r.report)});
}
writeFileSync(root+'/summary.json',JSON.stringify({baseline:manifest,summary},null,2));
