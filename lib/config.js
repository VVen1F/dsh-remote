// dsh-remote 共享常量（Host 与浏览器端共用，禁止依赖任何 Node 内置模块）
//
// 端口口径（唯一来源）
// ---------------------------------------------------------------
// 本插件对外只承认一个局域网端口：DSH 自己的 3080。这里给出常量与判定函数，
// 其它文件一律从这里取，不允许各自写死数字——`scripts/check-port-usage.mjs`
// 会扫描整个仓库，出现旧端口或第二个库内端口字面量即失败。

/** 局域网访问端口：DSH 默认端口。 */
export const LAN_PORT = 3080;

/** Connection RPC 通道（必须以 `/` 开头，且只含 A-Za-z0-9._~-）。 */
export const RPC_CHANNEL = '/dsh-remote';

/** 面板用到的 RPC 端点。只保留局域网功能真正需要的方法。 */
export const ENDPOINTS = {
  /** 读取当前状态：监听信息、网卡列表、访问地址、二维码。 */
  getStatus: 'getStatus',
  /** 手动指定用于生成地址的网卡 IP（传空串表示回到自动推荐）。 */
  setLanIp: 'setLanIp',
  /** 重新检测一次（网卡热插拔、端口被占用后重试）。 */
  refresh: 'refresh',
};

/** 网关失败时的可读原因代码（面板据此给出不同的修复建议）。 */
export const GATEWAY_ERRORS = {
  /** 3080 被别的进程占用。 */
  portInUse: 'port-in-use',
  /** 本机没有任何可用的局域网网卡。 */
  noInterface: 'no-interface',
  /** DSH 自身以回环方式占着 3080，网关无法再绑同一个端口。 */
  dshOwnsPort: 'dsh-owns-port',
  /** 其它监听失败（权限、地址不可用等）。 */
  listenFailed: 'listen-failed',
  /**
   * 网关在听，但上游 DSH 拒绝了这个地址的会话（cookie 注入无效）。
   * 端口上明明有人，用户却只看到 401 —— 必须如实报出来，不能显示「可以访问」。
   */
  authFailed: 'auth-failed',
};
