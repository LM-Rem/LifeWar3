import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleTicks} from '../src/tick-scheduler.js';

function harness() {
 let clock=0,pending=null,calls=0,work=0;const trace=[];
 const scheduler=scheduleTicks(()=>{calls++;clock+=work;},{periodMs:50,now:()=>clock,
  setTimer:(fn,delay)=>{pending={fn,delay};return fn;},clearTimer:()=>{pending=null;},
  setSoon:fn=>{pending={fn,delay:0};return fn;},clearSoon:()=>{pending=null;},onTiming:r=>trace.push(r)});
 return {scheduler,trace,get calls(){return calls;},get pending(){return pending;},set work(v){work=v;},
  wake(at){clock=at;const fn=pending.fn;pending=null;fn();}};
}
test('timer jitter does not accumulate into simulation drift; early wakes do not tick',()=>{
 const h=harness();assert.equal(h.pending.delay,50);
 h.wake(40);assert.equal(h.calls,0);assert.equal(h.pending.delay,10);
 h.wake(62);assert.equal(h.calls,1);assert.equal(h.pending.delay,38);
 h.wake(109);assert.equal(h.pending.delay,41);
 h.wake(155);assert.equal(h.pending.delay,45);
 assert.deepEqual(h.trace.map(r=>r.scheduledAt),[50,100,150]);
 assert.deepEqual(h.trace.map(r=>r.latenessMs),[12,9,5]);h.scheduler.stop();assert.equal(h.pending,null);
});
test('work time is included in deadlines, overload is bounded and reported without skipping steps',()=>{
 const h=harness();h.work=20;h.wake(50);assert.equal(h.pending.delay,30);
 h.work=120;h.wake(100);assert.equal(h.calls,2);assert.equal(h.pending.delay,0);assert.equal(h.trace.at(-1).rebaseMs,70);
 h.work=0;h.wake(5000);assert.equal(h.calls,3);assert.ok(h.trace.at(-1).rebaseMs>4000);
 h.wake(5001);assert.equal(h.calls,4);assert.equal(h.pending.delay,49);
 h.scheduler.stop();
});
test('stop inside callback never rearms; invalid periods are rejected',()=>{
 let fn,count=0,clock=0,scheduler;
 scheduler=scheduleTicks(()=>scheduler.stop(),{periodMs:10,now:()=>clock,setTimer:f=>{fn=f;count++;},clearTimer:()=>{}});
 clock=10;fn();assert.equal(count,1);fn();assert.equal(count,1);
 for(const periodMs of [0,-1,NaN,Infinity])assert.throws(()=>scheduleTicks(()=>{},{periodMs}));
});

test('overdue callbacks yield through a cancellable immediate instead of another timer',()=>{
 const h=harness();h.work=120;h.wake(50);assert.equal(h.pending.delay,0);
 const stale=h.pending.fn;h.scheduler.stop();assert.equal(h.pending,null);stale();assert.equal(h.calls,1);
});
