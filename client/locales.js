// 客户端文案（跟随 DSH 主体语言）
//
// 通过 `ctx.locale.register(namespace, { zh, en })` 注册到宿主语言服务，语言切换后
// 立即生效；不自己实现语言开关，也不读 navigator.language。
//
// 文案原则：只保留功能信息。状态、地址、端口、网络都能由界面自身表达，
// 不再额外写「让同一局域网内的手机打开…」这类解释性文字。

const LOCALE_NAMESPACE = '@wenbin_wb/dsh-remote';

const zh = {
  'section.title': '局域网访问',
  'section.intro': '手机扫码即可打开本机 DSH',

  'status.available': '可以访问',
  'status.unavailable': '暂不可用',

  'tag.existing': '已有 DSH',
  'tag.gateway': '插件网关',

  'address.copy': '复制链接',
  'address.copied': '已复制',
  'address.open': '打开',

  'qr.alt': '局域网访问二维码',

  'field.network': '网络',
  'field.port': '端口',

  'network.auto': '自动推荐',
  'network.unusable': '不可用',

  'action.refresh': '重新检测',

  'error.portInUse': '端口 ${port} 已被其它程序占用。关闭占用它的程序后重新检测。',
  'error.noInterface': '没有检测到可用的局域网网卡，请先连接 Wi-Fi 或网线。',
  'error.listenFailed': '无法在该地址上监听，请换一个网卡后重试。',
  'error.load': '读取状态失败：${message}',
  'error.network': '与 DSH 的连接已断开，稍后会自动重试。',
  'error.actionFailed': '操作失败：${message}',
};

const en = {
  'section.title': 'LAN access',
  'section.intro': 'Scan to open the DSH on this computer',

  'status.available': 'Reachable',
  'status.unavailable': 'Unavailable',

  'tag.existing': 'DSH already here',
  'tag.gateway': 'Gateway',

  'address.copy': 'Copy link',
  'address.copied': 'Copied',
  'address.open': 'Open',

  'qr.alt': 'LAN access QR code',

  'field.network': 'Network',
  'field.port': 'Port',

  'network.auto': 'Automatic',
  'network.unusable': 'unavailable',

  'action.refresh': 'Check again',

  'error.portInUse': 'Port ${port} is used by another program. Close it, then check again.',
  'error.noInterface': 'No LAN interface was found. Connect Wi-Fi or an Ethernet cable first.',
  'error.listenFailed': 'Listening on that address failed. Pick another interface and retry.',
  'error.load': 'Could not read the status: ${message}',
  'error.network': 'The connection to DSH dropped; retrying automatically.',
  'error.actionFailed': 'Action failed: ${message}',
};

module.exports = { LOCALE_NAMESPACE, zh, en };
