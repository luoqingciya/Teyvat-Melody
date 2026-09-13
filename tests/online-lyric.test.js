// 在线歌词解析自检：node tests/lyric.js
//
// 覆盖 LRC / LX 逐字 / 酷狗 KRC（含解密往返）/ 翻译合并 / 组装优先级。
// 全部离线（固定样本），线上接口的连通性由 electron/__test-e2e.js 覆盖。
const zlib = require("zlib");
const {
  parseLrc,
  parseLxLyric,
  parseKrc,
  decodeKrc,
  mergeTranslation,
  buildLines,
  toLxLyric,
  decodeEntities,
  fetchLyric,
  KRC_KEY,
} = require("../electron/onlineLyric");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  try {
    // ---- parseLrc ----
    const lrc = parseLrc("[00:01.50]第一行\n[00:03.000]第二行\n[01:00.25][01:02.25]重复行\n[ar:歌手]");
    ok("parseLrc：基本时间戳", lrc[0].t === 1.5 && lrc[0].text === "第一行", JSON.stringify(lrc[0]));
    ok("parseLrc：三位小数", lrc[1].t === 3, JSON.stringify(lrc[1]));
    ok("parseLrc：多时间戳展开", lrc.length === 4 && lrc[2].t === 60.25 && lrc[3].t === 62.25, JSON.stringify(lrc.slice(2)));
    ok("parseLrc：跳过元信息行", !lrc.some((r) => r.text.includes("歌手")), JSON.stringify(lrc));
    ok("parseLrc：空输入返回空数组", parseLrc("").length === 0 && parseLrc(null).length === 0);

    // ---- parseLxLyric ----
    const lx = parseLxLyric("[00:12.345]<0,300>你<300,250>好\n[00:15.000]无逐字行");
    ok("parseLxLyric：行起始时间", lx[0].t === 12.345, JSON.stringify(lx[0]));
    ok("parseLxLyric：逐字绝对时间与时长", lx[0].words[0].t === 12.345 && lx[0].words[0].d === 0.3 && lx[0].words[1].t === 12.645, JSON.stringify(lx[0].words));
    ok("parseLxLyric：行文本由逐字拼接", lx[0].text === "你好", lx[0].text);
    ok("parseLxLyric：无逐字的行不带 words", lx[1].t === 15 && !lx[1].words, JSON.stringify(lx[1]));

    // ---- parseKrc ----
    const krcText = "[ti:晴天]\n[ar:周杰伦]\n[0,2250]<0,160,0>晴<160,160,0>天\n[2250,1000]<0,200,0>故<200,200,0>事";
    const krc = parseKrc(krcText);
    ok("parseKrc：跳过元信息行", krc.length === 2, String(krc.length));
    ok("parseKrc：毫秒起始时间", krc[0].t === 0 && krc[1].t === 2.25, JSON.stringify(krc.map((r) => r.t)));
    ok("parseKrc：三段式逐字解析", krc[0].words.length === 2 && krc[0].words[1].t === 0.16 && krc[0].words[1].text === "天", JSON.stringify(krc[0].words));
    ok("parseKrc：行文本拼接", krc[1].text === "故事", krc[1].text);

    // ---- decodeKrc：自造 payload 做往返 ----
    const plain = "[ti:t]\n[0,1000]<0,500,0>甲<500,500,0>乙";
    const deflated = zlib.deflateSync(Buffer.from(plain, "utf8"));
    const xored = Buffer.alloc(deflated.length);
    for (let i = 0; i < deflated.length; i++) xored[i] = deflated[i] ^ KRC_KEY[i % 16];
    const payload = Buffer.concat([Buffer.from("krc1"), xored]).toString("base64");
    ok("decodeKrc：解密往返一致", decodeKrc(payload) === plain, JSON.stringify(decodeKrc(payload).slice(0, 40)));
    ok("decodeKrc：无 krc1 头也能解", decodeKrc(xored.toString("base64")) === plain);

    // ---- toLxLyric：酷狗路径转 LX 逐字文本，再解析回来应等价 ----
    const back = parseLxLyric(toLxLyric(krc));
    ok("toLxLyric：往返后行数一致", back.length === krc.length, `${back.length} vs ${krc.length}`);
    ok(
      "toLxLyric：往返后逐字时间一致",
      back[0].words.length === krc[0].words.length &&
        Math.abs(back[0].words[1].t - krc[0].words[1].t) < 0.002 &&
        back[0].text === krc[0].text,
      JSON.stringify(back[0])
    );

    // ---- mergeTranslation ----
    const merged = mergeTranslation(
      [{ t: 1, text: "hello" }, { t: 2, text: "world" }, { t: 3, text: "solo" }],
      "[00:01.05]你好\n[00:02.00]世界"
    );
    ok("mergeTranslation：容差内匹配并内联", merged[0].text === "hello | 你好", merged[0].text);
    ok("mergeTranslation：精确匹配", merged[1].text === "world | 世界", merged[1].text);
    ok("mergeTranslation：无翻译的行保持原样", merged[2].text === "solo", merged[2].text);
    ok("mergeTranslation：无翻译文本时原样返回", mergeTranslation([{ t: 1, text: "a" }], "")[0].text === "a");
    ok(
      "mergeTranslation：保留逐字字段",
      mergeTranslation([{ t: 1, text: "a", words: [{ t: 1, d: 1, text: "a" }] }], "[00:01.00]甲")[0].words.length === 1
    );

    // ---- buildLines：逐字优先于普通 LRC ----
    const built = buildLines({
      lyric: "[00:01.00]普通歌词",
      lxlyric: "[00:01.000]<0,500>逐<500,500>字",
      tlyric: "[00:01.00]翻译",
    });
    ok("buildLines：有 lxlyric 时优先逐字", built[0].text === "逐字 | 翻译" && built[0].words.length === 2, JSON.stringify(built[0]));
    const built2 = buildLines({ lyric: "[00:01.00]普通歌词" });
    ok("buildLines：无 lxlyric 时用 LRC", built2[0].text === "普通歌词" && !built2[0].words, JSON.stringify(built2[0]));
    ok("buildLines：全空返回空数组", buildLines({}).length === 0 && buildLines().length === 0);

    // ---- decodeEntities ----
    ok(
      "decodeEntities：数字实体与常用实体",
      decodeEntities("a&#58;b &amp; c&nbsp;d &quot;e&quot; &apos;f&apos;") === "a:b & c d \"e\" 'f'",
      decodeEntities("a&#58;b &amp; c&nbsp;d &quot;e&quot; &apos;f&apos;")
    );

    // ---- fetchLyric：优先源的 lyric 能力 ----
    const fakeManager = {
      callEnabled: async () => ({ result: { lyric: "[00:01.00]来自源" }, sourceId: "s", sourceName: "S" }),
    };
    const fromSource = await fetchLyric("kw", {}, fakeManager);
    ok("fetchLyric：源提供 lyric 时优先用源", fromSource.origin === "source" && fromSource.lines[0].text === "来自源", JSON.stringify(fromSource));

    const failingManager = { callEnabled: async () => { throw new Error("源不支持 lyric"); } };
    let err = null;
    try {
      await fetchLyric("nope", {}, failingManager);
    } catch (e) {
      err = e;
    }
    ok("fetchLyric：源失败且平台不支持时给出明确错误", !!err && /暂不支持 nope/.test(err.message), err && err.message);
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();
