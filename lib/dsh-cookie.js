// DSH 原生浏览器鉴权的兼容层（沿用 dsh-bridge 已验证的实现）
//
// 为什么需要它
// ---------------------------------------------------------------
// DSH 的浏览器会话 cookie 绑定 `127.0.0.1:<宿主端口>` 这个 authority。手机经
// 局域网地址（`192.168.x.x:3080`）访问时，浏览器带的是另一个 origin 的 cookie，
// 网关转发时必须自己注入一枚合法的回环会话 cookie，否则上游一律 401。
//
// 这里只做「按 DSH 的格式生成一枚回环 cookie」，不引入任何三方依赖；签名密钥直接
// 从宿主凭据服务的 `client-connection/browser-session` 记录里读，因此宿主轮换密钥
// 后网关下一次请求即自动跟上。

import { createHash, createHmac } from 'node:crypto';

/** DSH 会话 cookie 的名称前缀（与 dsh-client-connection 的 COOKIE_PREFIX 一致）。 */
export const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-';

/** cookie 载荷版本（与 dsh-client-connection 的 COOKIE_PAYLOAD_VERSION 一致）。 */
export const DSH_AUTH_COOKIE_VERSION = 1;

/** 承载签名密钥的凭据记录键。 */
export const DSH_BROWSER_SESSION_RECORD = 'client-connection/browser-session';

/**
 * 注入 cookie 的有效期。网关是**每个请求现签**一枚 cookie，它只在这一次转发里
 * 被宿主校验。宿主会拒绝 `expiresAt - issuedAt > cookieMaxAgeDays`（默认 30 天，
 * 可配置，最小 1 天），写死 30 天会在宿主调小配置时全面 401，因此取 1 小时。
 */
export const DSH_AUTH_COOKIE_INJECTION_MAX_AGE_MS = 60 * 60 * 1000;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * 计算 DSH 会话 cookie 的候选名称。
 *
 * 官方口径是 `dsh-auth-` + base64url(sha256("host:port"))；个别发行版把名字派生
 * 改成忽略端口。同时注入两个名字、共用同一个载荷（authority 始终带端口），官方
 * 宿主只按自己的名字取值，互不影响。
 * @param {number|string} targetPort DSH 回环端口
 * @param {string} [host]
 * @returns {string[]}
 */
export function dshAuthCookieNames(targetPort, host = '127.0.0.1') {
  return [...new Set([
    DSH_AUTH_COOKIE_PREFIX + base64Url(createHash('sha256').update(`${host}:${targetPort}`).digest()),
    DSH_AUTH_COOKIE_PREFIX + base64Url(createHash('sha256').update(String(host)).digest()),
  ])];
}

/**
 * 从 YAML 形式的凭据文件文本里取出 browser-session 记录的签名密钥。
 * @param {string} content 凭据文件文本
 * @returns {string} base64url 编码的密钥；取不到时返回空串
 */
export function readBrowserSessionSecretFromText(content) {
  if (typeof content !== 'string' || content === '') return '';
  const anchorMatch = /^[ \t]*client-connection\/browser-session:[ \t]*$/m.exec(content);
  if (anchorMatch) {
    const scoped = /secret:[ \t]*([A-Za-z0-9_-]+)/.exec(content.slice(anchorMatch.index));
    if (scoped) return scoped[1];
  }
  const fallback = /secret:[ \t]*([A-Za-z0-9_-]+)/.exec(content);
  return fallback ? fallback[1] : '';
}

/**
 * 从凭据记录载荷里取出签名密钥（`{ version: 1, secret: '...' }`）。
 * @param {unknown} record `ctx.credentials.readRecord()` 的返回值
 * @returns {string}
 */
export function readBrowserSessionSecretFromRecord(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return '';
  const secret = payload.secret;
  return typeof secret === 'string' ? secret : '';
}

/**
 * 生成绑定到回环 authority 的 DSH 原生会话 cookie（同一载荷、全部候选名称）。
 * @param {{targetPort: number|string, secret: string, host?: string, now?: number, maxAgeMs?: number}} options
 * @returns {string[]} 形如 `name=value` 的候选 cookie；密钥缺失时返回空数组
 */
export function buildDshLoopbackCookies({
  targetPort,
  secret,
  host = '127.0.0.1',
  now = Date.now(),
  maxAgeMs = DSH_AUTH_COOKIE_INJECTION_MAX_AGE_MS,
}) {
  if (!secret || !targetPort) return [];

  const authority = `${host}:${targetPort}`;
  // 与 DSH 一致：issuedAt 略微回拨，避免与宿主的同秒比较产生边界问题。
  const issuedAt = now - 1000;
  const expiresAt = issuedAt + maxAgeMs;

  const body = base64Url(Buffer.from(JSON.stringify({
    version: DSH_AUTH_COOKIE_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'));
  const sig = base64Url(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest());
  const value = `v${DSH_AUTH_COOKIE_VERSION}.${body}.${sig}`;
  return dshAuthCookieNames(targetPort, host).map((name) => `${name}=${value}`);
}

/**
 * 从 Cookie 请求头里剔除指定名称的键值（保留其余 cookie）。
 * @param {string} header 原始 Cookie 头
 * @param {string[]} names 要剔除的名称
 * @returns {string}
 */
export function stripCookiesByName(header, names) {
  if (!header) return '';
  const drop = new Set(names);
  return String(header)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .filter((part) => {
      const at = part.indexOf('=');
      return at < 0 || !drop.has(part.slice(0, at).trim());
    })
    .join('; ');
}
