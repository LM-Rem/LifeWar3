import { sparseCandidates } from './sparse.js';
import { orderedCandidates } from './dense.js';
import { evolutionRules } from './rule-table.js';
import { commitEvolution } from './backend.js';

const vote=new Uint16Array([0,1,16,256,4096]);
// Counts/votes belong to the active backend. Frontier retains their values and
// updates them only after all decisions have been computed (two-phase commit).
export class Frontier {
  constructor(game){this.rebuilds=0;this.fallbacks=0;this.bind(game);}
  bind(game){
    this.size=game.size;this.counts=game.counts;this.votes=game.votes;
    this.result=new Uint8Array(game.board.length);this.dirty=new Uint8Array(game.board.length);
    this.valid=false;this.rules=null;this.pendingChanges=0;
  }
  invalidate(){this.valid=false;}
  begin(game){
    if(this.size!==game.size||this.counts!==game.counts||this.votes!==game.votes)this.bind(game);
    const rebuild=!this.valid;this.pendingChanges=0;
    let length;
    if(rebuild){
      this.counts.fill(0);this.votes.fill(0);length=sparseCandidates.call(game);
      this.dirty.fill(0);this.valid=true;this.rebuilds++;this.evaluated=length;
    }else length=orderedCandidates.call(game);
    return {length,rebuild};
  }
  prepareChanges(count,liveCount){
    if(this.valid&&count>Math.max(256,liveCount/4)){this.valid=false;this.fallbacks++;}
  }
  change(game,key,oldOwner,newOwner){
    if(!this.valid||oldOwner===newOwner)return;
    if(++this.pendingChanges>Math.max(256,game.alive.length/4)){this.valid=false;this.fallbacks++;return;}
    const size=this.size,x=key%size,y=Math.floor(key/size),dc=(newOwner!==0)-(oldOwner!==0),dv=vote[newOwner]-vote[oldOwner];
    this.dirty[key]=1;
    for(let yy=Math.max(0,y-1);yy<=Math.min(size-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(size-1,x+1);xx++){
      const n=yy*size+xx;if(n===key)continue;this.counts[n]+=dc;this.votes[n]+=dv;this.dirty[n]=1;
    }
  }
  rememberRules(game,context){this.rules={...context,local:game.localIndex.signature};}
  activateCircle(rule){
    const size=this.size,r=rule.radius;
    for(let y=Math.max(0,Math.ceil(rule.y-r));y<=Math.min(size-1,Math.floor(rule.y+r));y++)
      for(let x=Math.max(0,Math.ceil(rule.x-r));x<=Math.min(size-1,Math.floor(rule.x+r));x++)
        if((x-rule.x)**2+(y-rule.y)**2<=r*r)this.dirty[y*size+x]=1;
  }
  updateRules(game,context){
    const old=this.rules;
    if(!old||old.birthMask!==context.birthMask||old.survivalMask!==context.survivalMask||old.priorityOwner!==context.priorityOwner)this.dirty.fill(1);
    else if(old.local!==game.localIndex.signature){
      // Old and new regions cover expiry, geometry edits, and priority changes.
      for(const rule of [...JSON.parse(old.local),...JSON.parse(game.localIndex.signature)])this.activateCircle(rule);
    }
    this.rememberRules(game,context);
  }
  settle(game,length){
    const {board,next,candidates,counts,votes}=game,context=evolutionRules(game);
    this.updateRules(game,context);
    const {birthMask,survivalMask,priorityOwner}=context;
    next.fill(0);const nextAlive=game.spareAlive;nextAlive.length=0;
    const totals=[0,0,0,0,0];this.evaluated=0;game.lastCandidateCount=length;
    for(let i=0;i<length;i++){
      const key=candidates[i];let owner=this.result[key];
      // A hypothetical cached birth must never freeze generation-dependent ties.
      if(this.dirty[key]||(!board[key]&&owner)){
        this.evaluated++;this.dirty[key]=0;owner=board[key];const count=counts[key],local=game.localIndex.active?game.localIndex.at(key):null;
        if(owner?!((local?.survival??survivalMask)&(1<<count)):!((local?.birth??birthMask)&(1<<count)))owner=0;
        else if(!owner){
          let max=0;for(let t=0;t<4;t++){const team=((t+key+game.generation)%4)+1,n=(votes[key]>>((team-1)*4))&15;if(n>max){max=n;owner=team;}}
          if(priorityOwner&&((votes[key]>>((priorityOwner-1)*4))&15))owner=priorityOwner;
        }
        this.result[key]=owner;
      }
      if(owner){next[key]=owner;nextAlive.push(key);totals[owner]++;}
    }
    commitEvolution(game,length,nextAlive,totals);
  }
}
