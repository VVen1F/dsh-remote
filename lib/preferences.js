// 插件自己的轻量持久化：只存用户选中的网卡地址。
//
// 为什么不写进 profile 的 cordis.patch.yml
// ---------------------------------------------------------------
// 通过宿主的配置编辑器写入普通字段会**重建插件**：新实例启动时要绑 3080，而旧实例
// 的监听还没释放，于是必然 EADDRINUSE，面板就会谎报「端口被别的程序占用」。
// 把「用户偏好」和「插件配置」分开之后，切换网卡只是一次内存 + 小文件写入，监听原地
// 迁移，不牵扯插件生命周期。
//
// 文件位置：`$DSH_HOME/dsh-remote/config.json`，权限 0600。

import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 配置文件所在目录。 */
function configDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'dsh-remote');
}

/** 配置文件路径。 */
export function configFile() {
  return join(configDirectory(), 'config.json');
}

/**
 * 读取已保存的偏好。
 * @returns {Promise<{lan: {selectedIp: string}}>}
 */
export async function readPreferences() {
  try {
    const raw = await readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const selectedIp = typeof parsed?.lan?.selectedIp === 'string' ? parsed.lan.selectedIp : '';
    return { lan: { selectedIp } };
  } catch {
    // 文件不存在、内容损坏、权限不足：都按「没有偏好」处理，不影响插件启动。
    return { lan: { selectedIp: '' } };
  }
}

/**
 * 覆盖写入偏好。写临时文件再 rename，避免断电/崩溃留下半截 JSON。
 * @param {{lan?: {selectedIp?: string}}} next
 * @returns {Promise<void>}
 */
export async function writePreferences(next) {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    lan: { selectedIp: next?.lan?.selectedIp ?? '' },
  }, null, 2);
  const target = configFile();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, target);
}
