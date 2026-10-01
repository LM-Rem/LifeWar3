// Six square faces with shared edges/corners, uniformly projected to a sphere.
const FACES = [
  [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
  [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
  [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
];
export function cubeSphere(size = 64) {
  const positions=[],indices=new Map(),incident=[],corners=new Uint32Array(6*size*size*4);
  const faceVertices=new Uint32Array(6*(size+1)*(size+1));
  const vertex=(face,x,y)=>{
    const [normal,u,v]=FACES[face],a=2*x-size,b=2*y-size;
    const cube=normal.map((value,i)=>value*size+u[i]*a+v[i]*b),key=cube.join(',');
    const offset=face*(size+1)*(size+1)+y*(size+1)+x;
    if(indices.has(key)){const index=indices.get(key);faceVertices[offset]=index;return index;}
    const index=positions.length/3;indices.set(key,index);incident.push([]);
    const [px,py,pz]=cube.map(value=>value/size),xx=px*px,yy=py*py,zz=pz*pz;
    positions.push(px*Math.sqrt(1-yy/2-zz/2+yy*zz/3),py*Math.sqrt(1-zz/2-xx/2+zz*xx/3),pz*Math.sqrt(1-xx/2-yy/2+xx*yy/3));
    faceVertices[offset]=index;return index;
  };
  for(let face=0;face<6;face++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const key=face*size*size+y*size+x;
    const quad=[vertex(face,x,y),vertex(face,x+1,y),vertex(face,x+1,y+1),vertex(face,x,y+1)];
    corners.set(quad,key*4);for(const index of quad)incident[index].push(key);
  }
  const count=6*size*size,neighbors=new Int32Array(count*8).fill(-1),edges=[],edgeKeys=new Set();
  const centers=new Float32Array(count*3),vertices=new Float32Array(positions);
  for(let key=0;key<count;key++){
    const adjacent=new Set();
    for(let i=0;i<4;i++){
      const a=corners[key*4+i],b=corners[key*4+(i+1)%4],edge=`${Math.min(a,b)},${Math.max(a,b)}`;
      if(!edgeKeys.has(edge)){edgeKeys.add(edge);edges.push(a,b);}
      for(const neighbor of incident[a])if(neighbor!==key)adjacent.add(neighbor);
      for(let axis=0;axis<3;axis++)centers[key*3+axis]+=vertices[a*3+axis]/4;
    }
    neighbors.set([...adjacent],key*8);
  }
  const gridLines=[];
  // Draw a restrained coarse grid; cell tiles still use every simulation cell.
  const lines=new Set([size]);for(let line=0;line<=size;line+=Math.max(1,Math.round(size/16)))lines.add(line);
  for(let face=0;face<6;face++)for(const line of lines){
    const offset=face*(size+1)*(size+1);
    for(let x=0;x<=size;x++)gridLines.push(faceVertices[offset+line*(size+1)+x]);gridLines.push(-1);
    for(let y=0;y<=size;y++)gridLines.push(faceVertices[offset+y*(size+1)+line]);gridLines.push(-1);
  }
  return {size,count,vertices,corners,neighbors,centers,edges:new Uint32Array(edges),gridLines:new Int32Array(gridLines)};
}

export class GlobeLife {
  constructor({ size = 64, random = Math.random, seedEvery = 300 } = {}) {
    this.mesh=cubeSphere(size);this.size=size;this.random = random; this.seedEvery = seedEvery;
    this.board = new Uint8Array(this.mesh.count); this.next = new Uint8Array(this.board.length);
    this.generation = 0; this.population = 0;
    this.accumulator = 0; this.lastTime = null;
    const bases=[[1,1,1],[-1,-1,1],[1,-1,-1],[-1,1,-1]];
    for (let i = 0; i < this.board.length; i++)if(random()<.26){
      const [x,y,z]=this.mesh.centers.subarray(i*3,i*3+3);let best=-Infinity,owner=1;
      for(let team=0;team<4;team++){const base=bases[team],dot=x*base[0]+y*base[1]+z*base[2];if(dot>best){best=dot;owner=team+1;}}
      this.board[i]=owner;
    }
    this.recount();
  }
  recount() {
    this.population = 0;
    for (let i = 0; i < this.board.length; i++) {
      if(this.board[i])this.population++;
    }
  }
  sprinkle() {
    const {random}=this;
    for (let patch = 0; patch < 8; patch++) {
      const start=Math.floor(random()*this.board.length),owner=1+(Math.floor(this.generation/this.seedEvery)+patch)%4;
      const reached=new Set([start]),queue=[start];
      // Grow a small connected patch across face boundaries as well.
      for(let i=0;i<queue.length&&queue.length<225;i++)for(let n=0;n<8;n++){
        const key=this.mesh.neighbors[queue[i]*8+n];if(key>=0&&!reached.has(key)){reached.add(key);queue.push(key);}
      }
      for(const key of queue) {
        if (random() < .3) {
          if (!this.board[key]) this.board[key] = owner;
        }
      }
    }
    this.recount();
  }
  step() {
    const {board,next}=this,generation=this.generation+1,neighbors=this.mesh.neighbors;
    let population = 0;
    for(let key=0;key<board.length;key++){
      let count=0,votes=0,owner=board[key];
      for(let n=0;n<8;n++){const k=neighbors[key*8+n];if(k<0)continue;const team=board[k];if(team){count++;votes+=1<<((team-1)*4);}}
      if(count!==3&&!(owner&&count===2))owner=0;
      else if(!owner){
        // Same majority vote and positional/generation tie-break as the game.
        let best=0;for(let t=0;t<4;t++){const team=((t+key+generation)%4)+1,n=(votes>>((team-1)*4))&15;if(n>best){best=n;owner=team;}}
      }
      next[key]=owner;if(owner)population++;
    }
    this.board = next; this.next = board; this.population = population; this.generation=generation;
    if (this.generation % this.seedEvery === 0) this.sprinkle();
  }
  advance(now, active = true) {
    if (!active) { this.lastTime = null; return 0; }
    if (this.lastTime === null) { this.lastTime = now; return 0; }
    // Discard background suspension time; never run an unbounded catch-up loop.
    this.accumulator += Math.min(Math.max(0, now - this.lastTime), 1000); this.lastTime = now;
    let steps = 0;
    while (this.accumulator >= 200) { this.accumulator -= 200; this.step(); steps++; }
    return steps;
  }
}

const multiply = (a, b) => [
  a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
  a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
  a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
  a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
];
export class GlobeRotation {
  constructor() { this.reset(); }
  reset() { this.q = [0, 0, 0, 1]; this.rotate(.4, Math.atan2(.35, .91)); }
  world(axis, angle) {
    const s = Math.sin(angle / 2), delta = [axis[0]*s, axis[1]*s, axis[2]*s, Math.cos(angle/2)];
    const q = multiply(delta, this.q), length = Math.hypot(...q);
    this.q = q.map(value => value / length);
  }
  rotate(horizontal, vertical) {
    // Pre-multiply: the axes belong to the screen/world, never to the globe.
    this.world([0, 1, 0], horizontal); this.world([1, 0, 0], vertical);
  }
  auto(elapsed) { this.world([0, 1, 0], elapsed * .000055); }
  matrix() {
    const [x,y,z,w] = this.q;
    return [1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),
      2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),
      2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)];
  }
}

// Angular force -> acceleration -> velocity. Fixed-size integration steps keep
// the heavy spring response and free-flight damping independent of frame rate.
export class GlobeMomentum {
  constructor() { this.error=[0,0];this.velocity=[0,0];this.held=false; }
  begin() {
    this.held=true;this.error.fill(0);
    this.velocity[0]*=.2;this.velocity[1]*=.2;
  }
  push(x,y) { this.error[0]+=x;this.error[1]+=y; }
  release(coast=true) { this.held=false;this.error.fill(0);if(!coast)this.stop(); }
  stop() { this.held=false;this.error.fill(0);this.velocity.fill(0); }
  advance(elapsed) {
    const seconds=Math.min(Math.max(elapsed,0),100)/1000;
    if(!seconds)return null;
    const steps=Math.ceil(seconds*120),dt=seconds/steps,delta=[0,0];
    for(let step=0;step<steps;step++)for(let axis=0;axis<2;axis++){
      let speed=this.velocity[axis];
      if(this.held){
        const force=40*this.error[axis]-Math.sqrt(40)*2*speed;
        speed+=Math.max(-7,Math.min(7,force))*dt;
        speed=Math.max(-1.8,Math.min(1.8,speed));
        const distance=speed*dt;this.error[axis]-=distance;delta[axis]+=distance;
      }else{
        const decay=Math.exp(-1.6*dt);
        delta[axis]+=speed*(1-decay)/1.6;speed*=decay;
      }
      if(Math.abs(speed)<.0005&&(!this.held||Math.abs(this.error[axis])<.0001)){speed=0;if(this.held)this.error[axis]=0;}
      this.velocity[axis]=speed;
    }
    return delta[0]||delta[1]?delta:null;
  }
}
