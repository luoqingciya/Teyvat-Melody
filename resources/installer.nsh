# 提瓦特旋律 —— NSIS 自定义脚本（electron-builder 的 nsis.include）
#
# ══ 这个文件为什么存在 ══════════════════════════════════════════════════════
# 安装版的数据（data / music / sources / cache / .appdata）**就放在 EXE 同级**，
# 也就是 $INSTDIR 里面 —— 这样整个安装目录是自包含的，可以整体搬移。
#
# 但安装器在升级时会**先执行旧版的卸载程序**（electron-builder 的
# installSection.nsh → uninstallOldVersion），而卸载程序默认会
# `RMDir /r $INSTDIR`（uninstaller.nsh）—— 把安装目录整个删掉。
# 于是「更新」= 删掉旧版（连数据一起）+ 装新版 = **每次更新都会丢光全部数据**。
# （`customUnInstall` 宏插在 RMDir **之后**，用它保数据是救不回来的。）
#
# 解法：electron-builder 允许用 `customRemoveFiles` 宏**完全接管**「删哪些文件」。
# 这里按场景区分：
#   · 升级（安装器总是带 --updated 调用旧卸载程序）→ 只删应用自己的文件，数据原样保留
#   · 真正卸载（用户在「应用和功能」里卸载）        → 全部删掉，不留残留
#
# ⚠️ 维护提醒：**新增应用级的顶层目录时要同步加进下面的清单**，
#    否则升级后会留下上一个版本的陈旧文件（不影响功能，只是占空间）。
#    顶层文件不必逐一列举（见下）。
#
# 本地验证：`python tools/verify-nsis-keep-data.py`
#   （用真实的 makensis 编译并运行这个宏，断言「升级保留数据、卸载清空」）

!macro customRemoveFiles
  ${if} ${isUpdated}
    # ── 升级：只清应用文件，数据目录一律不动 ──
    #
    # 1) 顶层文件：exe / dll / pak / bin / dat / html / txt / json / yml / ico …
    #    Delete 只删**文件**、不会递归删目录，所以 data/ music/ sources/ cache/ .appdata/
    #    这些目录（及其内容）不会被碰到。
    Delete "$INSTDIR\*.*"

    # 2) 应用自己的子目录：新版安装时会重新解包，删掉可避免旧版本的残留文件。
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
  ${else}
    # ── 真正卸载：连用户数据一起删（与 electron-builder 默认行为一致）──
    # 想让数据在卸载后保留，请改用免安装版（数据同样在软件目录里，删文件夹即卸载）。
    RMDir /r $INSTDIR
  ${endif}
!macroend
