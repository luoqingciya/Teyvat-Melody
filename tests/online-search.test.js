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

    // ---- 分页：各平台的页码参数名与起始值都不同，这里守住转换 ----
    // 用本地 HTTP 服务器接住请求，按 URL 里的分页参数决定返回几条，
    // 从而既能验参数也验 hasMore 推导（不依赖外网）。
    await testPagination();
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();

/**
 * 分页自检。
 *
 * 各平台约定（是这几家的历史包袱，不能想当然）：
 *   · tx：`p`，从 1 开始
 *   · kg：`page`，从 1 开始
 *   · wy：`offset`，是**条数偏移**（page 1 → 0）
 *   · kw：`pn`，是**页索引**，从 0 开始（page 1 → 0）
 * 对策：对外统一「1 起的页码」，转换只发生在适配器里 —— 本测试就是守住这条边界。
 */
async function testPagination() {
  const http = require("http");
  const seen = []; // 记录每个平台收到的分页参数

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const path = u.pathname;
    // POST 的 wy 请求：参数在 body 里，这里统一读出来
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(req.method === "POST" ? body : u.search);
      const pick = (k) => params.get(k);
      // 让「第 2 页」返回 1 条（模拟到底），第 1 页返回 2 条（满页 → hasMore）
      const isSecondPage = (() => {
        if (path.includes("client_search_cp")) return pick("p") === "2";
        if (path.includes("song_search_v2")) return pick("page") === "2";
        if (path.includes("cloudsearch")) return pick("offset") === "2";
        if (path.includes("r.s")) return pick("pn") === "1";
        return false;
      })();
      seen.push({ path, p: pick("p"), page: pick("page"), offset: pick("offset"), pn: pick("pn"), n: pick("n") || pick("pagesize") || pick("limit") || pick("rn") });

      const n = Number(pick("n") || pick("pagesize") || pick("limit") || pick("rn") || 2);
      const count = isSecondPage ? 1 : n;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (path.includes("client_search_cp")) {
        res.end(
          JSON.stringify({
            data: {
              song: {
                list: Array.from({ length: count }, (_, i) => ({
                  songmid: `tx${isSecondPage ? 2 : 1}_${i}`,
                  songname: "t",
                  singer: [],
                  interval: 100,
                  albumname: "a",
                })),
              },
            },
          })
        );
      } else if (path.includes("song_search_v2")) {
        res.end(
          JSON.stringify({
            data: {
              lists: Array.from({ length: count }, (_, i) => ({
                FileHash: `kg${isSecondPage ? 2 : 1}_${i}`,
                SongName: "t",
                SingerName: "s",
                Duration: 100,
              })),
            },
          })
        );
      } else if (path.includes("cloudsearch")) {
        res.end(
          JSON.stringify({
            result: {
              songs: Array.from({ length: count }, (_, i) => ({
                id: isSecondPage ? 2000 + i : 1000 + i,
                name: "t",
                ar: [],
                al: {},
                dt: 100000,
              })),
            },
          })
        );
      } else {
        res.end(
          "{'abslist':[" +
            Array.from(
              { length: count },
              (_, i) => `{'SONGNAME':'t','ARTIST':'s','DURATION':'100','MUSICRID':'MUSIC_kw${isSecondPage ? 2 : 1}_${i}'}`
            ).join(",") +
            "]}"
        );
      }
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 四个平台的接口地址是硬编码 https 的，外网在本机被沙箱拦着。
  // 这里拦下 http/https 两个模块的 request，把出站请求改写到本地服务器 ——
  // **统一用 http.request 发出**（本地服务器是明文 HTTP，若仍走 https 会握手失败）。
  const mod = require("../electron/onlineSearch");
  const httpMod = require("http");
  const httpsMod = require("https");
  const origHttpRequest = httpMod.request;
  const origHttpsRequest = httpsMod.request;

  const rewrite =
    () =>
    function (options, cb) {
      if (typeof options === "object" && options.hostname && options.hostname !== "127.0.0.1") {
        const target = new URL(options.path || "/", base);
        return origHttpRequest.call(
          this,
          { ...options, hostname: target.hostname, port: target.port, path: target.pathname + target.search },
          cb
        );
      }
      return origHttpRequest.apply(this, arguments);
    };
  httpMod.request = rewrite();
  httpsMod.request = rewrite();

  try {
    // 第 1 页：每平台 2 条 × 4 平台 = 8 条，且 hasMore 应为 true（有平台返回了满页）
    const p1 = await mod.search("晴天", ["tx", "kg", "wy", "kw"], 2, 1);
    ok("分页：第 1 页四平台合计 8 条（每平台 2 条）", p1.list.length === 8, String(p1.list.length));
    ok("分页：第 1 页 hasMore=true（有平台返回满页）", p1.hasMore === true, String(p1.hasMore));
    ok("分页：回传当前页与每页条数", p1.page === 1 && p1.limit === 2, JSON.stringify({ page: p1.page, limit: p1.limit }));

    // 各平台的参数名与起始值
    const calls1 = seen.filter((s) => s.path);
    const tx1 = calls1.find((s) => s.path.includes("client_search_cp"));
    ok("分页：tx 用 p，且第 1 页 p=1", tx1.p === "1", JSON.stringify(tx1));
    const kg1 = calls1.find((s) => s.path.includes("song_search_v2"));
    ok("分页：kg 用 page，且第 1 页 page=1", kg1.page === "1", JSON.stringify(kg1));
    const wy1 = calls1.find((s) => s.path.includes("cloudsearch"));
    ok("分页：wy 用 offset（条数偏移），第 1 页 offset=0", wy1.offset === "0", JSON.stringify(wy1));
    const kw1 = calls1.find((s) => s.path.includes("r.s"));
    ok("分页：kw 用 pn（页索引 0 起），第 1 页 pn=0", kw1.pn === "0", JSON.stringify(kw1));

    seen.length = 0;
    // 第 2 页：每平台退到只剩 1 条 × 4 = 4 条，且 hasMore 应为 false（没有平台再返回满页）
    const p2 = await mod.search("晴天", ["tx", "kg", "wy", "kw"], 2, 2);
    ok("分页：第 2 页四平台合计 4 条（每平台 1 条）", p2.list.length === 4, String(p2.list.length));
    ok("分页：第 2 页没有满页 → hasMore=false", p2.hasMore === false, String(p2.hasMore));
    ok("分页：第 2 页的结果与第 1 页 id 不同（确实翻了页）", p2.list.every((s) => !p1.list.some((x) => x.id === s.id)));

    const tx2 = seen.find((s) => s.path.includes("client_search_cp"));
    ok("分页：tx 第 2 页 p=2", tx2.p === "2", JSON.stringify(tx2));
    const kg2 = seen.find((s) => s.path.includes("song_search_v2"));
    ok("分页：kg 第 2 页 page=2", kg2.page === "2", JSON.stringify(kg2));
    const wy2 = seen.find((s) => s.path.includes("cloudsearch"));
    ok("分页：wy 第 2 页 offset=2（= (2-1)×2）", wy2.offset === "2", JSON.stringify(wy2));
    const kw2 = seen.find((s) => s.path.includes("r.s"));
    ok("分页：kw 第 2 页 pn=1（= 2-1）", kw2.pn === "1", JSON.stringify(kw2));

    // 单平台失败不影响其它平台 —— 翻页时尤其重要，否则一个平台挂了连翻页都点不动
    const partial = await mod.search("晴天", ["tx", "nope"], 2, 1);
    ok("分页：非法平台被过滤后仍能返回其它平台结果", partial.list.length > 0, JSON.stringify(partial.list.length));
  } finally {
    httpMod.request = origHttpRequest;
    httpsMod.request = origHttpsRequest;
    server.close();
  }
}
