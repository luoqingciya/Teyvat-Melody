// backup：把用户数据打包成**一个 zip**，以及从 zip 恢复。
//
// 为什么要它：README 一直提醒「卸载会连同数据一起删除」，但应用里没有任何
// 「先备份一下」的手段 —— 用户只能自己去找目录、自己拷。备份是把这条警告变成可执行的。
//
// 备份哪些：
//   · data/             曲库、歌单、收藏（SQLite）
//   · cache/config.json 代理、全局快捷键等**跨进程**配置（主进程/后端要读它）
//   · sources/          用户导入的源脚本 + 启用状态
//   · settings.json     渲染进程设置（主题、字号、播放选项…）—— 由渲染进程传进来，
//                       因为它存在 localStorage 里，主进程读不到
//
// **不**备份哪些（以及为什么）：
//   · music/           用户自己的音频文件：体积大，而且不是我们生成的数据
//   · cache/audio/     音频缓存：几十 MB，随时能重新下回来
//   · logs/ .appdata/  日志与 Chromium 缓存：没有备份价值

const fs = require("fs");
const path = require("path");
const { createZip, readZip } = require("./zip");

/** 清单文件名：恢复时靠它判断「这是我们自己的备份包」 */
const MANIFEST = "backup.json";
/** 备份格式版本：以后结构变了靠它判断能不能恢复 */
const FORMAT = 1;

/** 备份里固定包含的路径（相对数据根） */
const PARTS = ["data", path.join("cache", "config.json"), "sources"];

/** 单个文件大小上限：超过就不进备份（避免把意外的大文件塞进去） */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 递归收集一个目录下的文件（相对路径用 `/` 分隔） */
function walk(dir, base = dir, out = []) {
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      walk(full, base, out);
    } else if (it.isFile()) {
      out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
    }
  }
  return out;
}

/**
 * 收集要备份的内容。
 *
 * @param {string} root 数据根目录
 * @param {{settings?: object, appVersion?: string}} extra
 * @returns {{entries: {name:string,data:Buffer}[], files: number, bytes: number, skipped: string[]}}
 */
function collect(root, extra = {}) {
  const entries = [];
  const skipped = [];
  let bytes = 0;
  // 后端给出的一致快照（VACUUM INTO）。有它就**不**再拷 library.db / -wal / -shm ——
  // 直接拷活库可能拷到「还没并进主库」的旧数据或撕裂状态，那样的备份等于废的。
  const snapshot = Buffer.isBuffer(extra.dbSnapshot) ? extra.dbSnapshot : null;

  const push = (name, data) => {
    entries.push({ name, data });
    bytes += data.length;
  };

  for (const part of PARTS) {
    const full = path.join(root, part);
    let st = null;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // 不存在就跳过（比如用户从没导入过源）
    }
    if (st.isDirectory()) {
      for (const f of walk(full)) {
        if (f.full === path.join(root, MANIFEST)) continue;
        if (snapshot && part === "data" && /^library\.db(-wal|-shm)?$/.test(f.rel)) continue;
        let size = 0;
        try {
          size = fs.statSync(f.full).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) {
          skipped.push(`${part}/${f.rel}（${Math.round(size / 1048576)}MB，超过单文件上限）`);
          continue;
        }
        try {
          // 路径统一用 `/`：zip 里必须是正斜杠，Windows 的反斜杠解出来会是怪名字
          push(`${part.split(path.sep).join("/")}/${f.rel}`, fs.readFileSync(f.full));
        } catch (e) {
          skipped.push(`${part}/${f.rel}（读取失败：${e.message}）`);
        }
      }
    } else if (st.isFile()) {
      try {
        push(part.split(path.sep).join("/"), fs.readFileSync(full));
      } catch (e) {
        skipped.push(`${part}（读取失败：${e.message}）`);
      }
    }
  }

  if (snapshot) push("data/library.db", snapshot);

  // 渲染进程设置：主进程读不到 localStorage，只能由调用方传进来
  if (extra.settings && typeof extra.settings === "object") {
    push("settings.json", Buffer.from(JSON.stringify(extra.settings, null, 2), "utf8"));
  }

  push(
    MANIFEST,
    Buffer.from(
      JSON.stringify(
        {
          format: FORMAT,
          app: "TeyvatMelody",
          version: extra.appVersion || "",
          createdAt: new Date().toISOString(),
          files: entries.length + 1,
        },
        null,
        2
      ),
      "utf8"
    )
  );

  return { entries, files: entries.length, bytes, skipped };
}

/**
 * 检查一个备份包能不能恢复，并列出里面有什么。
 * @returns {{ok:boolean, message?:string, files?:{name:string,size:number}[], manifest?:object}}
 */
function inspect(buf) {
  let entries;
  try {
    entries = readZip(buf);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const manifestEntry = entries.find((e) => e.name === MANIFEST);
  if (!manifestEntry) {
    return { ok: false, message: "这不是本软件的备份包（缺少清单文件）" };
  }
  let manifest = {};
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    return { ok: false, message: "备份包的清单文件已损坏" };
  }
  if (Number(manifest.format) > FORMAT) {
    return { ok: false, message: `备份包来自更新的版本（格式 ${manifest.format}），当前程序读不了` };
  }
  return {
    ok: true,
    manifest,
    files: entries.filter((e) => !e.dir).map((e) => ({ name: e.name, size: e.data.length })),
  };
}

/** 恢复时要写回数据根的文件（排除清单自身） */
function writableEntries(buf) {
  return readZip(buf).filter((e) => !e.dir && e.name !== MANIFEST);
}

/**
 * 把备份内容写回数据根。
 *
 * ⚠️ **必须在后端停掉之后调用**：`data/` 里的 SQLite 被后端占着，
 * 运行中覆盖轻则写入失败，重则把库写坏。调用方负责先停后端（见 main.js 的恢复流程）。
 */
function apply(root, buf) {
  const entries = writableEntries(buf);
  const written = [];
  const failed = [];
  for (const e of entries) {
    // ⚠️ 防目录穿越：备份包里的 `../` 不能写到数据根外面去
    const target = path.resolve(root, e.name);
    if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
      failed.push(`${e.name}（路径越界，已拒绝）`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      written.push(e.name);
    } catch (err) {
      failed.push(`${e.name}（${err.message}）`);
    }
  }
  return { written, failed };
}

/** 备份包的默认文件名：带日期，便于用户自己留几份 */
function defaultFileName(version = "", now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `TeyvatMelody-备份-${stamp}${version ? "-v" + version : ""}.zip`;
}

module.exports = { collect, inspect, apply, createZip, defaultFileName, MANIFEST, FORMAT, PARTS, MAX_FILE_BYTES };
