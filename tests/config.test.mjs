// 端口口径与配置测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAN_PORT, RPC_CHANNEL, ENDPOINTS, GATEWAY_ERRORS } from '../lib/config.js';
import { loadClientModule } from './helpers/cjs.mjs';

const clientConstants = loadClientModule('client/constants.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('局域网端口固定为 DSH 默认的 3080', () => {
  assert.equal(LAN_PORT, 3080);
  assert.equal(clientConstants.LAN_PORT, LAN_PORT, '客户端副本必须与 Host 侧一致');
});

test('RPC 通道名符合 Connection 的通道格式', () => {
  assert.match(RPC_CHANNEL, /^\/[A-Za-z0-9._~-]+$/);
  assert.equal(clientConstants.RPC_CHANNEL, RPC_CHANNEL);
});

test('RPC 端点两侧一致，且只保留局域网需要的三个', () => {
  assert.deepEqual(ENDPOINTS, {
    getStatus: 'getStatus',
    setLanIp: 'setLanIp',
    refresh: 'refresh',
  });
  assert.deepEqual(clientConstants.ENDPOINTS, ENDPOINTS);
});

test('失败原因码覆盖监听失败的三种现实情况', () => {
  assert.deepEqual(Object.values(GATEWAY_ERRORS).sort(), [
    'dsh-owns-port', 'listen-failed', 'no-interface', 'port-in-use',
  ]);
});

test('插件零运行时依赖（链接安装也不会缺包）', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = Object.keys(pkg.dependencies ?? {});
  // 插件以「目录链接」方式装进 profile 时不会执行 npm install，任何运行时依赖都会让
  // 插件整体加载失败（曾因 qrcode 踩过这个坑），因此这里必须为空。
  assert.deepEqual(dependencies, [], `不得有运行时依赖，实际：${dependencies.join(', ')}`);
  for (const removed of ['ws', 'qrcode', '@larksuite/channel', '@larksuiteoapi/node-sdk', '@tencent-connect/qqbot-nodejs']) {
    assert.equal(dependencies.includes(removed), false, `不应保留依赖 ${removed}`);
  }
});

test('插件清单暴露客户端 bundle、语言与图标', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./client'], './client/client.js');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.ok(pkg.exports['./locale/*']);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
});

test('bundle patch 只插入一个 host 行', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const rows = patch.split('\n').filter((line) => /^\s*-\s+id:/.test(line));
  assert.deepEqual(rows.map((line) => line.trim()), ['- id: dsh-remote']);
  assert.match(patch, /name: '@wenbin_wb\/dsh-remote'/);
});

test('展示元数据齐备（标题、描述、详情文档）', () => {
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')).meta;
    assert.ok(meta.title.length > 0, `${locale} 缺少标题`);
    assert.ok(meta.description.length > 0, `${locale} 缺少描述`);
    assert.equal(meta.detail, 'docs/DETAIL.md');
  }
});
