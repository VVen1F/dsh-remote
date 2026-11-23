// 复制链接里的一次性访问凭证
//
// 为什么需要它
// ---------------------------------------------------------------
// 面板给出的地址本身不带任何凭证，认证完全依赖网关在**每个请求**上现签 cookie。
// 这条路能用，但有两个现实问题：
//   1. 用户把链接发到另一台设备 / 另一个浏览器，落地的第一跳没有任何本机会话，
//      一旦网关注入失效，看到的就只有 DSH 那句 401；
//   2. 静态链接无法表达「是不是最新的」——地址变了、网卡切换了，旧链接照样能打开
//      但指向错误的入口。
//
// 因此复制出来的链接带一张签名票据：网关校验通过就放行并换取正常会话，同时重定向回
// 干净地址；票据过期或地址不匹配时给出可读提示，而不是让用户对着 401 发呆。
//
// 票据有效期与 DSH 浏览器会话一致（默认 30 天），不额外缩短。
//
// 票据用 DSH 自己的 browser-session 密钥签名：不引入新的密钥文件，密钥轮换后旧票据
// 自动失效，与 DSH 的信任根保持一致。

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 票据有效期：与 DSH 自己的浏览器会话一致。
 *
 * DSH 的 `cookieMaxAgeDays` 默认 30 天、最小 1 天（见 dsh-client-connection），
 * 复制出来的链接就按同一个默认值走——链接相当于会话的另一种载体，不应比会话本身
 * 更早失效，否则用户得反复回来复制。
 */
export const LINK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 查询参数名。用插件前缀，避免与 DSH 自己的 `token` 冲突。 */
export const LINK_TOKEN_PARAM = 'dsh-remote-auth';

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/**
 * 计算票据签名。
 * @param {string} secret DSH browser-session 密钥（base64url）
 * @param {string} body 票据正文（base64url）
 * @returns {string}
 */
function sign(secret, body) {
  return base64Url(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest());
}

/**
 * 为某个入口地址签发一张访问票据。
 * @param {string} address 局域网地址
 * @param {string} secret DSH browser-session 密钥
 * @param {number} [now]
 * @returns {string} `body.signature`；密钥缺失时返回空串
 */
export function issueLinkToken(address, secret, now = Date.now()) {
  if (!address || !secret) return '';
  const payload = base64Url(Buffer.from(JSON.stringify({
    a: address,
    e: now + LINK_TOKEN_TTL_MS,
  }), 'utf8'));
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * 校验票据。
 *
 * 同时校验「签名有效」「未过期」「地址与本次请求的入口一致」——最后一条防止把 A
 * 网卡的票据拿到 B 网卡上使用。
 * @param {string|null|undefined} token
 * @param {string} address 本次请求命中的入口地址
 * @param {string} secret
 * @param {number} [now]
 * @returns {{ok: true} | {ok: false, reason: 'missing'|'malformed'|'expired'|'mismatch'|'signature'}}
 */
export function verifyLinkToken(token, address, secret, now = Date.now()) {
  if (!token) return { ok: false, reason: 'missing' };
  if (!secret) return { ok: false, reason: 'signature' };

  const parts = String(token).split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts;

  const expected = sign(secret, body);
  // 长度不同时 timingSafeEqual 会抛错，先比长度。
  if (expected.length !== signature.length) return { ok: false, reason: 'signature' };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return { ok: false, reason: 'signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload?.a !== 'string' || typeof payload?.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.a !== address) return { ok: false, reason: 'mismatch' };
  if (payload.e <= now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * 把票据拼到地址上。
 * @param {string} url 形如 `http://192.168.0.102:3080`
 * @param {string} token
 * @returns {string}
 */
export function withLinkToken(url, token) {
  if (!url) return url;
  if (!token) return url;
  return `${url}/?${LINK_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}
