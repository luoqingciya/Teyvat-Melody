// 自检：设置页每个分类的图标都必须真实存在（node tests/settings-icons.test.js）
//
// 背景：AppIcon 里查不到的名字会**静默渲染成空白**（`ICONS[name] || ""`），
// 不报错、不警告。实际发生过一次 —— 新增的「快捷键」分类写了 `icon: "command"`，
// 而图标集里没有这个键，结果只有它没有图标，其他分类都有，看起来像是漏做了。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ICON_FILE = path.join(ROOT, "frontend", "src", "components", "AppIcon.vue");
const SETTINGS_FILE = path.join(ROOT, "frontend", "src", "components", "SettingsModal.vue");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

/** AppIcon.vue 里 ICONS 对象定义的全部图标名 */
function iconNames() {
  const src = fs.readFileSync(ICON_FILE, "utf8");
  const start = src.indexOf("const ICONS = {");
  const end = src.indexOf("\n};", start);
  const body = src.slice(start, end);
  const names = new Set();
  // 形如 `  keyboard:` 或 `  "list-music":`
  const re = /^\s{2}"?([a-z0-9-]+)"?:/gm;
  let m;
  while ((m = re.exec(body))) names.add(m[1]);
  return names;
}

/** SettingsModal.vue 里 TABS 用到的图标名 */
function tabIcons() {
  const src = fs.readFileSync(SETTINGS_FILE, "utf8");
  const start = src.indexOf("const TABS = [");
  const end = src.indexOf("];", start);
  const body = src.slice(start, end);
  const out = [];
  const re = /icon:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

const icons = iconNames();
const tabs = tabIcons();

console.log("---- 设置页分类图标 ----");
ok("解析出图标集（数量 > 20）", icons.size > 20, `实际 ${icons.size}`);
ok("解析出分类列表（数量 >= 6）", tabs.length >= 6, `实际 ${tabs.length}`);

const missing = tabs.filter((n) => !icons.has(n));
ok(
  "⚠️ 每个分类的图标都在图标集里（缺失会静默变空白）",
  missing.length === 0,
  `缺失：${missing.join(", ")}（可用：${[...icons].slice(0, 8).join(", ")}…）`
);

// 顺带守住：新增分类必须给图标，否则同样会出现「只有它没图标」
{
  const src = fs.readFileSync(SETTINGS_FILE, "utf8");
  const start = src.indexOf("const TABS = [");
  const body = src.slice(start, src.indexOf("];", start));
  const entries = body.split("\n").filter((l) => l.includes("key:"));
  ok(
    "每个分类都声明了 icon",
    entries.every((l) => l.includes("icon:")),
    entries.filter((l) => !l.includes("icon:")).join(" | ")
  );
}

console.log("\n自检结束");
process.exit(FAILED);
