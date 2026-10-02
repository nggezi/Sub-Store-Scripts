/**
 * 节点入口 & 落地检测（整合版）
 * ------------------------------------------------------------------
 * 把 xream 官方的 entrance.js（入口检测）和 geo.js（落地检测）合并成一个脚本，
 * 一次完成：域名解析 → 入口检测 → 落地检测 → 重命名。
 *
 * 运行环境要求：
 *   - 入口检测：任意环境（直接 HTTP 请求 ip-api.com，查节点服务器 IP 归属）
 *   - 落地检测：需要 Loon / Surge / Egern（通过代理发请求，查出口 IP 归属）
 *     纯 Node.js 版 Sub-Store 无法做落地检测（需配合 http-meta），脚本会自动跳过
 *
 * 使用：
 *   订阅 → 脚本操作 → 粘贴本脚本 → 按需改 CONFIG → 保存刷新
 *
 * 注意：
 *   - 落地检测会让请求数翻倍，注意调节 timeout / concurrency
 *   - 已开启缓存（scriptResourceCache），避免重复请求被风控
 *   - 默认重命名为「🇺🇸 AS123 ➮ 🇯🇵 AS456 [vmess]」格式
 *   - 可用 restoreDomain 把 server 还原为原始域名
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge, isEgern } = $.env
  const target = isLoon ? 'Loon' : isEgern ? 'Egern' : isSurge ? 'Surge' : undefined
  const canDetectExit = !!(isLoon || isSurge || isEgern)

  // ==================== 配置区（按需修改） ====================
  const CONFIG = {
    // 域名解析：是否先把域名节点解析成 IP（入口检测需要 IP）
    resolve: true,
    doh: 'https://223.6.6.6/dns-query',
    resolveType: 'A',
    // 入口检测 API（{{proxy.server}} 会被替换为节点 IP）
    entranceApi: 'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN',
    // 落地检测 API（请求通过节点代理发出，API 看到的是出口 IP）
    exitApi: 'http://ip-api.com/json?lang=zh-CN',
    // 请求参数
    timeout: 5000,
    retries: 1,
    retryDelay: 1000,
    concurrency: 10,
    // 是否移除检测失败的节点
    removeFailed: false,
    // 是否使用缓存
    cache: true,
    // 是否在最后重命名为「入口 ➮ 落地」格式
    rename: true,
    // 是否把 server 还原为原始域名（需先开启 resolve）
    restoreDomain: false,
  }
  // ============================================================

  const cache = scriptResourceCache

  // Phase 0: 域名解析
  if (CONFIG.resolve) {
    await executeAsyncTasks(proxies.map(p => () => resolveDomain(p)), { concurrency: CONFIG.concurrency })
  }

  // Phase 1: 入口检测
  await executeAsyncTasks(proxies.map(p => () => checkEntrance(p)), { concurrency: CONFIG.concurrency })

  // Phase 2: 落地检测（仅 Loon/Surge/Egern）
  if (canDetectExit) {
    await executeAsyncTasks(proxies.map(p => () => checkExit(p)), { concurrency: CONFIG.concurrency })
  }

  // Phase 3: 重命名
  if (CONFIG.rename) {
    for (const p of proxies) renameNode(p)
  }

  // Phase 4: 还原域名
  if (CONFIG.restoreDomain) {
    for (const p of proxies) {
      if (p._domain) {
        p.server = p._domain
        delete p._domain
      }
    }
  }

  // 过滤失败节点
  if (CONFIG.removeFailed) {
    proxies = proxies.filter(p => p._entrance && (!canDetectExit || p._geo))
  }

  return proxies

  // ==================== 域名解析 ====================
  async function resolveDomain(proxy) {
    const server = proxy.server
    if (!server || ProxyUtils.isIP(server)) return
    try {
      const res = await ProxyUtils.doh({ url: CONFIG.doh, domain: server, type: CONFIG.resolveType })
      const answers = (res && res.answers) || []
      const ips = answers.filter(a => a && a.type === CONFIG.resolveType).map(a => a.data).filter(Boolean)
      const ip = [...new Set(ips.flat())][0]
      if (ip && ProxyUtils.isIP(ip)) {
        proxy._domain = server
        proxy.server = ip
      }
    } catch (e) { /* 解析失败则保留原域名 */ }
  }

  // ==================== 入口检测 ====================
  async function checkEntrance(proxy) {
    const id = CONFIG.cache ? `entrance:${proxy.server}` : undefined
    try {
      const cached = cache.get(id)
      if (CONFIG.cache && cached) {
        if (cached.api) { proxy._entrance = cached.api; return }
        return
      }
      const res = await http({
        method: 'get',
        url: formatter({ proxy, format: CONFIG.entranceApi }),
      })
      let api = String(lodash_get(res, 'body'))
      try { api = JSON.parse(api) } catch (e) {}
      const status = parseInt(res.status || res.statusCode || 200)
      if (status == 200 && api && (api.countryCode || api.country)) {
        proxy._entrance = api
        if (CONFIG.cache) cache.set(id, { api })
      } else if (CONFIG.cache) {
        cache.set(id, {})
      }
    } catch (e) {
      if (CONFIG.cache) cache.set(id, {})
    }
  }

  // ==================== 落地检测 ====================
  async function checkExit(proxy) {
    const id = CONFIG.cache ? `exit:${proxy.server}:${proxy.port}:${proxy.type}` : undefined
    try {
      const cached = cache.get(id)
      if (CONFIG.cache && cached) {
        if (cached.api) { proxy._geo = cached.api; return }
        return
      }
      // ProxyUtils.produce 生成代理策略描述符，让 HTTP 请求通过该节点发出
      let node
      if (isEgern) {
        node = JSON.stringify(ProxyUtils.produce([proxy], target, 'internal', {})[0])
      } else {
        node = ProxyUtils.produce([proxy], target, undefined, {})
      }
      if (!node) return
      const res = await http({
        method: 'get',
        url: CONFIG.exitApi,
        'policy-descriptor': node,
        node,
      })
      let api = String(lodash_get(res, 'body'))
      try { api = JSON.parse(api) } catch (e) {}
      const status = parseInt(res.status || res.statusCode || 200)
      if (status == 200 && api && (api.countryCode || api.country)) {
        proxy._geo = api
        if (CONFIG.cache) cache.set(id, { api })
      } else if (CONFIG.cache) {
        cache.set(id, {})
      }
    } catch (e) {
      if (CONFIG.cache) cache.set(id, {})
    }
  }

  // ==================== 重命名 ====================
  function renameNode(proxy) {
    const { _entrance, _geo } = proxy
    if (!_entrance && !_geo) return
    const flag = (cc) => ProxyUtils.getFlag(cc || '').replace(/🇹🇼/g, '🇼🇸')
    if (_entrance && _geo) {
      const eFlag = flag(_entrance.countryCode)
      const gFlag = flag(_geo.countryCode)
      // 入口和出口不同 → 显示「入口 ➮ 落地」；相同 → 只显示落地
      proxy.name = (_entrance.aso !== _geo.aso || _entrance.countryCode !== _geo.countryCode)
        ? `${eFlag} ${_entrance.aso} ➮ ${gFlag} ${_geo.aso} [${proxy.type}]`
        : `${gFlag} ${_geo.aso} [${proxy.type}]`
    } else if (_entrance) {
      proxy.name = `${flag(_entrance.countryCode)} ${_entrance.aso} [${proxy.type}]`
    } else {
      proxy.name = `${flag(_geo.countryCode)} ${_geo.aso} [${proxy.type}]`
    }
    delete proxy._entrance
    delete proxy._geo
  }

  // ==================== 工具函数 ====================
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || CONFIG.timeout)
    const RETRIES = parseFloat(opt.retries ?? CONFIG.retries)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? CONFIG.retryDelay)
    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY * count)
          return await fn()
        }
        throw e
      }
    }
    return await fn()
  }

  function formatter({ proxy = {}, api = {}, format = '' }) {
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}')
    return eval(`\`${f}\``)
  }

  function lodash_get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.')
    let result = source
    for (const p of paths) {
      result = Object(result)[p]
      if (result === undefined) return defaultValue
    }
    return result
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve) => {
      let running = 0
      let index = 0
      function next() {
        while (index < tasks.length && running < concurrency) {
          const i = index++
          running++
          tasks[i]().finally(() => {
            running--
            next()
          })
        }
        if (running === 0) resolve()
      }
      next()
    })
  }
}
