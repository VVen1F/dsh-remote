// DSH 原生会话 cookie 兼容层测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  buildDshLoopbackCookies,
  dshAuthCookieNames,
  readBrowserSessionSecretFromText,
  readBrowserSessionSecretFromRecord,
  stripCookiesByName,
  DSH_AUTH_COOKIE_PREFIX,
  DSH_BROWSER_SESSION_RECORD,
} from '../lib/dsh-cookie.js';

/** 32 字节密钥的 base64url（与 DSH 存储格式一致）。 */
const SECRET = Buffer.alloc(32, 7).toString('base64url');

test('cookie 名称按 DSH 口径派生（sha256(authority) 的 base64url）', () => {
  const names = dshAuthCookieNames(3080);
  const expected = DSH_AUTH_COOKIE_PREFIX
    + createHash('sha256').update('127.0.0.1:3080').digest('base64url');
  assert.equal(names[0], expected);
  assert.equal(names.length, 2, '同时给出忽略端口的候选名');
  assert.equal(new Set(names).size, 2);
});

test('cookie 值是可验证的 HMAC 载荷', () => {
  const [entry] = buildDshLoopbackCookies({ targetPort: 3080, secret: SECRET, now: 1_700_000_000_000 });
  const value = entry.slice(entry.indexOf('=') + 1);
  const [version, body, signature] = value.split('.');
  assert.equal(version, 'v1');

  const expected = createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(body).digest('base64url');
  assert.equal(signature, expected, '签名必须能被同一密钥复算');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  assert.equal(payload.version, 1);
  assert.equal(payload.authority, '127.0.0.1:3080', 'authority 必须带端口');
  assert.equal(payload.expiresAt - payload.issuedAt, 60 * 60 * 1000, '有效期固定 1 小时');
  assert.ok(payload.issuedAt < 1_700_000_000_000, 'issuedAt 需略微回拨');
});

test('缺密钥时返回空数组，不生成无效 cookie', () => {
  assert.deepEqual(buildDshLoopbackCookies({ targetPort: 3080, secret: '' }), []);
  assert.deepEqual(buildDshLoopbackCookies({ targetPort: 0, secret: SECRET }), []);
});

test('从凭据记录载荷读取密钥', () => {
  assert.equal(readBrowserSessionSecretFromRecord({
    kind: 'grant',
    payload: { version: 1, secret: SECRET },
  }), SECRET);
  assert.equal(readBrowserSessionSecretFromRecord({ payload: {} }), '');
  assert.equal(readBrowserSessionSecretFromRecord(undefined), '');
});

test('从凭据文件文本读取密钥时锚定 browser-session 记录', () => {
  const text = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: THE_REAL_ONE',
    '  other/record:',
    '    payload:',
    '      secret: WRONG_ONE',
  ].join('\n');
  assert.equal(readBrowserSessionSecretFromText(text), 'THE_REAL_ONE');
  assert.equal(readBrowserSessionSecretFromText(''), '');
  assert.equal(readBrowserSessionSecretFromText('nothing here'), '');
});

test('剔除同名 cookie 时保留无关 cookie', () => {
  const header = 'a=1; dsh-auth-x=OLD; b=2; dsh-auth-y=OLD2';
  assert.equal(stripCookiesByName(header, ['dsh-auth-x']), 'a=1; b=2; dsh-auth-y=OLD2');
  assert.equal(stripCookiesByName('', ['a']), '');
  assert.equal(stripCookiesByName('a=1', []), 'a=1');
});

test('凭据记录键与 DSH 的约定一致', () => {
  assert.equal(DSH_BROWSER_SESSION_RECORD, 'client-connection/browser-session');
});
