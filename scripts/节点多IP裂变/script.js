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
 *   - 解析做了并发限制，避免一次性打爆 DoH 被限速；
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

    // 2. 裂变命名：每个节点的每个唯一 IP 生成一条新节点。
    const list = [];
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      if (Array.isArray(ips) && ips.length > 0) {
        // 按 IP 合并：同一个 IP 被多条线路解析出来时，合并成一个节点，
        // 前缀用「/」连接线路名（如 电信+联通 → 电/联）。
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
        order.forEach((ip, i) => {
          const arr = names.get(ip);
          // 单线路用全称（移动/电信/联通），多线路取首字缩写（移/电/联）
          const prefix = arr.length === 1 ? arr[0] : arr.map((n) => n[0]).join('/');
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
