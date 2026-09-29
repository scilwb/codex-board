import assert from 'node:assert/strict';
import test from 'node:test';
import { activityPresentation, createActivityTracker } from '../src/activity.js';

const thread = (status, eventKey, at, extras = {}) => ({
  id: 'thread-a', title: '测试对话', status,
  activity: { status, eventKey, at, stale: false }, ...extras,
});

test('activity labels identify inferred states and round completion', () => {
  assert.match(activityPresentation(thread('active')).label, /推测/);
  assert.match(activityPresentation(thread('waiting')).label, /推测/);
  assert.equal(activityPresentation(thread('completed')).label, '本轮结束');
  assert.equal(activityPresentation(thread('unsupported')).status, 'unknown');
});

test('first snapshot is silent and each new waiting or completed event notifies once', () => {
  const observe = createActivityTracker();
  assert.deepEqual(observe([thread('completed', 'old', 90)], 100), []);
  assert.deepEqual(observe([thread('active', 'start', 110)], 110), []);
  assert.equal(observe([thread('waiting', 'question', 120)], 120).length, 1);
  assert.deepEqual(observe([thread('waiting', 'question', 120)], 121), []);
  assert.equal(observe([thread('completed', 'done', 130)], 130).length, 1);
  assert.deepEqual(observe([thread('failed', 'failure', 140)], 140), []);
});

test('reconnection, old snapshots and temporarily missing threads do not replay notifications', () => {
  const observe = createActivityTracker();
  observe([thread('active', 'start', 100)], 100);
  observe([thread('waiting', 'question', 120)], 120);
  observe([thread('completed', 'done', 130)], 130);
  assert.deepEqual(observe([], 140), []);
  assert.deepEqual(observe([thread('waiting', 'question', 120)], 150), []);
  assert.deepEqual(observe([thread('waiting', 'unknown-old-question', 110)], 150), []);
  assert.deepEqual(observe([thread('completed', 'done', 130)], 150), []);
  assert.equal(observe([thread('completed', 'next-done', 160)], 160).length, 1);
});

test('newly discovered historical threads are silent; genuinely new events can notify', () => {
  const observe = createActivityTracker();
  observe([], 100);
  assert.deepEqual(observe([thread('completed', 'old', 90)], 120), []);
  assert.deepEqual(observe([thread('completed', 'no-time', null, { id: 'thread-b' })], 120), []);
  assert.equal(observe([thread('waiting', 'new', 130, { id: 'thread-c' })], 130).length, 1);
});

test('stale and archived activity is recorded without showing notices', () => {
  const observe = createActivityTracker();
  observe([thread('active', 'start', 100)], 100);
  const stale = thread('waiting', 'stale-question', 120);
  stale.activity.stale = true;
  assert.deepEqual(observe([stale], 120), []);
  assert.deepEqual(observe([thread('waiting', 'stale-question', 120)], 121), []);
  assert.deepEqual(observe([thread('completed', 'archived', 130, { archived: true })], 130), []);
});

test('tracking can continue while notices are muted, so re-enabling does not replay', () => {
  const observe = createActivityTracker();
  observe([thread('active', 'start', 100)], 100);
  observe([thread('completed', 'muted', 120)], 120); // UI discards this result while muted.
  assert.deepEqual(observe([thread('completed', 'muted', 120)], 130), []);
  assert.equal(observe([thread('waiting', 'next', 140)], 140).length, 1);
});


test('a historical event is silent even when the thread was already observed', () => {
  const observe = createActivityTracker();
  observe([thread('active', 'start', 90)], 100);
  assert.deepEqual(observe([thread('waiting', 'old-question', 95)], 120), []);
  assert.equal(observe([thread('waiting', 'new-question', 130)], 140).length, 1);
});
