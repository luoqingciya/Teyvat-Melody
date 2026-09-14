// onlineSearch store：在线搜索的**跨页面共享状态**。
//
// 为什么要有这个 store（而不是继续把状态放在 OnlineSearchView 里）：
// 路由切走时 OnlineSearchView 会被卸载，组件内的 ref 随之销毁 —— 用户搜完一批结果、
// 点进「全部音乐」看一眼再回来，结果、关键词、翻到第几页全没了，只能重搜。
// 所以把这些状态提到 store 里（组件卸载不销毁），组件只负责渲染与交互。
//
// 另外这里也用 localStorage 落盘一层：同一会话内切页面靠内存，**重启应用后仍能恢复**
// （用户搜到一半关窗口、第二天再打开，列表还在原处）。
// 键名沿用 piniaPersist 插件的前缀约定，保持一致。
import { computed, reactive, ref } from "vue";

const STORAGE_KEY = "teyvat-melody:onlineSearch";

/** 每页多少条（每平台），4 个平台合计 = 每页 4×PAGE_SIZE 条 */
export const PAGE_SIZE = 30;

/** 结果列表最多保留多少条，避免无限翻页吃内存（提示用户「已到上限」） */
export const MAX_RESULTS = 300;

/** 一次搜索最多能翻到第几页（= ceil(MAX_RESULTS / (平台数×PAGE_SIZE)) 的量级） */
export const MAX_PAGE = 10;

const PLATFORM_KEYS = ["kw", "kg", "tx", "wy"];

function emptyState() {
  return {
    keyword: "", // 搜索框里的词
    submitted: "", // 真正搜过的词（与 keyword 区分：用户改了但没点搜索时，结果不该变）
    results: [], // 累积的结果（翻页是追加）
    page: 1, // 已加载到第几页
    hasMore: true, // 还有没有下一页
    picked: [], // 勾选的平台
    searched: false, // 是否搜过（用于空态文案）
    errorMsg: "",
    loadedPlatforms: false, // 平台列表是否已拉过（避免每次进页面都拉）
  };
}

// ---- 模块级状态：整个应用共用一份，组件卸载不丢 ----
const state = reactive(emptyState());
const loading = ref(false);
// 翻页时的「正在加载更多」状态（与首次搜索分开，便于按钮上单独显示）
const loadingMore = ref(false);
// 结果区滚动位置：切走再回来要停在原处，否则用户翻回去还得重新滚
const scrollTop = ref(0);
let searchToken = 0; // 并发令牌：连续搜索 / 翻页时丢弃过期响应

// ---- localStorage 落盘（只存必要的，结果本身太大就截断） ----
let restoreDone = false;

/** 从 localStorage 恢复上一次的搜索现场（每次启动只做一次） */
function restore() {
  if (restoreDone) return;
  restoreDone = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return;
    state.keyword = String(saved.keyword || "");
    state.submitted = String(saved.submitted || "");
    state.page = Math.max(1, Number(saved.page) || 1);
    state.hasMore = saved.hasMore !== false;
    state.searched = !!saved.searched;
    state.picked = Array.isArray(saved.picked) ? saved.picked.filter((k) => PLATFORM_KEYS.includes(k)) : [];
    // 结果截断保存：单条也才几百字节，但翻到上限会有上千条，超配额会静默失败，
    // 所以只留最近 MAX_RESULTS 条（与内存上限一致）。
    state.results = Array.isArray(saved.results) ? saved.results.slice(-MAX_RESULTS) : [];
  } catch {
    /* 损坏的缓存忽略即可 */
  }
}

let saveTimer = 0;

/** 防抖落盘：翻页 / 输入时不必每次都写 */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          keyword: state.keyword,
          submitted: state.submitted,
          results: state.results.slice(-MAX_RESULTS),
          page: state.page,
          hasMore: state.hasMore,
          picked: state.picked,
          searched: state.searched,
        })
      );
    } catch {
      /* 配额不足等：不落盘也不影响本次使用 */
    }
  }, 400);
}

restore();

/** 是否还能再翻下一页 */
const canNext = computed(
  () => state.results.length > 0 && state.page < MAX_PAGE && state.hasMore && !loading.value && !loadingMore.value
);

/** 是否到了结果上限（用于提示用户「只能搜到这些」，而不是以为坏了） */
const atLimit = computed(() => state.page >= MAX_PAGE || !state.hasMore);

/**
 * 清空搜索现场（结果 + 关键词）。
 * 用户主动清空时调用；平台勾选保留（那是偏好，不是搜索现场）。
 */
function reset() {
  searchToken += 1; // 让还在飞的请求作废
  const picked = [...state.picked];
  Object.assign(state, emptyState(), { picked, loadedPlatforms: state.loadedPlatforms });
  scrollTop.value = 0;
  persist();
}

/** 记录平台列表已拉取（组件 onMounted 判断要不要再拉） */
function markPlatformsLoaded(picked) {
  state.loadedPlatforms = true;
  if (Array.isArray(picked) && picked.length) state.picked = [...picked];
}

/** 打开页面时恢复上次现场：把 keyword 同步到搜索框（组件绑定 state.keyword，天然一致） */
function hydrate() {
  restore();
}

export function useOnlineSearch() {
  return {
    // 状态
    state,
    loading,
    loadingMore,
    scrollTop,
    canNext,
    atLimit,
    // 方法
    reset,
    persist,
    hydrate,
    markPlatformsLoaded,
    /** 供组件申请一个请求令牌（判断响应是否过期） */
    nextToken: () => ++searchToken,
    isStale: (token) => token !== searchToken,
    PAGE_SIZE,
    MAX_RESULTS,
    MAX_PAGE,
  };
}
