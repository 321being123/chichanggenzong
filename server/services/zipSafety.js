// 在解压前读取 ZIP 中央目录，限制条目数、声明展开体积和压缩比。
function assertSafeZip(buffer, options) {
  options = options || {};
  const maxUncompressed = options.maxUncompressed || 200 * 1024 * 1024;
  const maxEntries = options.maxEntries || 10000;
  const maxRatio = options.maxRatio || 250;
  const label = options.label || 'ZIP';

  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error(label + ' 压缩包结构异常');

  const min = Math.max(0, buffer.length - 22 - 0xFFFF);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054B50) continue;
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(label + ' 压缩包结构异常或疑似压缩炸弹');

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) throw new Error(label + ' 不支持分卷 ZIP');
  if (entries === 0 || entries > maxEntries) throw new Error(label + ' 文件条目数量异常');
  if (entries === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) {
    throw new Error(label + ' 不支持 ZIP64');
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw new Error(label + ' 中央目录越界');

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014B50) {
      throw new Error(label + ' 中央目录损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x01) throw new Error(label + ' 不支持加密 ZIP');
    if (compressed === 0xFFFFFFFF || uncompressed === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      throw new Error(label + ' 不支持 ZIP64');
    }
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034B50) {
      throw new Error(label + ' 本地文件头损坏');
    }
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > maxUncompressed) throw new Error(label + ' 解压后体积过大，疑似压缩炸弹');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error(label + ' 中央目录长度异常');
  if (totalUncompressed > 1024 * 1024 && totalUncompressed / Math.max(1, totalCompressed) > maxRatio) {
    throw new Error(label + ' 压缩比异常，疑似压缩炸弹');
  }
  return { entries, totalCompressed, totalUncompressed };
}

module.exports = { assertSafeZip };
