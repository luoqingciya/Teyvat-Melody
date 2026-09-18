// zip：极简 ZIP 读写（**仅 store 模式，不压缩**）。
//
// 为什么要自己写：项目硬约束是**零运行时依赖**（见 package.json 的 dependencies 是空对象），
// 而 Node 标准库没有 zip。备份功能又需要「一个文件」而不是「一个目录」——
// 目录容易被误删/误改，也不方便发给别人。
//
// 只做 store（method 0）不做 deflate：备份的瓶颈在磁盘 IO 不在 CPU，
// 而自己实现 deflate 是另一个量级的风险。压缩率换来的复杂度不值得。
//
// 格式要点（都踩过）：
//   · 文件名用 **UTF-8**，必须置 flags 的 bit 11（0x0800），否则中文名在别的工具里是乱码。
//   · DOS 时间/日期是两字节的位域，不是 Unix 时间戳。
//   · 中央目录里的「本地头偏移」必须准确，解压工具靠它定位。
//   自检见 tests/zip.test.js（含「写出来能被系统工具读」的往返验证）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32（ZIP 用的就是它） */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** JS Date → DOS 时间/日期两个 16 位字段 */
function dosDateTime(d) {
  const year = d.getFullYear();
  // DOS 时间从 1980 年起算；早于此的（不可能，但防御一下）按 1980-01-01
  const y = Math.max(0, year - 1980);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 打包成 ZIP。
 * @param {{name: string, data: Buffer}[]} entries 名字用 `/` 分隔（目录用结尾的 `/` 表示）
 * @param {Date} [now] 统一用同一个时间戳，便于测试
 * @returns {Buffer}
 */
function createZip(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || "");
    const crc = crc32(data);
    const isDir = e.name.endsWith("/");

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // ⚠️ bit 11：文件名是 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小（store 下相同）
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建者版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // 外部属性：目录标记
    central.writeUInt32LE(offset, 42); // ⚠️ 本地头偏移，解压工具靠它定位
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 在 buf 里从后往前找 EOCD（末尾可能有注释，所以要搜） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 解出 ZIP 内容。
 * @returns {{name: string, data: Buffer, dir: boolean}[]}
 * @throws {Error} 不是合法 zip / 条目用了压缩（本模块只支持 store）
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("不是合法的 zip 文件（太短）");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是合法的 zip 文件（找不到中央目录）");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("zip 中央目录已损坏");
    }
    const method = buf.readUInt16LE(ptr + 10);
    const size = buf.readUInt32LE(ptr + 24); // 原始大小
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    if (method !== 0) {
      throw new Error(`条目「${name}」使用了压缩（方法 ${method}），本工具只支持未压缩的备份包`);
    }
    // 从本地头再取一次文件名长度/extra 长度：本地头的 extra 可能和中央目录不同
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    out.push({
      name,
      data: buf.subarray(dataStart, dataStart + size),
      dir: name.endsWith("/"),
    });

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { createZip, readZip, crc32, dosDateTime };
