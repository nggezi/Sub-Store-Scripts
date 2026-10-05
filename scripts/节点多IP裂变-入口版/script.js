/**
 * 节点多 IP 裂变（入口版）—— Sub-Store「脚本操作」
 * ------------------------------------------------------------------
 * 作用：
 *   把「域名类型」的节点，用 DoH（可带 EDNS Client Subnet）解析成多个入口 IP，
 *   再把每个 IP 裂变成一个独立节点；节点名前缀标注该入口 IP 的「运营商 + IP 第一段」。
 *
 * 与 ../节点多IP裂变 的区别：
 *   那一版用 EDNS 线路名命名（移/电/联）；本版用 IP 真实归属命名：
 *   国内 →「运营商+IP首段」（如「电信119 - 原名」），
 *   海外 →「国家/地区+IP首段」（如「新加坡119 - 原名」）。
 *
 * 流程：
 *   1) 遍历节点，对域名节点发起 DoH 解析（每个 EDNS 线路一条），拿到各自的 IP；
 *   2) 汇总所有唯一 IP，用 ip-api.com 查运营商与国家/地区；
 *   3) 每个唯一 IP 复制成一个新节点，server 换成该 IP，name 换成「运营商/国家+IP首段」。
 *
 * 注意：
 *   - 只对「域名」节点裂变，server 本身是 IP 的节点原样保留；
 *   - 解析失败不抛错，会回退保留原节点；地理定位失败则回退用 EDNS 线路名命名；
 *   - 解析用「多 DoH 源轮询 + 失败换源重试 + 连续失败线性退避」，缓解单源被限速；
 *   - 解析/地理定位都做了并发限制，避免一次性打爆 DoH 或 ip-api 被限速；
 *   - 所有可调项集中在下方 CONFIG，运行时也可用脚本参数覆盖。
 */
async function operator(proxies = [], targetPlatform, context) {
  // ==================== 配置区（按需修改） ====================
  const CONFIG = {
    // DoH 服务器地址列表（多源轮询，避免单源被限速/超时后整批解析失败）。
    // 每次解析从列表里选一个，失败自动换下一个源重试。
    // 可放多个厂商，如腾讯/阿里/Google/Cloudflare/Quad9。
    dohs: [
      'https://doh.pub/dns-query',
      'https://dns.alidns.com/dns-query',
      'https://cloudflare-dns.com/dns-query',
      'https://dns.google/dns-query',
      'https://dns.quad9.net/dns-query',
    ],

    // 单条解析最多尝试几个 DoH 源（换源重试次数上限）。
    // 例：3 → 最多依次试 3 个不同的源，全失败才算这条解析失败。
    resolveRetries: 3,

    // 连续解析失败达到该次数后，插入一段退避等待（应对被限速）。
    // 设为 0 关闭退避。
    resolveBackoffAfter: 2,

    // 每次退避的基础毫秒数，实际等待 = base * 已退避轮次（简单线性退避）。
    resolveBackoffMs: 800,

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

  // 运行时参数（Sub-Store「键/值」）可覆盖 CONFIG 中的 edns / dohs / doh / seq。
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
        // dohs 优先（数组），其次兼容单个 doh 字符串
        if (Array.isArray(arg.dohs) && arg.dohs.length) CONFIG.dohs = arg.dohs;
        else if (typeof arg.doh === 'string' && arg.doh) CONFIG.dohs = [arg.doh];
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

  // 生成节点名前缀。优先级：
  //   1) 国内（countryCode=CN）且命中 ispMap → 运营商 + IP 首段（如 电信119）
  //   2) 有国家信息（含海外、国内未命中运营商）→ 国家/地区 + IP 首段（如 新加坡119、中国119）
  //   3) 地理定位失败 → EDNS 线路名（单线路全称，多线路各取首字去重，如 移/电/联）
  const buildPrefix = (ip, geo, lines) => {
    const seg = firstSeg(ip);
    if (geo && geo.operator && geo.countryCode === 'CN') return geo.operator + seg;
    if (geo && geo.country) return geo.country + seg;
    if (!lines || lines.length === 0) return seg;
    if (lines.length === 1) return lines[0];
    // 多条线路取首字并去重（避免「移动/电信」这类同首字重复）
    return [...new Set(lines.map((n) => (n || '')[0]).filter(Boolean))].join('/');
  };

  // 去掉脚本内部字段，避免泄漏进输出节点（_domain / _resolved_ips）。
  const cleanNode = (p) => {
    const { _domain, _resolved_ips, ...rest } = p;
    return rest;
  };

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

  // 退避等待：连续解析失败后插入一段 sleep，缓解被限速。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failStreak = 0;   // 连续失败计数（跨节点累计）
  let backoffRound = 0; // 已退避轮次，用于线性放大等待
  const backoff = async () => {
    if (!CONFIG.resolveBackoffMs || !CONFIG.resolveBackoffAfter) return;
    if (failStreak < CONFIG.resolveBackoffAfter) return;
    backoffRound += 1;
    const wait = CONFIG.resolveBackoffMs * backoffRound;
    log(`rate-limit backoff: sleep ${wait}ms (failStreak=${failStreak}, round=${backoffRound})`);
    await sleep(wait);
  };

  // 从 dohs 列表中选一个起始源，并按 rotate 顺序返回要尝试的源序列。
  // 用全局游标轮询，让不同解析请求分散到不同源，降低单源压力。
  let dohCursor = 0;
  const dohPlan = () => {
    const list = (CONFIG.dohs && CONFIG.dohs.length) ? CONFIG.dohs : ['https://doh.pub/dns-query'];
    const start = dohCursor++ % list.length;
    const tries = Math.max(1, Math.min(CONFIG.resolveRetries || 1, list.length));
    return Array.from({ length: tries }, (_, k) => list[(start + k) % list.length]);
  };

  // 单个域名解析：对某个 EDNS 线路发起 DoH，返回去重后的 IP 数组。
  // 多源轮询：一个源失败自动换下一个源重试；全失败才返回空结果（不抛错）。
  const resolve = async (domain, { name, ip }) => {
    // 缓存 key 只跟域名/类型/线路有关，与具体 DoH 源无关（换个源结果应一致）。
    const id = `doh:${domain}:${CONFIG.type}:${name}:${ip}`;
    const cached = cacheGet(id);
    if (cached) return cached;

    const targets = dohPlan();
    for (const url of targets) {
      try {
        // ProxyUtils.doh 是 Sub-Store 内置的 DoH 工具；edns 传 IP 字符串即启用 ECS。
        const res = await ProxyUtils.doh({ url, domain, type: CONFIG.type, edns: ip });
        const { answers } = res;
        if (!Array.isArray(answers) || answers.length === 0) throw new Error('No answers');
        let result = answers
          .filter((i) => i && i.type === CONFIG.type) // 只取目标记录类型（A/AAAA）
          .map((i) => i.data)
          .filter(Boolean);
        if (result.length === 0) throw new Error('No answers');
        // data 可能是字符串或数组，flat 展平后去重，再过滤非法值。
        result = [...new Set(result.flat())].filter((x) => ProxyUtils.isIP(x));
        if (result.length === 0) throw new Error('No valid IP');
        // 成功：清空失败计数
        failStreak = 0;
        backoffRound = 0;
        const data = { ip, name, result };
        cacheSet(id, data);
        return data;
      } catch (e) {
        // 该源失败，先做退避再试下一个源
        failStreak += 1;
        log(`resolve ${domain} via ${name || '?'} @ ${url} failed: ${(e && e.message) || e}`);
        await backoff();
      }
    }
    // 所有源都失败
    return { ip, name, result: [] };
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

  // IP 地理定位：用 ip-api.com 取运营商 + 国家（返回 { operator, country, countryCode }）。
  // 只缓存成功结果（失败不缓存，避免一次网络抖动把该 IP 永久钉死在空结果上）。
  //   operator：命中 ispMap 的国内运营商中文名（海外/未命中为空）；
  //   country/countryCode：国家中文名 + 二字母码（lang=zh-CN，如 新加坡/SG、美国/US）。
  const geoip = async (ip) => {
    const cached = cacheGet('geo:' + ip);
    if (cached) return cached;
    let operator = '';
    let country = '';
    let countryCode = '';
    let ok = false;
    try {
      const data = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,message,isp,country,countryCode`);
      if (data && data.status === 'success') {
        operator = mapIsp(data.isp || '');
        country = data.country || '';
        countryCode = (data.countryCode || '').toUpperCase();
        ok = true;
      }
    } catch (e) {}
    log(`geoip ${ip} => operator=${operator || '?'}, country=${country || '?'}(${countryCode || '?'})`);
    const geo = { operator, country, countryCode };
    // 只有查到了国家/地区（能用于命名）才写缓存；完全失败下次重试。
    if (ok) cacheSet('geo:' + ip, geo);
    return geo;
  };

  try {
    log(`operator start, proxies=${(proxies || []).length}, edns lines=${CONFIG.edns.length}, dohs=${(CONFIG.dohs || []).length}, retries=${CONFIG.resolveRetries}`);

    // 本次运行真正解析过的节点集合：只有它们才允许走裂变分支。
    // 不能只看 p._resolved_ips 是否存在——上游脚本（或历史残留）可能把该字段
    // 留在一个 server 已是 IP 的节点上，盲信会把 IP 节点误当域名节点再裂变一次。
    const resolvedNow = new Set();

    // 1. 解析所有域名节点：按 resolveLimit 控制并发，单节点内多条 EDNS 线路并发。
    await mapLimit(proxies || [], CONFIG.resolveLimit, async (p) => {
      if (p && p.server && !ProxyUtils.isIP(p.server)) {
        p._domain = p.server; // 记下原始域名，供 keepOriginal 使用
        p._resolved_ips = await Promise.all(
          CONFIG.edns.map(({ ip, name }) => resolve(p.server, { ip, name }))
        );
        resolvedNow.add(p);
      }
    });

    // 2. 汇总全局唯一 IP，并记录每个 IP 命中了哪些 EDNS 线路（解析失败时的兜底命名用）。
    const ipLines = new Map();
    const allIps = new Set();
    (proxies || []).forEach((p = {}) => {
      if (!resolvedNow.has(p)) return; // 只看本次真正解析过的节点
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
    const base = cleanNode; // 复制节点时先剥掉内部字段
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      // 只有本次真正解析过的节点才裂变；其余（含 server 已是 IP 的）原样保留
      if (resolvedNow.has(p) && Array.isArray(ips) && ips.length > 0) {
        // 收集本节点的唯一 IP（保持首次出现顺序）
        const seen = new Set();
        const nodeIps = [];
        ips.forEach(({ result }) => {
          (result || []).forEach((ip) => {
            if (!seen.has(ip)) { seen.add(ip); nodeIps.push(ip); }
          });
        });
        // 没有任何有效 IP：原样保留（剥内部字段）
        if (nodeIps.length === 0) { list.push(base(p)); return; }
        nodeIps.forEach((ip, i) => {
          const geo = geoMap.get(ip) || {};
          const prefix = buildPrefix(ip, geo, ipLines.get(ip));
          // 复制原节点，仅替换 server 与 name，其余字段（端口/uuid/协议等）保持不变。
          const newName = CONFIG.seq ? `${prefix} ${i + 1} - ${p.name}` : `${prefix} - ${p.name}`;
          list.push({ ...base(p), name: newName, server: ip });
        });
        // 可选：额外保留一条原始域名节点
        if (CONFIG.keepOriginal) list.push({ ...base(p), name: `原始 - ${p.name}`, server: p._domain });
      } else {
        // 无解析结果 / server 本身是 IP → 原样保留
        list.push(base(p));
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
