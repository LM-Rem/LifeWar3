import { Game, RULES } from './engine.js';
import { runBots } from './bots.js';
import { PacketHistory } from './packet-history.js';
import { boardVariant as variantOf } from '../public/board-protocol.js';

// Owns all mutable game state. Called only on the room thread (or directly by
// deterministic tests). Commands and ticks are synchronous, atomic boundaries.
export class RoomRuntime {
  constructor({ members, epoch, evolutionMode, gpuEvolution, gameOptions = {}, game, emit, bots = true }) {
    this.game = game ?? new Game(members, { ...gameOptions, evolutionMode });
    this.game.gpuEvolution = gpuEvolution;
    this.epoch = epoch; this.emit = emit; this.bots = bots;
    this.peers = new Map(); this.history = new PacketHistory();
    this.baseline = this.game.board.slice(); this.baseGeneration = this.game.generation;
    this.orderedNext = new Set(); this.frameBusy = false; this.closed = false;
    this.tickMs = 0; this.stateDue = true;
    for (const m of members) this.attach(m, false);
  }
  meta() {
    return { status:this.game.status, generation:this.game.generation, startedAt:this.game.startedAt,
      players:this.game.players.map(({id,eliminated})=>({id,eliminated})), lastBackend:this.game.lastBackend };
  }
  needsCommandWindow() {
    return this.game.cardDraft?.players.some(entry=>!entry.picked && this.peers.get(entry.playerId)?.session!=null && !this.peers.get(entry.playerId)?.bot) ?? false;
  }
  attach(member, flush = true) {
    const previous = this.peers.get(member.id);
    const peer = { ...member, session:member.session??null, boardVersion:member.boardVersion ?? 1, bufferedAmount:0,
      sentGeneration:-1, needsSnapshot:true, awaitingStart:true, lastStateGeneration:-1, offlineAt:null };
    if (member.bot) { peer.session=null; peer.awaitingStart=false; }
    if (previous?.surrendered) peer.surrendered = true;
    this.peers.set(peer.id,peer);
    if (flush) this.flush();
  }
  disconnect(id, session, explicit = false) {
    const peer=this.peers.get(id);
    if (!peer || peer.session!==session) return;
    peer.session=null; peer.offlineAt=this.game.now(); peer.awaitingStart=false;
    if (explicit && this.game.status==='playing') {
      peer.surrendered=true; this.game.eliminate(id); this.game.checkVictory();
      // A final generation can be revised by surrender between ticks.
      if (this.game.status==='finished') this.recordFrame();
    }
    this.stateDue=true; this.flush();
  }
  packet(variant, snapshot = false, ordered = false) {
    return variant===1 ? this.game.packet(snapshot) : this.game.packetV2({
      roomEpoch:this.epoch, baseGeneration:this.baseGeneration, previous:this.baseline,
      snapshot, forceOrdered:ordered, allowVarint:String(variant).endsWith('-varint'), allowBitmap:String(variant).startsWith('2-bitmap'), allowPalette:String(variant).includes('-palette')
    });
  }
  recordFrame() {
    const g=this.game, packets=new Map();
    for (const peer of this.peers.values()) {
      if (peer.session===null || peer.bot) continue;
      const variant=variantOf(peer);
      if (!packets.has(variant)) packets.set(variant,this.packet(variant));
      if (variant!==1 && this.orderedNext.has(variant)) packets.set(`${variant}ordered`,this.packet(variant,false,true));
    }
    if (this.history.frames.has(g.generation) && g.changes.size) {
      for(const peer of this.peers.values())peer.needsSnapshot=true;
    }
    this.history.add(g.generation,packets); this.orderedNext.clear();
    for(let i=0;i<g.changes.size;i++){const key=g.changes.order[i];this.baseline[key]=g.changes.owners[key];}
    this.baseGeneration=g.generation;g.changes.clear();
  }
  tick() {
    if (this.closed) return;
    const g=this.game, start=performance.now();
    for(const peer of this.peers.values()) {
      if (!peer.bot && peer.session===null && peer.offlineAt!==null && g.now()-peer.offlineAt>90000 && g.status==='playing') {
        g.eliminate(peer.id);g.checkVictory();peer.offlineAt=null;
      }
    }
    if(g.status==='playing') {
      if(this.bots && g.generation % Math.max(1,Math.round(RULES.hz*3))===0)runBots(g);
      g.step();this.recordFrame();
    } else if(g.changes.size)this.recordFrame();
    this.tickMs=performance.now()-start;
    if(g.generation % Math.max(1,Math.round(RULES.hz/5))===0 || g.status==='finished')this.stateDue=true;
    this.flush();
  }
  json(peer, data, control = false) { return {id:peer.id,session:peer.session,data,control}; }
  states(peer) {
    const state=this.game.state(peer.id);
    const events=[this.json(peer,{type:'card_state',roomEpoch:this.epoch,cards:state.cards,
      cardDraft:state.cardDraft,status:state.status,serverTime:state.serverTime},true)];
    if(peer.bufferedAmount<=262144)events.push(this.json(peer,{...state,tickMs:this.tickMs}));
    return events;
  }
  command(id, session, msg) {
    const peer=this.peers.get(id),g=this.game;
    if (!peer || peer.session!==session || peer.surrendered || this.closed) return [];
    const fail=message=>[this.json(peer,{type:'error',message},true)];
    switch(msg.type) {
      case 'cards': return this.states(peer).filter(e=>e.control);
      case 'resync': peer.needsSnapshot=true;this.flush();return [];
      case 'deploy': {
        const result=g.deploy(id,msg.x,msg.y,msg.cells);
        return result.error?fail(result.error):[this.json(peer,{type:'deployed',x:msg.x,y:msg.y,cost:result.cost})];
      }
      case 'pick_card': {
        const draft=g.cardDraft;
        if(msg.draftRound!==undefined && (msg.draftRound!==draft?.round || msg.draftGen!==draft?.gen))return fail('本轮征召已结束，请重新选择');
        const result=g.pickCard(id,String(msg.cardId||''));
        if(result.error)return fail(result.error);
        return [this.json(peer,{type:'card_picked',playerId:id,cardId:result.card.id},true),...this.states(peer)];
      }
      case 'play_card': {
        const result=g.playCard(id,String(msg.cardId||''),Number.isInteger(msg.x)?msg.x:undefined,Number.isInteger(msg.y)?msg.y:undefined,msg.instanceId);
        if(result.error)return fail(result.error);
        return [...this.peers.values()].filter(p=>p.session!==null&&!p.bot).flatMap(p=>[
          this.json(p,{type:'card_played',playerId:id,cardId:String(msg.cardId||''),x:msg.x,y:msg.y},true),...this.states(p)]);
      }
      default:return fail('不支持的房间操作');
    }
  }
  updateBuffers(buffers) {
    for(const {id,session,bufferedAmount} of buffers) {
      const peer=this.peers.get(id);
      if(peer?.session===session)peer.bufferedAmount=bufferedAmount;
    }
  }
  acknowledge(buffers) {
    this.updateBuffers(buffers);this.frameBusy=false;
  }
  drain() {
    if(this.closed||this.frameBusy)return;
    // No empty-frame ACK loop. Backpressure notifications never release the
    // output lock; only the ACK for a submitted frame may do that.
    if([...this.peers.values()].some(p=>p.session!==null&&!p.bot&&p.bufferedAmount<=262144&&
      (p.awaitingStart||p.needsSnapshot||p.sentGeneration<this.game.generation)))this.flush();
  }
  flush() {
    if(this.closed || this.frameBusy)return;
    const events=[], cache=new Map(),g=this.game;
    // Copy each retained packet once for transfer; history remains attached.
    const board=(peer,packet,snapshot=false)=>{
      if(!cache.has(packet))cache.set(packet,packet.slice(0));
      events.push({id:peer.id,session:peer.session,packet:cache.get(packet),snapshot});
      peer.sentGeneration=new DataView(packet).getUint32(peer.boardVersion===2?12:4,true);
      peer.v2NeedsOrdered=snapshot&&!peer.bitmapTiles;
      if(snapshot){peer.needsSnapshot=false;if(peer.boardVersion===2&&!peer.bitmapTiles)this.orderedNext.add(variantOf(peer));}
    };
    const snapshots=new Map();
    for(const peer of this.peers.values()) {
      if(peer.session===null || peer.bot)continue;
      if(peer.awaitingStart) {
        events.push(this.json(peer,{type:'started',id:peer.id,rules:RULES,startedAt:g.startedAt,roomEpoch:this.epoch,boardProtocol:peer.boardVersion,bitmapTiles:!!peer.bitmapTiles,paletteTiles:!!peer.paletteTiles}));
        events.push(...this.states(peer));peer.awaitingStart=false;
      } else if(this.stateDue)events.push(...this.states(peer).filter(e=>e.control));
      if(peer.bufferedAmount>262144)continue;
      const variant=variantOf(peer);
      if(!peer.needsSnapshot && peer.sentGeneration<g.generation) {
        const replay=this.history.after(peer.sentGeneration,g.generation,variant);
        if(replay && peer.v2NeedsOrdered && peer.boardVersion===2) {
          const ordered=this.history.frames.get(peer.sentGeneration+1)?.packets.get(`${variant}ordered`);
          if(ordered)replay[0]=ordered;else peer.needsSnapshot=true;
        }
        if(replay && !peer.needsSnapshot) {
          // Submit only a bounded burst before learning the real socket buffer.
          let bytes=0,count=0;
          for(const packet of replay){board(peer,packet);bytes+=packet.byteLength;if(bytes>=262144||++count>=4)break;}
        }else peer.needsSnapshot=true;
      }
      if(peer.needsSnapshot) {
        if(!snapshots.has(variant))snapshots.set(variant,this.packet(variant,true));
        board(peer,snapshots.get(variant),true);
      }
      if(peer.sentGeneration===g.generation && (this.stateDue || peer.lastStateGeneration<0)) {
        events.push(this.json(peer,{...g.state(peer.id),tickMs:this.tickMs}));peer.lastStateGeneration=g.generation;
      }
    }
    this.stateDue=false;
    this.frameBusy=true;
    this.emit({type:'frame',events,meta:this.meta(),tickMs:this.tickMs},[...cache.values()]);
  }
  close() {this.closed=true;}
}
