// 客户端共享常量（浏览器半边的副本）
//
// 与 lib/config.js 保持同一口径。客户端 bundle 不能 import Node 侧文件，因此这里是
// 一份显式副本；`scripts/check-port-usage.mjs` 会交叉校验两处端口一致。

const LAN_PORT = 3080;
const RPC_CHANNEL = '/dsh-remote';

const ENDPOINTS = {
  getStatus: 'getStatus',
  setLanIp: 'setLanIp',
  refresh: 'refresh',
};

module.exports = { LAN_PORT, RPC_CHANNEL, ENDPOINTS };
