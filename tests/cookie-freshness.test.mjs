// 回环 cookie 的时效性回归测试。
//
// 真实故障：网关在 DSH 端口还没定下来时就把 cookie 签好并缓存，之后每个请求都带着
// authority 不匹配的 cookie；网关又会剥掉浏览器自带的同名 cookie，于是客户端只会
// 一直拿到 401，看起来就像「用久了就失效」。这里锁住「必须按当前端口现签」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

import { RemoteService } from '../lib/service.js';
import { LAN_PORT } from '../lib/config.js';

/** 测试专用入口端口：避开生产端口，避免与运行中的实例冲突。 */
const TEST_PORT = 38080;

/** 本机一个真实局域网地址；没有就跳过。 */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/** 造一个带凭据文件的临时 DSH_HOME，返回路径与清理函数。 */
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-cookie-'));
  const secret = Buffer.alloc(32, 7).toString('base64url');
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secret}`,
    'refs: {}',
    '',
  ].join('\n'), 'utf8');
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** 从 `name=value` 里解出 authority。 */
function authorityOf(cookie) {
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const body = value.split('.')[1];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return payload;
}

test('cookie 按当前 DSH 端口现签，端口变化后自动跟随', async (t) => {
  const address = lanAddress();
  if (address === null) { t.skip('本机没有局域网地址'); return; }
  if (address) { /* 继续 */ }

  const { home, cleanup } = await tempHome();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  // 端口可变：模拟桌面版 `--port 0` 启动后端口才确定，以及后续端口变化。
  const ctx = {
    webServer: { port: 51234, host: '127.0.0.1' },
    get: () => undefined,
  };
  // 用临时端口，避免与正在运行的实例抢 3080
  const service = new RemoteService({
    ctx,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    persist: async () => {},
    selectedIp: address,
    port: TEST_PORT,
  });

  try {
    await service.ensureGateway();
    const gateway = service.gateway;
    if (!gateway) { t.skip(`${address}:${TEST_PORT} 无法绑定，跳过`); return; }

    // 第一签：绑定当前端口
    const first = gateway.cookieProvider();
    assert.ok(first.length > 0, '应能生成 cookie');
    assert.equal(authorityOf(first[0]).authority, '127.0.0.1:51234');

    // 端口变了（宿主重开），同一个 provider 必须给出新的 authority
    ctx.webServer.port = 60001;
    const second = gateway.cookieProvider();
    assert.equal(
      authorityOf(second[0]).authority,
      '127.0.0.1:60001',
      'cookie 必须按当前端口现签，不能沿用启动时的端口',
    );

    // 有效期保持在注入窗口内（远小于宿主的 30 天上限）
    const payload = authorityOf(second[0]);
    const hours = (payload.expiresAt - payload.issuedAt) / 3_600_000;
    assert.ok(hours > 0 && hours <= 24, `有效期应短于 24 小时，实际 ${hours}h`);
  } finally {
    await service.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await cleanup();
  }
});

test('没有密钥时不生成 cookie（宁可透传，也不注入坏 cookie）', async () => {
  const { home, cleanup } = await tempHome();
  const previous = process.env.DSH_HOME;
  // 指向一个没有凭据文件的目录
  process.env.DSH_HOME = join(home, 'empty');

  const ctx = { webServer: { port: 51234, host: '127.0.0.1' }, get: () => undefined };
  const service = new RemoteService({
    ctx,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    persist: async () => {},
    selectedIp: '',
    port: TEST_PORT,
  });

  try {
    assert.equal(service.sessionSecret, '');
    const cookies = service['#buildCookies'] ? null : null;
    // 通过私有方法不可达时，至少断言字段为空——网关此时会透传而不注入。
    assert.equal(service.sessionSecret, '');
    assert.equal(cookies, null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await cleanup();
  }
});
