// 零依赖的二维码编码器（Byte 模式，纠错等级 M）
//
// 为什么不用 npm 的 qrcode 包
// ---------------------------------------------------------------
// 插件的安装方式是「把目录链接进 profile」（`dsh plugin add <目录>`），链接不会执行
// `npm install`，因此任何运行时依赖在用户机器上都可能不存在——插件会因为一句
// `Cannot find package 'qrcode'` 整体加载失败。二维码本身只需要几十行矩阵计算，
// 与其让用户踩依赖，不如把编码器内置。
//
// 实现范围：Byte 模式 + 纠错等级 M + 版本 1–10 自动选择。局域网地址
// （`http://192.168.100.100:3080` 量级，最长 40 字符左右）在版本 3 以内就足够；
// 版本上限留到 10（约 213 字节）足以覆盖 IPv6 地址。
//
// 算法与掩码评分遵循 ISO/IEC 18004。输出为可直接绘制的模块矩阵。

/** 纠错等级 M：约 15% 冗余，扫码鲁棒性与容量的常规折中。 */
const ECC_LEVEL_M = { index: 0, formatBits: 0, eccPerBlock: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26] };

/** 每块纠错码字数：按（版本, 等级 M）索引。 */
const ECC_CODEWORDS_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** 纠错块数：按（版本, 等级 M）索引。 */
const NUM_ERROR_CORRECTION_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** 版本 <= 40 时每版本的总模块数公式；这里只用到前 10 个版本。 */
function getNumRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 该版本在等级 M 下可容纳的数据码字数。 */
function getNumDataCodewords(version) {
  return Math.floor(getNumRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK_M[version] * NUM_ERROR_CORRECTION_BLOCKS_M[version];
}

/** 字节模式所需比特数 = 4（模式指示符）+ 字符计数 + 8×字节数。 */
function getByteModeBitLength(byteCount, version) {
  const countBits = version <= 9 ? 8 : 16;
  return 4 + countBits + byteCount * 8;
}

/** 选出能容纳 payload 的最小版本（1–10）。 */
function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    if (getByteModeBitLength(byteLength, version) <= getNumDataCodewords(version) * 8) return version;
  }
  throw new Error(`二维码内容过长（${byteLength} 字节）`);
}

/** 按版本生成对齐图案中心坐标。 */
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon ---------------------------------------------------------

/** GF(2^8) 乘法，本原多项式 0x11D。 */
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 生成 degree 次的 RS 生成多项式系数。 */
function rsGenerator(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** 计算数据码字的 RS 纠错码字。 */
function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) result[i] ^= gfMultiply(generator[i], factor);
  }
  return result;
}

// ---- 矩阵绘制 -------------------------------------------------------------

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Uint8Array(this.size));
    this.isFunction = Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark ? 1 : 0;
    this.isFunction[y][x] = 1;
  }

  drawFunctionPatterns() {
    const { size } = this;
    // 定时图案
    for (let i = 0; i < size; i += 1) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    // 三个定位图案
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    // 对齐图案
    const positions = alignmentPositions(this.version);
    const count = positions.length;
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        // 跳过与定位图案重叠的三个角
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
        this.drawAlignment(positions[i], positions[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue;
        this.setFunction(xx, yy, distance !== 2 && distance !== 4);
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask) {
    const data = (ECC_LEVEL_M.formatBits << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, ((bits >>> i) & 1) !== 0);
    this.setFunction(8, 7, ((bits >>> 6) & 1) !== 0);
    this.setFunction(8, 8, ((bits >>> 7) & 1) !== 0);
    this.setFunction(7, 8, ((bits >>> 8) & 1) !== 0);
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, ((bits >>> i) & 1) !== 0);

    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
    for (let i = 8; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, ((bits >>> i) & 1) !== 0);
    this.setFunction(8, this.size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawCodewords(data) {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (this.isFunction[y][x]) continue;
          if (index < data.length * 8) {
            this.modules[y][x] = (data[index >>> 3] >>> (7 - (index & 7))) & 1;
            index += 1;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] ^= 1;
      }
    }
  }

  /**
   * 规范 ISO/IEC 18004 §7.8.3 的四条掩码惩罚规则。
   *
   * 规则 3 的实现要点：规范的 1:1:3:1:1 图案要求「深-浅-深-深-深-浅-深」，
   * 其外侧还需连续 4 个浅色模块；两侧都满足时按规范各计一次。
   */
  penaltyScore() {
    const { size } = this;
    let score = 0;

    const addRun = (length) => {
      if (length >= 5) score += 3 + (length - 5);
    };

    // 规则 1：行/列上同色连续 >= 5
    for (let y = 0; y < size; y += 1) {
      let runColor = this.modules[y][0];
      let runLength = 1;
      for (let x = 1; x < size; x += 1) {
        if (this.modules[y][x] === runColor) runLength += 1;
        else { addRun(runLength); runColor = this.modules[y][x]; runLength = 1; }
      }
      addRun(runLength);
    }
    for (let x = 0; x < size; x += 1) {
      let runColor = this.modules[0][x];
      let runLength = 1;
      for (let y = 1; y < size; y += 1) {
        if (this.modules[y][x] === runColor) runLength += 1;
        else { addRun(runLength); runColor = this.modules[y][x]; runLength = 1; }
      }
      addRun(runLength);
    }

    // 规则 2：2×2 同色块，每块 3 分
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1]
          && color === this.modules[y + 1][x]
          && color === this.modules[y + 1][x + 1]) score += 3;
      }
    }

    // 规则 3：定位图案相似的 1:1:3:1:1 序列，每处 40 分
    const FINDER = [1, 0, 1, 1, 1, 0, 1];
    const matchesFinder = (get, start) => {
      for (let k = 0; k < 7; k += 1) if (get(start + k) !== FINDER[k]) return false;
      return true;
    };
    const lightRun = (get, start) => {
      if (start < 0 || start + 3 >= size) return false;
      for (let k = 0; k < 4; k += 1) if (get(start + k) !== 0) return false;
      return true;
    };
    for (let y = 0; y < size; y += 1) {
      const get = (i) => this.modules[y][i];
      for (let x = 0; x + 6 < size; x += 1) {
        if (!matchesFinder(get, x)) continue;
        if (lightRun(get, x - 4)) score += 40;
        if (lightRun(get, x + 7)) score += 40;
      }
    }
    for (let x = 0; x < size; x += 1) {
      const get = (i) => this.modules[i][x];
      for (let y = 0; y + 6 < size; y += 1) {
        if (!matchesFinder(get, y)) continue;
        if (lightRun(get, y - 4)) score += 40;
        if (lightRun(get, y + 7)) score += 40;
      }
    }

    // 规则 4：暗模块比例每偏离 5% 计 10 分
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) dark += this.modules[y][x];
    }
    const total = size * size;
    const percent = (dark * 100) / total;
    const deviation = Math.abs(percent - 50);
    score += Math.floor(deviation / 5) * 10;

    return score;
  }
}

// ---- 编码 -----------------------------------------------------------------

/** 把字节流切成数据码字并补齐。 */
function buildCodewords(bytes, version) {
  const capacityBits = getNumDataCodewords(version) * 8;
  const bits = [];

  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // Byte 模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  // 终止符 + 补零到字节边界
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | bits[i + k];
    codewords.push(byte);
  }
  // 填充码字从 0xEC 开始，与 0x11 交替，直到填满数据容量。
  const capacity = getNumDataCodewords(version);
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return Uint8Array.from(codewords);
}

/** 按块交织数据码字与纠错码字。 */
function interleave(dataCodewords, version) {
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[version];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);

  const generator = rsGenerator(eccPerBlock);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const dataLength = shortBlockLength - eccPerBlock + (i < numShortBlocks ? 0 : 1);
    const data = dataCodewords.subarray(offset, offset + dataLength);
    offset += dataLength;
    blocks.push({ data, ecc: rsRemainder(data, generator) });
  }

  const result = [];
  const maxDataLength = shortBlockLength - eccPerBlock + 1;
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return Uint8Array.from(result);
}

/**
 * 把文本编码成二维码模块矩阵。
 * @param {string} text
 * @returns {number[][]} 每行一个 0/1 数组，1 表示暗模块
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length === 0) throw new Error('二维码内容不能为空');
  const version = pickVersion(bytes.length);
  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(interleave(buildCodewords(bytes, version), version));

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    matrix.applyMask(mask);
    matrix.drawFormatBits(mask);
    const score = matrix.penaltyScore();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    matrix.applyMask(mask); // 异或两次即还原
  }
  matrix.applyMask(bestMask);
  matrix.drawFormatBits(bestMask);

  return { version, mask: bestMask, size: matrix.size, modules: matrix.modules.map((row) => Array.from(row)) };
}

/**
 * 生成 SVG 路径（每个暗模块一个 1×1 方块），供面板内联渲染。
 * @param {number[][]} modules
 * @param {number} [scale] 每个模块的像素数
 * @returns {{path: string, size: number}}
 */
export function matrixToSvgPath(modules, scale = 4) {
  const rows = modules.length;
  const columns = rows === 0 ? 0 : modules[0].length;
  const parts = [];
  for (let y = 0; y < rows; y += 1) {
    const row = modules[y];
    let runStart = -1;
    // 多遍历一格用于收尾：走到 columns 时把最后一段连续块刷出去。
    for (let x = 0; x <= columns; x += 1) {
      const dark = x < columns && row[x] === 1;
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        const width = x - runStart;
        parts.push(`M${runStart * scale} ${y * scale}h${width * scale}v${scale}h-${width * scale}z`);
        runStart = -1;
      }
    }
  }
  // 尺寸取较长边，避免非方阵（测试向量）算错。
  return { path: parts.join(''), size: Math.max(rows, columns) * scale };
}
