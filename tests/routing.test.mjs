import test from 'node:test';
import assert from 'node:assert/strict';
import { routeAroundCards, segmentCrossesRect } from '../src/edgeRouting.js';

const cards = [
  { id: 'a', x: 0, y: 0, width: 290, height: 180 },
  { id: 'middle', x: 350, y: 0, width: 290, height: 180 },
  { id: 'b', x: 700, y: 0, width: 290, height: 180 },
];

for (const reverse of [false, true]) {
  test(`关系连线${reverse ? '反向' : '正向'}绕过中间无关卡片`, () => {
    const source = reverse ? cards[2] : cards[0];
    const target = reverse ? cards[0] : cards[2];
    const route = routeAroundCards({ source: source.id, target: target.id,
      sourceX: source.x + source.width, sourceY: 90,
      targetX: target.x, targetY: 90, cards });
    assert.ok(route.path.length);
    const obstacle = { left: 350, right: 640, top: 0, bottom: 180 };
    for (let i = 1; i < route.points.length; i++) {
      assert.equal(segmentCrossesRect(route.points[i - 1], route.points[i], obstacle), false);
    }
    assert.ok(route.points.some(p => p.y < 0 || p.y > 180));
  });
}

test('相邻对话连线保持直接且简短', () => {
  const pair = [cards[0], { ...cards[1], id: 'b' }];
  const route = routeAroundCards({ source: 'a', target: 'b', sourceX: 290, sourceY: 90, targetX: 350, targetY: 90, cards: pair });
  assert.deepEqual(route.points, [{ x: 290, y: 90 }, { x: 350, y: 90 }]);
});
