// Routes on padded card boundaries, keeping unrelated cards clear of every segment.
const GAP = 20;
const EPSILON = 0.01;

export function segmentCrossesRect(a, b, rect) {
  if (Math.abs(a.y - b.y) < EPSILON) {
    return a.y > rect.top + EPSILON && a.y < rect.bottom - EPSILON &&
      Math.max(a.x, b.x) > rect.left + EPSILON && Math.min(a.x, b.x) < rect.right - EPSILON;
  }
  return a.x > rect.left + EPSILON && a.x < rect.right - EPSILON &&
    Math.max(a.y, b.y) > rect.top + EPSILON && Math.min(a.y, b.y) < rect.bottom - EPSILON;
}

function clearPath(points, obstacles) {
  for (let i = 1; i < points.length; i++) {
    if (obstacles.some((rect) => segmentCrossesRect(points[i - 1], points[i], rect))) return false;
  }
  return true;
}

function simplify(points) {
  const result = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    if (result.length > 1) {
      const before = result.at(-2);
      if ((before.x === previous.x && previous.x === point.x) || (before.y === previous.y && previous.y === point.y)) result.pop();
    }
    result.push(point);
  }
  return result;
}

function length(points) {
  return points.slice(1).reduce((total, point, index) => total + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0);
}

// This fallback uses a compressed orthogonal grid. Normal card rows use the much
// cheaper lane candidates below; the grid handles cards manually moved into a lane.
function gridRoute(start, end, obstacles) {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap((rect) => [rect.left, rect.right])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap((rect) => [rect.top, rect.bottom])])].sort((a, b) => a - b);
  const width = xs.length;
  const startKey = ys.indexOf(start.y) * width + xs.indexOf(start.x);
  const endKey = ys.indexOf(end.y) * width + xs.indexOf(end.x);
  const point = (key) => ({ x: xs[key % width], y: ys[Math.floor(key / width)] });
  const distance = new Map([[startKey, 0]]);
  const previous = new Map();
  const pending = [{ key: startKey, cost: 0 }];
  const closed = new Set();
  while (pending.length) {
    pending.sort((a, b) => b.cost - a.cost);
    const { key } = pending.pop();
    if (closed.has(key)) continue;
    if (key === endKey) {
      const route = [end];
      let cursor = endKey;
      while (cursor !== startKey) { cursor = previous.get(cursor); route.push(point(cursor)); }
      return route.reverse();
    }
    closed.add(key);
    const xIndex = key % width;
    const yIndex = Math.floor(key / width);
    const neighbors = [];
    if (xIndex > 0) neighbors.push(key - 1);
    if (xIndex + 1 < width) neighbors.push(key + 1);
    if (yIndex > 0) neighbors.push(key - width);
    if (yIndex + 1 < ys.length) neighbors.push(key + width);
    const from = point(key);
    for (const next of neighbors) {
      if (closed.has(next)) continue;
      const to = point(next);
      if (obstacles.some((rect) => segmentCrossesRect(from, to, rect))) continue;
      const nextDistance = distance.get(key) + Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      if (nextDistance >= (distance.get(next) ?? Infinity)) continue;
      distance.set(next, nextDistance);
      previous.set(next, key);
      pending.push({ key: next, cost: nextDistance + Math.abs(to.x - end.x) + Math.abs(to.y - end.y) });
    }
  }
  return null;
}

export function routeAroundCards({ sourceX, sourceY, targetX, targetY, source, target, cards }) {
  const from = { x: sourceX, y: sourceY };
  const to = { x: targetX, y: targetY };
  const start = { x: sourceX + GAP, y: sourceY };
  const end = { x: targetX - GAP, y: targetY };
  const obstacles = cards.map((card) => ({
    id: card.id,
    left: card.x - GAP,
    right: card.x + card.width + GAP,
    top: card.y - GAP,
    bottom: card.y + card.height + GAP,
  }));
  // Ports may sit 1px inside the CSS border. Put the escape point on the exact
  // padded boundary so the parent's own padding never blocks the route.
  const sourceRect = obstacles.find((rect) => rect.id === source);
  const targetRect = obstacles.find((rect) => rect.id === target);
  if (sourceRect) start.x = sourceRect.right;
  if (targetRect) end.x = targetRect.left;
  let route;
  const middleX = (start.x + end.x) / 2;
  const direct = [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
  if (start.x <= end.x && clearPath(direct, obstacles)) route = direct;
  if (!route) {
    const lanes = [...new Set([start.y, end.y, ...obstacles.flatMap((rect) => [rect.top, rect.bottom])])];
    const candidates = lanes.map((y) => [start, { x: start.x, y }, { x: end.x, y }, end]);
    candidates.sort((a, b) => length(a) - length(b));
    route = candidates.find((candidate) => clearPath(candidate, obstacles));
  }
  if (!route) route = gridRoute(start, end, obstacles);
  // Overlapping cards can cover a port completely. Avoid inventing a line through
  // another card; the relation stays available in the saved graph until moved apart.
  if (!route) return { path: '', points: [], labelX: sourceX, labelY: sourceY };
  const points = simplify([from, ...route, to]);
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const segments = points.slice(1).map((point, index) => ({ a: points[index], b: point, size: Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y) }));
  // Prefer a horizontal segment for a readable centered relation label.
  const horizontal = segments.filter(({ a, b }) => a.y === b.y);
  const label = (horizontal.length ? horizontal : segments).sort((a, b) => b.size - a.size)[0];
  return { path, points, labelX: (label.a.x + label.b.x) / 2, labelY: (label.a.y + label.b.y) / 2 };
}
