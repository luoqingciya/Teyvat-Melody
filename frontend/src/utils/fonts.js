// 字体管理：注册 @font-face（上传的字体文件）并切换界面全局字体。
// 字体文件由 pywebview 保存到 <data>/fonts，经 Flask 的 /fonts/<file> 静态路由提供；
// 无桥接（纯浏览器）时退化为 object URL，仅当前会话有效。

const STYLE_ID = "tm-custom-fonts";

function ensureStyleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

/** 根据扩展名推断 @font-face 的 format */
function formatFor(url) {
  const u = String(url).split("?")[0].toLowerCase();
  if (u.endsWith(".woff2")) return "woff2";
  if (u.endsWith(".woff")) return "woff";
  if (u.endsWith(".otf")) return "opentype";
  return "truetype";
}

/** 注入一条 @font-face（重复 family 自动跳过） */
export function registerFont({ family, url }) {
  if (!family || !url) return;
  const el = ensureStyleEl();
  const token = `font-family:'${family}'`;
  if (el.textContent.includes(token)) return;
  const fmt = formatFor(url);
  el.textContent += `@font-face{font-family:'${family}';src:url('${url}') format('${fmt}');font-display:swap;}\n`;
}

/** 启动时批量注册所有已保存的自定义字体 */
export function applyCustomFonts(customFonts = []) {
  (customFonts || []).forEach((f) => registerFont({ family: f.family, url: f.url }));
}

/** 设置界面全局字体（写入 CSS 变量，body 通过 var(--app-font-family) 引用） */
export function setAppFont(family) {
  document.documentElement.style.setProperty("--app-font-family", family || "");
}
