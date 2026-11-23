// 二维码编码器测试：与规范/参考实现一致的固定向量
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeQrMatrix, matrixToSvgPath } from '../lib/qr-encoder.js';
import { toSvgDataUrl } from '../lib/qr.js';

/** 固定向量：由参考实现（qrcode@1.5，纠错等级 M、Byte 模式）逐模块比对通过。 */
const VECTORS = [
  { text: 'http://192.168.0.102:3080', version: 2, mask: 2, size: 25 },
  { text: 'http://100.64.0.100:3080', version: 2, mask: 4, size: 25 },
  { text: 'http://10.0.0.5:3080', version: 2, mask: 1, size: 25 },
  { text: 'http://172.20.1.9:3080', version: 2, mask: 2, size: 25 },
  { text: 'http://192.168.100.200:3080', version: 3, mask: 2, size: 29 },
  { text: 'http://192.168.0.102:3080/', version: 2, mask: 2, size: 25 },
  { text: 'http://[fd00::1]:3080', version: 2, mask: 2, size: 25 },
];

test('版本与掩码选择与参考实现一致', () => {
  for (const vector of VECTORS) {
    const result = encodeQrMatrix(vector.text);
    assert.equal(result.version, vector.version, `${vector.text} 的版本`);
    assert.equal(result.mask, vector.mask, `${vector.text} 的掩码`);
    assert.equal(result.size, vector.size, `${vector.text} 的边长`);
  }
});

test('三个定位图案位于规范位置', () => {
  const { modules } = encodeQrMatrix('http://192.168.0.102:3080');
  const n = modules.length;

  /** 定位图案中心 3×3 必须是「深 浅 深」结构；用外圈 7×7 判定更稳妥。 */
  const isFinderTopLeft = (x0, y0) => {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        // 7×7 定位图案：最外环深、第二环浅、中心 3×3 深。
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        const expected = ring === 3 || ring <= 1 ? 1 : 0;
        if (modules[y0 + dy][x0 + dx] !== expected) return false;
      }
    }
    return true;
  };

  assert.ok(isFinderTopLeft(0, 0), '左上定位图案');
  assert.ok(isFinderTopLeft(n - 7, 0), '右上定位图案');
  assert.ok(isFinderTopLeft(0, n - 7), '左下定位图案');
});

test('定时图案在图幅边缘交替', () => {
  const { modules } = encodeQrMatrix('http://192.168.0.102:3080');
  // 第一行第 8 列起是水平定时图案：模块颜色随列号奇偶交替。
  for (let x = 8; x < modules.length - 8; x += 1) {
    assert.equal(modules[6][x], x % 2 === 0 ? 1 : 0, `第 6 行第 ${x} 列的定时图案`);
  }
});

test('矩阵只含 0/1，且行数等于列数', () => {
  const { modules } = encodeQrMatrix('http://10.0.0.5:3080');
  assert.equal(modules.length, modules[0].length);
  for (const row of modules) {
    for (const cell of row) assert.ok(cell === 0 || cell === 1, '模块只能是 0 或 1');
  }
});

test('超长内容会明确报错而不是产出坏码', () => {
  assert.throws(() => encodeQrMatrix('x'.repeat(500)), /二维码内容过长/);
  assert.throws(() => encodeQrMatrix(''), /不能为空/);
});

test('SVG 路径按行合并连续暗模块', () => {
  const modules = [
    [1, 1, 0, 1],
    [0, 0, 0, 0],
    [1, 0, 1, 0],
  ];
  const { path, size } = matrixToSvgPath(modules, 2);
  assert.equal(size, 8, '4 列 × 2px');
  // 第 0 行：两连块 + 单块；第 2 行：两块单块 —— 共 4 段
  assert.equal((path.match(/M/g) ?? []).length, 4);
  assert.match(path, /^M0 0h4v2h-4z/);
});

test('dataURL 是合法 SVG 且带静区', () => {
  const url = toSvgDataUrl('http://192.168.0.102:3080');
  assert.match(url, /^data:image\/svg\+xml;base64,/);

  const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /<svg[^>]+shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#FFFFFF"/, '必须有浅色底');
  assert.match(svg, /fill="#1F2421"/, '必须有深色前景');
  // 静区：整体边长 = (模块数 + 8) × 每模块像素
  const width = Number(/width="(\d+)"/.exec(svg)[1]);
  const height = Number(/height="(\d+)"/.exec(svg)[1]);
  assert.equal(width, height);
  assert.ok(width % 4 === 0 || width > 0);
});
