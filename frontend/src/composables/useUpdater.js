// useUpdater：在线更新检查（查 GitHub Release）。
//
// 只做「查 → 告知 → 跳转下载」，**不做自动下载安装**，原因：
//   - zip 免安装版没有安装位置，electron-updater 那类方案只支持 NSIS 安装版；
//   - 未签名的更新包会被 Windows SmartScreen 拦截，静默安装体验反而更差。
// 好处是安装版与免安装版都能用，且不引入运行时依赖。
import { ref } from "vue";
import { useConfigStore } from "@/stores/config";
import { toast } from "@/utils/toast";
import { useI18n } from "@/utils/i18n";

export function useUpdater() {
  const config = useConfigStore();
  const { t } = useI18n();
  const checking = ref(false);
  const info = ref(null); // 主进程返回的检查结果
  const error = ref("");

  /** 手动检查（设置页按钮）。返回结果供调用方判断，失败不抛错。 */
  async function check() {
    const api = window.pywebview?.api;
    if (!api || typeof api.checkUpdate !== "function") {
      error.value = t("update.unsupported");
      return null;
    }
    checking.value = true;
    error.value = "";
    try {
      const r = await api.checkUpdate();
      info.value = r;
      if (!r?.ok) error.value = r?.message || t("update.checkFailed");
      return r;
    } catch (e) {
      error.value = e.message;
      return null;
    } finally {
      checking.value = false;
    }
  }

  /** 用系统浏览器打开更新页 / 下载链接（主进程会校验域名） */
  function openPage(url) {
    const api = window.pywebview?.api;
    if (url && api && typeof api.openUpdatePage === "function") api.openUpdatePage(url);
  }

  /** 启动时的静默检查：有新版且用户未忽略该版本时，弹一条可操作提示。 */
  async function checkOnStartup() {
    const r = await check();
    if (!r?.ok || !r.hasUpdate) return;
    if (config.skipUpdateVersion === r.latest) return; // 已忽略该版本，不再打扰
    toast(t("update.available", { v: r.latest }), {
      duration: 12000,
      action: { label: t("update.download"), onClick: () => openPage(r.pageUrl) },
    });
  }

  /** 忽略某个版本的提示（持久化到配置） */
  function skip(version) {
    config.skipUpdateVersion = version || "";
  }

  return { checking, info, error, check, openPage, checkOnStartup, skip };
}
