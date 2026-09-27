import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('launch defaults enable room isolation and honor explicit inline fallback',()=>{
  const env={...process.env};delete env.LIFEWAR_ROOM_WORKERS;
  const run=()=>execFileSync(process.execPath,['--import','./src/runtime-defaults.js','--input-type=module','-e','console.log(process.env.LIFEWAR_ROOM_WORKERS)'],{cwd:new URL('../',import.meta.url),env,encoding:'utf8'}).trim();
  assert.equal(run(),'1');env.LIFEWAR_ROOM_WORKERS='0';assert.equal(run(),'0');
});
