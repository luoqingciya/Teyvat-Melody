// 在线搜索解析自检：node tests/search.js
//
// 说明：本机外网被沙箱代理限制，无法直连四平台接口，因此这里用**按各平台公开接口
// 文档/常见响应形状构造的样本**验证解析与归一化逻辑（纯函数，不联网）。
// 真正对接线上接口仍需在用户本机跑一次（见 docs 的 Phase 3 补充）。
const {
  normalize,
  parseLooseJson,
  parseTx,
  parseKg,
  parseWy,
  parseKw,
  search,
} = require("../electron/onlineSearch");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// ---------------- 样本 ----------------

const TX_SAMPLE = {
  code: 0,
  data: {
    song: {
      list: [
        {
          songmid: "0039MnYb0qxYhV",
          songname: "晴天",
          singer: [{ id: 4558, mid: "0025NhlN2yWrP4", name: "周杰伦" }],
          albumname: "叶惠美",
          albummid: "002fRO0N4FftzY",
          interval: 269,
          songid: 123456,
        },
        { songname: "缺 songmid 的记录", singer: [], interval: 100 },
        {
          songmid: "001Qu4I30eVFYb",
          songname: "七里香",
          singer: [{ name: "周杰伦" }, { name: "方文山" }],
          albumname: "七里香",
          interval: 299,
        },
      ],
    },
  },
};

const KG_SAMPLE = {
  status: 1,
  data: {
    lists: [
      {
        FileHash: "ABC123DEF456",
        SongName: "晴天",
        SingerName: "周杰伦",
        AlbumName: "叶惠美",
        Duration: 269,
        AlbumID: "100",
        AudioID: 200,
        EMixSongID: "emix1",
      },
      { SongName: "缺 FileHash 的记录", SingerName: "x", Duration: 10 },
    ],
  },
};

const WY_SAMPLE = {
  code: 200,
  result: {
    songs: [
      {
        id: 186016,
        name: "晴天",
        ar: [{ id: 6452, name: "周杰伦" }],
        al: { id: 18874, name: "叶惠美" },
        dt: 269000,
        fee: 0,
      },
    ],
  },
};

// 酷我老接口：单引号伪 JSON + &nbsp; 实体 + 转义单引号
const KW_SAMPLE_TEXT =
  "{'abslist':[" +
  "{'SONGNAME':'晴天','ARTIST':'周杰伦&nbsp;/&nbsp;方文山','ALBUM':'叶惠美','DURATION':'269','MUSICRID':'MUSIC_228908','DC_TARGETID':'228908','ALBUMID':'123'}," +
  "{'SONGNAME':'缺 rid 的记录','ARTIST':'x','DURATION':'10'}" +
  "]}";

// ---------------- 用例 ----------------

(async () => {
  try {
    // ---- normalize ----
    const n = normalize("kw", { pid: "1", name: "  歌名  ", singer: "", album: null, duration: "269.6", meta: { rid: "1" } });
    ok("normalize：id 形如 online:{平台}:{ID}", n.id === "online:kw:1", n.id);
    ok("normalize：online 标记", n.online === true);
    ok("normalize：name/title 双写（复用本地渲染）", n.name === "歌名" && n.title === "歌名", JSON.stringify(n));
    ok("normalize：artist 空值保持空串", n.artist === "");
    ok("normalize：album 缺失归一为空串", n.album === "");
    ok("normalize：duration 取整（含字符串输入）", n.duration === 270 && n.interval === 270, String(n.duration));

    const n2 = normalize("kg", { pid: "h", name: "", duration: 0 });
    ok("normalize：空歌名兜底", n2.title === "未知歌曲", n2.title);

    // ---- tx ----
    const tx = parseTx(TX_SAMPLE);
    ok("tx：过滤缺 songmid 的记录", tx.length === 2, String(tx.length));
    ok("tx：id / 平台 ID 正确", tx[0].id === "online:tx:0039MnYb0qxYhV" && tx[0].meta.songmid === "0039MnYb0qxYhV", JSON.stringify(tx[0]));
    ok("tx：多歌手用 / 连接", tx[1].artist === "周杰伦 / 方文山", tx[1].artist);
    ok("tx：时长与专辑", tx[0].duration === 269 && tx[0].album === "叶惠美", JSON.stringify(tx[0]));

    // ---- kg ----
    const kg = parseKg(KG_SAMPLE);
    ok("kg：过滤缺 FileHash 的记录", kg.length === 1, String(kg.length));
    ok("kg：hash 同时写入 meta.hash 与 meta.FileHash",
      kg[0].meta.hash === "ABC123DEF456" && kg[0].meta.FileHash === "ABC123DEF456", JSON.stringify(kg[0].meta));
    ok("kg：歌手为纯字符串", kg[0].artist === "周杰伦" && kg[0].duration === 269, JSON.stringify(kg[0]));

    // ---- wy ----
    const wy = parseWy(WY_SAMPLE);
    ok("wy：毫秒转秒", wy[0].duration === 269, String(wy[0].duration));
    ok("wy：id 与专辑 id", wy[0].id === "online:wy:186016" && wy[0].meta.albumId === 18874, JSON.stringify(wy[0]));
    ok(
      "wy：带 songmid / hash 别名（兼容不同源脚本取值习惯）",
      wy[0].meta.songmid === "186016" && wy[0].meta.hash === "186016",
      JSON.stringify(wy[0].meta)
    );

    // ---- kw（伪 JSON） ----
    const loose = parseLooseJson(KW_SAMPLE_TEXT);
    ok("kw：伪 JSON 可解析出 abslist", Array.isArray(loose?.abslist) && loose.abslist.length === 2, JSON.stringify(loose));
    ok("kw：&nbsp; 实体被还原为空格", loose.abslist[0].ARTIST === "周杰伦 / 方文山", loose.abslist[0].ARTIST);

    const kw = parseKw(loose);
    ok("kw：过滤缺 rid 的记录", kw.length === 1, String(kw.length));
    ok("kw：MUSIC_ 前缀已剥离", kw[0].meta.rid === "228908" && kw[0].id === "online:kw:228908", JSON.stringify(kw[0]));
    // 源脚本读的字段名与我们的不同：实测独家音源读 kw 的 songmid（hash 亦可），
    // 只给 rid 会导致取不到 ID、源后端直接报错。这里守住别名必须带上。
    ok(
      "kw：带 songmid / hash 别名（源脚本实际读的字段）",
      kw[0].meta.songmid === "228908" && kw[0].meta.hash === "228908",
      JSON.stringify(kw[0].meta)
    );

    // 转义单引号：走 JSON.parse 分支也要语义正确
    const esc = parseLooseJson("{'abslist':[{'SONGNAME':'it\\'s ok','MUSICRID':'MUSIC_1'}]}");
    ok("kw：转义单引号语义不漂移", esc.abslist[0].SONGNAME === "it's ok", JSON.stringify(esc));

    // 空沙箱兜底分支：JSON.parse 一定失败（值里带未转义换行）时仍能求值
    const fallback = parseLooseJson("{'abslist':[{'SONGNAME':'a' + 'b','MUSICRID':'MUSIC_9'}]}");
    ok("kw：JSON 失败时退回空沙箱求值", fallback.abslist[0].SONGNAME === "ab", JSON.stringify(fallback));

    // 酷我把 & 写成**双重转义**的 \\u0026：响应体里就是两个反斜杠，
    // JSON.parse 之后仍剩一个字面量 \u0026，不还原就会把「周杰伦\u0026五月天」
    // 原样显示给用户（真实界面截图里肉眼可见）。这里守住还原逻辑。
    const amp = normalize("kw", {
      pid: "9",
      name: "甲\\u0026乙", // 单层转义：JSON.parse 已还原成 &，这里不该再动
      singer: "丙\\\\u0026丁", // 双层转义：parse 后仍是字面量 \u0026，必须还原
      album: "A&amp;B",
      duration: 1,
      meta: { rid: "9" },
    });
    ok("normalize：还原双重转义的 \\u0026（酷我常见）", amp.artist === "丙&丁", amp.artist);
    ok("normalize：单层转义不受影响", amp.title === "甲&乙", amp.title);
    ok("normalize：HTML 实体一并还原", amp.album === "A&B", amp.album);

    const kwAmp = parseKw(
      parseLooseJson("{'abslist':[{'ARTIST':'周杰伦\\\\u0026五月天','NAME':'志明与春娇','MUSICRID':'MUSIC_1'}]}")
    );
    ok("kw：双重转义在入库前已还原（不会显示成 \\u0026）", kwAmp[0].artist === "周杰伦&五月天", kwAmp[0].artist);

    // ---- search 边界 ----
    const empty = await search("");
    ok("search：空关键词直接返回空", empty.list.length === 0 && empty.errors.length === 0, JSON.stringify(empty));

    const bogus = await search("晴天", ["nope"]);
    ok("search：非法平台返回明确错误", bogus.list.length === 0 && /没有可用的搜索平台/.test(bogus.errors[0] || ""), JSON.stringify(bogus));
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();
