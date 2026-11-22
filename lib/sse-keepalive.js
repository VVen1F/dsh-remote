// SSE 空闲保活
//
// 局域网上同样存在「空闲连接被中间设备回收」的问题：DSH 的事件流在首帧之后
// 可以长时间没有字节，链路空闲阈值一到就会被掐断，手机上的实时通道随之中断。
// 这里在静默超过阈值时写入一帧 SSE 注释行（规范要求客户端忽略），对任何合规
// 解析器零影响。
//
// 三条护栏缺一不注入：
//   1. content-type 必须是 text/event-stream；
//   2. 未压缩（往压缩流里插明文会损坏字节流）；
//   3. 无 content-length（定长响应插字节会破坏消息帧界）。

/** 保活帧：SSE 注释行，规范要求客户端忽略。 */
export const SSE_KEEPALIVE_FRAME = ': keepalive\n\n';

/** 静默多久注入一帧。远小于常见的 60s 空闲回收阈值。 */
export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;

/**
 * 判断一份上游响应头是否允许注入保活帧。
 * @param {Record<string, string|string[]|undefined>} [headers]
 * @returns {boolean}
 */
export function isSseKeepaliveCandidate(headers = {}) {
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) return false;
  if (headers['content-length'] !== undefined && headers['content-length'] !== null) return false;
  return !/(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 创建 SSE 空闲保活计时器。
 *
 * 语义：
 *   - 创建即开始第一段静默倒计时；
 *   - `poke()` 表示刚见到上游数据，从零重新起算；
 *   - 静默满 intervalMs 写入一帧，并继续按周期写；
 *   - `stop()` 幂等终止；`write` 抛错视为连接已坏，停表并通过 onWriteError 上报。
 * @param {{write: (frame: string) => void, intervalMs?: number, onWriteError?: (error: unknown) => void}} options
 * @returns {{poke: () => void, stop: () => void}}
 */
export function createSseKeepalive({ write, intervalMs = SSE_KEEPALIVE_INTERVAL_MS, onWriteError }) {
  let timer = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    // 保活计时器不应单独撑住进程退出。
    if (typeof timer.unref === 'function') timer.unref();
  };

  const tick = () => {
    if (stopped) return;
    try {
      write(SSE_KEEPALIVE_FRAME);
    } catch (error) {
      stopped = true;
      clear();
      onWriteError?.(error);
      return;
    }
    schedule();
  };

  schedule();

  return {
    poke: () => { if (!stopped) schedule(); },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
