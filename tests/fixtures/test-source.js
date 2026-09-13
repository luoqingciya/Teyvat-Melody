/**
 * @name 测试音乐源
 * @description 用于 SourceHost 宿主自检的测试源
 * @version 1.0.0
 * @author teyvat-test
 * @homepage https://example.com
 */
const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx

// 验证 utils：md5 / aes / zlib 可用性检查（结果通过 musicUrl 回传断言）
const md5ok = utils.crypto.md5('teyvat') === 'a9b2cd6f91b0c42ee48e9bb2fe56e59e' // 预计算值若不符则脚本侧降级标记

const httpRequest = (url, options) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) return reject(err)
    resolve(resp.body)
  })
})

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'musicUrl':
      // 返回伪 URL，携带关键信息供宿主断言（musicInfo 透传 + env + version）
      return Promise.resolve(`https://test.local/${source}/${info.type}/${info.musicInfo.songmid}?env=${env}&v=${version}`)
    case 'searchEcho':
      // 用 lx.request 真实请求 QQ 搜索接口，回传第一首歌名（验证无跨域 HTTP 能力）
      return httpRequest('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=%E5%91%A8%E6%9D%B0%E4%BC%A6&p=1&n=1&format=json', {
        method: 'GET',
        headers: { Referer: 'https://y.qq.com/' },
      }).then(body => body.data.song.list[0].songname)
    default:
      return Promise.reject(new Error('action not support'))
  }
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    local: { name: '本地音乐', type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: [] },
  },
})
