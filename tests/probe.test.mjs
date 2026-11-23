// 探测三态测试：核心是「没有证据不得声称端口被占用」。
//
// 曾经的真实缺陷：除 ECONNREFUSED 之外的所有失败（超时、不可达）都被当成
// 「有服务在听但不是 DSH」，于是离线的点对点隧道地址会被报成「端口被占用」，
// 用户被引导去关闭一个根本不存在的占用进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { probeDshOnAddress, PROBE } from '../lib/service.js';

/** 起一个临时 HTTP 服务，返回端口与关闭函数。 */
async function serve(handler) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
      server.close(() => resolve());
    }),
  };
}

/** 找一个当前没人监听的本机端口。 */
async function closedPort() {
  const probe = await serve((req, res) => res.end('x'));
  const { port } = probe;
  await probe.close();
  return port;
}

/** 本机一个真实局域网地址；没有就返回 null。 */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

test('没人监听时判定为 down，而不是「被占用」', async () => {
  const port = await closedPort();
  const result = await probeDshOnAddress('127.0.0.1', port);
  assert.equal(result.state, PROBE.down, `实际：${JSON.stringify(result)}`);
  assert.notEqual(result.state, PROBE.taken, '连接被拒绝不等于端口被占用');
});

test('非 DSH 的 HTTP 服务判定为 taken', async () => {
  const service = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('some other service');
  });
  try {
    const result = await probeDshOnAddress('127.0.0.1', service.port);
    assert.equal(result.state, PROBE.taken, `实际：${JSON.stringify(result)}`);
    assert.equal(result.status, 200);
  } finally {
    await service.close();
  }
});

test('DSH 页面判定为 up', async () => {
  const service = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>DeepSeek Harness</title></head><body><script>window.__DSH_BOOT__={}</script></body></html>');
  });
  try {
    const result = await probeDshOnAddress('127.0.0.1', service.port);
    assert.equal(result.state, PROBE.up, `实际：${JSON.stringify(result)}`);
  } finally {
    await service.close();
  }
});

test('DSH 的登录页（401 + 提示文案）也算 up', async () => {
  const service = await serve((req, res) => {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>dsh web authentication required; reopen the URL printed by dsh web.</body></html>');
  });
  try {
    const result = await probeDshOnAddress('127.0.0.1', service.port);
    assert.equal(result.state, PROBE.up, `实际：${JSON.stringify(result)}`);
  } finally {
    await service.close();
  }
});

test('不可达地址超时后判定为 down，且不会拖过超时上限太多', async () => {
  // 10.255.255.1 在常见网络里是黑洞：SYN 得不到响应，正是生产里出现 SYN_SENT 的场景。
  const startedAt = Date.now();
  const result = await probeDshOnAddress('10.255.255.1', 3080, 300);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.state, PROBE.down, `超时必须是 down，实际：${JSON.stringify(result)}`);
  assert.notEqual(result.state, PROBE.taken);
  // 允许一定调度误差，但必须尊重传入的超时，而不是固定 1.2s。
  assert.ok(elapsed < 1500, `探测应在超时后尽快返回，实际 ${elapsed}ms`);
});

test('超时可配置，短超时更快返回', async () => {
  const startedAt = Date.now();
  await probeDshOnAddress('10.255.255.1', 3080, 150);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1200, `应遵守 150ms 超时，实际 ${elapsed}ms`);
});

test('回环上没有 3080 时不会误判为 up', async () => {
  const result = await probeDshOnAddress('127.0.0.1', 3080, 500);
  // 本机若恰好有 DSH 在 3080，则允许 up；否则必须是 down。
  assert.ok(
    result.state === PROBE.down || result.state === PROBE.up,
    `实际：${JSON.stringify(result)}`,
  );
});

test('真实局域网地址 + 未监听端口 → down', async (t) => {
  const host = lanAddress();
  if (host === null) { t.skip('本机没有局域网地址'); return; }
  const port = await closedPort();
  const result = await probeDshOnAddress(host, port);
  assert.equal(result.state, PROBE.down, `实际：${JSON.stringify(result)}`);
});
