import { PATTERNS, transform } from '../public/patterns.js';
import { CARDS } from '../public/cards.js';

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
    const hand = game.cards.hand[player.id - 1];
    if (hand) {
      const card = CARDS.find(c => c.id === hand.id);
      const enemies = game.players.filter(p => p.id !== player.id && !p.eliminated);
      if (card?.effect?.kind === 'rule' || card?.effect?.kind === 'energy') {
        game.playCard(player.id, hand.id);
      } else if (card?.effect?.kind === 'purge' && enemies.length) {
        game.playCard(player.id, hand.id, Math.round(enemies[0].x), Math.round(enemies[0].y));
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
