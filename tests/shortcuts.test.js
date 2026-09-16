// 自检：快捷键的纯逻辑（node --import ./tests/register-alias.mjs tests/shortcuts.test.js）
//
// 为什么单独锁住：真正按键的那套（监听 keydown / globalShortcut 注册）没法在单测里跑，
// 但**按键串的解析与匹配**全是字符串处理，恰恰是最容易出边界问题的地方 ——
// 尤其是「修饰键必须精确匹配」，错了会让软件内与全局的默认键互相串。
import {
  actionsFor,
  defaultMap,
  eventToAccelerator,
  findConflicts,
  formatAccelerator,
  matchesEvent,
  mergeWithDefaults,
  normalizeAccelerator,
  ACTIONS,
} from "../frontend/src/utils/shortcuts.js";

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

/** 造一个 KeyboardEvent 形状的对象（单测里没有真实事件） */
const key = (k, mods = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

console.log("---- eventToAccelerator ----");
ok("Ctrl+F5", eventToAccelerator(key("F5", { ctrl: true })) === "Ctrl+F5");
ok("修饰键按固定顺序排列（Ctrl 在 Alt 前）", eventToAccelerator(key("A", { alt: true, ctrl: true })) === "Ctrl+Alt+A");
ok("Shift 排在 Alt 之后", eventToAccelerator(key("A", { shift: true, alt: true })) === "Alt+Shift+A");
ok("Meta 记作 Super", eventToAccelerator(key("A", { meta: true })) === "Super+A");
ok("字母统一大写", eventToAccelerator(key("a", { ctrl: true })) === "Ctrl+A");
ok("方向键保留 Arrow 名", eventToAccelerator(key("ArrowLeft", { ctrl: true })) === "Ctrl+ArrowLeft");
ok("空格 → Space", eventToAccelerator(key(" ", { ctrl: true })) === "Ctrl+Space");
ok("功能键可单独使用（F1）", eventToAccelerator(key("F1")) === "F1");
ok("方向键可单独使用", eventToAccelerator(key("ArrowRight")) === "ArrowRight");

ok("⚠️ 只按修饰键不算一次按键", eventToAccelerator(key("Control", { ctrl: true })) === null);
ok("⚠️ 只按 Alt 不算", eventToAccelerator(key("Alt", { alt: true })) === null);
ok("⚠️ 裸字母被拒绝（否则打字全被吃掉）", eventToAccelerator(key("a")) === null, String(eventToAccelerator(key("a"))));
ok("⚠️ 裸数字被拒绝", eventToAccelerator(key("1")) === null);
ok("无事件不抛错", eventToAccelerator(null) === null);

console.log("\n---- normalizeAccelerator ----");
ok("修饰键重排成固定顺序", normalizeAccelerator("Alt+Ctrl+A") === "Ctrl+Alt+A");
ok("重复修饰键去重", normalizeAccelerator("Ctrl+Ctrl+A") === "Ctrl+A");
ok("大小写不敏感", normalizeAccelerator("ctrl+alt+a") === "Ctrl+Alt+A");
ok("空串 → 空串", normalizeAccelerator("") === "");
ok("只有修饰键 → 空串（不是合法快捷键）", normalizeAccelerator("Ctrl+Alt") === "");
ok("两个主键 → 空串", normalizeAccelerator("Ctrl+A+B") === "");
ok("前后空格被忽略", normalizeAccelerator("  Ctrl + F5  ") === "Ctrl+F5");

console.log("\n---- formatAccelerator ----");
ok("方向键显示成箭头", formatAccelerator("Ctrl+Alt+ArrowLeft") === "Ctrl + Alt + ←");
ok("空格显示成中文", formatAccelerator("Ctrl+Space", "zh") === "Ctrl + 空格");
ok("英文下显示 Space", formatAccelerator("Ctrl+Space", "en") === "Ctrl + Space");
ok("未设置 → 空串", formatAccelerator("") === "");
ok("非法输入 → 空串", formatAccelerator("Ctrl+Alt") === "");

console.log("\n---- matchesEvent ----");
ok("命中自身", matchesEvent("Ctrl+F5", key("F5", { ctrl: true })) === true);
ok(
  "⚠️ 修饰键必须精确匹配：Ctrl+F5 不该被 Ctrl+Alt+F5 触发",
  matchesEvent("Ctrl+F5", key("F5", { ctrl: true, alt: true })) === false
);
ok(
  "⚠️ 反向同理：Ctrl+Alt+F5 不该被 Ctrl+F5 触发",
  matchesEvent("Ctrl+Alt+F5", key("F5", { ctrl: true })) === false
);
ok("少了 Shift 不命中", matchesEvent("Ctrl+Shift+A", key("A", { ctrl: true })) === false);
ok("顺序无关（事件与配置写法不同也能命中）", matchesEvent("Alt+Ctrl+A", key("A", { ctrl: true, alt: true })) === true);
ok("未设置的空快捷键永不命中", matchesEvent("", key("F5", { ctrl: true })) === false);

console.log("\n---- 冲突与合并 ----");
{
  const c = findConflicts({ a: "Ctrl+F5", b: "Ctrl+F5", c: "Ctrl+F6" });
  ok("检出重复组合", Object.keys(c).length === 1 && c["Ctrl+F5"].length === 2, JSON.stringify(c));
  ok("不重复时返回空", Object.keys(findConflicts({ a: "Ctrl+F5", b: "Ctrl+F6" })).length === 0);
  ok("空串不算冲突（多个「未设置」是正常的）", Object.keys(findConflicts({ a: "", b: "", c: "" })).length === 0);
  ok("写法不同但等价也算冲突", Object.keys(findConflicts({ a: "Alt+Ctrl+A", b: "Ctrl+Alt+A" })).length === 1);
}
{
  const merged = mergeWithDefaults({ playPause: "Ctrl+P" }, "inApp");
  ok("用户设置覆盖默认值", merged.playPause === "Ctrl+P", JSON.stringify(merged));
  ok("未设置的动作保留默认值", merged.next === "Ctrl+ArrowRight", JSON.stringify(merged));
  ok("未知动作 id 被丢弃", merged.bogus === undefined);
  ok("显式清空（空串）能覆盖掉默认值", mergeWithDefaults({ playPause: "" }, "inApp").playPause === "");
}

console.log("\n---- 动作表 ----");
ok("动作 id 不重复", new Set(ACTIONS.map((a) => a.id)).size === ACTIONS.length);
ok("每个动作都有文案 key", ACTIONS.every((a) => typeof a.label === "string" && a.label.startsWith("shortcut.")));
ok("软件内不含「仅全局」的动作", actionsFor("inApp").every((a) => !a.globalOnly));
ok("全局动作比软件内多", actionsFor("global").length > actionsFor("inApp").length);
ok("默认键表覆盖所有动作", Object.keys(defaultMap("global")).length === actionsFor("global").length);
{
  const c = findConflicts(defaultMap("global"));
  ok("⚠️ 全局默认键之间没有冲突", Object.keys(c).length === 0, JSON.stringify(c));
  const d = findConflicts(defaultMap("inApp"));
  ok("⚠️ 软件内默认键之间没有冲突", Object.keys(d).length === 0, JSON.stringify(d));
}
{
  // 默认的软件内/全局键必须互不相同，否则同一个组合会在两个作用域里打架
  const inApp = Object.values(defaultMap("inApp")).filter(Boolean);
  const glob = Object.values(defaultMap("global")).filter(Boolean);
  const overlap = inApp.filter((a) => glob.includes(a));
  ok("⚠️ 软件内与全局的默认键没有重叠", overlap.length === 0, JSON.stringify(overlap));
}

console.log("\n自检结束");
process.exit(FAILED);
