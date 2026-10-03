async function operator(proxies = [], targetPlatform, context) {
  // ===== 参数 =====
  // 键 edns：JSON 数组，如 [{"name":"移动","ip":"111.47.229.151"},...]，默认 移动/电信/联通
  // 键 doh ：DoH 服务器，默认 https://223.6.6.6/dns-query（可换成 223.5.5.5 / doh.pub 等）
  const defaultEdns = [
    { name: '移动', ip: '111.47.229.151' },
    { name: '电信', ip: '116.207.181.162' },
    { name: '联通', ip: '119.36.124.169' },
  ];
  let doh = 'https://doh.pub/dns-query';
  const type = 'A';

  const log = (msg) => {
    try { if (typeof $substore !== 'undefined' && $substore && $substore.info) $substore.info(msg); } catch (e) {}
  };

  let edns = defaultEdns;
  try {
    if (typeof $arguments !== 'undefined' && $arguments) {
      let arg = $arguments;
      if (typeof arg === 'string') {
        const s = arg.trim();
        if (s.startsWith('{') || s.startsWith('[')) { try { arg = JSON.parse(s); } catch (e) {} }
      }
      if (Array.isArray(arg)) {
        if (arg.length) edns = arg;
      } else if (arg && typeof arg === 'object') {
        if (Array.isArray(arg.edns) && arg.edns.length) edns = arg.edns;
        if (typeof arg.doh === 'string' && arg.doh) doh = arg.doh;
      }
    }
  } catch (e) {}

  // ISP 英文 → 中文 映射（ip-api 返回英文 isp，需转中文做命名）
  const ISP_MAP = [
    [/tencent|腾讯/i, '腾讯云'],
    [/alibaba|aliyun|阿里/i, '阿里'],
    [/huawei|华为/i, '华为'],
    [/telecom|chinanet|电信/i, '电信'],
    [/mobile|移动/i, '移动'],
    [/unicom|cnc|联通/i, '联通'],
    [/dr\.?peng|鹏博士/i, '鹏博士'],
    [/cernet|教育/i, '教育网'],
    [/broadcast|广电/i, '广电'],
  ];
  const mapIsp = (isp) => {
    if (!isp) return '';
    for (const [re, name] of ISP_MAP) { if (re.test(isp)) return name; }
    return '';
  };

  const cache = scriptResourceCache;
  const cacheGet = (k) => { try { return cache.get(k); } catch (e) { return undefined; } };
  const cacheSet = (k, v) => { try { cache.set(k, v); } catch (e) {} };

  // 并发限制器：避免一次性打爆 DoH / 定位接口
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

  // DoH 解析（带 EDNS）。失败不抛错，返回空结果。
  const resolve = async (domain, { name, ip }) => {
    const id = `${doh}:${domain}:${type}:${name}:${ip}`;
    const cached = cacheGet(id);
    if (cached) return cached;
    try {
      const res = await ProxyUtils.doh({ url: doh, domain, type, edns: ip });
      const { answers } = res;
      if (!Array.isArray(answers) || answers.length === 0) throw new Error('No answers');
      let result = answers.filter((i) => i && i.type === type).map((i) => i.data).filter(Boolean);
      if (result.length === 0) throw new Error('No answers');
      result = [...new Set(result.flat())].filter((x) => ProxyUtils.isIP(x));
      const data = { ip, name, result };
      cacheSet(id, data);
      return data;
    } catch (e) {
      log(`resolve ${domain} via ${name || '?'} failed: ${(e && e.message) || e}`);
      return { ip, name, result: [] };
    }
  };

  // 通用 JSON HTTP 请求：兼容 $substore.http.get 与 $httpClient.get 两种 API
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

  // IP 地理定位（ip-api.com，返回中文 city + 英文 isp）
  const geoip = async (ip) => {
    const cached = cacheGet('geo:' + ip);
    if (cached) return cached;
    let city = '', operator = '';
    try {
      const data = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,message,regionName,city,isp,as`);
      if (data && data.status === 'success') {
        city = data.city || data.regionName || '';
        operator = mapIsp(data.isp || '');
      }
    } catch (e) {}
    log(`geoip ${ip} => city=${city || '?'} operator=${operator || '?'}`);
    const geo = { city, operator };
    cacheSet('geo:' + ip, geo);
    return geo;
  };

  try {
    log(`operator start, proxies=${(proxies || []).length}, edns lines=${edns.length}, doh=${doh}`);

    // 1. 解析所有域名节点（逐个节点串行，单个节点内部 3 条线路并发）
    for (const p of (proxies || [])) {
      if (p && p.server && !ProxyUtils.isIP(p.server)) {
        p._domain = p.server;
        p._resolved_ips = await Promise.all(
          edns.map(({ ip, name }) => resolve(p.server, { ip, name }))
        );
      }
    }

    // 2. 收集全局唯一 IP + 每个 IP 对应的 EDNS 线路名（兜底命名用）
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

    // 3. 地理定位每个唯一 IP（限制并发，避免 ip-api 限速）
    const geoMap = new Map();
    await mapLimit([...allIps], 3, async (ip) => {
      geoMap.set(ip, await geoip(ip));
    });

    // 4. 裂变命名
    const list = [];
    (proxies || []).forEach((p = {}) => {
      const ips = p._resolved_ips;
      if (Array.isArray(ips) && ips.length > 0) {
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
          if (geo.city && geo.operator) {
            // 入口命名：城市首字 + 运营商首字（如 深圳电信 → 深电）
            prefix = (geo.city[0] || '') + (geo.operator[0] || '');
          } else {
            // 兜底：EDNS 线路名（单线路全称，多线路首字）
            const lines = ipLines.get(ip) || [];
            prefix = lines.length === 1 ? lines[0] : lines.map((n) => n[0]).join('/');
          }
          list.push({ ...p, name: `${prefix} ${i + 1} - ${p.name}`, server: ip });
        });
        // 可选：保留原始域名节点
        // list.push({ ...p, name: `原始 - ${p.name}`, server: p._domain });
      } else {
        list.push(p);
      }
    });

    log(`operator done, output=${list.length}`);
    return list;
  } catch (e) {
    log(`operator ERROR: ${(e && e.stack) || e}`);
    return proxies || [];
  }
}
