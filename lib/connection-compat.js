// 运行时兼容垫片：DSH 的 Connection RPC 通道注册回归
//
// 现象
// ---------------------------------------------------------------
// 在 DSH 0.2.2-rc.5（桌面版内置版本）上，任何插件调用
//     ctx.connection.rpc.handle(channel, handler)
// 都会抛：
//     Error: cannot get property "webServer" without inject
// 原因是 `HostConnectionService.register()` 里这一句：
//     return owner.effect(() => owner.webServer.register(route), ...)
// 其中 `owner` 是 connection 插件自己的 ctx，而它自 0.1.5-alpha.1 起不再把
// `webServer` 写进 inject，于是 cordis 4 的服务守卫直接抛错。调用发生在插件树
// 加载期，异常向上冒泡会整棵插件树加载失败。
//
// 处理方式
// ---------------------------------------------------------------
// 不改 DSH 源码、不猜私有方法，只走两个公开面：
//   1. 正常路径：直接调用 `ctx.connection.rpc.handle(...)`；上游修好后这里就够；
//   2. 兜底路径：仅当首次调用抛出 "webServer … without inject" 时，在 root 的
//      `internal/get` 瀑布事件上临时挂一个监听器 —— 先让默认解析跑，默认解析失败
//      （抛出的正是同一个 error 对象）才补上本插件已通过 inject 拿到的 webServer
//      单例引用。语义等价，且监听器只在这一次同步注册调用期间存在。
//
// 上游修好后本模块自动空转：首次调用不再抛错，兜底分支根本不会进入。

const MISSING_INJECT = /without inject/;

/**
 * 判断错误是否为「跨服务取属性缺 inject 作用域」的守卫错误，且对象是 webServer。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isMissingWebServerInjectError(error) {
  return error instanceof Error
    && MISSING_INJECT.test(error.message)
    && /webServer/.test(error.message);
}

/**
 * 在 root 的 `internal/get` 瀑布事件上挂一个临时兜底。
 *
 * cordis 4 的 `ctx.events` 是所有子 ctx 共享的同一个实例，`internal/get` 派发时
 * 不带 context 过滤条件，因此在本插件 ctx 上注册的监听器同样会对 connection 插件
 * ctx 的查找生效。监听器由 root fiber 持有，须手工摘除。
 * @param {object} ctx 本插件的 ctx
 * @returns {() => void} 摘除函数
 */
export function installWebServerResolutionFallback(ctx) {
  const webServer = ctx?.webServer;
  if (webServer === undefined) return () => {};

  const listener = function (lookupCtx, prop, error, next) {
    if (prop !== 'webServer') return next();
    try {
      return next();
    } catch (thrown) {
      // 默认解析抛的不是本次守卫错误 → 原样上抛，绝不掩盖真实故障。
      if (thrown !== error) throw thrown;
    }
    return webServer;
  };

  const off = ctx.on?.('internal/get', listener, { global: true });
  return typeof off === 'function' ? off : () => {};
}

/**
 * 注册 Connection RPC 通道，并兼容上面的上游回归。
 * @param {object} ctx 本插件的 ctx
 * @param {string} channel 通道名（以 `/` 开头）
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} handler
 * @param {object} [logger]
 * @returns {() => void} 注销函数
 */
export function registerRpcChannel(ctx, channel, handler, logger) {
  const rpc = ctx?.connection?.rpc;
  if (typeof rpc?.handle !== 'function') {
    logger?.warn?.('dsh-remote: 宿主的 Connection RPC 不可用');
    return () => {};
  }

  try {
    // 正常路径：上游未受影响时直接注册。
    return rpc.handle(channel, handler);
  } catch (error) {
    if (!isMissingWebServerInjectError(error)) throw error;
    logger?.debug?.('dsh-remote: 命中 Connection RPC 的 webServer 注入回归，启用兼容路径');
  }

  const disposeFallback = installWebServerResolutionFallback(ctx);
  try {
    return rpc.handle(channel, handler);
  } finally {
    // cordis 的 effect 同步执行，注册完成后 owner.webServer 不再被访问。
    disposeFallback();
  }
}
