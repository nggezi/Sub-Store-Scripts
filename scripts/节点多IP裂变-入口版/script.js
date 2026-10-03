/**
 * 节点多 IP 裂变（入口版）—— Sub-Store「脚本操作」
 * ------------------------------------------------------------------
 * 作用：
 *   把「域名类型」的节点，用 DoH（可带 EDNS Client Subnet）解析成多个入口 IP，
 *   再把每个 IP 裂变成一个独立节点；节点名前缀标注该入口 IP 的「运营商 + IP 第一段」。
 *
 * 与 ../节点多IP裂变 的区别：
 *   那一版用 EDNS 线路名命名（移/电/联）；本版用 IP 真实归属（运营商）命名，
 *   形如「电信119 - 原名」「联通36 - 原名」。
 *
 * 流程：
 *   1) 遍历节点，对域名节点发起 DoH 解析（每个 EDNS 线路一条），拿到各自的 IP；
 *   2) 汇总所有唯一 IP，用 ip-api.com 查运营商；
 *   3) 每个唯一 IP 复制成一个新节点，server 换成该 IP，name 换成「运营商+IP首段」。
 *
 * 注意：
 *   - 只对「域名」节点裂变，server 本身是 IP 的节点原样保留；
 *   - 解析失败不抛错，会回退保留原节点；地理定位失败则回退用 EDNS 线路名命名；
 *   - 解析/地理定位都做了并发限制，避免一次性打爆 DoH 或 ip-api 被限速；
 *   - 所有可调项集中在下方 CONFIG，运行时也可用脚本参数覆盖。
 */
async function operator(proxies = [], targetPlatform, context) {
  // ==================== 配置区（按需修改） ====================
  const CONFIG = {
    // DoH 服务器地址。默认腾讯 doh.pub；也可换 'https://223.6.6.6/dns-query'、
    // 'https://223.5.5.5/dns-query'、'https://1.1.1.1/dns-query' 等。
    doh: 'https://doh.pub/dns-query',

    // 查询记录类型：'A' 解析 IPv4，'AAAA' 解析 IPv6。
    type: 'A',

    // EDNS Client Subnet 列表（ECS）。
    // 原理：向 DoH 声明「请求方位于某个网段」，权威 DNS 会优先返回该网段就近的入口 IP，
    // 从而让同一域名解析出不同运营商/地区的多个入口。
    //   name：线路标签（解析失败时用于兜底命名，不参与最终入口命名）；
    //   ip：  ECS 用的客户端 IP（不同运营商/地区各填一个）。
    edns: [
      { name: '移动', ip: '111.47.229.151' },
      { name: '电信', ip: '116.207.181.162' },
      { name: '联通', ip: '119.36.124.169' },
    ],

    // 命名是否带序号。false →「电信119 - 原名」；true →「电信119 1 - 原名」。
    seq: false,

    // 是否额外保留一条原始域名节点（未解析，直接用原 server）。
    keepOriginal: false,

    // 并发限制：
    //   resolveLimit：每批同时解析几个节点（1 = 逐个串行，最稳；调大可加速但更易触发限速）；
    //   geoipLimit：  同时查询几个 IP 的归属地（ip-api 免费版约 45 次/分，别调太大）。
    resolveLimit: 1,
    geoipLimit: 3,

    // 运营商英文 → 中文 映射。ip-api 的 isp 字段是英文，这里转成中文用于命名。
    // 顺序有意义：越具体/越靠前越优先匹配。
    ispMap: [
      [/tencent|腾讯/i, '腾讯'],
      [/alibaba|aliyun|阿里/i, '阿里'],
      [/huawei|华为/i, '华为'],
      [/telecom|chinanet|电信/i, '电信'],
      [/mobile|移动/i, '移动'],
      [/unicom|cnc|联通/i, '联通'],
      [/dr\.?peng|鹏博士/i, '鹏博士'],
      [/cernet|教育/i, '教育网'],
      [/broadcast|广电/i, '广电'],
    ],
  };
  // ============================================================

  // 运行时参数（Sub-Store「键/值」）可覆盖 CONFIG 中的 edns / doh / seq。
  // 支持三种格式：JSON 数组（只给 edns）、JSON 对象、以及 Sub-Store 传的对象。
  try {
    if (typeof $arguments !== 'undefined' && $arguments) {
      let arg = $arguments;
      // 字符串形式的 JSON 先尝试解析
      if (typeof arg === 'string') {
        const s = arg.trim();
        if (s.startsWith('{') || s.startsWith('[')) { try { arg = JSON.parse(s); } catch (e) {} }
      }
      if (Array.isArray(arg)) {
        if (arg.length) CONFIG.edns = arg; // 参数直接是 edns 数组
      } else if (arg && typeof arg === 'object') {
        if (Array.isArray(arg.edns) && arg.edns.length) CONFIG.edns = arg.edns;
        if (typeof arg.doh === 'string' && arg.doh) CONFIG.doh = arg.doh;
        // seq 兼容 true / 'true' / 1 / '1'
        if (arg.seq != null) CONFIG.seq = arg.seq === true || arg.seq === 'true' || arg.seq === 1 || arg.seq === '1';
      }
    }
  } catch (e) {}

  // 日志：优先走 Sub-Store 的 info 通道，没有就忽略（不报错）。
  const log = (msg) => {
    try { if (typeof $substore !== 'undefined' && $substore && $substore.info) $substore.info(msg); } catch (e) {}
  };

  // 按 ispMap 把英文 ISP 转中文；未命中返回空串（外层会走兜底命名）。
  const mapIsp = (isp) => {
    if (!isp) return '';
    for (const [re, name] of CONFIG.ispMap) { if (re.test(isp)) return name; }
    return '';
  };

  // 取 IP 第一段：IPv4 取第一段数字（119.36.x.x → 119），IPv6 取第一组。
  const firstSeg = (ip) => (ip || '').split(/[.:]/)[0] || '';

  // scriptResourceCache 是 Sub-Store 提供的脚本级缓存，用于避免重复 DoH / 定位请求。
  // 某些环境可能没有该对象，用 try/catch 兜底，缓存失败不影响主流程。
  const cache = scriptResourceCache;
  const cacheGet = (k) => { try { return cache.get(k); } catch (e) { return undefined; } };
  const cacheSet = (k, v) => { try { cache.set(k, v); } catch (e) {} };

  // 并发限制器：最多 limit 个任务同时执行，避免一次性打爆接口。
  const mapLimit = async (items, limit, fn) => {
    const arr = [...items];
    const results = new Array(arr.length);
    let idx = 0;
    const run = async () => {
      while (idx < arr.length) {
        const i = idx++;
        results[i] = await fn(arr[i], i);
      }
    };
    const n = Math.max(1, Math.min(limit, arr.length || 1));
    await Promise.all(Array.from({ length: n }, run));
    return results;
  };

  // 单个域名解析：对某个 EDNS 线路发起 DoH，返回去重后的 IP 数组。
  // 失败不抛错，返回空结果，避免中断整个 operator。
  const resolve = async (domain, { name, ip }) => {
    // 缓存 key：DoH + 域名 + 类型 + 线路，保证不同线路互不覆盖。
    const id = `${CONFIG.doh}:${domain}:${CONFIG.type}:${name}:${ip}`;
    const cached = cacheGet(id);
    if (cached) return cached;
    try {
      // ProxyUtils.doh 是 Sub-Store 内置的 DoH 工具；edns 传 IP 字符串即启用 ECS。
      const res = await ProxyUtils.doh({ url: CONFIG.doh, domain, type: CONFIG.type, edns: ip });
      const { answers } = res;
      if (!Array.isArray(answers) || answers.length === 0) throw new Error('No answers');
      let result = answers
        .filter((i) => i && i.type === CONFIG.type) // 只取目标记录类型（A/AAAA）
        .map((i) => i.data)
        .filter(Boolean);
      if (result.length === 0) throw new Error('No answers');
      // data 可能是字符串或数组，flat 展平后去重，再过滤非法值。
      result = [...new Set(result.flat())].filter((x) => ProxyUtils.isIP(x));
      const data = { ip, name, result };
      cacheSet(id, data);
      return data;
    } catch (e) {
      log(`resolve ${domain} via ${name || '?'} failed: ${(e && e.message) || e}`);
      return { ip, name, result: [] };
    }
  };

  // 通用 JSON 请求：兼容 $substore.http.get 与 $httpClient.get 两种 Sub-Store HTTP API。
  const fetchJson = async (url) => {
    try {
      if (typeof $substore !== 'undefined' && $substore && $substore.http && $substore.http.get) {
        const res = await $substore.http.get({ url, timeout: 6000 });
        if (res) {
          if (typeof res.body === 'string') return JSON.parse(res.body);
          if (res.body !== undefined) return res.body;
          if (res.data !== undefined) return res.data;
        }
      }
    } catch (e) {}
    try {
      if (typeof $httpClient !== 'undefined' && $httpClient && $httpClient.get) {
        const res = await $httpClient.get(url, { timeout: 6000 });
        if (res) {
          if (res.data !== undefined) return res.data;
          if (typeof res.body === 'string') return JSON.parse(res.body);
        }
      }
    } catch (e) {}
    return null;
  };

  // IP 地理定位：用 ip-api.com 只取运营商（返回 { operator }）。
  // 结果按 IP 缓存；失败返回空 operator，外层会回退用 EDNS 线路名。
  const geoip = async (ip) => {
    const cached = cacheGet('geo:' + ip);
    if (cached) return cached;
    let operator = '';
    try {
      const data = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,message,isp`);
      if (data && data.status === 'success') {
        operator = mapIsp(data.isp || '');
      }
    } catch (e) {}
    log(`geoip ${ip} => operator=${operator || '?'}`);
    const geo = { operator };
    cacheSet('geo:' + ip, geo);
    return geo;
  };

  try {
    log(`operator start, proxies=${(proxies || []).length}, edns lines=${CONFIG.edns.length}, doh=${CONFIG.doh}`);

    // 1. 解析所有域名节点：按 resolveLimit 控制并发，单节点内多条 EDNS 线路并发。
    await mapLimit(proxies || [], CONFIG.resolveLimit, async (p) => {
      if (p && p.server && !ProxyUtils.isIP(p.server)) {
        p._domain = p.server; // 记下原始域名，供 keepOriginal 使用
        p._resolved_ips = await Promise.all(
          CONFIG.edns.map(({ ip, name }) => resolve(p.server, { ip, name }))
        );
      }
    });

    // 2. 汇总全局唯一 IP，并记录每个 IP 命中了哪些 EDNS 线路（解析失败时的兜底命名用）。
    const ipLines = new Map();
    const allIps = new Set();
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      if (!Array.isArray(ips)) return;
      ips.forEach(({ name, result }) => {
        (result || []).forEach((ip) => {
          allIps.add(ip);
          if (!ipLines.has(ip)) ipLines.set(ip, []);
          const arr = ipLines.get(ip);
          if (!arr.includes(name)) arr.push(name);
        });
      });
    });
    log(`resolved unique ips=${allIps.size}`);

    // 3. 逐个唯一 IP 查归属地（按 geoipLimit 并发）。
    const geoMap = new Map();
    await mapLimit([...allIps], CONFIG.geoipLimit, async (ip) => {
      geoMap.set(ip, await geoip(ip));
    });

    // 4. 裂变命名：每个节点的每个唯一 IP 生成一条新节点。
    const list = [];
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      if (Array.isArray(ips) && ips.length > 0) {
        // 收集本节点的唯一 IP（保持首次出现顺序）
        const seen = new Set();
        const nodeIps = [];
        ips.forEach(({ result }) => {
          (result || []).forEach((ip) => {
            if (!seen.has(ip)) { seen.add(ip); nodeIps.push(ip); }
          });
        });
        nodeIps.forEach((ip, i) => {
          const geo = geoMap.get(ip) || {};
          let prefix;
          if (geo.operator) {
            // 命名：运营商 + IP 第一段（如 深圳电信 119.x.x.x → 电信119）
            prefix = geo.operator + firstSeg(ip);
          } else {
            // 兜底：EDNS 线路名（单线路用全称，多线路取首字）
            const lines = ipLines.get(ip) || [];
            prefix = lines.length === 1 ? lines[0] : lines.map((n) => n[0]).join('/');
          }
          // 复制原节点，仅替换 server 与 name，其余字段（端口/uuid/协议等）保持不变。
          const newName = CONFIG.seq ? `${prefix} ${i + 1} - ${p.name}` : `${prefix} - ${p.name}`;
          list.push({ ...p, name: newName, server: ip });
        });
        // 可选：额外保留一条原始域名节点
        if (CONFIG.keepOriginal) list.push({ ...p, name: `原始 - ${p.name}`, server: p._domain });
      } else {
        // 无解析结果 / server 本身是 IP → 原样保留
        list.push(p);
      }
    });

    log(`operator done, output=${list.length}`);
    return list;
  } catch (e) {
    // 兜底：任何意外错误都不让订阅失败，记录日志并返回原始节点。
    log(`operator ERROR: ${(e && e.stack) || e}`);
    return proxies || [];
  }
}
