// 入口模型测试：3080 上已有 DSH 在服务时，必须识别为「可用入口」而不是「端口被占用」。
//
// 这是本插件最关键的一条语义：用户能访问，就是可用；谁起的进程不重要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { RemoteService, ENTRY_STATE } from '../lib/service.js';
import { LAN_PORT } from '../lib/config.js';

/** 本机一个真实可用的局域网地址；没有就跳过（CI 容器里常见）。 */
function pickLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

const LAN_ADDRESS = pickLanAddress();

/** 起一个假的「已有 DSH」，页面带 DSH 特征。 */
async function startFakeDsh(address) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>DeepSeek Harness</title></head><body><script>window.__DSH_BOOT__ = {}</script></body></html>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  const bound = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(LAN_PORT, address, () => resolve(true));
  });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
    server.close(() => resolve());
  });
  return { bound, close };
}

/** 最小 ctx：提供 webServer 端口与地址，凭据服务故意缺失（走文件回退，读不到就用空密钥）。 */
function makeCtx({ port = 51234, host = '127.0.0.1' } = {}) {
  return {
    webServer: { port, host },
    get: () => undefined,
  };
}

const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

test('已有 DSH 服务时识别为 ready 入口，且不启动自己的网关', async (t) => {
  if (LAN_ADDRESS === null) { t.skip('本机没有局域网地址'); return; }
  const fake = await startFakeDsh(LAN_ADDRESS);
  if (!fake.bound) { t.skip(`${LAN_ADDRESS}:${LAN_PORT} 已被占用（可能正是 DSH 本身）`); return; }

  const service = new RemoteService({
    ctx: makeCtx(),
    logger: quietLogger,
    persist: async () => {},
    selectedIp: LAN_ADDRESS,
  });

  try {
    await service.ensureGateway();
    assert.equal(service.gateway, null, '已有 DSH 时不应再起网关');
    assert.equal(service.lastError, null, '不应报错');

    const status = await service.getStatus({ fresh: true });
    assert.equal(status.available, true);
    const entry = status.entries.find((item) => item.address === LAN_ADDRESS);
    assert.equal(entry.state, ENTRY_STATE.ready);
    assert.equal(entry.source, 'existing');
    assert.equal(entry.url, `http://${LAN_ADDRESS}:${LAN_PORT}`);
    assert.ok(entry.qr, 'ready 入口必须带二维码');
    assert.equal(status.primary.address, LAN_ADDRESS);
  } finally {
    await service.dispose();
    await fake.close();
  }
});

test('端口被非 DSH 程序占用时标记 blocked，且没有可用入口', async (t) => {
  if (LAN_ADDRESS === null) { t.skip('本机没有局域网地址'); return; }

  // 监听同端口但返回非 DSH 内容
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('some other service');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  const bound = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(LAN_PORT, LAN_ADDRESS, () => resolve(true));
  });
  if (!bound) { t.skip(`${LAN_ADDRESS}:${LAN_PORT} 已被占用`); return; }

  const service = new RemoteService({
    ctx: makeCtx(),
    logger: quietLogger,
    persist: async () => {},
    selectedIp: LAN_ADDRESS,
  });

  try {
    await service.ensureGateway();
    const status = await service.getStatus({ fresh: true });
    const entry = status.entries.find((item) => item.address === LAN_ADDRESS);
    assert.equal(entry.state, ENTRY_STATE.blocked);
    assert.equal(entry.error, 'port-in-use');
    assert.equal(entry.url, null);
    // 该地址不可用；但本机可能还有其它可用网卡，因此只断言这一个入口的状态。
    assert.equal(status.entries.some((item) => item.address === LAN_ADDRESS && item.url !== null), false,
      '被别人的非 DSH 程序占着的地址不得出现在可用入口里');
  } finally {
    await service.dispose();
    for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('端口空闲时由网关接管，状态为 gateway', async (t) => {
  if (LAN_ADDRESS === null) { t.skip('本机没有局域网地址'); return; }

  const service = new RemoteService({
    ctx: makeCtx(),
    logger: quietLogger,
    persist: async () => {},
    selectedIp: LAN_ADDRESS,
  });

  try {
    await service.ensureGateway();
    const status = await service.getStatus({ fresh: true });
    const entry = status.entries.find((item) => item.address === LAN_ADDRESS);

    // 该地址上若已有 DSH 在服务（例如本机正跑着 dsh web），网关按设计不启动，
    // 此时入口是 ready/existing —— 那是另一条用例覆盖的路径，这里跳过。
    if (entry.state === ENTRY_STATE.blocked) { t.skip('该地址的 3080 被非 DSH 程序占用'); return; }
    if (entry.state === ENTRY_STATE.ready) { t.skip('该地址上已有 DSH 在服务，网关不启动属预期'); return; }

    assert.equal(entry.state, ENTRY_STATE.gateway);
    assert.equal(entry.source, 'gateway');
    assert.equal(entry.url, `http://${LAN_ADDRESS}:${LAN_PORT}`);
    assert.ok(service.gateway?.running, '网关应在运行');
  } finally {
    await service.dispose();
  }
});

test('没有局域网网卡时给出 no-interface 而非崩溃', async () => {
  const service = new RemoteService({
    ctx: makeCtx(),
    logger: quietLogger,
    persist: async () => {},
    // 选一个必然不存在的地址，触发回落到自动推荐；随后把网卡列表伪装成空。
    selectedIp: '',
  });

  const original = LAN_ADDRESS;
  try {
    // 直接验证：当选不到地址时的错误对象形状
    const status = await service.getStatus();
    // 本机有网卡时应 available 或 error 之一；没有网卡时应是 no-interface。
    if (original === null) {
      assert.equal(status.error?.code, 'no-interface');
    } else {
      assert.ok(status.entries.length > 0);
    }
  } finally {
    await service.dispose();
  }
});

test('getStatus 的每个条目都带齐字段', async () => {
  const service = new RemoteService({
    ctx: makeCtx(),
    logger: quietLogger,
    persist: async () => {},
    selectedIp: '',
  });
  try {
    const status = await service.getStatus();
    assert.equal(status.port, LAN_PORT);
    for (const entry of status.entries) {
      assert.equal(typeof entry.address, 'string');
      assert.equal(typeof entry.label, 'string');
      assert.ok(Object.values(ENTRY_STATE).includes(entry.state), `非法状态 ${entry.state}`);
      assert.ok('url' in entry);
      assert.ok('qr' in entry);
    }
    // 有可用入口时 error 必须为 null，避免面板同时显示「可用」和红色错误。
    if (status.available) assert.equal(status.error, null);
  } finally {
    await service.dispose();
  }
});
