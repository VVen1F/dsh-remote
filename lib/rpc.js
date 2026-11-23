// RPC 通道：面板与 Host 之间的唯一接口。
//
// 只暴露三个方法，全部围绕「拿到一个能用的局域网地址」这一件事；没有管理员
// 解锁、没有密码、没有隧道开关、没有机器人管理。

import { RPC_CHANNEL, ENDPOINTS } from './config.js';
import { registerRpcChannel } from './connection-compat.js';

/**
 * 统一的成功响应。
 * @param {unknown} value
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 统一的失败响应。错误码收敛为固定集合，避免把内部异常结构泄露给浏览器。
 * @param {string} message
 * @param {{code?: string, details?: object}} [options]
 */
function fail(message, { code = 'bad-request', details = {} } = {}) {
  const allowed = new Set(['bad-request', 'cancelled', 'internal']);
  return {
    ok: false,
    error: {
      code: allowed.has(code) ? code : 'bad-request',
      message,
      details: { issues: [{ message }], ...details },
    },
  };
}

/**
 * 把 RPC 通道注册到宿主 Connection 服务上。
 *
 * 通道本身要求已认证的浏览器（Connection 的默认策略），因此局域网上的手机
 * 必须先通过 DSH 自己的登录页完成认证，插件不额外造一套认证。
 * @param {object} ctx Cordis 上下文
 * @param {object} service RemoteService 实例
 * @param {object} [logger]
 * @returns {() => void} 注销函数
 */
export function installRpc(ctx, service, logger) {
  return registerRpcChannel(ctx, RPC_CHANNEL, async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('请求已取消', { code: 'cancelled' });
    try {
      if (endpoint === ENDPOINTS.getStatus) return ok(await service.getStatus());
      if (endpoint === ENDPOINTS.setLanIp) return ok(await service.setLanIp(payload ?? {}));
      if (endpoint === ENDPOINTS.refresh) return ok(await service.refresh());
      return fail(`未知的接口：${endpoint}`);
    } catch (error) {
      logger?.error?.('dsh-remote: RPC %s 失败：%s', endpoint, error?.stack ?? error);
      return fail(error?.message ?? '操作失败', { code: 'internal' });
    }
  }, logger);
}

export { RPC_CHANNEL, ENDPOINTS };
