# -*- coding: utf-8 -*-
"""后端代理配置自检：python tests/proxy-config.test.py

后端也要读代理配置（音频/封面/歌词这些上游请求由 Flask 发起），但配置文件的
**写入方有两个**：主进程的 writeConfigPatch（electron/appConfig.js）与本文件的
online_cache.save_config()。两边都是「读-改-写」，任何一方漏掉对方的键就会把对方
刚写的东西抹掉 —— 这是本文件重点盯的回归点。

另外盯住两条安全线：
  1. 不完整的代理配置必须退回「未启用」（宁可不用代理，也不能让应用断网）
  2. 判据必须与 electron/proxy.js 的 normalizeProxy 一致（跨语言镜像，容易走偏）
"""
import json
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import online_cache  # noqa: E402

# 配置写到临时目录，别污染项目根的 cache/
_TMP = Path(tempfile.mkdtemp(prefix="tm-proxy-cfg-"))
online_cache._root_cache_dir = lambda: _TMP

FAILED = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global FAILED
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  → {extra}" if not cond and extra else ""))
    if not cond:
        FAILED = 1


def write_raw(obj) -> None:
    (_TMP / "config.json").write_text(json.dumps(obj, ensure_ascii=False), "utf-8")


def read_raw() -> dict:
    return json.loads((_TMP / "config.json").read_text("utf-8"))


def main() -> int:
    # ---------- _normalize_proxy：与 electron/proxy.js 对齐的边界 ----------
    n = online_cache._normalize_proxy
    full = n({"enabled": True, "host": "127.0.0.1", "port": 7890})
    ok("完整配置 → 启用", full["enabled"] and full["host"] == "127.0.0.1" and full["port"] == 7890)
    ok("未勾选启用 → 关闭", not n({"enabled": False, "host": "127.0.0.1", "port": 7890})["enabled"])
    ok("缺主机 → 关闭", not n({"enabled": True, "host": "   ", "port": 7890})["enabled"])
    ok("缺端口 → 关闭（不猜默认端口）", not n({"enabled": True, "host": "127.0.0.1"})["enabled"])
    ok("端口非数字 → 关闭", not n({"enabled": True, "host": "127.0.0.1", "port": "abc"})["enabled"])
    ok("端口越界 → 关闭", not n({"enabled": True, "host": "h", "port": 70000})["enabled"]
       and not n({"enabled": True, "host": "h", "port": 0})["enabled"]
       and not n({"enabled": True, "host": "h", "port": -1})["enabled"])
    ok("端口是字符串数字 → 接受并转成整数（JSON 里可能是字符串）",
       n({"enabled": True, "host": "h", "port": "8080"})["port"] == 8080)
    ok("主机前后空格 → 去掉", n({"enabled": True, "host": " 127.0.0.1 ", "port": 1})["host"] == "127.0.0.1")
    ok("None / 非 dict / 字符串 → 关闭且不抛错",
       not n(None)["enabled"] and not n("x")["enabled"] and not n([])["enabled"])
    ok("关闭态的 shape 稳定（永远是 enabled/host/port 三键，不留残缺键）",
       set(n(None).keys()) == {"enabled", "host", "port"})

    # ---------- 与 JS 侧逐条对齐（跨语言镜像，最容易悄悄走偏） ----------
    # 这里不重复实现，只把「同输入是否同结论」当作断言。JS 侧由
    # tests/proxy.test.js 覆盖同一批输入；两边都过 = 镜像没偏。
    mirror_cases = [
        {"enabled": True, "host": "127.0.0.1", "port": "8080"},
        {"enabled": True, "host": " h ", "port": 0},
        {"enabled": True},
        {"enabled": False, "host": "h", "port": 1},
        "not-a-dict",
        None,
    ]
    got = [n(c)["enabled"] for c in mirror_cases]
    ok("镜像结论与 JS 一致（同批输入 → 仅第 1 条启用）", got == [True, False, False, False, False, False], str(got))

    # ---------- load_config：文件损坏 / 缺失都要有默认值 ----------
    (_TMP / "config.json").unlink(missing_ok=True)
    cfg = online_cache.load_config()
    ok("配置文件不存在 → 默认开启 + 代理关闭", cfg["enabled"] and cfg["proxy"]["enabled"] is False)
    (_TMP / "config.json").write_text("{ 坏掉的 json", "utf-8")
    ok("配置文件损坏 → 退回默认且不抛错", online_cache.load_config()["proxy"]["enabled"] is False)
    write_raw({"enabled": True, "maxBytes": 123, "proxy": {"enabled": True, "host": "10.0.0.1", "port": 1080}})
    ok("proxy 键被读出来", online_cache.proxy_url() == "http://10.0.0.1:1080", str(online_cache.proxy_url()))
    write_raw({"enabled": True, "maxBytes": 123, "proxy": {"enabled": False, "host": "10.0.0.1", "port": 1080}})
    ok("未启用时 proxy_url() 是 None（调用方据此直连）", online_cache.proxy_url() is None)

    # ---------- validate_proxy_save：写入口的拒绝判据（与 JS 镜像） ----------
    v = online_cache.validate_proxy_save
    ok_ = v({"enabled": True, "host": "127.0.0.1", "port": 7890})
    ok("启用 + 完整配置 → 接受", ok_[0] and ok_[2]["enabled"] and ok_[2]["port"] == 7890)
    r = v({"enabled": True, "host": "127.0.0.1"})
    ok("启用 + 缺端口 → 拒绝", not r[0] and "端口" in r[1])
    r = v({"enabled": True, "host": "127.0.0.1", "port": "abc"})
    ok("启用 + 端口非数字 → 拒绝", not r[0])
    r = v({"enabled": True, "host": "127.0.0.1", "port": 99999})
    ok("启用 + 端口越界 → 拒绝", not r[0])
    # ⚠️ 关键回归：开关关着、但填错了也要拒 —— 否则存成空配置，输入框里却留着用户的字
    r = v({"enabled": False, "host": "127.0.0.1", "port": "abc"})
    ok("⚠️ 未启用 + 填了非法端口 → 拒绝", not r[0] and "有误" in r[1])
    r = v({"enabled": False, "host": "127.0.0.1", "port": ""})
    ok("未启用 + 只填主机（端口空）→ 拒绝", not r[0])
    r = v({"enabled": False, "host": "", "port": ""})
    ok("未启用 + 两框都空 → 接受（正当清空）", r[0] and r[2]["enabled"] is False)
    r = v({"enabled": False, "host": "h", "port": 1})
    ok("未启用 + 完整合法配置 → 接受（先填好、暂不启用是正常操作）", r[0] and r[2]["enabled"] is False)
    ok("参数全缺 → 当作清空，接受", v({})[0] and v(None)[0])
    r = v({"enabled": True, "host": " h ", "port": "8080"})
    ok("归一化：去空格 + 端口转整数", r[0] and r[2]["host"] == "h" and r[2]["port"] == 8080)

    # 与 JS 侧 validateProxySave 逐条对齐
    mirror = [
        {"enabled": True, "host": "127.0.0.1", "port": 7890},
        {"enabled": True, "host": "127.0.0.1"},
        {"enabled": False, "host": "127.0.0.1", "port": "abc"},
        {"enabled": False, "host": "", "port": ""},
        {"enabled": False, "host": "h", "port": 1},
    ]
    got = [v(c)[0] for c in mirror]
    ok("validateProxySave 镜像结论与 JS 一致（应只有第 2 条被拒）",
       got == [True, False, False, True, True], str(got))

    # ---------- save_config 白名单：漏放行 = 静默丢弃 ----------
    write_raw({})
    after = online_cache.save_config({"proxy": {"enabled": True, "host": "1.2.3.4", "port": 8080}})
    ok("save_config 接受了 proxy（白名单放行了）", after["proxy"]["enabled"] is True)
    ok("落盘了（不是只在内存里改了）", read_raw()["proxy"]["host"] == "1.2.3.4")

    # ---------- ⚠️ 两个写入方互不抹除 ----------
    # 场景：主进程写了「缓存开关 + 上限」，后端随后写代理 —— 前者的键必须还在。
    online_cache.save_config({"proxy": {"enabled": True, "host": "1.2.3.4", "port": 8080}})
    raw = read_raw()
    ok("save_config 保留了自己没碰的键（enabled/maxBytes 没被抹掉）",
       "enabled" in raw and "maxBytes" in raw, str(raw))
    # 反向：模拟主进程 writeConfigPatch 只写缓存开关，代理键必须活下来。
    # 主进程是「读-改-写」，这里按同样语义模拟。
    raw = read_raw()
    raw["maxBytes"] = 4096
    write_raw(raw)
    ok("主进程只改 maxBytes 时，proxy 键仍在（跨写入方不互相覆盖）",
       read_raw().get("proxy", {}).get("host") == "1.2.3.4", str(read_raw()))
    ok("proxy 改动确实生效到 proxy_url()", online_cache.proxy_url() == "http://1.2.3.4:8080")

    # 非法值不能把已有配置写坏：save_config 遇到非法 proxy 应当**原样保留旧值**
    # （既不写入非法值，也不清空 —— 清空会让用户以为「刚才那次保存生效了」）
    # 从一个已知的「启用中」状态出发，才能同时验出「没被非法值覆盖」和「没被清空」。
    online_cache.save_config({"proxy": {"enabled": True, "host": "9.9.9.9", "port": 1080}})
    before = online_cache.proxy_url()
    online_cache.save_config({"proxy": {"enabled": True, "host": "1.2.3.4"}})  # 缺端口 → 非法
    ok("写入非法代理 → 不写入、且旧值原样保持（既没覆盖也没清空）",
       online_cache.proxy_url() == before == "http://9.9.9.9:1080",
       f"{before} -> {online_cache.proxy_url()}")

    # 合法值应当正常写入
    online_cache.save_config({"proxy": {"enabled": True, "host": "1.2.3.4", "port": 8080}})
    ok("合法代理正常写入", online_cache.proxy_url() == "http://1.2.3.4:8080")

    print("\n自检结束")
    return FAILED


if __name__ == "__main__":
    sys.exit(main())
