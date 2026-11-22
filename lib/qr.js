// 二维码：把访问地址渲染成可直接用于 <img src> 的 dataURL。
//
// 编码器是仓库内置的零依赖实现（lib/qr-encoder.js），因此插件被「链接安装」到
// profile 时不会因为缺少 npm 依赖而整体加载失败。缓存以地址为键，网卡切换或端口
// 变化后会自动生成新的二维码，不会出现「地址变了二维码没变」。

import { encodeQrMatrix, matrixToSvgPath } from './qr-encoder.js';

/** 二维码目标边长（像素）。手机扫码在 300px 下已足够清晰。 */
const QR_PIXEL_SIZE = 300;

/** 静区宽度（模块数），规范推荐 4。 */
const QR_QUIET_ZONE = 4;

/** 深色前景与浅色底：保证扫码对比度，观感也与 DSH 深色主题协调。 */
const QR_DARK = '#1F2421';
const QR_LIGHT = '#FFFFFF';

/** 缓存条目上限：正常情况下同时只会有 1~3 个地址。 */
const QR_CACHE_LIMIT = 8;

export class QrCache {
  constructor() {
    /** @type {Map<string, {dataUrl: string, at: number}>} */
    this.entries = new Map();
  }

  /**
   * 取某个文本对应的二维码 dataURL。
   * @param {string|null|undefined} text 访问地址
   * @returns {Promise<string|null>} 地址为空或渲染失败时返回 null
   */
  async render(text) {
    if (!text) return null;
    const cached = this.entries.get(text);
    if (cached) return cached.dataUrl;

    let dataUrl;
    try {
      dataUrl = toSvgDataUrl(text);
    } catch {
      return null;
    }

    this.entries.set(text, { dataUrl, at: Date.now() });
    if (this.entries.size > QR_CACHE_LIMIT) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    return dataUrl;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * 生成内联 SVG 的二维码，并以 dataURL 形式返回。
 *
 * 用 SVG 而不是 PNG：面板里以固定尺寸显示，矢量在任意像素密度下都锐利，也不需要
 * 额外的 PNG 编码器。
 * @param {string} text
 * @returns {string}
 */
export function toSvgDataUrl(text) {
  const { modules } = encodeQrMatrix(text);
  const total = modules.length + QR_QUIET_ZONE * 2;
  // 每个模块取整数像素，避免半像素造成的模糊。
  const moduleSize = Math.max(1, Math.floor(QR_PIXEL_SIZE / total));
  const size = total * moduleSize;
  const { path, size: pathSize } = matrixToSvgPath(modules, moduleSize);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg"'
    + ` width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"`
    + ' shape-rendering="crispEdges">'
    + `<rect width="${size}" height="${size}" fill="${QR_LIGHT}"/>`
    + `<g transform="translate(${QR_QUIET_ZONE * moduleSize} ${QR_QUIET_ZONE * moduleSize})" fill="${QR_DARK}">`
    + `<path d="${path}" width="${pathSize}"/>`
    + '</g>'
    + '</svg>';

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
