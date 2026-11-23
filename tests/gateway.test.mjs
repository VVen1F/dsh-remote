// 网关端到端测试：真的起一个上游 + 网关，验证 HTTP / WebSocket / cookie 注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';

import { LanGateway } from '../lib/gateway.js';
import { LAN_PORT } from '../lib/config.js';

/** 起一个假的上游 DSH：记录收到的头，回显并支持 upgrade。 */
async function startUpstream() {
  const seen = [];
  /** 记录所有 socket，close 时强制断开，避免升级后的长连接挂住 close 回调。 */
  const sockets = new Set();
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>DSH</title></head><body>ok</body></html>');
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${req.headers['sec-websocket-key'] ?? 'x'}\r\n\r\n`,
    );
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => socket.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) { try { socket.destroy(); } catch { /* 已关闭 */ } }
    sockets.clear();
    server.close(() => resolve());
  });
  return { server, seen, sockets, close, port: server.address().port };
}

/** 找一个可绑定的本机地址用于网关（回环即可，测试不依赖真实网卡）。 */
const BIND_HOST = '127.0.0.1';

test('网关把请求转发给上游，并改写 Host / Origin / Referer', async () => {
  const upstream = await startUpstream();
  const provided = ['dsh-auth-test=VALUE'];
  const gateway = new LanGateway({
    targetPort: upstream.port,
    bindHost: BIND_HOST,
    port: LAN_PORT,
    cookieProvider: () => provided,
  });

  const started = await gateway.start();
  // 3080 可能被本机其它程序占用：占用时跳过本用例（另有专门的失败用例覆盖）。
  if (!started.ok) {
    if (started.code === 'port-in-use') {
      await upstream.server.close();
      return;
    }
    throw new Error(started.message);
  }

  try {
    const response = await fetch(`http://${BIND_HOST}:${LAN_PORT}/some/path?x=1`, {
      headers: { origin: `http://${BIND_HOST}:${LAN_PORT}`, referer: `http://${BIND_HOST}:${LAN_PORT}/some/path` },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /apple-mobile-web-app-capable/, 'HTML 必须带上移动端提示');

    const hit = upstream.seen.at(-1);
    assert.equal(hit.url, '/some/path?x=1');
    assert.equal(hit.headers.host, `127.0.0.1:${upstream.port}`, 'Host 必须改写成回环');
    assert.equal(hit.headers.origin, `http://127.0.0.1:${upstream.port}`, 'Origin 必须改写成回环');
    assert.equal(hit.headers.referer, `http://127.0.0.1:${upstream.port}/some/path`);
    assert.match(hit.headers.cookie, /dsh-auth-test=VALUE/, '必须注入会话 cookie');
    assert.equal(hit.headers['accept-encoding'], undefined, '转发时不得要求压缩');
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('同名旧 cookie 被剔除，避免遮住注入值', async () => {
  const upstream = await startUpstream();
  const gateway = new LanGateway({
    targetPort: upstream.port,
    bindHost: BIND_HOST,
    port: LAN_PORT,
    cookieProvider: () => ['dsh-auth-abc=FRESH'],
  });
  const started = await gateway.start();
  if (!started.ok) {
    await upstream.server.close();
    if (started.code === 'port-in-use') return;
    throw new Error(started.message);
  }

  try {
    await fetch(`http://${BIND_HOST}:${LAN_PORT}/`, {
      headers: { cookie: 'dsh-auth-abc=STALE; other=1' },
    });
    const cookie = upstream.seen.at(-1).headers.cookie;
    assert.equal(cookie.includes('STALE'), false, '旧值必须被剔除');
    assert.match(cookie, /dsh-auth-abc=FRESH/);
    assert.match(cookie, /other=1/, '无关 cookie 必须保留');
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('WebSocket 升级经网关转发成功', async () => {
  const upstream = await startUpstream();
  const gateway = new LanGateway({
    targetPort: upstream.port,
    bindHost: BIND_HOST,
    port: LAN_PORT,
    cookieProvider: () => ['dsh-auth-abc=VALUE'],
  });
  const started = await gateway.start();
  if (!started.ok) {
    await upstream.server.close();
    if (started.code === 'port-in-use') return;
    throw new Error(started.message);
  }

  try {
    const status = await new Promise((resolve, reject) => {
      const socket = connect(LAN_PORT, BIND_HOST, () => {
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\n'
          + `Host: ${BIND_HOST}:${LAN_PORT}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n')) {
          socket.destroy();
          resolve(Number(buffer.split(' ')[1]));
        }
      });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); resolve(0); }, 3000).unref();
    });
    assert.equal(status, 101, '网关必须回 101');
    const upgradeHit = upstream.seen.find((entry) => entry.upgrade);
    assert.ok(upgradeHit, '上游必须收到升级请求');
    assert.match(upgradeHit.headers.cookie ?? '', /dsh-auth-abc=VALUE/);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('上游不可达时返回 502 且带可读原因', async () => {
  const gateway = new LanGateway({
    targetPort: 1, // 必然没人监听
    bindHost: BIND_HOST,
    port: LAN_PORT,
    cookieProvider: () => [],
  });
  const started = await gateway.start();
  if (!started.ok) {
    if (started.code === 'port-in-use') return;
    throw new Error(started.message);
  }
  try {
    const response = await fetch(`http://${BIND_HOST}:${LAN_PORT}/`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /无法连接本机 DSH/);
  } finally {
    await gateway.stop();
  }
});

test('端口被占用时启动失败并给出 port-in-use 与可读原因', async () => {
  const blocker = createServer((req, res) => res.end('blocker'));
  const occupied = await new Promise((resolve) => {
    blocker.once('error', () => resolve(false));
    blocker.listen(LAN_PORT, BIND_HOST, () => resolve(true));
  });
  if (!occupied) {
    // 端口本来就被别的程序占用：同样应当拿到 port-in-use。
    const gateway = new LanGateway({
      targetPort: 1, bindHost: BIND_HOST, port: LAN_PORT, cookieProvider: () => [],
    });
    const started = await gateway.start();
    assert.equal(started.ok, false);
    assert.equal(started.code, 'port-in-use');
    assert.match(started.message, /已被其它程序占用/);
    return;
  }

  try {
    const gateway = new LanGateway({
      targetPort: 1, bindHost: BIND_HOST, port: LAN_PORT, cookieProvider: () => [],
    });
    const started = await gateway.start();
    assert.equal(started.ok, false);
    assert.equal(started.code, 'port-in-use');
    assert.match(started.message, /已被其它程序占用/);
    assert.equal(gateway.running, false, '失败后不得保留运行状态');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('stop 之后端口可再次绑定（无残留监听）', async () => {
  const upstream = await startUpstream();
  const gateway = new LanGateway({
    targetPort: upstream.port, bindHost: BIND_HOST, port: LAN_PORT, cookieProvider: () => [],
  });
  const started = await gateway.start();
  await upstream.server.close();
  if (!started.ok) {
    if (started.code === 'port-in-use') return;
    throw new Error(started.message);
  }
  await gateway.stop();

  const again = new LanGateway({
    targetPort: 1, bindHost: BIND_HOST, port: LAN_PORT, cookieProvider: () => [],
  });
  const restarted = await again.start();
  if (restarted.ok) await again.stop();
  assert.notEqual(restarted.code, 'port-in-use', 'stop 后不得残留监听');
});
