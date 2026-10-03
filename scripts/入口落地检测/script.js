/**
 * 入口 & 落地 检测（http-meta 版）
 * ------------------------------------------------------------------
 * 把 Sub-Store「处理」配置 entrance-geo-test-http-meta.json 脚本化：
 * 用官方脚本 API ProxyUtils.process 在一个脚本里跑完整条 process[] 链，
 * 效果与导入那份 JSON 完全一致，但可以托管到 GitHub、贴脚本链接直接用。
 *
 * 处理链（11 步，顺序不能改）：
 *   1. 快速设置      udp/tfo/skip-cert-verify 置 ENABLED
 *   2. 正则筛选      丢掉 `#` / `//` 开头的注释行
 *   3. 域名解析      Google 解析 IPv4
 *   4. 域名解析      Cloudflare 解析 IPv6，filter=IPOnly 只留已成 IP 的节点
 *   5. 去重          按 server+port+type 去重，清掉 _geo/_entrance
 *   6. 落地检测      xream http_meta_geo.js（经 http-meta 查出口 IP 归属）
 *   7. 入口检测      xream entrance.js（查节点服务器 IP 归属）
 *   8. 脚本筛选      只保留 _geo && _entrance 都拿到的节点
 *   9. 重命名        `🇺🇸 aso ➮ 🇯🇵 aso [type]`，入口=落地时只留落地
 *  10. 排序          按名称升序
 *  11. 重名加角标    重名节点追加 ⁰¹²³… 上标
 *
 * ⚠️ 运行前提：
 *   - 面向 Node.js / Docker 版 Sub-Store（第 6 步 http_meta_geo.js 会连本地 http-meta）
 *   - 需要本地跑 http-meta（https://github.com/xream/http-meta），默认 127.0.0.1:9876
 *     App 版（Surge/Loon）没有 http-meta，整条链会报错，请改用 xream 的 geo.js
 *   - Node.js 版 Sub-Store 需设置 SUB_STORE_FRONTEND_BACKEND_PATH（脚本操作的通用要求）
 *
 * 用法：
 *   订阅 → 节点操作 → 脚本操作 → 填本脚本的 raw 链接，可带 `#` 参数覆盖 CONFIG
 *   默认 internal=auto：有本地 GeoIP 库就用本地库，缺库自动回退在线 ip-api
 *   例：https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/入口落地检测/script.js
 */
async function operator(proxies = [], targetPlatform, context) {
  // ==================== 配置区（可用链接 `#参数` 覆盖） ====================
  const CONFIG = {
    // 'auto' = 自动探测：本地 GeoIP 库可用就用它，缺库则回退在线 IP 库（推荐）
    // true   = 强制内置 GeoIP 库（MMDB / $utils），离线查归属
    // false  = 强制在线 IP 库（ip-api.com）
    // 对应两份源 JSON：true ≈ -internal-geoip，false ≈ entrance-geo-test-http-meta
    internal: 'auto',
    // 域名解析的 DNS 服务提供方，可选 Ali / Tencent / Google / Cloudflare / Custom / IP-API
    // 默认 Ali（223.6.6.6，国内直连可达）。
    // 源 JSON 用的是 Google + Cloudflare，国内不通会让域名节点被 filter=IPOnly 静默丢掉，
    // 所以这里换了默认值；要还原源 JSON 行为用 #dns4=Google&dns6=Cloudflare
    dns4: 'Ali',
    dns6: 'Ali',
    // provider=Custom 时的 DoH/DoT/UDP 地址，多个用换行分隔；仅 provider 为 Custom 时生效
    dnsUrl: '',
    retries: '1',
    timeout: '1999',
  }
  // ========================================================================

  const args = typeof $arguments !== 'undefined' && $arguments ? $arguments : {}
  const rawInternal = args.internal === undefined ? CONFIG.internal : args.internal
  const internal = resolveInternal(rawInternal)
  const retries = args.retries === undefined ? CONFIG.retries : String(args.retries)
  const timeout = args.timeout === undefined ? CONFIG.timeout : String(args.timeout)

  // DNS provider 必须先校验：ResolveDomainOperator 的工厂函数会直接 throw，
  // 而那个 throw 发生在 process 循环里，会把整条链炸掉而不是跳过单步
  const dns4 = resolveDnsProvider(args.dns4, CONFIG.dns4, 'IPv4', args.dnsUrl, CONFIG.dnsUrl)
  const dns6 = resolveDnsProvider(args.dns6, CONFIG.dns6, 'IPv6', args.dnsUrl, CONFIG.dnsUrl)
  const dnsUrl = args.dnsUrl === undefined ? CONFIG.dnsUrl : String(args.dnsUrl)

  // 让用户在日志里确认这次实际走了哪套数据源
  console.log(`[SCOPE] INFO: 归属地数据源 = ${internal ? '本地 GeoIP 库' : '在线 IP 库'}（internal=${rawInternal}）`);

  // 落地检测：经 http-meta 起核心，用节点出口访问 IP 查询接口
  // internal 时响应视为纯文本 IP，改由本地 GeoIP 库解析（默认接口换为 checkip.amazonaws.com）
  const geoUrl =
    'https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/' +
    `check/http_meta_geo.js#${internal ? 'internal&' : ''}geo&retries=${retries}&timeout=${timeout}&cache`

  // 入口检测：直接查节点服务器 IP 的归属，不经代理
  // internal 时用 GeoIP 库离线解析，省掉一次 HTTP 请求
  const entranceUrl =
    'https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/' +
    `check/entrance.js#${internal ? 'internal&' : ''}entrance&cache&incompatible&remove_failed` +
    `&retries=${retries}&timeout=${timeout}`

  // 重命名取的字段两套接口不一样：ip-api 给 country/isp，GeoIP 库给 countryCode/aso
  const RENAME = internal ? RENAME_INTERNAL : RENAME_ONLINE

  const process = [
    {
      type: 'Quick Setting Operator',
      args: {
        useless: 'DISABLED',
        udp: 'ENABLED',
        scert: 'ENABLED',
        tfo: 'ENABLED',
        'vmess aead': 'DEFAULT',
      },
    },
    // 丢掉注释行（`# xxx` / `// xxx`），它们不是节点
    { type: 'Regex Filter', args: { keep: false, regex: ['^(#|\\/\\/)'] } },
    // 域名节点先解析成 IP：入口检测要拿 IP 才能查归属
    {
      type: 'Resolve Domain Operator',
      args: { provider: dns4, type: 'IPv4', filter: 'disabled', cache: 'enabled', url: dnsUrl },
    },
    // 再补一轮 IPv6；filter=IPOnly 把仍没解析出 IP 的域名节点筛掉
    {
      type: 'Resolve Domain Operator',
      args: { provider: dns6, type: 'IPv6', filter: 'IPOnly', cache: 'enabled', url: dnsUrl },
    },
    // 同 server+port+type 视为重复节点，只留第一个
    { type: 'Script Operator', args: { mode: 'script', content: DEDUP_SCRIPT } },
    // 落地检测（_geo）
    { type: 'Script Operator', args: { mode: 'link', content: geoUrl } },
    // 入口检测（_entrance）
    { type: 'Script Operator', args: { mode: 'link', content: entranceUrl } },
    // 两项都测到的才留；缺任一项说明该节点检测失败
    { type: 'Script Filter', args: { mode: 'script', content: 'return $server._geo && $server._entrance' } },
    // 重命名
    { type: 'Script Operator', args: { mode: 'script', content: RENAME } },
    // 按名称升序，让重名节点挨在一起
    { type: 'Sort Operator', args: 'asc' },
    // 重名的追加 ⁰¹²³ 上标；link 留空表示直接接在名字后面
    {
      type: 'Handle Duplicate Operator',
      args: { action: 'rename', position: 'back', template: '⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹', link: '' },
    },
  ]

  // ProxyUtils.process 是 Sub-Store 官方脚本 API，等价于订阅里配置一整条处理链
  // source / raw / $options 原样透传，让链内脚本拿到和导入 JSON 时相同的上下文
  const source = context && context.source !== undefined ? context.source : undefined
  const raw = context && context.raw !== undefined ? context.raw : undefined
  const opts = typeof $options !== 'undefined' ? $options : undefined

  return await ProxyUtils.process(proxies, process, targetPlatform, source, opts, raw, {})
}

// `internal` 参数三态：
//   不传 / 'auto' -> 自动探测，本地库可用就用本地，否则回退在线
//   '#internal' 或 '#internal=true' -> 强制本地库
//   '#internal=false' -> 强制在线库
function resolveInternal(value) {
  if (value === undefined || value === null || value === '' || String(value).toLowerCase() === 'auto') {
    return hasLocalGeoip();
  }
  return toBool(value);
}

// 本地 GeoIP 库是否真的可用。三处都会用到它，必须和下游脚本的判断保持一致：
//   - 代理 App 版：entrance.js 靠 $utils.geoip / $utils.ipaso
//   - Node.js 版：靠 ProxyUtils.MMDB（读 SUB_STORE_MMDB_COUNTRY_PATH / ASN_PATH）
// 构造 MMDB 时文件不存在会直接抛错（见 backend/src/utils/geo.js:796、806），所以要用 try 包住
function hasLocalGeoip() {
  // 代理 App 版（Surge / Loon build >= 692）自带 $utils
  try {
    if (
      typeof $utils !== 'undefined' &&
      $utils &&
      typeof $utils.geoip === 'function' &&
      typeof $utils.ipaso === 'function'
    ) {
      return true;
    }
  } catch (e) {
    /* $utils 未定义时 typeof 不会抛，这里兜个底 */
  }
  // Node.js 版：country 和 asn 两个库都得在，否则重名改名时会缺字段
  try {
    const mmdb = new ProxyUtils.MMDB();
    return !!(mmdb && mmdb.geoip('1.1.1.1') && mmdb.ipaso('1.1.1.1'));
  } catch (e) {
    return false;
  }
}

// 校验并归一化 DNS provider。
// 这层校验不能省：ResolveDomainOperator 的工厂在 provider 无效、或 IP-API 解 IPv6 时
// 会直接 throw（见 backend/src/core/proxy-utils/processors/index.js:1135、1148），
// 而那个 throw 抛在 process 的 for 循环里，会整链失败而不是跳过该步骤。
function resolveDnsProvider(value, dft, type, urlValue, urlDft) {
  const provider = String(value === undefined ? dft : value).trim()
  const known = ['Custom', 'Google', 'IP-API', 'Cloudflare', 'Ali', 'Tencent']
  if (!known.includes(provider)) {
    throw new Error(`无效的 DNS 提供方 "${provider}"，可选：${known.join(' / ')}`)
  }
  if (provider === 'IP-API' && type === 'IPv6') {
    throw new Error('DNS 提供方 IP-API 不支持解析 IPv6，请改用 Ali / Tencent / Cloudflare 等')
  }
  if (provider === 'Custom' && !String(urlValue === undefined ? urlDft : urlValue).trim()) {
    throw new Error('provider 为 Custom 时必须提供 dnsUrl（#dnsUrl=https://dns.alidns.com/dns-query）')
  }
  return provider
}

// `#internal` 解析出来是 true，`#internal=false` 是字符串，统一成布尔值
function toBool(value) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return false
  const s = String(value).toLowerCase()
  return !(s === '' || s === 'false' || s === '0' || s === 'off' || s === 'disabled')
}

// 按 server+port+type 去重，并清掉上一轮检测留下的字段
const DEDUP_SCRIPT = `function operator(proxies = []) {
    function removeDuplicates(arr, fields) {
        const map = new Map()
        return arr.filter(item => {
            const key = fields.map(field => item[field]).join('-')
            if (map.has(key)) {
                return false
            } else {
                map.set(key, true)
                return true
            }
        })
    }
    return removeDuplicates(proxies, ['server', 'port', 'type']).map(i => {
      delete i._geo
      delete i._entrance
      return i
    })
}
`

// 在线 IP 库（ip-api.com）：country 为国家名，isp 为运营商
const RENAME_ONLINE = "\nconst { _entrance, _geo } = $server\n\nlet entranceFlag = ProxyUtils.getFlag(_entrance.country).replace(/🇹🇼/g, '🇼🇸')\nlet geoFlag = ProxyUtils.getFlag(_geo.country).replace(/🇹🇼/g, '🇼🇸')\n$server.name = (_entrance.isp !== _geo.isp || _entrance.country !== _geo.country) ? `${entranceFlag} ${_entrance.isp} ➮ ${geoFlag} ${_geo.isp} [${$server.type}]` : `${geoFlag} ${_geo.isp} [${$server.type}]`\n\ndelete $server._entrance\ndelete $server._geo"

// 内置 GeoIP 库：countryCode 为国家码，aso 为运营商/ASN 名
const RENAME_INTERNAL = "\nconst { _entrance, _geo } = $server\n\nlet entranceFlag = ProxyUtils.getFlag(_entrance.countryCode).replace(/🇹🇼/g, '🇼🇸')\nlet geoFlag = ProxyUtils.getFlag(_geo.countryCode).replace(/🇹🇼/g, '🇼🇸')\n$server.name = (_entrance.aso !== _geo.aso || _entrance.countryCode !== _geo.countryCode) ? `${entranceFlag} ${_entrance.aso} ➮ ${geoFlag} ${_geo.aso} [${$server.type}]` : `${geoFlag} ${_geo.aso} [${$server.type}]`\n\ndelete $server._entrance\ndelete $server._geo"
