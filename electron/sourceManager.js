// sourceManager：洛雪自定义源的文件存储与生命周期管理。
// 存储约定（遵循"数据存软件根目录"）：
//   <软件根目录>/sources/*.js        —— 源脚本文件（文件名即源 id）
//   <软件根目录>/sources/sources.json —— 启用状态与排序
const fs = require("fs");
const path = require("path");
const { SourceInstance } = require("./sourceHost");

const CONFIG_FILE = "sources.json";

// 音质降级链（高 → 低）：按源声明取最高可用音质，失败逐级降档
const QUALITY_CHAIN = ["flac24bit", "flac", "320k", "128k"];

class SourceManager {
  /** @param {string} rootDir 软件根目录（main.js 的 dataRoot()） */
  constructor(rootDir) {
    this.dir = path.join(rootDir, "sources");
    /** @type {Map<string, {instance: SourceInstance|null, file: string, enabled: boolean, error: string|null}>} */
    this.items = new Map();
    // 平台解析失败记忆：源声明支持某平台、实际却解析不出地址（如源后端不支持该平台）时，
    // 记下来供界面提示，避免用户反复「搜到了却播不了」。源列表变化即失效。
    /** @type {Map<string, {message: string, at: number}>} */
    this.failures = new Map();
  }

  /** 源列表发生任何变化后调用：旧的解析失败结论不再可信 */
  _clearFailures() {
    this.failures.clear();
  }

  /**
   * 各平台最近的解析失败记录（供界面提示）。
   * @param {number} [ttlMs] 超过该时长的记录视为过期，默认 10 分钟
   */
  platformWarnings(ttlMs = 10 * 60 * 1000) {
    const now = Date.now();
    const out = {};
    for (const [key, rec] of this.failures) {
      if (now - rec.at <= ttlMs) out[key] = { message: rec.message, at: rec.at };
    }
    return out;
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
    // 这里是「源列表发生变化」的唯一收口（init / 导入 / 删除 / 启停 / 重载都会走到），
    // 顺带清空平台失败记忆 —— 源变了，之前「这个平台播不了」的结论就不再可信。
    this._clearFailures();
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
      // 保留 meta / updateInfo：源因"版本过低"拒绝初始化时，UI 需要靠 updateInfo 给出更新提示
      this.items.set(id, {
        instance: null,
        file,
        enabled,
        error: e.message,
        meta: instance.meta,
        updateInfo: instance.updateInfo,
      });
      console.warn(`自定义源加载失败（${file}）：`, e.message);
    }
  }

  list() {
    return [...this.items.entries()].map(([id, it]) => {
      if (it.instance) return { ...it.instance.summary(it.enabled), error: null };
      // 加载失败的源也要在列表中可见（展示错误 / 更新提示，允许删除、重试）
      let meta = it.meta;
      if (!meta) {
        meta = { name: id, description: "", version: "", author: "", homepage: "" };
        try {
          const { parseMeta } = require("./sourceHost");
          meta = parseMeta(fs.readFileSync(path.join(this.dir, it.file), "utf8"));
        } catch {}
      }
      return {
        id,
        ...meta,
        enabled: it.enabled,
        sources: {},
        updateInfo: it.updateInfo || null,
        error: it.error,
      };
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

  /** 汇总某平台在「已启用源」中声明的音质与 actions（并集）。 */
  capabilitiesFor(sourceKey) {
    const qualitys = new Set();
    const actions = new Set();
    for (const [, it] of this.items) {
      if (!it.enabled || !it.instance?.sources) continue;
      const decl = it.instance.sources[sourceKey];
      if (!decl) continue;
      (decl.qualitys || []).forEach((q) => qualitys.add(q));
      (decl.actions || []).forEach((a) => actions.add(a));
    }
    return { qualitys: [...qualitys], actions: [...actions] };
  }

  /** 调用启用源的 action。返回首个成功结果及命中的源信息；全部失败抛错（错误聚合便于排查）。 */
  async callEnabled(sourceKey, action, info) {
    const errors = [];
    for (const [id, it] of this.items) {
      if (!it.enabled || !it.instance) continue;
      const decl = it.instance.sources?.[sourceKey];
      if (!decl || !(decl.actions || []).includes(action)) continue;
      try {
        const result = await it.instance.call(sourceKey, action, info);
        return { result, sourceId: id, sourceName: it.instance.meta.name };
      } catch (e) {
        errors.push(`${it.instance.meta.name}: ${e.message}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : `没有可用源支持 ${sourceKey}/${action}`);
  }

  /**
   * 解析在线歌曲的播放 URL：**音质降级 + 多源换源重试**。
   *
   * 先取该平台在启用源中声明的音质并集，按 QUALITY_CHAIN 由高到低排序（用户偏好音质优先）；
   * 每个音质内部由 callEnabled 逐个源尝试，任一源成功即返回。全部失败抛错，错误链聚合返回。
   *
   * @param {string} sourceKey 平台 key（kw/kg/tx/wy/mg/local）
   * @param {object} musicInfo 平台歌曲信息（应含全量平台 ID：hash/songmid/rid/id/mid 等）
   * @param {string} [preferred] 用户偏好音质；未声明时忽略
   * @returns {Promise<{url:string, quality:string, sourceId:string, sourceName:string}>}
   */
  async resolveMusicUrl(sourceKey, musicInfo, preferred) {
    const { qualitys, actions } = this.capabilitiesFor(sourceKey);
    if (!actions.includes("musicUrl")) {
      throw new Error(`没有启用的源支持平台「${sourceKey}」的 musicUrl`);
    }

    // 偏好优先，其余按降级链；源声明的非标准音质排在最后（尽量仍能播）
    const chain = [];
    if (preferred && qualitys.includes(preferred)) chain.push(preferred);
    for (const q of QUALITY_CHAIN) {
      if (qualitys.includes(q) && !chain.includes(q)) chain.push(q);
    }
    for (const q of qualitys) {
      if (!chain.includes(q)) chain.push(q);
    }
    if (!chain.length) chain.push(preferred || "128k"); // 源未声明音质时的兜底

    const errors = [];
    for (const quality of chain) {
      try {
        const { result, sourceId, sourceName } = await this.callEnabled(sourceKey, "musicUrl", {
          type: quality,
          musicInfo,
        });
        // 洛雪契约返回字符串 URL；对个别返回 { url } 的源做兼容
        const url = typeof result === "string" ? result : result && result.url;
        if (url) {
          this.failures.delete(sourceKey); // 该平台本次可用，清掉历史失败
          return { url, quality, sourceId, sourceName };
        }
        errors.push(`${quality}: 源未返回有效 URL`);
      } catch (e) {
        errors.push(`${quality}: ${e.message}`);
      }
    }
    // 同一原因会在每个音质档重复出现，逐档罗列会刷屏且看不出重点；
    // 各档失败原因一致时只报一次，否则保留逐档信息便于定位。
    const reasons = [...new Set(errors.map((e) => e.replace(/^[^:]+:\s*/, "")))];
    const message = `音质降级全部失败 → ${reasons.length === 1 ? reasons[0] : errors.join("；")}`;
    // 记下失败：界面据此在平台筛选条上提示「这个平台你的源可能播不了」，
    // 避免用户反复「搜得到却播不了」。
    this.failures.set(sourceKey, { message, at: Date.now() });
    throw new Error(message);
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
