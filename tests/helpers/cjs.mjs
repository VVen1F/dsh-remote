// 以 CommonJS 语义加载 client/ 下的模块。
//
// client/*.js 是"浏览器模块体"，最终由 DSH 客户端加载器以 CJS 语义求值；仓库本身是
// ESM 包，所以 Node 直接 import 会报错。这里用同一套语义把它们读进来，保证测试跑的
// 就是线上产物。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 允许的宿主模块（与 scripts/build-client.mjs 的白名单一致）。 */
const HOST_MODULES = new Set(['react']);

/**
 * 在 CJS 语义下加载一个客户端模块。
 * @param {string} relativePath 相对仓库根的路径，例如 'client/constants.js'
 * @param {{react?: object}} [env] 宿主模块替身
 * @returns {object} 模块的 exports
 */
export function loadClientModule(relativePath, env = {}) {
  const cache = new Map();

  const load = (absPath) => {
    if (cache.has(absPath)) return cache.get(absPath);
    const source = readFileSync(absPath, 'utf8');
    const module = { exports: {} };
    cache.set(absPath, module.exports);

    const requireShim = (specifier) => {
      if (HOST_MODULES.has(specifier)) {
        if (specifier === 'react') return env.react ?? {};
        throw new Error(`测试未提供宿主模块 ${specifier}`);
      }
      if (!specifier.startsWith('.')) {
        throw new Error(`不支持的模块说明符 ${specifier}`);
      }
      return load(resolve(dirname(absPath), specifier));
    };

    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', source)(requireShim, module, module.exports);
    cache.set(absPath, module.exports);
    return module.exports;
  };

  return load(join(root, relativePath));
}
