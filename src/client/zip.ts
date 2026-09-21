/**
 * 极简 ZIP 打包器(仅 STORE 不压缩)。
 *
 * 用于"批量下载":把多个素材合成一个压缩包。素材本身几乎都是已压缩格式
 * (jpg / mp4 / pdf / docx / xlsx),再压缩收益接近 0,因此不引入 fflate、jszip
 * 等依赖(避免增加包体与 lockfile 变更),直接按 ZIP 规范拼字节。
 *
 * 结构:每个文件 = 本地文件头 + 原始数据;之后是中央目录;最后是目录结束记录。
 */

export interface ZipEntry {
  /** 压缩包内的文件名(含扩展名) */
  name: string;
  data: Uint8Array;
}

// CRC32 查表(多项式 0xEDB88320)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP 用的是 DOS 时间格式(1980 起算) */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipEntry[], when = new Date()): Blob {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // 本地文件头(30 字节 + 文件名)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 签名
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // 标志位:文件名用 UTF-8(中文标题不乱码)
    lv.setUint16(8, 0, true); // 压缩方式:0 = STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // 压缩后大小(STORE 下等于原始大小)
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra 长度
    local.set(nameBytes, 30);
    body.push(local, entry.data);

    // 中央目录头(46 字节 + 文件名)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    // 30 extra 长度 / 32 注释长度 / 34 起始磁盘 / 36 内部属性 / 38 外部属性 均为 0
    cv.setUint32(42, offset, true); // 对应本地头的偏移
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const cdSize = central.reduce((sum, c) => sum + c.length, 0);

  // 目录结束记录(22 字节)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...body, ...central, eocd] as BlobPart[], { type: 'application/zip' });
}

/** 压缩包内重名时自动加序号:photo.jpg → photo(2).jpg */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (used.has(`${base}(${i})${ext}`)) i++;
  const out = `${base}(${i})${ext}`;
  used.add(out);
  return out;
}
