// sourceManager：洛雪自定义源的文件存储与生命周期管理。
// 存储约定（遵循"数据存软件根目录"）：
//   <软件根目录>/sources/*.js        —— 源脚本文件（文件名即源 id）
//   <软件根目录>/sources/sources.json —— 启用状态与排序
const fs = require("fs");
const path = require("path");
const { SourceInstance } = require("./sourceHost");

const CONFIG_FILE = "sources.json";

class SourceManager {
  /** @param {string} rootDir 软件根目录（main.js 的 dataRoot()） */
  constructor(rootDir) {
    this.dir = path.join(rootDir, "sources");
    /** @type {Map<string, {instance: SourceInstance|null, file: string, enabled: boolean, error: string|null}>} */
    this.items = new Map();
  }

  _configPath() {
    return path.join(this.dir, CONFIG_FILE);
  }

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this._configPath(), "utf8"));
    } catch {
      return { items: [] };
    }
  }

  _saveConfig() {
    const items = [...this.items.entries()].map(([id, it]) => ({ id, file: it.file, enabled: it.enabled }));
    try {
      fs.writeFileSync(this._configPath(), JSON.stringify({ items }, null, 2));
    } catch (e) {
      console.error("保存源配置失败:", e.message);
    }
  }

  /** 启动时扫描 sources/ 目录并加载全部源（禁用的也加载以展示声明，但标记禁用）。
   *  注：禁用源仍执行脚本以获取 inited 声明（列表需要展示支持的平台/音质）；
   *  调用侧（播放/歌词）只路由到 enabled 的源。 */
  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    const cfg = this._loadConfig();
    const cfgMap = new Map(cfg.items.map((i) => [i.id, i]));

    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const id = file.replace(/\.js$/, "");
      const enabled = cfgMap.has(id) ? !!cfgMap.get(id).enabled : true; // 新源默认启用
      await this._loadOne(id, file, enabled);
    }
    this._saveConfig();
  }

  async _loadOne(id, file, enabled) {
    const full = path.join(this.dir, file);
    let raw;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch (e) {
      this.items.set(id, { instance: null, file, enabled, error: `读取失败：${e.message}` });
      return;
    }
    const instance = new SourceInstance(id, raw);
    try {
      await instance.init();
      this.items.set(id, { instance, file, enabled, error: null });
      console.log(`自定义源已加载：${instance.meta.name}（${id}）`, Object.keys(instance.sources || {}));
    } catch (e) {
      this.items.set(id, { instance: null, file, enabled, error: e.message });
      console.warn(`自定义源加载失败（${file}）：`, e.message);
    }
  }

  list() {
    return [...this.items.entries()].map(([id, it]) => {
      if (it.instance) return { ...it.instance.summary(it.enabled), error: null };
      // 加载失败的源也要在列表中可见（展示错误，允许删除/重试）
      let meta = { name: id, description: "", version: "", author: "", homepage: "" };
      try {
        const { parseMeta } = require("./sourceHost");
        meta = parseMeta(fs.readFileSync(path.join(this.dir, it.file), "utf8"));
      } catch {}
      return { id, ...meta, enabled: it.enabled, sources: {}, updateInfo: null, error: it.error };
    });
  }

  /** 导入源文件：拷贝进 sources/ 并试加载。失败回滚。 */
  async importFrom(srcPath) {
    fs.mkdirSync(this.dir, { recursive: true });
    const raw = fs.readFileSync(srcPath, "utf8");
    const probe = new SourceInstance("probe", raw);
    await probe.init(); // 先试跑，失败则不落盘

    const id = `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const file = `${id}.js`;
    fs.writeFileSync(path.join(this.dir, file), raw, "utf8");

    const instance = new SourceInstance(id, raw);
    await instance.init();
    this.items.set(id, { instance, file, enabled: true, error: null });
    this._saveConfig();
    return instance.summary(true);
  }

  async remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, it.file));
    } catch {}
    this._saveConfig();
    return true;
  }

  async toggle(id, enabled) {
    const it = this.items.get(id);
    if (!it) return false;
    it.enabled = !!enabled;
    this._saveConfig();
    return true;
  }

  /** 重新读取文件并重载（源更新后） */
  async reload(id) {
    const it = this.items.get(id);
    if (!it) return false;
    await this._loadOne(id, it.file, it.enabled);
    this._saveConfig();
    return !this.items.get(id).error;
  }

  /** 调用启用源的 action。返回第一个成功的结果；全部失败抛错（供换源重试）。 */
  async callEnabled(sourceKey, action, info) {
    const errors = [];
    for (const [, it] of this.items) {
      if (!it.enabled || !it.instance) continue;
      const decl = it.instance.sources?.[sourceKey];
      if (!decl || !(decl.actions || []).includes(action)) continue;
      try {
        return await it.instance.call(sourceKey, action, info);
      } catch (e) {
        errors.push(`${it.instance.meta.name}: ${e.message}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : `没有可用源支持 ${sourceKey}/${action}`);
  }

  /** 汇总全部启用源声明（音质选择、能力探测用） */
  enabledSources() {
    const out = {};
    for (const [, it] of this.items) {
      if (!it.enabled || !it.instance?.sources) continue;
      for (const [key, decl] of Object.entries(it.instance.sources)) {
        out[key] = out[key] || { qualitys: new Set(), actions: new Set() };
        (decl.qualitys || []).forEach((q) => out[key].qualitys.add(q));
        (decl.actions || []).forEach((a) => out[key].actions.add(a));
      }
    }
    return Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, { qualitys: [...v.qualitys], actions: [...v.actions] }])
    );
  }
}

module.exports = { SourceManager };
