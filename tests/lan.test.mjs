// 局域网网卡探测测试
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNetworkReachableHost } from '../lib/lan.js';

test('回环地址不算局域网可达', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '']) {
    assert.equal(isNetworkReachableHost(host), false, `${host} 应判定为不可达`);
  }
});

test('具体网卡地址算局域网可达', () => {
  for (const host of ['192.168.0.102', '10.0.0.5', '172.20.1.9', '100.64.0.100']) {
    assert.equal(isNetworkReachableHost(host), true, `${host} 应判定为可达`);
  }
});

test('探测结果结构完整且按优先级排序', async () => {
  const { listLanInterfaces } = await import('../lib/lan.js');
  const list = listLanInterfaces();
  assert.ok(Array.isArray(list));
  for (const item of list) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.label, 'string');
    assert.match(item.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(typeof item.isVirtual, 'boolean');
    assert.equal(typeof item.score, 'number');
  }
  const scores = list.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left), '必须按分数降序');
});

test('虚拟网卡排在物理网卡之后', async () => {
  const { listLanInterfaces } = await import('../lib/lan.js');
  const list = listLanInterfaces();
  const virtualIndex = list.findIndex((item) => item.isVirtual);
  if (virtualIndex === -1) return; // 本机没有虚拟网卡：无可断言
  const firstVirtualScore = list[virtualIndex].score;
  const lastPhysicalScore = Math.min(
    ...list.filter((item) => !item.isVirtual).map((item) => item.score),
    Number.POSITIVE_INFINITY,
  );
  assert.ok(firstVirtualScore <= lastPhysicalScore, '虚拟网卡不得排在物理网卡之前');
});

test('已选网卡失效时回落到自动推荐', async () => {
  const { resolveLanAddress, listLanInterfaces } = await import('../lib/lan.js');
  const interfaces = listLanInterfaces();
  const bogus = resolveLanAddress('203.0.113.999', interfaces);
  assert.equal(bogus.selected, '', '失效的选择应被清空');
  assert.equal(bogus.address, interfaces[0]?.address ?? null);

  const first = interfaces[0];
  if (first) {
    const kept = resolveLanAddress(first.address, interfaces);
    assert.equal(kept.selected, first.address);
    assert.equal(kept.address, first.address);
  }
});
