// 局域网网卡探测
//
// 保留原项目 dsh-bridge 的成熟实现（评分排序 + 虚拟网卡识别），仅做两点收敛：
//   1. 去掉与「隧道 / 机器人」相关的字段，只留下生成局域网地址需要的信息；
//   2. 明确区分「可被手机访问的物理网卡」与「虚拟 / 点对点网卡」，供面板解释。

import { networkInterfaces } from 'node:os';

/**
 * 虚拟网卡 / 点对点网卡名称特征。命中即大幅降权：它们通常不能被同 Wi-Fi 的
 * 手机直接访问（WSL、容器、VPN 隧道），但用户仍可能主动选择（例如 Tailscale）。
 */
const VIRTUAL_KEYWORDS = [
  'vethernet', 'wsl', 'hyper-v', 'virtual', 'vmware', 'vbox', 'docker',
  'tailscale', 'zerotier', 'tap', 'tun', 'utun', 'wireguard', 'loopback', 'bridge',
];

/** 名称特征 → 中文网卡类型标签。 */
function describeInterface(name, isVirtual) {
  const lower = name.toLowerCase();
  if (isVirtual) return '虚拟网卡 / 隧道';
  if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) return 'Wi-Fi';
  if (lower.includes('ethernet') || lower.includes('以太网') || lower.startsWith('eth') || lower.startsWith('en')) {
    return '有线网卡';
  }
  return '网卡';
}

/** 私有网段加分：家庭 / 办公局域网最常用的地址段排在前面。 */
function addressScore(address) {
  if (address.startsWith('192.168.')) return 100;
  if (address.startsWith('10.')) return 90;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address)) return 70;
  // 100.64/10 是运营商级 NAT，也是 Tailscale 的默认段：可用但优先级最低。
  return 10;
}

/**
 * 列出全部可用 IPv4 网卡，按「手机最可能访问到」的顺序排序。
 * @returns {Array<{name: string, label: string, address: string, netmask: string, isVirtual: boolean, score: number}>}
 */
export function listLanInterfaces() {
  const interfaces = networkInterfaces();
  const list = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue;
    const lower = name.toLowerCase();
    const isVirtual = VIRTUAL_KEYWORDS.some((keyword) => lower.includes(keyword));

    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;

      let score = addressScore(address.address);
      if (isVirtual) {
        score -= 200;
      } else {
        score += 100;
        if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) score += 50;
        else if (lower.includes('ethernet') || lower.includes('以太网') || lower.startsWith('eth') || lower.startsWith('en')) {
          score += 40;
        }
      }

      list.push({
        name,
        label: describeInterface(name, isVirtual),
        address: address.address,
        netmask: address.netmask,
        isVirtual,
        score,
      });
    }
  }

  return list.sort((left, right) => right.score - left.score);
}

/**
 * 挑选默认使用的地址：排序后的第一个。
 * @param {Array<ReturnType<typeof listLanInterfaces>[number]>} [interfaces] 已探测的网卡列表
 * @returns {string|null}
 */
export function selectLanAddress(interfaces = listLanInterfaces()) {
  return interfaces[0]?.address ?? null;
}

/**
 * 解析最终生效的地址：用户选中的地址仍然存在就用它，否则回落到自动推荐。
 * @param {string|null|undefined} selected 持久化的用户选择
 * @param {Array<ReturnType<typeof listLanInterfaces>[number]>} [interfaces] 已探测的网卡列表
 * @returns {{address: string|null, selected: string, interfaces: Array<object>}}
 */
export function resolveLanAddress(selected, interfaces = listLanInterfaces()) {
  const picked = typeof selected === 'string' ? selected.trim() : '';
  const stillPresent = picked !== '' && interfaces.some((item) => item.address === picked);
  return {
    address: stillPresent ? picked : selectLanAddress(interfaces),
    selected: stillPresent ? picked : '',
    interfaces,
  };
}

/**
 * 判断某个监听地址是否已经能被局域网访问。
 * 回环地址之外的裸 IPv4 都算（DSH 的 Web 服务只接受具体地址，不接受通配）。
 * @param {string} host
 * @returns {boolean}
 */
export function isNetworkReachableHost(host) {
  const value = String(host ?? '').trim();
  if (value === '') return false;
  return !(value === '::1' || value.startsWith('127.') || value === 'localhost');
}
