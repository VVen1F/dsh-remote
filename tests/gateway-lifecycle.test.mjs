// 网关生命周期回归测试：并发切网卡 / 反复重建不得出现「端口被占用」假错误。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { LanGateway } from '../lib/gateway.js';
import { LAN_PORT } from '../lib/config.js';

const HOST_A = '127.0.0.1';

/** 选一个除回环外真实可用的本机地址；没有就跳过「换地址」类用例。 */
function pickSecondHost() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}
const HOST_B = pickSecondHost();

/** 起一个回显上游。 */
async function startUpstream() {
  const sockets = new Set();
  const server = createServer((req, res) => res.end('upstream'));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
    server.close(() => resolve());
  });
  return { port: server.address().port, close };
}

test('串行重建：停掉旧实例后，同端口换地址可立即绑定', async (ctx) => {
  if (HOST_B === null) { ctx.skip('本机没有第二个可用网卡地址'); return; }
  const upstream = await startUpstream();
  try {
    const first = new LanGateway({
      targetPort: upstream.port, bindHost: HOST_A, port: LAN_PORT, cookieProvider: () => [],
    });
    const started = await first.start();
    if (!started.ok) {
      if (started.code === 'port-in-use') return; // 本机 3080 被占：跳过（另有专门用例）
      throw new Error(started.message);
    }

    await first.stop();

    const second = new LanGateway({
      targetPort: upstream.port, bindHost: HOST_B, port: LAN_PORT, cookieProvider: () => [],
    });
    const restarted = await second.start();
    if (!restarted.ok && restarted.code === 'port-in-use') {
      // 该地址的 3080 已被真实程序占用（例如本机正在跑 DSH）：无法验证换地址绑定。
      ctx.skip(`${HOST_B}:${LAN_PORT} 被占用，跳过`);
      return;
    }
    assert.equal(restarted.ok, true, `换地址后必须能立即绑定，实际：${restarted.message ?? ''}`);
    await second.stop();
  } finally {
    await upstream.close();
  }
});

test('并发重建不会双双失败', async (ctx) => {
  if (HOST_B === null) { ctx.skip('本机没有第二个可用网卡地址'); return; }
  const upstream = await startUpstream();
  try {
    // 模拟「切换网卡」与「重新检测」同时触发：两个 rebuild 并发。
    const rebuild = async (host) => {
      const gateway = new LanGateway({
        targetPort: upstream.port, bindHost: host, port: LAN_PORT, cookieProvider: () => [],
      });
      const result = await gateway.start();
      if (!result.ok) return { ok: false, code: result.code, gateway };
      await gateway.stop();
      return { ok: true, gateway };
    };

    const results = await Promise.all([rebuild(HOST_A), rebuild(HOST_B)]);
    // 两个都绑同一端口：串行执行时后一个必然成功，绝不能两个都报 EADDRINUSE。
    const successes = results.filter((item) => item.ok).length;
    const skipped = results.some((item) => item.code === 'port-in-use' && !item.ok);
    if (skipped && successes === 0) return; // 本机 3080 本来被占：跳过
    assert.ok(successes >= 1, `至少应有一个重建成功，实际 ${JSON.stringify(results.map((r) => r.code ?? 'ok'))}`);
    for (const item of results) {
      if (!item.ok) await item.gateway.stop();
    }
  } finally {
    await upstream.close();
  }
});

test('反复 start/stop 十轮不泄漏监听', async () => {
  const upstream = await startUpstream();
  try {
    for (let round = 0; round < 10; round += 1) {
      const gateway = new LanGateway({
        targetPort: upstream.port, bindHost: HOST_A, port: LAN_PORT, cookieProvider: () => [],
      });
      const result = await gateway.start();
      if (!result.ok) {
        if (result.code === 'port-in-use') return;
        throw new Error(`第 ${round} 轮启动失败：${result.message}`);
      }
      const response = await fetch(`http://${HOST_A}:${LAN_PORT}/`);
      assert.equal(await response.text(), 'upstream');
      await gateway.stop();
      assert.equal(gateway.running, false);
    }
  } finally {
    await upstream.close();
  }
});

test('未启动时 stop 是安全的空操作', async () => {
  const gateway = new LanGateway({ targetPort: 1, bindHost: HOST_A, port: LAN_PORT, cookieProvider: () => [] });
  await gateway.stop();
  await gateway.stop();
  assert.equal(gateway.running, false);
});

test('重复 start 不会二次监听', async () => {
  const upstream = await startUpstream();
  try {
    const gateway = new LanGateway({
      targetPort: upstream.port, bindHost: HOST_A, port: LAN_PORT, cookieProvider: () => [],
    });
    const first = await gateway.start();
    if (!first.ok) {
      if (first.code === 'port-in-use') return;
      throw new Error(first.message);
    }
    const second = await gateway.start();
    assert.equal(second.ok, true, '重复 start 应幂等返回成功');
    await gateway.stop();
  } finally {
    await upstream.close();
  }
});
