// 偏好持久化测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 每个用例用独立的 DSH_HOME，避免污染真实配置。 */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-prefs-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // 重新导入以拿到基于新 DSH_HOME 的路径
    const module = await import(`../lib/preferences.js?home=${encodeURIComponent(home)}`);
    return await run(module, home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('没有配置文件时返回空选择', async () => {
  await withHome(async (prefs) => {
    assert.deepEqual(await prefs.readPreferences(), { lan: { selectedIp: '' } });
  });
});

test('写入后可读回，并且以 0600 权限落盘', async () => {
  await withHome(async (prefs) => {
    await prefs.writePreferences({ lan: { selectedIp: '192.168.0.102' } });
    assert.deepEqual(await prefs.readPreferences(), { lan: { selectedIp: '192.168.0.102' } });

    const file = prefs.configFile();
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `配置文件权限应为 0600，实际 ${mode.toString(8)}`);

    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.lan.selectedIp, '192.168.0.102');
  });
});

test('覆盖写入不残留临时文件', async () => {
  await withHome(async (prefs, home) => {
    await prefs.writePreferences({ lan: { selectedIp: '10.0.0.5' } });
    await prefs.writePreferences({ lan: { selectedIp: '' } });
    assert.deepEqual(await prefs.readPreferences(), { lan: { selectedIp: '' } });

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(home, 'dsh-remote'));
    assert.deepEqual(files, ['config.json'], `不应残留临时文件，实际：${files.join(', ')}`);
  });
});

test('文件损坏时降级为「无偏好」而不是抛错', async () => {
  await withHome(async (prefs, home) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, 'dsh-remote'), { recursive: true });
    await writeFile(join(home, 'dsh-remote', 'config.json'), '{ 这不是 JSON', 'utf8');
    assert.deepEqual(await prefs.readPreferences(), { lan: { selectedIp: '' } });
  });
});

test('非字符串的 selectedIp 被归一化为空串', async () => {
  await withHome(async (prefs, home) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, 'dsh-remote'), { recursive: true });
    await writeFile(join(home, 'dsh-remote', 'config.json'), JSON.stringify({ lan: { selectedIp: 42 } }), 'utf8');
    assert.deepEqual(await prefs.readPreferences(), { lan: { selectedIp: '' } });
  });
});
