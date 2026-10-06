/**
 * 节点多 IP 裂变 —— Sub-Store「脚本操作」
 * ------------------------------------------------------------------
 * 作用：
 *   把「域名类型」的节点，用 DoH（可带 EDNS Client Subnet）解析成多个入口 IP，
 *   再把每个 IP 裂变成一个独立节点。命名用 EDNS 线路名（单线路全称，多线路首字合并）。
 *
 * 与 ../节点多IP裂变-入口版 的区别：
 *   本版按「EDNS 线路」命名（移/电/联）；入口版按 IP 真实运营商命名（电信119）。
 *
 * 流程：
 *   1) 遍历节点，对域名节点按每条 EDNS 线路分别 DoH 解析，拿到各自的 IP；
 *   2) 汇总每个节点的唯一 IP，同一 IP 被多条线路解析出来时合并前缀（如 电信+联通 → 电/联）；
 *   3) 每个唯一 IP 复制成一个新节点，server 换成该 IP。
 *
 * 注意：
 *   - 只对「域名」节点裂变，server 本身是 IP 的节点原样保留；
 *   - 解析失败不抛错，会回退保留原节点；
 *   - 解析用「多 DoH 源轮询 + 失败换源重试 + 连续失败线性退避」，缓解单源被限速；
 *   - 解析做了并发限制，避免一次性打爆 DoH 被限速；
 *   - 所有可调项集中在下方 CONFIG，运行时也可用脚本参数覆盖；
 *   - 缓存：解析结果走 Sub-Store 的 scriptResourceCache（key 带版本号，升级可整体作废）；
 *     若以 mode=link 方式引入本脚本，可在链接后加 #noCache 让 Sub-Store 每次都重新拉取脚本内容（不吃脚本下载缓存）。
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
    //   name：线路标签，用于命名（合并时取首字，如 移/电/联）；
    //   ip：  ECS 用的客户端 IP（不同运营商/地区各填一个）。
    edns: [
      { name: '移动', ip: '111.47.229.151' },
      { name: '电信', ip: '116.207.181.162' },
      { name: '联通', ip: '119.36.124.169' },
    ],

    // 命名是否带序号。false →「移/电 - 原名」；true →「移/电 1 - 原名」。
    seq: false,

    // 是否额外保留一条原始域名节点（未解析，直接用原 server）。
    keepOriginal: false,

    // 并发限制：每批同时解析几个节点（1 = 逐个串行，最稳；调大可加速但更易触发限速）。
    resolveLimit: 1,
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

  // scriptResourceCache 是 Sub-Store 提供的脚本级缓存，用于避免重复 DoH 请求。
  // 某些环境可能没有该对象，用 try/catch 兜底，缓存失败不影响主流程。
  const cache = scriptResourceCache;
  const cacheGet = (k) => { try { return cache.get(k); } catch (e) { return undefined; } };
  const cacheSet = (k, v) => { try { cache.set(k, v); } catch (e) {} };

  // 并发限制器：最多 limit 个任务同时执行，避免一次性打爆 DoH。
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
  // 计数**按 DoH 源**分桶：并发解析多个节点时，各源互不干扰，
  // 一个坏域名/坏源不会把其它源的成功计数清零、也不会误触退避。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const srcState = new Map(); // url -> { failStreak, backoffRound }
  const srcOf = (url) => {
    let s = srcState.get(url);
    if (!s) { s = { failStreak: 0, backoffRound: 0 }; srcState.set(url, s); }
    return s;
  };
  const onResolveOk = (url) => {
    const s = srcOf(url);
    s.failStreak = 0;
    s.backoffRound = 0;
  };
  const onResolveFail = async (url) => {
    const s = srcOf(url);
    s.failStreak += 1;
    if (!CONFIG.resolveBackoffMs || !CONFIG.resolveBackoffAfter) return;
    if (s.failStreak < CONFIG.resolveBackoffAfter) return;
    s.backoffRound += 1;
    const wait = CONFIG.resolveBackoffMs * s.backoffRound;
    log(`rate-limit backoff: sleep ${wait}ms @ ${url} (failStreak=${s.failStreak}, round=${s.backoffRound})`);
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
    // 带版本号（doh:v2:）：旧版脚本写入的缓存结构与新版不兼容时，升版即可整体作废。
    const id = `doh:v2:${domain}:${CONFIG.type}:${name}:${ip}`;
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
        // 成功：清空该源的失败计数
        onResolveOk(url);
        const data = { ip, name, result };
        cacheSet(id, data);
        return data;
      } catch (e) {
        // 该源失败，按源累计并可能退避，再试下一个源
        log(`resolve ${domain} via ${name || '?'} @ ${url} failed: ${(e && e.message) || e}`);
        await onResolveFail(url);
      }
    }
    // 所有源都失败
    return { ip, name, result: [] };
  };

  // 生成节点名前缀：单线路用全称（移动/电信/联通），多线路各取首字并去重（移/电/联）。
  const buildPrefix = (lines) => {
    const arr = (lines || []).filter(Boolean);
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    return [...new Set(arr.map((n) => n[0]))].join('/');
  };

  // 去掉脚本内部字段，避免泄漏进输出节点（_domain / _resolved_ips）。
  const cleanNode = (p) => {
    const { _domain, _resolved_ips, ...rest } = p;
    return rest;
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

    // 2. 裂变命名：每个节点的每个唯一 IP 生成一条新节点。
    const list = [];
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      // 只有本次真正解析过的节点才裂变；其余（含 server 已是 IP 的）原样保留
      if (resolvedNow.has(p) && Array.isArray(ips) && ips.length > 0) {
        // 按 IP 合并：同一个 IP 被多条线路解析出来时，合并成一个节点，
        // 前缀用「/」连接线路名首字（如 电信+联通 → 电/联）。
        const order = [];        // 唯一 IP 的出现顺序
        const names = new Map(); // ip -> [线路名...]
        ips.forEach(({ name, result }) => {
          (result || []).forEach((ip) => {
            if (!names.has(ip)) {
              names.set(ip, []);
              order.push(ip);
            }
            const arr = names.get(ip);
            if (!arr.includes(name)) arr.push(name);
          });
        });
        // 没有任何有效 IP：原样保留（剥内部字段）
        if (order.length === 0) { list.push(cleanNode(p)); return; }
        order.forEach((ip, i) => {
          const prefix = buildPrefix(names.get(ip));
          // 复制原节点，仅替换 server 与 name，其余字段（端口/uuid/协议等）保持不变。
          const newName = CONFIG.seq ? `${prefix} ${i + 1} - ${p.name}` : `${prefix} - ${p.name}`;
          list.push({ ...cleanNode(p), name: newName, server: ip });
        });
        // 可选：额外保留一条原始域名节点（_domain 一定存在，这里再兜一层）
        if (CONFIG.keepOriginal && p._domain) list.push({ ...cleanNode(p), name: `原始 - ${p.name}`, server: p._domain });
      } else {
        // 无解析结果 / server 本身是 IP → 原样保留
        list.push(cleanNode(p));
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
