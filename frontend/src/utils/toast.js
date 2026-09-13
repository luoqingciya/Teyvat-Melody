// toast：极简非侵入式提示（不依赖 Vue 组件树，直接挂到 body）。
// 用于在线播放失败等需要即时反馈、但又不值得引入全局状态/组件的场景。
// 注：项目 CSP 为 style-src 'self' 'unsafe-inline'，用 CSSOM 写样式不会被拦截。
let host = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    left: "50%",
    bottom: "96px",
    transform: "translateX(-50%)",
    zIndex: "9999",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    pointerEvents: "none",
  });
  document.body.appendChild(host);
  return host;
}

/**
 * 弹出一条提示。
 * @param {string} message 文案
 * @param {{type?: "info"|"error", duration?: number, action?: {label: string, onClick?: Function}}} [opts]
 *        action 会在文案右侧渲染一个按钮（用于「前往下载」这类可操作提示）。
 * @returns {() => void} 手动关闭函数
 */
export function toast(message, { type = "info", duration = 3200, action = null } = {}) {
  if (!message) return () => {};
  const isErr = type === "error";
  const el = document.createElement("div");
  Object.assign(el.style, {
    maxWidth: "440px",
    padding: "10px 16px",
    borderRadius: "10px",
    fontSize: "13px",
    lineHeight: "1.55",
    color: "#fff",
    background: isErr ? "rgba(178, 54, 54, 0.95)" : "rgba(26, 30, 44, 0.95)",
    border: `1px solid ${isErr ? "rgba(255, 150, 150, 0.5)" : "rgba(255, 215, 107, 0.35)"}`,
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
    backdropFilter: "blur(8px)",
    opacity: "0",
    transform: "translateY(8px)",
    transition: "opacity .18s ease, transform .18s ease",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    // 默认不拦截鼠标：提示不该挡住下面的界面。带操作按钮时才放开。
    pointerEvents: action?.label ? "auto" : "none",
  });
  el.appendChild(document.createTextNode(message));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 220);
  };

  if (action?.label) {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.gap = "10px";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    Object.assign(btn.style, {
      flexShrink: "0",
      padding: "4px 12px",
      borderRadius: "999px",
      border: "1px solid rgba(255, 215, 107, 0.55)",
      background: "rgba(255, 215, 107, 0.16)",
      color: "#FFD76B",
      fontSize: "12px",
      cursor: "pointer",
    });
    btn.addEventListener("click", () => {
      try {
        action.onClick?.();
      } finally {
        close();
      }
    });
    el.appendChild(btn);
  }

  ensureHost().appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });

  const timer = setTimeout(close, duration);
  return () => {
    clearTimeout(timer);
    close();
  };
}

/** 错误提示（红色） */
export function toastError(message, duration) {
  return toast(message, { type: "error", duration });
}
