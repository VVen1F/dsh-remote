// 端口口径检查：仓库里只允许出现一个局域网端口常量，且不出现旧端口 3082。
//
// 这个脚本是 `npm run lint` 的执行体，也是 CI 的守卫：
//   1. 旧端口 3082 出现即失败（含文档、注释、测试夹具）；
//   2. `LAN_PORT` 的数值必须只有一个来源，客户端副本会与 lib 侧交叉校验；
//   3. 代码里不允许出现"裸端口字面量"的监听调用（只允许经由常量）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 不参与扫描的目录 / 文件。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'scripts/check-port-usage.mjs']);

/** 旧端口：只允许出现在"禁止出现"的说明里，因此整份仓库都不允许。 */
const LEGACY_PORT = ['3082'].join('');

/**
 * 递归收集需要检查的文件。
 * @param {string} directory
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collect(directory, out = []) {
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRS.has(name)) continue;
    const absolute = join(directory, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      collect(absolute, out);
      continue;
    }
    if (!/\.(js|mjs|cjs|ts|json|ya?ml|md|svg)$/i.test(name)) continue;
    const relativePath = relative(root, absolute).split('\\').join('/');
    if (SKIP_FILES.has(relativePath)) continue;
    out.push(relativePath);
  }
  return out;
}

const failures = [];

for (const file of collect(root)) {
  const text = readFileSync(join(root, file), 'utf8');
  if (text.includes(LEGACY_PORT)) {
    failures.push(`${file}: 仍引用旧端口 ${LEGACY_PORT}`);
  }
}

/** 交叉校验：Host 侧与客户端副本的端口必须一致。 */
function readLanPort(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const match = /LAN_PORT\s*=\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

const hostPort = readLanPort('lib/config.js');
const clientPort = readLanPort('client/constants.js');

if (hostPort === null) failures.push('lib/config.js: 未找到 LAN_PORT 定义');
if (clientPort === null) failures.push('client/constants.js: 未找到 LAN_PORT 定义');
if (hostPort !== null && clientPort !== null && hostPort !== clientPort) {
  failures.push(`端口不一致：lib=${hostPort}，client=${clientPort}`);
}
if (hostPort !== 3080) {
  failures.push(`lib/config.js: LAN_PORT 应为 3080，实际为 ${hostPort}`);
}

/** 只允许 `listen(this.port, ...)` 这类经由字段的调用，禁止裸端口监听。 */
const gatewayText = readFileSync(join(root, 'lib/gateway.js'), 'utf8');
if (/\.listen\(\s*\d+\s*,/.test(gatewayText)) {
  failures.push('lib/gateway.js: 出现裸端口字面量监听，必须使用 this.port');
}

if (failures.length > 0) {
  console.error('端口口径检查失败：\n' + failures.map((line) => `  · ${line}`).join('\n'));
  process.exit(1);
}

console.log(`端口口径检查通过：局域网端口 ${hostPort}，无旧端口残留。`);
