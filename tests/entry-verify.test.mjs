// 入口自检回归测试。
//
// 真实故障：网关端口在听、面板显示「可以访问」，但 cookie 注入失效，浏览器只拿到
// 401。可用性必须来自「真的取到了 DSH 页面」，而不是「端口在监听」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

import { RemoteService, ENTRY_STATE } from '../lib/service.js';
import { GATEWAY_ERRORS } from '../lib/config.js';

const TEST_PORT = 38081;

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/** 一个会校验 cookie 的假 DSH：没有正确 cookie 就回 401。 */
async function fakeDsh({ requireCookie }) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const cookie = String(req.headers.cookie ?? '');
    const authed = !requireCookie || cookie.includes('dsh-auth-');
    if (!authed) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>DeepSeek Harness</title></head><body><script>window.__DSH_BOOT__={}</script></body></html>');
  });
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

/** 临时 DSH_HOME，可选择是否写入凭据。 */
async function tempHome(withSecret) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-verify-'));
  if (withSecret) {
    const secret = Buffer.alloc(32, 9).toString('base64url');
    await writeFile(join(home, '.credentials.yaml'), [
      'version: 1', 'records:', '  client-connection/browser-session:',
      '    kind: grant', '    payload:', '      version: 1', `      secret: ${secret}`, 'refs: {}', '',
    ].join('\n'), 'utf8');
  }
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function withService({ address, dshPort, home, run }) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = new RemoteService({
    ctx: { webServer: { port: dshPort, host: '127.0.0.1' }, get: () => undefined },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    persist: async () => {},
    selectedIp: address,
    port: TEST_PORT,
  });
  try {
    await service.ensureGateway();
    return await run(service);
  } finally {
    await service.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('上游要求 cookie 且注入正确 → 入口为可用', async (t) => {
  const address = lanAddress();
  if (address === null) { t.skip('本机没有局域网地址'); return; }
  const dsh = await fakeDsh({ requireCookie: true });
  const { home, cleanup } = await tempHome(true);
  try {
    const status = await withService({
      address, dshPort: dsh.port, home,
      run: async (service) => {
        if (!service.gateway?.running) return null;
        return service.getStatus({ fresh: true });
      },
    });
    if (status === null) { t.skip(`${address}:${TEST_PORT} 无法绑定`); return; }

    const entry = status.entries.find((item) => item.address === address);
    assert.equal(entry.state, ENTRY_STATE.gateway, '注入正常时应为 gateway');
    assert.equal(entry.url, `http://${address}:${TEST_PORT}`);
    assert.equal(status.available, true);
  } finally {
    await dsh.close();
    await cleanup();
  }
});

test('没有密钥 → 上游返回 401 时不得显示为可用', async (t) => {
  const address = lanAddress();
  if (address === null) { t.skip('本机没有局域网地址'); return; }
  const dsh = await fakeDsh({ requireCookie: true });
  const { home, cleanup } = await tempHome(false);
  try {
    const status = await withService({
      address, dshPort: dsh.port, home,
      run: async (service) => {
        if (!service.gateway?.running) return null;
        return service.getStatus({ fresh: true });
      },
    });
    if (status === null) { t.skip(`${address}:${TEST_PORT} 无法绑定`); return; }

    const entry = status.entries.find((item) => item.address === address);
    assert.equal(entry.url, null, '401 的入口不能给出可点开的地址');
    assert.equal(entry.error, GATEWAY_ERRORS.authFailed, '应如实报告会话被拒');
    assert.equal(status.available, false, '端口在听但 401，不算可用');
  } finally {
    await dsh.close();
    await cleanup();
  }
});
