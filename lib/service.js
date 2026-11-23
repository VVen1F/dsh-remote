// dsh-remote 的 Host 服务：局域网访问的唯一状态源。
//
// 状态模型（这是本插件最核心的设计）
// ---------------------------------------------------------------
// 不要用「网关是否成功绑定」当唯一真相。3080 上本来就可能已经有东西在服务：
// 用户自己跑的 `dsh web`、另一个 DSH 实例、甚至本插件上一次留下的监听。
// 把这种情形一律报成「端口被占用」是错的——对用户来说那是一个**能直接用的入口**。
//
// 因此状态以「入口（entry）」为单位，每个局域网地址都是一个候选：
//   · ready       —— 该地址的 3080 上已经有 DSH 在服务（无论谁起的），可直接访问
//   · gateway     —— 该地址由本插件网关接管并转发到本机 DSH
//   · blocked     —— 该地址的 3080 被非 DSH 程序占用，无法使用
//   · unavailable —— 该地址不可用（网卡断开等）
// 面板按「ready 优先、其次 gateway」排序，自动推荐第一个可用入口。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { request as httpRequest } from 'node:http';

import { LAN_PORT, GATEWAY_ERRORS } from './config.js';
import { LanGateway } from './gateway.js';
import { QrCache } from './qr.js';
import { listLanInterfaces, resolveLanAddress, isNetworkReachableHost } from './lan.js';
import {
  buildDshLoopbackCookies,
  readBrowserSessionSecretFromRecord,
  readBrowserSessionSecretFromText,
  DSH_BROWSER_SESSION_RECORD,
} from './dsh-cookie.js';

const PACKAGE_JSON = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version ?? '0.0.0';

/** 入口状态。 */
const ENTRY_STATE = {
  ready: 'ready',
  gateway: 'gateway',
  blocked: 'blocked',
  unavailable: 'unavailable',
};

/** 探测缓存有效期：太短会让每 4s 的轮询都去打一遍网络，太长会看不到刚起来的服务。 */
const PROBE_TTL_MS = 5000;
/** 单次探测超时。局域网内这个值足够，卡住的连接也不会拖慢面板。 */
const PROBE_TIMEOUT_MS = 1200;

/**
 * 探测某个地址的 3080 端口上是否已经有 DSH 在服务。
 *
 * 判定依据是 DSH 自己的页面特征（`__DSH_BOOT__` 注入、登录页文案、标题），
 * 而不是「端口通了就算」——端口可能被别的程序占着，那种情况对用户没有价值。
 * @param {string} address
 * @param {number} [port]
 * @returns {Promise<{listening: boolean, isDsh: boolean, status?: number}>}
 */
function probeDshOnAddress(address, port = LAN_PORT) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = httpRequest({
      host: address,
      port,
      path: '/',
      method: 'GET',
      agent: false,
      timeout: PROBE_TIMEOUT_MS,
      headers: { accept: 'text/html', connection: 'close' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        // 只需要判定特征，读到一定长度就够，避免把整页拉下来。
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on('end', () => {
        const isDsh = body.includes('__DSH_BOOT__')
          || body.includes('DeepSeek Harness')
          || /dsh web authentication required/i.test(body);
        finish({ listening: true, isDsh, status: response.statusCode });
      });
      response.on('error', () => finish({ listening: true, isDsh: false }));
    });

    request.on('timeout', () => {
      request.destroy();
      finish({ listening: true, isDsh: false });
    });
    request.on('error', (error) => {
      // ECONNREFUSED = 没人在听；其它错误按「占用但不可用」处理。
      const code = error?.code;
      finish({ listening: code !== 'ECONNREFUSED', isDsh: false });
    });
    request.end();
  });
}

/**
 * 局域网访问服务。
 *
 * 状态只有一份：`getStatus()` 每次现算并探测，面板不做本地推导，因此「展示的入口」
 * 与「实际可访问的入口」不会脱节。
 */
export class RemoteService {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis 上下文（用来取 webServer / credentials）
   * @param {object} options.logger
   * @param {(patch: {lan?: {selectedIp?: string}}) => Promise<unknown>} [options.persist] 持久化回调
   * @param {string|null} [options.selectedIp] 已保存的网卡选择
   */
  constructor({ ctx, logger, persist, selectedIp }) {
    this.ctx = ctx;
    this.logger = logger;
    this.persist = persist ?? null;
    this.selectedIp = typeof selectedIp === 'string' ? selectedIp : '';
    this.qrCache = new QrCache();
    this.gateway = null;
    /** @type {{code: string, message: string, address: string}|null} */
    this.lastError = null;
    /** 上一次启动时使用的「地址 + 端口」，用于判断是否需要重建网关。 */
    this.boundKey = null;
    this.startPromise = null;
    this.sessionCookies = [];
    /** 探测缓存：address -> {at, result} */
    this.probeCache = new Map();
  }

  // ---- DSH 宿主信息 -------------------------------------------------------

  /** DSH 的监听端口；宿主尚未提供时回落到 3080。 */
  get dshPort() {
    const port = this.ctx?.webServer?.port;
    return Number.isInteger(port) && port > 0 ? port : LAN_PORT;
  }

  /** DSH 的监听地址（`127.0.0.1`、具体网卡地址或 `::1`）。 */
  get dshHost() {
    return this.ctx?.webServer?.host ?? '127.0.0.1';
  }

  // ---- 回环会话 cookie ----------------------------------------------------

  /**
   * 读取 DSH 的 browser-session 签名密钥。
   *
   * 优先走宿主凭据服务（宿主轮换密钥后立即生效）；凭据服务不可用时退回读取
   * `$DSH_HOME/.credentials.yaml`，保证老部署也能用。
   * @returns {Promise<string>}
   */
  async resolveSessionSecret() {
    const credentials = this.ctx?.get?.('credentials');
    if (credentials?.readRecord) {
      try {
        const record = await credentials.readRecord(DSH_BROWSER_SESSION_RECORD);
        const secret = readBrowserSessionSecretFromRecord(record);
        if (secret) return secret;
      } catch (error) {
        this.logger?.debug?.('dsh-remote: 读取 browser-session 凭据记录失败：%s', error?.message ?? error);
      }
    }

    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    for (const file of [join(home, '.credentials.yaml'), join(home, 'credentials.yaml')]) {
      try {
        const secret = readBrowserSessionSecretFromText(readFileSync(file, 'utf8'));
        if (secret) return secret;
      } catch { /* 文件不存在或不可读：继续尝试下一个位置 */ }
    }
    return '';
  }

  // ---- 探测 ---------------------------------------------------------------

  /**
   * 带缓存地探测某个地址。
   * @param {string} address
   * @param {boolean} [fresh] 跳过缓存
   * @returns {Promise<{listening: boolean, isDsh: boolean}>}
   */
  async #probe(address, fresh = false) {
    const cached = this.probeCache.get(address);
    const now = Date.now();
    if (!fresh && cached && now - cached.at < PROBE_TTL_MS) return cached.result;
    const result = await probeDshOnAddress(address);
    this.probeCache.set(address, { at: now, result });
    return result;
  }

  // ---- 生命周期 -----------------------------------------------------------

  /**
   * 确保网关按当前网卡/端口运行。
   *
   * 串行化：所有重建都排在同一条队列上。否则「切换网卡」与「重新检测」并发时会出现
   * 两个网关各自先 stop 再 start，后手的 stop 关掉的是先手的旧实例，先手的 start
   * 却已抢到端口——于是新实例报 EADDRINUSE，而端口上实际有监听，状态自相矛盾。
   * @param {{force?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async ensureGateway({ force = false } = {}) {
    const run = async () => this.#startOnce({ force });
    const chained = (this.startPromise ?? Promise.resolve()).catch(() => {}).then(run);
    this.startPromise = chained;
    try {
      await chained;
    } finally {
      if (this.startPromise === chained) this.startPromise = null;
    }
  }

  /**
   * 按当前选择建立入口。
   *
   * 候选顺序：用户选中的地址优先，其后按网卡评分依次尝试。任一候选要么「已有 DSH
   * 可直接复用」，要么由本插件网关接管；只有全部候选都失败才记录错误。这样即使
   * 保存的选择过期（网卡被拔掉、地址变成虚拟网卡），也不会把整个功能卡死。
   * @param {{force: boolean}} options
   */
  async #startOnce({ force }) {
    const interfaces = listLanInterfaces();
    const resolved = resolveLanAddress(this.selectedIp, interfaces);

    if (!resolved.address) {
      await this.#stopGateway();
      this.lastError = {
        code: GATEWAY_ERRORS.noInterface,
        address: '',
        message: '没有检测到可用的局域网网卡，请确认已连接 Wi-Fi 或网线',
      };
      return;
    }

    const secret = await this.resolveSessionSecret();
    this.sessionCookies = secret ? buildDshLoopbackCookies({ targetPort: this.dshPort, secret }) : [];
    if (!secret) {
      this.logger?.warn?.('dsh-remote: 未取到 DSH 的 browser-session 密钥，局域网访问会返回 401');
    }

    // 候选地址：选中的排最前，其余按评分顺序跟后。
    const candidates = [resolved.address, ...interfaces
      .map((item) => item.address)
      .filter((address) => address !== resolved.address)];

    if (!force && this.gateway?.running && this.boundKey === `${candidates[0]}:${LAN_PORT}->${this.dshPort}`) return;

    // 必须先停掉自己的旧网关再探测：否则探到的正是「自己上一轮起的网关」，会被
    // 误判成「外部已有 DSH」，于是网关再也不重建，网卡切换就失效。
    await this.#stopGateway();
    for (const address of candidates) this.probeCache.delete(address);

    let lastFailure = null;
    for (const address of candidates) {
      const served = await this.#tryCandidate(address);
      if (served.ok) {
        this.lastError = null;
        return;
      }
      lastFailure = served;
    }

    this.lastError = {
      code: lastFailure?.code ?? GATEWAY_ERRORS.listenFailed,
      address: lastFailure?.address ?? resolved.address,
      message: lastFailure?.message ?? '无法开启局域网访问',
    };
    this.logger?.warn?.('dsh-remote: %s', this.lastError.message);
  }

  /**
   * 在单个地址上建立入口：已有 DSH 就复用，否则由网关接管。
   * @param {string} address
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string, address: string}>}
   */
  async #tryCandidate(address) {
    const probe = await this.#probe(address, true);
    if (probe.listening && probe.isDsh) {
      this.logger?.info?.('dsh-remote: %s:%d 上已有 DSH 在服务，直接作为访问入口', address, LAN_PORT);
      return { ok: true };
    }
    if (probe.listening) {
      return {
        ok: false,
        code: GATEWAY_ERRORS.portInUse,
        address,
        message: `${address}:${LAN_PORT} 已被其它程序占用，局域网访问暂时无法开启`,
      };
    }

    const gateway = new LanGateway({
      targetPort: this.dshPort,
      bindHost: address,
      port: LAN_PORT,
      cookieProvider: () => this.sessionCookies,
      onWarn: (message) => this.logger?.warn?.(`dsh-remote: ${message}`),
    });

    let result = await gateway.start();
    // 端口刚释放时内核可能仍处于 TIME_WAIT：短暂重试一次再判定失败。
    if (!result.ok && result.code === GATEWAY_ERRORS.portInUse) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      result = await gateway.start();
    }

    if (!result.ok) {
      return { ok: false, code: result.code, address, message: result.message };
    }

    this.gateway = gateway;
    this.boundKey = `${address}:${LAN_PORT}->${this.dshPort}`;
    this.probeCache.delete(address);
    this.logger?.info?.('dsh-remote: 局域网访问已开启 %s:%d -> 127.0.0.1:%d', address, LAN_PORT, this.dshPort);
    return { ok: true };
  }

  async #stopGateway() {
    if (!this.gateway) {
      this.boundKey = null;
      return;
    }
    const gateway = this.gateway;
    this.gateway = null;
    this.boundKey = null;
    await gateway.stop();
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ---- 对外状态 -----------------------------------------------------------

  /**
   * 为每个局域网地址解析出一个「访问入口」。
   * @param {Array<object>} interfaces
   * @param {boolean} fresh 是否跳过探测缓存
   * @returns {Promise<Array<object>>}
   */
  async #collectEntries(interfaces, fresh = false) {
    const entries = [];
    for (const iface of interfaces) {
      const url = `http://${iface.address}:${LAN_PORT}`;
      const probe = await this.#probe(iface.address, fresh);

      let state;
      let source;
      let error = null;
      // 自己网关占着的地址必须先判定：它同样会返回 DSH 页面，若先看探测结果就会被
      // 误标成「已有 DSH」，用户看到的原因与实际不符。
      const isOurGateway = Boolean(this.gateway?.running) && this.boundKey?.startsWith(`${iface.address}:`);
      if (isOurGateway) {
        state = ENTRY_STATE.gateway;
        source = 'gateway';
      } else if (probe.listening && probe.isDsh) {
        // 已经有 DSH 在服务：现成入口，优先级最高。
        state = ENTRY_STATE.ready;
        source = 'existing';
      } else if (probe.listening) {
        // 端口有人在听但不是 DSH：这个地址用不了。
        state = ENTRY_STATE.blocked;
        source = null;
        error = GATEWAY_ERRORS.portInUse;
      } else if (this.lastError && this.lastError.address === iface.address) {
        state = ENTRY_STATE.blocked;
        source = null;
        error = this.lastError.code;
      } else {
        state = ENTRY_STATE.unavailable;
        source = null;
      }

      entries.push({
        address: iface.address,
        name: iface.name,
        label: iface.label,
        isVirtual: iface.isVirtual,
        state,
        source,
        url: state === ENTRY_STATE.ready || state === ENTRY_STATE.gateway ? url : null,
        qr: state === ENTRY_STATE.ready || state === ENTRY_STATE.gateway
          ? await this.qrCache.render(url)
          : null,
        error,
      });
    }

    // 排序：可用入口在前，不可用在后；同类按网卡评分顺序（局域网网卡排在虚拟网卡前）。
    // ready 与 gateway 同为「可用」，不互相压过——否则虚拟网卡的现成入口会顶掉有线网卡。
    const rank = { [ENTRY_STATE.ready]: 0, [ENTRY_STATE.gateway]: 0, [ENTRY_STATE.blocked]: 1, [ENTRY_STATE.unavailable]: 2 };
    entries.sort((left, right) => {
      const byRank = rank[left.state] - rank[right.state];
      if (byRank !== 0) return byRank;
      return interfaces.findIndex((item) => item.address === left.address)
        - interfaces.findIndex((item) => item.address === right.address);
    });
    return entries;
  }

  /**
   * 生成面板需要的全部状态。
   * @param {{fresh?: boolean}} [options]
   * @returns {Promise<object>}
   */
  async getStatus({ fresh = false } = {}) {
    const interfaces = listLanInterfaces();
    const resolved = resolveLanAddress(this.selectedIp, interfaces);
    const entries = await this.#collectEntries(interfaces, fresh);

    // 主入口：用户选中的地址如果有入口就用它，否则用排序后的第一个可用入口。
    const usable = entries.filter((entry) => entry.url !== null);
    const preferred = resolved.selected
      ? usable.find((entry) => entry.address === resolved.selected)
      : undefined;
    const primary = preferred ?? usable[0] ?? null;

    // 只要存在任一可用入口，就算「可用」；lastError 仅在没有入口时展示。
    const anyUsable = usable.length > 0;

    return {
      version: VERSION,
      port: LAN_PORT,
      available: anyUsable,
      primary,
      entries,
      selectedIp: resolved.selected,
      interfaces: interfaces.map((iface) => ({
        address: iface.address,
        name: iface.name,
        label: iface.label,
        isVirtual: iface.isVirtual,
      })),
      dsh: {
        port: this.dshPort,
        host: this.dshHost,
        onLan: isNetworkReachableHost(this.dshHost),
      },
      error: anyUsable ? null : this.lastError,
    };
  }

  /**
   * 切换用于生成访问地址的网卡。
   * @param {{ip?: string}} [payload] 传空串表示回到自动推荐
   * @returns {Promise<object>}
   */
  async setLanIp({ ip } = {}) {
    const next = typeof ip === 'string' ? ip.trim() : '';
    this.selectedIp = next;
    await this.persist?.({ lan: { selectedIp: next } });
    await this.ensureGateway({ force: true });
    return this.getStatus({ fresh: true });
  }

  /** 重新探测并重建网关（网卡热插拔、端口冲突解除后使用）。 */
  async refresh() {
    this.qrCache.clear();
    this.probeCache.clear();
    await this.ensureGateway({ force: true });
    return this.getStatus({ fresh: true });
  }

  /** 释放网关。插件卸载时调用。 */
  async dispose() {
    this.qrCache.clear();
    this.probeCache.clear();
    this.sessionCookies = [];
    await this.#stopGateway();
  }
}

export { ENTRY_STATE };
