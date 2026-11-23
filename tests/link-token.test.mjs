// 票据的签发/校验语义
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueLinkToken, verifyLinkToken, withLinkToken, LINK_TOKEN_TTL_MS, LINK_TOKEN_PARAM } from '../lib/link-token.js';

const SECRET = Buffer.alloc(32, 3).toString('base64url');
const ADDRESS = '192.168.0.102';

test('有效票据通过校验', () => {
  const token = issueLinkToken(ADDRESS, SECRET);
  assert.equal(verifyLinkToken(token, ADDRESS, SECRET).ok, true);
});

test('过期票据被拒绝且原因明确', () => {
  const token = issueLinkToken(ADDRESS, SECRET, Date.now() - LINK_TOKEN_TTL_MS - 1);
  const v = verifyLinkToken(token, ADDRESS, SECRET);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'expired');
});

test('换一个地址使用同一张票据被拒绝', () => {
  const token = issueLinkToken(ADDRESS, SECRET);
  const v = verifyLinkToken(token, '100.64.0.100', SECRET);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'mismatch');
});

test('换一个密钥签不动别人的票据', () => {
  const token = issueLinkToken(ADDRESS, SECRET);
  const other = Buffer.alloc(32, 4).toString('base64url');
  assert.equal(verifyLinkToken(token, ADDRESS, other).ok, false);
});

test('被篡改的票据被拒绝', () => {
  const token = issueLinkToken(ADDRESS, SECRET);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ a: ADDRESS, e: Date.now() + 9e6 })).toString('base64url');
  assert.equal(verifyLinkToken(`${forged}.${sig}`, ADDRESS, SECRET).ok, false);
});

test('缺密钥或缺票据时安全失败', () => {
  assert.equal(verifyLinkToken('', ADDRESS, SECRET).ok, false);
  assert.equal(verifyLinkToken(issueLinkToken(ADDRESS, SECRET), ADDRESS, '').ok, false);
  assert.equal(issueLinkToken(ADDRESS, ''), '');
});

test('每次签发都是完整有效期，绝不沿用上一次的剩余时间', () => {
  // 用户担心：过 10 天再复制，会不会拿到只剩 20 天的票据。答案必须是不会——
  // 票据在每次取状态（面板每 5 秒轮询一次）时重新签发，过期时间从那一刻起算。
  const first = issueLinkToken(ADDRESS, SECRET, 1_000_000);
  const later = issueLinkToken(ADDRESS, SECRET, 1_000_000 + 10 * 24 * 60 * 60 * 1000);

  const expiry = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).e;
  const issuedAt = (token) => expiry(token) - LINK_TOKEN_TTL_MS;

  assert.equal(expiry(first) - issuedAt(first), LINK_TOKEN_TTL_MS);
  assert.equal(expiry(later) - issuedAt(later), LINK_TOKEN_TTL_MS, '每次签发都应是完整有效期');
  assert.notEqual(first, later, '不同时刻签发必须是不同的票据');
  assert.ok(expiry(later) > expiry(first), '后签发的过期时间必须更晚');

  // 默认有效期与 DSH 浏览器会话一致：30 天。
  assert.equal(LINK_TOKEN_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test('拼接到地址上形态正确', () => {
  const token = issueLinkToken(ADDRESS, SECRET);
  const url = withLinkToken('http://192.168.0.102:3080', token);
  assert.ok(url.startsWith(`http://192.168.0.102:3080/?${LINK_TOKEN_PARAM}=`));
  assert.equal(withLinkToken('http://x', ''), 'http://x');
});
