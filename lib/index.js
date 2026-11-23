// dsh-remote：DeepSeek Harness 局域网远程连接插件（Host 半边）
//
// 插件只做一件事：把当前设备在局域网里的访问地址（含二维码）交给用户，让手机
// 直接打开电脑上正在运行的 DSH。
//
// 端口口径：局域网入口固定为 DSH 的默认端口 3080（见 lib/config.js）。网关监听
// 的是**局域网地址**上的 3080，再反向代理到本机 DSH 实际监听的端口；因此不会与
// 本机回环上的 DSH 抢同一个 socket，也不会把 DSH 主程序端口改掉。

import { RemoteService } from './service.js';
import { readPreferences, writePreferences } from './preferences.js';
import { installRpc } from './rpc.js';
import { LAN_PORT } from './config.js';
import { isNetworkReachableHost } from './lan.js';

export const name = 'dsh-remote';

/**
 * 从配置里取出当前选中的网卡地址。兼容 volatile 引用与普通字符串两种形态。
 * @param {unknown} config
 * @returns {string}
 */
function selectedIpOf(config) {
  const lan = config?.lan;
  if (!lan) return '';
  const value = lan.selectedIp;
  if (typeof value === 'string') return value;
  if (value && typeof value.get === 'function') {
    const current = value.get();
    return typeof current === 'string' ? current : '';
  }
  return '';
}

/**
 * 依赖：Web 服务（读 DSH 的监听端口/地址）与 Connection（注册面板 RPC）。
 * 凭据服务是可选依赖，通过 `ctx.get('credentials')` 读取，不写进 inject。
 */
export const inject = ['webServer', 'connection'];

export function apply(ctx, config = {}) {
  const logger = ctx.logger(name);

  /**
   * 网卡选择持久化到插件自己的小配置文件。
   *
   * 刻意不用宿主的配置编辑器：写插件配置会重建插件，新实例绑 3080 时旧实例还没放开
   * 监听，会得到假的「端口被占用」。写自己的文件不触碰插件生命周期，监听原地迁移。
   */
  const persist = async (patch) => {
    try {
      await writePreferences({ lan: { selectedIp: patch?.lan?.selectedIp ?? '' } });
    } catch (error) {
      logger?.warn?.('dsh-remote: 保存网卡选择失败：%s', error?.message ?? error);
    }
  };

  // 启动时的选择：preferences 文件优先，其次插件配置里的显式值。
  const service = new RemoteService({
    ctx,
    logger,
    persist,
    selectedIp: selectedIpOf(config),
  });

  const disposeRpc = installRpc(ctx, service, logger);

  // 先读完偏好，再开启网关：两个 Promise 并行跑会让网关先按「自动推荐」绑定，
  // 等偏好读回来时地址已经绑错了（重启后不记住用户选择）。这里显式串行。
  void readPreferences()
    .then((stored) => {
      const saved = stored?.lan?.selectedIp ?? '';
      if (saved) service.selectedIp = saved;
    })
    .catch(() => {})
    .then(() => service.ensureGateway())
    .then(() => {
      const status = service.lastError;
      if (status) logger.warn('dsh-remote: %s', status.message);
    })
    .catch((error) => {
      logger.error('dsh-remote: 开启局域网访问失败：%s', error?.stack ?? error);
    });

  // DSH 若自己已经监听在局域网地址上（`dsh web --host <局域网 IP>`），
  // 网关仍会启动：同端口不同地址，两者互不冲突，网关负责把回环口径与 cookie
  // 处理好，行为更一致。这里只记一条信息，便于排查。
  if (isNetworkReachableHost(ctx.webServer?.host)) {
    logger.info('dsh-remote: DSH 已监听在局域网地址 %s，网关将在同一端口上处理其它地址', ctx.webServer?.host);
  }

  if (ctx.webServer?.port !== LAN_PORT) {
    logger.info('dsh-remote: 局域网入口使用端口 %d（DSH 自身监听 %d）', LAN_PORT, ctx.webServer?.port);
  }

  ctx.effect(() => async () => {
    try { disposeRpc(); } catch { /* 通道可能已随插件树卸载 */ }
    await service.dispose();
  }, 'dsh-remote: stop LAN gateway and RPC channel');

  // 供宿主的运行时探针读取（只读），便于确认插件真的挂上了。
  return { service };
}
