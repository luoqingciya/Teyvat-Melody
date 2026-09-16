// useUpdater：在线更新检查 + 下载 + 拉起安装。
//
// 为什么不用 electron-updater 的静默安装：它只支持 NSIS 安装版（免安装 zip 没有安装位置），
// 且未签名的更新包会被 Windows SmartScreen 拦截。这里的做法是「查 → 下载到临时目录 → 拉起安装向导」：
//   · 安装版：下 Setup exe，直接拉起安装向导（用户点几下即可，无需自己找下载页）
//   · 免安装版：下 zip，下载完在资源管理器里定位，由用户自行解压替换
// 两种分发方式都能用，也不需要额外运行时依赖。
import { ref } from "vue";
import { useConfigStore } from "@/stores/config";
import { toast, toastError } from "@/utils/toast";
import { useI18n } from "@/utils/i18n";

export function useUpdater() {
  const config = useConfigStore();
  const { t } = useI18n();
  const checking = ref(false);
  const info = ref(null); // 主进程返回的检查结果（含 installed / asset）
  const error = ref("");
  // ⚠️ 下载失败与「检查失败」必须分开存：
  //    之前两者共用一个 error，而模板里信息块是 `v-else-if="!error"` ——
  //    于是下载失败一次，**「有新版本」和「下载并安装」按钮一起消失**，
  //    用户看到一行报错却再也点不到重试（界面还停在「检查更新」那一步，很费解）。
  const downloadError = ref("");
  const downloading = ref(false);
  const progress = ref(0); // 0~100
  const downloadedPath = ref(""); // 下载完成的本地路径
  let offProgress = null;

  const api = () => window.pywebview?.api;

  /** 订阅一次进度事件（重复调用无副作用） */
  function watchProgress() {
    const a = api();
    if (!a || typeof a.onUpdateProgress !== "function" || offProgress) return;
    offProgress = a.onUpdateProgress((p) => {
      progress.value = Math.max(0, Math.min(100, p?.percent ?? 0));
    });
  }

  /** 手动检查（设置页按钮）。返回结果供调用方判断，失败不抛错。 */
  async function check() {
    const a = api();
    if (!a || typeof a.checkUpdate !== "function") {
      error.value = t("update.unsupported");
      return null;
    }
    checking.value = true;
    error.value = "";
    downloadError.value = "";
    downloadedPath.value = "";
    try {
      const r = await a.checkUpdate();
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

  /** 下载当前版本对应的更新包到本地临时目录 */
  async function download() {
    const a = api();
    const asset = info.value?.asset;
    if (!a || typeof a.downloadUpdate !== "function") {
      downloadError.value = t("update.unsupported");
      return false;
    }
    if (!asset) {
      downloadError.value = t("update.noAsset");
      return false;
    }
    downloading.value = true;
    progress.value = 0;
    downloadError.value = "";
    try {
      watchProgress();
      const r = await a.downloadUpdate(asset.url, asset.name);
      if (!r?.ok) throw new Error(r?.message || "unknown");
      downloadedPath.value = r.path;
      progress.value = 100;
      return true;
    } catch (e) {
      downloadError.value = e.message;
      return false;
    } finally {
      downloading.value = false;
    }
  }

  /**
   * 下载并安装：安装版拉起安装向导；免安装版下载后在资源管理器里定位。
   * 返回是否成功启动后续动作。
   */
  async function downloadAndInstall() {
    const ok = await download();
    if (!ok) {
      toastError(`${t("update.downloadFailed")}：${downloadError.value}`);
      return false;
    }
    const a = api();
    const installed = !!info.value?.installed;
    const r = await a.installUpdate(downloadedPath.value, !installed);
    if (!r?.ok) {
      toastError(`${t("update.installFailed")}：${r?.message || ""}`);
      return false;
    }
    toast(installed ? t("update.installLaunched") : t("update.revealed"), { duration: 7000 });
    return true;
  }

  /** 用系统浏览器打开更新页 / 下载链接（主进程会校验域名） */
  function openPage(url) {
    const a = api();
    if (url && a && typeof a.openUpdatePage === "function") a.openUpdatePage(url);
  }

  /** 启动时的静默检查：有新版且用户未忽略该版本时，弹一条可操作提示。 */
  async function checkOnStartup() {
    const r = await check();
    if (!r?.ok || !r.hasUpdate) return;
    if (config.skipUpdateVersion === r.latest) return; // 已忽略该版本，不再打扰
    toast(t("update.available", { v: r.latest }), {
      duration: 12000,
      action: { label: t("update.downloadInstall"), onClick: () => downloadAndInstall() },
    });
  }

  /** 忽略某个版本的提示（持久化到配置） */
  function skip(version) {
    config.skipUpdateVersion = version || "";
  }

  return {
    checking,
    info,
    error,
    downloadError,
    downloading,
    progress,
    downloadedPath,
    check,
    download,
    downloadAndInstall,
    openPage,
    checkOnStartup,
    skip,
  };
}
