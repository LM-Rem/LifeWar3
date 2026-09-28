import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.js';
import {RoomRuntime} from '../src/room-runtime.js';
import {randomSource} from './helpers/load-fixture.js';
import {decodeBoardPacket,orderedBoardEntries} from '../public/board-protocol.js';
import {seedRoomLoad} from './helpers/room-load.js';

const members=[{id:1,name:'A',session:1},{id:2,name:'B',session:2}];
for(const version of [1,2,'varint','bitmap'])test(`room runtime v${version}: transferred packets preserve every generation, order, snapshots and reference settlement`,()=>{
  let now=1000;const frames=[];
  const peers=members.map(m=>({...m,boardVersion:version===1?1:2,deltaVarint:version==='varint'||version==='bitmap',bitmapTiles:version==='bitmap'}));
  const options=()=>({now:()=>now,random:randomSource(93),cardDrawTimes:[0],evolutionMode:'sparse'});
  const game=new Game(peers,options()),reference=new Game(peers,options());
  const runtime=new RoomRuntime({members:peers,epoch:9,game,bots:false,emit:(data,transfer)=>frames.push(structuredClone(data,{transfer}))});
  const board=new Uint8Array(1000000),order=new Map(),referenceOrder=new Map();let generation=-1;
  function updateReference(snapshot=false){
    if(snapshot)referenceOrder.clear();
    for(const packed of decodeBoardPacket(reference.packet(snapshot)).entries){
      const key=packed%1000000,owner=Math.floor(packed/1000000);
      if(owner)referenceOrder.set(key,owner);else referenceOrder.delete(key);
    }
  }
  function drain(snapshotExpected=false){
    for(const frame of frames.splice(0))for(const event of frame.events){
      if(event.id!==1||!event.packet)continue;
      const decoded=decodeBoardPacket(event.packet);
      if(decoded.snapshot){assert.ok(snapshotExpected);board.fill(0);order.clear();}
      else assert.equal(decoded.generation,generation+1);
      for(const packed of orderedBoardEntries(decoded,board)){
        const key=packed%1000000,owner=Math.floor(packed/1000000);board[key]=owner;
        if(owner)order.set(key,owner);else order.delete(key);
      }
      generation=decoded.generation;
    }
    runtime.acknowledge(peers.map(p=>({...p,bufferedAmount:0})));
  }
  runtime.flush();drain(true);
  const deploy={type:'deploy',x:180,y:180,cells:[[0,0],[1,0],[2,0],[2,1],[1,2]]};
  assert.equal(runtime.command(1,1,deploy)[0].data.type,'deployed');reference.deploy(1,deploy.x,deploy.y,deploy.cells);
  for(let i=0;i<60;i++){
    now+=100;reference.step();updateReference();reference.changes.clear();runtime.tick();drain();
    assert.deepEqual(game.board,reference.board);assert.deepEqual([...game.alive],[...reference.alive]);
    assert.deepEqual(board,reference.board);if(version!=='bitmap')assert.deepEqual([...order],[...referenceOrder]);
    const normalize=g=>{const state=g.state(1);return {...state,events:state.events.map(({time,...event})=>event)};};
    assert.deepEqual(normalize(game),normalize(reference));
    if(i===10){runtime.command(1,1,{type:'resync'});drain(true);updateReference(true);}
  }
  runtime.close();
});

for(const bitmapTiles of [false,true])test(`room runtime bitmap=${bitmapTiles}: bounded output, short replay and long-backlog snapshot`,()=>{
  const peers=members.map(m=>({...m,boardVersion:bitmapTiles?2:1,bitmapTiles}));
  const frames=[],runtime=new RoomRuntime({members:peers,epoch:1,evolutionMode:'sparse',bots:false,emit:data=>frames.push(data)});
  runtime.flush();
  for(let i=0;i<4;i++)runtime.tick();
  assert.equal(frames.length,1,'one unacknowledged output batch');
  runtime.acknowledge(members.map(p=>({...p,bufferedAmount:0})));runtime.flush();
  assert.deepEqual(frames[1].events.filter(e=>e.id===1&&e.packet).map(e=>new DataView(e.packet).getUint32(bitmapTiles?12:4,true)),[1,2,3,4]);
  for(let i=0;i<40;i++)runtime.tick();
  assert.ok(runtime.history.frames.size<=32);assert.ok(runtime.history.bytes<=16*1024*1024);assert.equal(frames.length,2);
  runtime.acknowledge(members.map(p=>({...p,bufferedAmount:0})));runtime.flush();
  assert.equal(frames[2].events.find(e=>e.id===1&&e.packet).snapshot,true);
});

test('room runtime session fences commands, expires disconnects and keeps private card views',()=>{
  let now=1000;
  const runtime=new RoomRuntime({members,epoch:1,evolutionMode:'sparse',bots:false,gameOptions:{now:()=>now,cardDrawTimes:[0]},emit(){}});
  runtime.tick();const choice=runtime.game.cardDraft.players[0].options[0];
  assert.equal(runtime.needsCommandWindow(),true);
  runtime.attach({...members[0],session:3});
  assert.deepEqual(runtime.command(1,1,{type:'pick_card',cardId:choice.id}),[]);
  const result=runtime.command(1,3,{type:'pick_card',cardId:choice.id});
  assert.equal(result[0].data.type,'card_picked');assert.equal(result.find(e=>e.data.type==='card_state').data.cards.hand[1],null);
  assert.equal(runtime.command(1,3,{type:'pick_card',cardId:choice.id})[0].data.type,'error');
  runtime.peers.get(2).bot=true;assert.equal(runtime.needsCommandWindow(),false);
  runtime.disconnect(1,1);assert.equal(runtime.peers.get(1).session,3);
  runtime.disconnect(1,3);now+=90001;runtime.tick();
  assert.equal(runtime.game.players[0].eliminated,true);assert.equal(runtime.game.status,'finished');
});

test('dense mixed protocol transfer and snapshot successor preserve v1 client insertion order',()=>{
  const peers=[...members,{id:3,name:'C',session:3},{id:4,name:'D',session:4}].map((m,i)=>({...m,boardVersion:i===3?1:2,deltaVarint:i===0||i===2,bitmapTiles:i===2})),frames=[];
  const game=new Game(peers,{evolutionMode:'sparse',cardDrawTimes:[]});seedRoomLoad(game);
  const runtime=new RoomRuntime({members:peers,epoch:11,game,bots:false,emit:(data,transfer)=>frames.push(structuredClone(data,{transfer}))});
  let expectedPacket;
  const record=runtime.recordFrame.bind(runtime);
  runtime.recordFrame=()=>{expectedPacket=game.packet();record();};
  const boards=peers.map(()=>new Uint8Array(1000000)),orders=peers.map(()=>new Map()),reference=new Map();
  function apply(order,board,decoded){
    if(decoded.snapshot){order.clear();board?.fill(0);}
    for(const packed of orderedBoardEntries(decoded,board)){
      const key=packed%1000000,owner=Math.floor(packed/1000000);
      if(board)board[key]=owner;
      if(owner)order.set(key,owner);else order.delete(key);
    }
  }
  function consume(){for(const frame of frames.splice(0))for(const event of frame.events)if(event.packet)apply(orders[event.id-1],boards[event.id-1],decodeBoardPacket(event.packet));runtime.acknowledge(peers.map(p=>({...p,bufferedAmount:0})));}
  runtime.flush();consume();apply(reference,null,decodeBoardPacket(game.packet(true)));
  for(let i=0;i<5;i++){
    runtime.tick();apply(reference,null,decodeBoardPacket(expectedPacket));consume();
    for(let p=0;p<peers.length;p++){assert.deepEqual(boards[p],game.board);if(!peers[p].bitmapTiles)assert.deepEqual([...orders[p]],[...reference]);}
    if(i===2){for(const peer of peers)runtime.peers.get(peer.id).needsSnapshot=true;runtime.flush();consume();apply(reference,null,decodeBoardPacket(game.packet(true)));}
  }
});
