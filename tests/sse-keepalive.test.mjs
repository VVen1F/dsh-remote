// SSE 保活测试
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSseKeepaliveCandidate, createSseKeepalive, SSE_KEEPALIVE_FRAME } from '../lib/sse-keepalive.js';

test('只对满足三条护栏的事件流注入保活', () => {
  assert.equal(isSseKeepaliveCandidate({ 'content-type': 'text/event-stream' }), true);
  assert.equal(isSseKeepaliveCandidate({ 'content-type': 'text/event-stream; charset=utf-8' }), true);
  // 定长响应
  assert.equal(isSseKeepaliveCandidate({ 'content-type': 'text/event-stream', 'content-length': '12' }), false);
  // 压缩响应
  assert.equal(isSseKeepaliveCandidate({ 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }), false);
  // 非事件流
  assert.equal(isSseKeepaliveCandidate({ 'content-type': 'text/html' }), false);
  assert.equal(isSseKeepaliveCandidate({}), false);
});

test('静默达到阈值后注入一帧注释行', async () => {
  const frames = [];
  const keepalive = createSseKeepalive({ write: (frame) => frames.push(frame), intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  keepalive.stop();
  assert.ok(frames.length >= 2, `应至少注入 2 帧，实际 ${frames.length}`);
  assert.equal(frames[0], SSE_KEEPALIVE_FRAME);
  assert.equal(SSE_KEEPALIVE_FRAME, ': keepalive\n\n');
});

test('poke 重新起算静默窗口', async () => {
  const frames = [];
  const keepalive = createSseKeepalive({ write: (frame) => frames.push(frame), intervalMs: 40 });
  const timer = setInterval(() => keepalive.poke(), 10);
  await new Promise((resolve) => setTimeout(resolve, 90));
  clearInterval(timer);
  keepalive.stop();
  assert.equal(frames.length, 0, '持续有数据时不应注入保活帧');
});

test('写入失败即停表并上报，不抛出', async () => {
  let errors = 0;
  const keepalive = createSseKeepalive({
    write: () => { throw new Error('socket closed'); },
    intervalMs: 10,
    onWriteError: () => { errors += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  keepalive.stop();
  assert.equal(errors, 1, '失败后不得反复重试');
});

test('stop 幂等且之后不再写入', async () => {
  const frames = [];
  const keepalive = createSseKeepalive({ write: (frame) => frames.push(frame), intervalMs: 10 });
  keepalive.stop();
  keepalive.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(frames.length, 0);
});
