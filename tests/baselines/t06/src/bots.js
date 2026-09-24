import { PATTERNS, transform } from '../public/patterns.js';
import { CARDS, isTargetedCard } from '../public/cards.js';

const GLIDER_DIRECTIONS = [[1,1],[-1,1],[-1,-1],[1,-1]];
const SHIP_DIRECTIONS = [[-1,0],[0,-1],[1,0],[0,1]];
const weapons = [
  ...GLIDER_DIRECTIONS.map(([dx,dy],r)=>({dx,dy,cells:transform(PATTERNS[0].cells,r)})),
  ...SHIP_DIRECTIONS.map(([dx,dy],r)=>({dx,dy,cells:transform(PATTERNS[1].cells,r)})),
];

export function runBots(game) {
  for (const player of game.players) {
    if (!player.bot || player.eliminated) continue;
    // 阶段4：AI 使用手牌（能量/法则卡直接使用，净化道具卡以最近的敌方基地为目标施放）
    // Try later cards if an earlier targeted card has no legal placement.
    // Use at most one card per bot update.
    for (const hand of game.cards.hand[player.id - 1]) {
      const card = CARDS.find(c => c.id === hand.id);
      const enemies = game.players.filter(p => p.id !== player.id && !p.eliminated);
      if (card && !isTargetedCard(card)) {
        if (game.playCard(player.id, hand.id, undefined, undefined, hand.instanceId).ok) break;
      } else if (card && enemies.length) {
        const creates = ['seed','nebula'].includes(card.effect.kind);
        const targets = creates ? game.nodes.filter(n=>n.owner!==player.id) : [];
        if (!creates) for (const key of game.alive) {
          if (game.board[key] === player.id) continue;
          targets.push({ x: key % game.size, y: Math.floor(key / game.size) });
          if (targets.length === 64) break;
        }
        if (!targets.length) targets.push(creates ? {x:player.x+50,y:player.y} : enemies[0]);
        if (targets.some(target => game.playCard(player.id, hand.id, Math.round(target.x), Math.round(target.y), hand.instanceId).ok)) break;
      }
    }
    if (player.energy < 9) continue;
    const origins = [player, ...game.nodes.filter(n=>n.owner===player.id)];
    const distanceToLand = target => Math.min(...origins.map(p=>Math.hypot(target.x-p.x,target.y-p.y)));
    const neutral = game.nodes.filter(n=>n.owner!==player.id).sort((a,b)=>distanceToLand(a)-distanceToLand(b));
    const enemies = game.players.filter(p=>p.id!==player.id&&!p.eliminated).sort((a,b)=>distanceToLand(a)-distanceToLand(b));
    // Alternate expansion and pressure once the bot has territory. Every launch
    // is checked against the same polygon ownership rules as a human request.
    const targets = player.nodes >= 2 && game.generation % 90 === 0 ? [...enemies,...neutral] : [...neutral,...enemies];
    let deployed = false;
    for (const target of targets) {
      for (let distance=24;distance<=500&&!deployed;distance+=6) {
        for (const weapon of weapons) {
          const x=Math.round(target.x-weapon.dx*distance),y=Math.round(target.y-weapon.dy*distance);
          if(!game.inRange(player,x,y))continue;
          if(game.deploy(player.id,x,y,weapon.cells).ok){deployed=true;break;}
        }
      }
      if(deployed)break;
    }
  }
}
