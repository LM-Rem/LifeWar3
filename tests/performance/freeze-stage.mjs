// Read a known Git revision into an artifact directory; never changes the checkout.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [ref,output]=process.argv.slice(2);
if(!ref||!output)throw new Error('Usage: freeze-stage.mjs REF OUTPUT');
if(existsSync(output))throw new Error('Output already exists; choose a new artifact directory');
const commit=execFileSync('git',['rev-parse','--verify',`${ref}^{commit}`],{encoding:'utf8'}).trim();
const files=['src/engine.js','src/dormancy.js','src/bots.js','src/config.js','public/cards.js','public/cards.json','public/territory.js'];
const manifest={commit,files:{}};
for(const file of files){const bytes=execFileSync('git',['show',`${commit}:${file}`],{maxBuffer:16*1024*1024});const dest=resolve(output,file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes);manifest.files[file]=createHash('sha256').update(bytes).digest('hex');}
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
