// Shared by the authoritative simulation, deployment preview, and map renderer.
export const BASE_HIT_RADIUS = 12;
export const NODE_MIN_SPACING = 140;

export function generateNodes(players, random = Math.random, size = 1000) {
  const count = 12 + Math.floor(random() * 5);
  const nodes = [], sites = [...players];
  const nearestDistance = (x, y) => Math.min(...sites.map(p => (p.x - x) ** 2 + (p.y - y) ** 2));
  for (let i = 0; i < count; i++) {
    let best = null, bestDistance = -1;
    // Best-candidate sampling fills gaps without a visible grid, while bases also
    // repel nodes so every starting territory has usable deployment space.
    for (let attempt = 0; attempt < 160; attempt++) {
      const x = Math.round(60 + random() * (size - 120));
      const y = Math.round(60 + random() * (size - 120));
      const distance = nearestDistance(x, y);
      if (distance > bestDistance) { best = { x, y }; bestDistance = distance; }
    }
    // Bounded fallback guarantees progress even for a degenerate RNG stream.
    if (bestDistance < NODE_MIN_SPACING ** 2) {
      for (let y = 60; y <= size - 60; y += 10) for (let x = 60; x <= size - 60; x += 10) {
        const distance = nearestDistance(x, y);
        if (distance > bestDistance) { best = { x, y }; bestDistance = distance; }
      }
    }
    if (bestDistance < NODE_MIN_SPACING ** 2) throw new Error('无法生成满足间距的节点布局');
    const node = { id: i, ...best, owner: 0, claimant: 0, progress: 0 };
    nodes.push(node); sites.push(node);
  }
  return nodes;
}

function clipHalfPlane(polygon, nx, ny, offset) {
  const clipped = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = nx * a[0] + ny * a[1] - offset, db = nx * b[0] + ny * b[1] - offset;
    if (da <= 1e-8) clipped.push(a);
    if ((da < -1e-8 && db > 1e-8) || (da > 1e-8 && db < -1e-8)) {
      const t = da / (da - db);
      clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return clipped;
}

export function createTerritories(players, nodes, size = 1000) {
  const sites = [
    ...players.map(p => ({ kind: 'base', id: p.id, x: p.x, y: p.y })),
    ...nodes.map(n => ({ kind: 'node', id: n.id, x: n.x, y: n.y })),
  ];
  return sites.map((site, i) => {
    let polygon = [[0, 0], [size, 0], [size, size], [0, size]];
    for (let j = 0; j < sites.length && polygon.length; j++) {
      if (i === j) continue;
      const other = sites[j];
      const nx = other.x - site.x, ny = other.y - site.y;
      const offset = (other.x ** 2 + other.y ** 2 - site.x ** 2 - site.y ** 2) / 2;
      polygon = clipHalfPlane(polygon, nx, ny, offset);
    }
    return { ...site, polygon };
  });
}

export function territoryAt(territories, x, y, size = 1000) {
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  let nearest = null, distance = Infinity;
  // An exact bisector tie belongs to the earlier site. Both clients and server
  // use this same order, so grid cells on shared edges have one owner.
  for (const site of territories) {
    const d = (site.x - x) ** 2 + (site.y - y) ** 2;
    if (d < distance) { nearest = site; distance = d; }
  }
  return nearest;
}

export function territoryOwner(site, players, nodes) {
  if (!site) return 0;
  if (site.kind === 'base') {
    const player = players.find(p => p.id === site.id);
    return player && !player.eliminated ? player.id : 0;
  }
  return nodes[site.id]?.owner ?? 0;
}

export function canDeployInTerritory(territories, players, nodes, id, x, y, size = 1000) {
  return territoryOwner(territoryAt(territories, x, y, size), players, nodes) === id;
}

// Adjacent means a shared edge, not just a shared vertex. Used by border-drop
// on both the authoritative server and deployment preview.
export function adjacentNeutralTerritories(territories, players, nodes, id) {
  const owned = territories.filter(t => territoryOwner(t, players, nodes) === id);
  return territories.filter(t => t.kind === 'node' && !territoryOwner(t, players, nodes) && owned.some(o =>
    t.polygon.filter(a => o.polygon.some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-5)).length >= 2
  ));
}
