import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const receive=source.slice(source.indexOf('function receiveCardState('),source.indexOf('\nconst $ ='));
test('live card state rejects stale sequence/epoch and clears pending picks only on resolution or a new round',()=>{
  let renders=0;
  const context=vm.createContext({cardEpoch:7,cardState:null,playerId:1,pendingCardPick:{draftKey:'1:20'},
    renderCards(){renders++;},showCardDraft(){},$:()=>({classList:{add(){}},open:false})});
  vm.runInContext(receive,context);
  const update=(sequence,round=1,picked=false,epoch=7)=>{
    context.incoming={roomEpoch:epoch,sequence,cardDraft:{round,gen:20,players:[{playerId:1,picked}]},cards:{hand:[[]]}};
    vm.runInContext('receiveCardState(incoming)',context);
  };
  update(10);assert.ok(context.pendingCardPick);assert.equal(renders,1);
  update(9,1,true);update(11,1,true,8);assert.ok(context.pendingCardPick);assert.equal(renders,1);
  update(11,1,true);assert.equal(context.pendingCardPick,null);assert.equal(renders,2);
  context.pendingCardPick={draftKey:'1:20'};update(12,2);assert.equal(context.pendingCardPick,null);
});
