// 客户端打包：把 CommonJS 模块体包进 DSH 客户端模块加载器要求的 lazy factory。
//
// 产物格式（与 DSH 官方客户端模块一致）：
//   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { ... } })
// `require('react')` 由宿主的浏览器模块表提供，不打包 React 自身。
//
// 这里刻意不引入打包器：插件只有三个客户端模块，一个带目录解析的小注册表就够用，
// 产物可读，也能在单元测试里直接求值验证。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** 参与打包的模块（相对仓库根），全部按 CommonJS 书写。 */
const MODULES = ['client/constants.js', 'client/locales.js', 'client/panel.js'];

/** 入口模块（返回给宿主的 exports）。 */
const ENTRY = 'client/panel.js';

/** 允许 require 的宿主模块：只放行 React，其余一律报错以免悄悄依赖不存在的模块。 */
const HOST_MODULES = ['react'];

const sources = new Map();
for (const id of MODULES) sources.set(id, readFileSync(join(root, id), 'utf8'));

const definitions = MODULES.map((id) => `
  __def(${JSON.stringify(id)}, function (require, module, exports) {
${sources.get(id)}
  });`).join('\n');

const output = `// dsh-remote 客户端 bundle —— 由 scripts/build-client.mjs 生成，请勿手工编辑。
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    'use strict';
    const React = require('react');

    const HOST_MODULES = new Set(${JSON.stringify(HOST_MODULES)});
    const defs = new Map();
    const cache = new Map();

    function __def(id, body) { defs.set(id, body); }

    /** 把相对说明符解析成同仓库内的模块 id。 */
    function resolveId(from, specifier) {
      const base = from.slice(0, from.lastIndexOf('/') + 1);
      const stack = [];
      for (const part of (base + specifier).split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') { stack.pop(); continue; }
        stack.push(part);
      }
      return stack.join('/');
    }

    function load(id) {
      if (cache.has(id)) return cache.get(id);
      const body = defs.get(id);
      if (body === undefined) throw new Error('dsh-remote client: missing module ' + id);
      const module = { exports: {} };
      // 先占位再求值：模块之间不存在循环依赖，但占位能避免重复求值。
      cache.set(id, module.exports);
      body((specifier) => {
        if (HOST_MODULES.has(specifier)) return React;
        if (!specifier.startsWith('.')) {
          throw new Error('dsh-remote client: unsupported module ' + JSON.stringify(specifier));
        }
        return load(resolveId(id, specifier));
      }, module, module.exports);
      cache.set(id, module.exports);
      return module.exports;
    }
${definitions}

    return load(${JSON.stringify(ENTRY)});
  },
});
`;

mkdirSync(join(root, 'client'), { recursive: true });
const outFile = join(root, 'client', 'client.js');
writeFileSync(outFile, output, 'utf8');
console.log(`Wrote ${outFile} (${output.length} bytes)`);
