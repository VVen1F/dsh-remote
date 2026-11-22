// 局域网网关：在局域网地址上监听 DSH 的默认端口，并把请求反向代理到本机 DSH。
//
// 设计约束（来自 DSH 的服务架构）
// ---------------------------------------------------------------
// 1. DSH 的 Web 服务只监听**一个具体地址**，并明确拒绝 0.0.0.0 这类通配绑定；
//    桌面版更是直接以 `--host 127.0.0.1 --port 0` 启动，端口由系统分配。
// 2. 因此「让 DSH 自己监听局域网」这条路走不通，插件也不能往一个不存在的 3080
//    实例里注册路由。
// 3. 网关于是自己监听 `局域网地址:3080`，把请求反向代理到 `127.0.0.1:<DSH 端口>`。
//    实测（macOS）：DSH 占着 127.0.0.1:3080 时，绑具体网卡地址的同一端口仍然成功，
//    两条监听互不影响——本机回环仍是 DSH 自己，局域网地址归网关。
// 4. 端口冲突时**让**不**抢**：绑定失败就如实报告原因，绝不 kill 进程、绝不改 DSH
//    主程序端口、绝不退回到另一个端口偷偷监听。

import { createServer, request as httpRequest } from 'node:http';
import { buildDshLoopbackCookies, stripCookiesByName } from './dsh-cookie.js';
import { createSseKeepalive, isSseKeepaliveCandidate } from './sse-keepalive.js';
import { GATEWAY_ERRORS, LAN_PORT } from './config.js';

/** 逐跳头：描述的是「当前这一跳」的传输语义，反向代理必须剥离。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** WebSocket 101 响应只放行必要头，避免上游把任何敏感头透传给浏览器。 */
const WS_101_ALLOWED = new Set([
  'connection', 'upgrade', 'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol',
]);

/** 上游压缩响应不解压就无法改写 HTML，因此转发时要求上游给明文。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 剔除逐跳头，返回可安全 writeHead 的响应头。
 * @param {Record<string, unknown>} headers
 * @returns {Record<string, unknown>}
 */
function sanitizeProxyHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 把请求头改写成回环口径：Host / Origin / Referer 指回 DSH，并注入合法的会话 cookie。
 *
 * DSH 对 /api 与根路径都做 Host/Origin 校验：局域网 IP 不在 trustedHosts 里会被
 * 403 拒绝，所以网关必须把口径统一成 `127.0.0.1:<dshPort>`。
 * @param {Record<string, unknown>} headers 浏览器原始请求头
 * @param {number} targetPort DSH 回环端口
 * @param {() => string[]} cookieProvider 返回当前应注入的 cookie 列表
 * @returns {Record<string, unknown>}
 */
function loopbackHeaders(headers, targetPort, cookieProvider) {
  const authority = `127.0.0.1:${targetPort}`;
  const out = { ...headers };
  out.host = authority;
  if (out.origin) out.origin = `http://${authority}`;
  if (out.Origin) out.Origin = `http://${authority}`;

  for (const key of ['referer', 'Referer']) {
    if (!out[key]) continue;
    try {
      const url = new URL(String(out[key]));
      out[key] = `http://${authority}${url.pathname}${url.search}`;
    } catch {
      delete out[key];
    }
  }

  // 同名旧 cookie 会遮住注入值（宿主按「同名取第一个」读取），先剔除再追加。
  const cookies = cookieProvider();
  if (cookies.length > 0) {
    const names = cookies.map((entry) => entry.slice(0, entry.indexOf('=')));
    const cleaned = stripCookiesByName(String(out.cookie ?? out.Cookie ?? ''), names);
    delete out.Cookie;
    out.cookie = cleaned ? `${cleaned}; ${cookies.join('; ')}` : cookies.join('; ');
  }

  // 转发层要求上游返回明文 HTML，注入才有内容可改；顺带避免重复压缩。
  delete out['accept-encoding'];
  delete out['Accept-Encoding'];
  return out;
}

/**
 * 局域网网关。
 *
 * 生命周期：`start()` 绑定 `地址:端口`，`stop()` 释放；两者都可多次安全调用。
 */
export class LanGateway {
  /**
   * @param {object} options
   * @param {number} options.targetPort 本机 DSH 监听端口
   * @param {string} options.bindHost 要监听的局域网地址
   * @param {number} [options.port] 局域网入口端口（默认 DSH 端口 3080）
   * @param {() => string[]} options.cookieProvider 每次请求现签的 cookie 提供者
   * @param {(message: string) => void} [options.onWarn] 诊断输出
   */
  constructor({ targetPort, bindHost, port = LAN_PORT, cookieProvider, onWarn }) {
    this.targetPort = targetPort;
    this.bindHost = bindHost;
    this.port = port;
    this.cookieProvider = cookieProvider;
    this.onWarn = onWarn ?? (() => {});
    this.server = null;
    this.sockets = new Set();
    this.startedAt = null;
  }

  get running() {
    return this.server !== null;
  }

  /**
   * 启动监听。
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
   */
  async start() {
    if (this.server) return { ok: true };
    const server = createServer((req, res) => this.#handleHttp(req, res));
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
    });

    const failure = await new Promise((resolve) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        resolve(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(null);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.bindHost);
    });

    if (failure) {
      try { server.close(); } catch { /* 未成功监听，close 无副作用 */ }
      return { ok: false, ...describeBindFailure(failure, this.port, this.bindHost) };
    }

    this.server = server;
    this.startedAt = Date.now();
    return { ok: true };
  }

  /** 停止监听并强制关闭存量连接。 */
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.startedAt = null;
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* 连接可能已关闭 */ }
    }
    this.sockets.clear();
    // close() 只停止接收新连接；回调触发才代表监听句柄已释放。旧版 Node 在存在
    // keep-alive 时回调可能延后，因此再显式等待一次 'close' 事件兜底。
    await new Promise((resolve) => {
      server.close(() => resolve());
      // closeAllConnections 需要 Node 18.2+；缺失时上面的 socket.destroy 已足够。
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch { /* 无连接可关 */ }
      }
    });
  }

  #handleHttp(req, res) {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      agent: false,
      headers: loopbackHeaders(req.headers, this.targetPort, this.cookieProvider),
    }, (upstreamRes) => {
      const contentType = String(upstreamRes.headers['content-type'] ?? '');
      const rewriteHtml = contentType.includes('text/html') && !isCompressed(upstreamRes.headers);

      if (rewriteHtml) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8');
          const body = Buffer.from(injectMobileHints(html), 'utf8');
          const headers = sanitizeProxyHeaders(upstreamRes.headers);
          delete headers['content-length'];
          headers['content-length'] = String(body.length);
          res.writeHead(upstreamRes.statusCode ?? 200, headers);
          res.end(body);
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, sanitizeProxyHeaders(upstreamRes.headers));

      // 事件流在局域网里同样会被中间设备按空闲回收：静默时补注释帧。
      const keepalive = isSseKeepaliveCandidate(upstreamRes.headers)
        ? createSseKeepalive({
            write: (frame) => { if (!res.writableEnded && !res.destroyed) res.write(frame); },
            onWriteError: (error) => this.onWarn(`SSE 保活帧写入失败：${error?.message ?? error}`),
          })
        : null;
      if (keepalive) {
        upstreamRes.on('data', keepalive.poke);
        upstreamRes.on('end', keepalive.stop);
        res.on('close', keepalive.stop);
      }

      upstreamRes.pipe(res);
      res.on('close', () => upstreamRes.destroy());
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
    });

    upstream.on('error', (error) => {
      this.onWarn(`代理请求失败：${error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-remote: 无法连接本机 DSH (127.0.0.1:${this.targetPort}) — ${error.message}`);
    });

    req.pipe(upstream);
  }

  #handleUpgrade(req, socket, head) {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      agent: false,
      headers: loopbackHeaders(req.headers, this.targetPort, this.cookieProvider),
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const lines = [];
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!WS_101_ALLOWED.has(key.toLowerCase())) continue;
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);

      const teardown = () => {
        try { upstreamSocket.destroy(); } catch { /* 已关闭 */ }
        try { socket.destroy(); } catch { /* 已关闭 */ }
      };
      // 上游 socket 必须有 error 监听者，否则上游 RST 会变成未捕获异常。
      upstreamSocket.on('error', teardown);
      upstreamSocket.on('close', teardown);
      socket.on('close', teardown);
    });

    upstream.on('response', (upstreamRes) => {
      try {
        const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`.trim()];
        for (const [key, value] of Object.entries(sanitizeProxyHeaders(upstreamRes.headers))) {
          lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
        socket.end(`${lines.join('\r\n')}\r\n\r\n`);
        upstreamRes.resume();
      } catch {
        socket.destroy();
      }
    });

    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
    socket.on('error', () => socket.destroy());
  }
}

/**
 * 给手机端页面补两条 PWA 提示（不改动 DSH 自身的 head 结构）。
 *
 * 只做两件事：让「添加到主屏幕」以独立全屏方式打开，以及声明可以缩放到安全区。
 * 页面本身仍是 DSH 自己的页面，不做任何 DOM 改写。
 * @param {string} html 上游返回的 HTML
 * @returns {string}
 */
function injectMobileHints(html) {
  if (!/<head[^>]*>/i.test(html)) return html;
  const addition = [
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="theme-color" content="#1e1e2e">',
  ].join('');
  return html.replace(/<head[^>]*>/i, (match) => `${match}${addition}`);
}

/**
 * 把监听失败翻译成面板可读的原因。
 * @param {NodeJS.ErrnoException} error
 * @param {number} port
 * @param {string} host
 * @returns {{code: string, message: string}}
 */
function describeBindFailure(error, port, host) {
  if (error?.code === 'EADDRINUSE') {
    return {
      code: GATEWAY_ERRORS.portInUse,
      message: `${host}:${port} 已被其它程序占用，局域网访问暂时无法开启`,
    };
  }
  if (error?.code === 'EADDRNOTAVAIL') {
    return {
      code: GATEWAY_ERRORS.listenFailed,
      message: `地址 ${host} 当前不可用（网卡可能已断开），请重新选择网卡`,
    };
  }
  if (error?.code === 'EACCES') {
    return {
      code: GATEWAY_ERRORS.listenFailed,
      message: `没有权限监听 ${port} 端口（1024 以下的端口通常需要管理员权限）`,
    };
  }
  return {
    code: GATEWAY_ERRORS.listenFailed,
    message: `无法在 ${host}:${port} 上开启局域网访问：${error?.message ?? '未知错误'}`,
  };
}
