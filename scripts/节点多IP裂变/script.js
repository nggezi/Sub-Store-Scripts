/**
 * 节点多 IP 裂变（Sub-Store「脚本操作」）
 * ------------------------------------------------------------------
 * 作用：
 *   把「域名类型」的节点，通过 DoH 解析成多个入口 IP，并把每个 IP
 *   裂变成一个独立节点。支持两种玩法：
 *     1) 多线路模式：对不同运营商/地区注入不同的 EDNS Client Subnet(ECS)，
 *        从而解析出对应线路的入口 IP，节点名自动标注线路（联通/电信/移动）。
 *     2) 纯裂变模式：不做 ECS，直接解析出该域名的全部 IP，逐个裂变。
 *
 * 为什么能一步到位：
 *   Sub-Store 官方的做法是「解析脚本 + 裂变脚本」两个操作串联，因为第一步
 *   用来替换内置的「域名解析」步骤、只负责把结果挂到 server 上。而脚本操作
 *   本身允许 async，所以可以在同一个 operator 里直接 await ProxyUtils.doh，
 *   解析和裂变一次性完成，无需再串联第二个操作。
 *
 * 使用：
 *   1. 订阅 → 「脚本操作」→ 选择本地脚本或填入脚本链接；
 *   2. 把本文件内容整体粘贴进去（无需额外参数）；
 *   3. 按需修改下方 CONFIG 后保存并刷新订阅。
 *
 * 注意：
 *   - 只对「域名」节点裂变，server 本身是 IP 的节点原样保留；
 *   - DoH 服务器可能限速，已用 scriptResourceCache 按 (域名+线路) 缓存结果；
 *   - 裂变会使节点数量成倍增长，请用 maxIpPerLine 控制上限；
 *   - 无解析结果时，原节点原样保留，不会丢节点。
 */
async function operator(proxies = []) {
  // ==================== 配置区（按需修改） ====================
  const CONFIG = {
    // DoH 服务器地址。默认是 223.6.6.6（阿里），但阿里/腾讯的公共 DoH
    // 在高频请求下容易限速；可自行替换为其它 DoH，例如自建或
    // 'https://1.1.1.1/dns-query'、'https://8.8.8.8/dns-query' 等。
    doh: 'https://223.6.6.6/dns-query',

    // 查询记录类型：'A' 解析 IPv4，'AAAA' 解析 IPv6。
    // 多数场景用 'A' 即可；如需 IPv6 入口，改成 'AAAA'。
    type: 'A',

    // 是否启用「多线路」模式。
    //   true  → 按下方 edns 列表逐个查询（每个 ECS 得到对应线路的 IP），
    //           节点名会带上线路名（如「联通1 - 香港01」）。
    //   false → 不使用 ECS，只做一次普通解析，把域名的所有 IP 都裂变出来，
    //           节点名形如「1 - 香港01」「2 - 香港01」。
    multiLine: true,

    // 多线路模式使用的 EDNS Client Subnet 列表（ECS）。
    // 原理：向 DoH 声明「请求方位于某个网段」，权威 DNS 会优先返回该网段
    // 就近/同线路的入口 IP，从而实现按运营商或地区解析出不同入口。
    //   name：线路标签，仅用于节点命名；
    //   ip：  ECS 用的客户端 IP（不同运营商/地区各填一个即可）。
    // 需要更多线路时，直接往数组里加对象即可。
    edns: [
      { name: '联通', ip: '119.36.124.169' },
      { name: '电信', ip: '116.207.181.162' },
      { name: '移动', ip: '111.47.229.151' },
    ],

    // 裂变后是否额外保留一个「原域名」节点（未解析、直接用原 server）。
    //   false → 只保留裂变出来的 IP 节点；
    //   true  → 额外 push 一个原始域名节点，便于对比/兜底。
    keepOriginal: false,

    // 每条线路最多裂变几个 IP。防止一个域名解析出几十个 IP 把订阅撑爆。
    //   0 → 不限制（不推荐）。
    maxIpPerLine: 5,

    // 是否去重。不同的 ECS 有可能返回相同的 IP，开启后按「线路名+序号+IP」
    // 去掉完全重复的节点。注意：同一 IP 在不同线路名下不会被去掉。
    dedupe: true,
  };
  // ============================================================

  // 缓存读写封装：scriptResourceCache 是 Sub-Store 提供的脚本级缓存，
  // 用于避免对同一域名反复发起 DoH 请求（公共 DoH 容易限速）。
  // 某些环境可能没有该对象，因此用 try/catch 兜底，缓存失败不影响主流程。
  const cacheGet = (key) => {
    try { return scriptResourceCache.get(key); } catch (e) { return undefined; }
  };
  const cacheSet = (key, value) => {
    try { scriptResourceCache.set(key, value); } catch (e) { /* 忽略缓存写入失败 */ }
  };

  // 解析单个域名，返回去重后的 IP 数组。
  //   domain：要解析的域名（即节点的 server）
  //   edns：  { name, ip } 或 null（纯裂变模式下传 null）
  const resolve = async (domain, edns) => {
    // 缓存 key：DoH + 域名 + 记录类型 + 线路，保证不同线路互不覆盖。
    const cacheKey = `${CONFIG.doh}:${domain}:${CONFIG.type}:${edns ? edns.name + edns.ip : ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    let ips = [];
    try {
      // ProxyUtils.doh 是 Sub-Store 内置的 DoH 工具；
      // edns 传入 IP 字符串即启用 EDNS Client Subnet。
      const res = await ProxyUtils.doh({
        url: CONFIG.doh,
        domain,
        type: CONFIG.type,
        edns: edns ? edns.ip : undefined,
      });
      const answers = (res && res.answers) || [];
      ips = answers
        .filter((a) => a && a.type === CONFIG.type) // 只取目标记录类型（A/AAAA）
        .map((a) => a.data)
        .filter(Boolean);
      // data 可能是字符串或数组，flat 展平后用 Set 去重，再过滤非法值。
      ips = [...new Set(ips.flat())].filter((ip) => ProxyUtils.isIP(ip));
    } catch (e) {
      // 解析失败（超时/限速/无记录）时返回空数组，外层会保留原节点。
      ips = [];
    }

    cacheSet(cacheKey, ips);
    return ips;
  };

  const result = [];        // 最终输出的节点列表
  const seen = new Set();   // 去重用的签名集合

  // 逐个处理节点（使用 for...of 保证 await 按顺序执行，避免并发过高触发限速）
  for (const p of proxies) {
    const domain = p && p.server;

    // server 为空，或本身就是 IP 的节点：不做裂变，原样保留。
    if (!domain || ProxyUtils.isIP(domain)) {
      result.push(p);
      continue;
    }

    // 需要查询的线路：多线路模式用 CONFIG.edns，否则用 [null] 表示普通解析。
    const lines = CONFIG.multiLine ? CONFIG.edns : [null];

    // 并发解析各线路（同一个域名，线路之间并发是安全的）。
    // 结果结构：[{ name: 线路名, ips: [ip1, ip2, ...] }, ...]
    const groups = await Promise.all(
      lines.map(async (e) => ({
        name: e ? e.name : '',
        ips: await resolve(domain, e),
      })),
    );

    let expanded = 0; // 记录本节点实际裂变出的数量

    for (const g of groups) {
      let ips = g.ips || [];
      // 限制每条线路的 IP 数量，防止节点爆炸。
      if (CONFIG.maxIpPerLine > 0) ips = ips.slice(0, CONFIG.maxIpPerLine);

      ips.forEach((ip, i) => {
        // 节点名：有线路名 →「联通1 - 原名」；无线路名 →「1 - 原名」。
        const tag = g.name ? `${g.name}${i + 1}` : `${i + 1}`;

        // 去重签名：线路名 + 序号 + IP。相同签名只保留一次。
        const signature = `${g.name}|${i}|${ip}`;
        if (CONFIG.dedupe && seen.has(signature)) return;
        seen.add(signature);

        // 复制原节点，仅替换 server 和 name，其余字段（端口/uuid/协议等）保持不变。
        result.push({ ...p, name: `${tag} - ${p.name}`, server: ip });
        expanded++;
      });
    }

    // 没有解析出任何 IP → 保留原节点；
    // 或者用户显式要求保留原域名节点 → 额外追加一个。
    if (expanded === 0 || CONFIG.keepOriginal) result.push(p);
  }

  return result;
}
