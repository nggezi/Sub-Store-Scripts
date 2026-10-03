async function operator(proxies = [], targetPlatform, context) {
  // ===== 参数 =====
  // 键 edns：JSON 数组，如 [{"name":"移动","ip":"111.47.229.151"},...]，默认 移动/电信/联通
  // 键 doh ：DoH 服务器，默认 https://doh.pub/dns-query（可换成 223.6.6.6 / 223.5.5.5 等）
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

  // 直辖市：用省份字段 regionName 判断，避免北京抓到「海淀」这类区名
  const MUNICIPALITY = [
    [/北京|Beijing/i, '京'],
    [/上海|Shanghai/i, '沪'],
    [/天津|Tianjin/i, '津'],
    [/重庆|Chongqing/i, '渝'],
  ];

  // 主要城市简称/别称
  const CITY_ALIAS = [
    [/广州|Guangzhou/i, '穗'],
    [/深圳|Shenzhen/i, '深'],
    [/成都|Chengdu/i, '蓉'],
    [/武汉|Wuhan/i, '汉'],
    [/南京|Nanjing/i, '宁'],
    [/杭州|Hangzhou/i, '杭'],
    [/西安|Xi'?an/i, '安'],
    [/沈阳|Shenyang/i, '沈'],
    [/哈尔滨|Harbin/i, '哈'],
    [/济南|Jinan/i, '济'],
    [/青岛|Qingdao/i, '青'],
    [/大连|Dalian/i, '连'],
    [/郑州|Zhengzhou/i, '郑'],
    [/长沙|Changsha/i, '长'],
    [/福州|Fuzhou/i, '榕'],
    [/厦门|Xiamen/i, '厦'],
    [/昆明|Kunming/i, '昆'],
    [/南宁|Nanning/i, '邕'],
    [/海口|Haikou/i, '海'],
    [/温州|Wenzhou/i, '温'],
    [/宁波|Ningbo/i, '甬'],
    [/苏州|Suzhou/i, '苏'],
    [/无锡|Wuxi/i, '锡'],
    [/佛山|Foshan/i, '佛'],
    [/东莞|Dongguan/i, '莞'],
    [/珠海|Zhuhai/i, '珠'],
    [/合肥|Hefei/i, '肥'],
    [/太原|Taiyuan/i, '并'],
    [/石家庄|Shijiazhuang/i, '石'],
    [/南昌|Nanchang/i, '昌'],
    [/贵阳|Guiyang/i, '贵'],
    [/兰州|Lanzhou/i, '兰'],
    [/乌鲁木齐|Urumqi/i, '乌'],
    [/呼和浩特|Hohhot/i, '呼'],
    [/拉萨|Lhasa/i, '拉'],
    [/西宁|Xining/i, '西'],
    [/银川|Yinchuan/i, '银'],
    [/烟台|Yantai/i, '烟'],
    [/唐山|Tangshan/i, '唐'],
    [/洛阳|Luoyang/i, '洛'],
    [/常州|Changzhou/i, '常'],
    [/徐州|Xuzhou/i, '徐'],
    [/泉州|Quanzhou/i, '泉'],
    [/佛山|Foshan/i, '佛'],
  ];

  // 取城市别称：直辖市优先看 regionName，其他看 city，都没有就用首字
  const cityAlias = (city, region) => {
    if (region) { for (const [re, alias] of MUNICIPALITY) { if (re.test(region)) return alias; } }
    if (city) { for (const [re, alias] of CITY_ALIAS) { if (re.test(city)) return alias; } }
    return (city || region || '')[0] || '';
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
    let city = '', region = '', operator = '';
    try {
      const data = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,message,regionName,city,isp,as`);
      if (data && data.status === 'success') {
        city = data.city || '';
        region = data.regionName || '';
        operator = mapIsp(data.isp || '');
      }
    } catch (e) {}
    log(`geoip ${ip} => city=${city || '?'} region=${region || '?'} operator=${operator || '?'}`);
    const geo = { city, region, operator };
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
          const c = cityAlias(geo.city, geo.region);
          if (c && geo.operator) {
            // 入口命名：城市别称 + 运营商首字（如 广州电信 → 穗电、北京电信 → 京电）
            prefix = c + (geo.operator[0] || '');
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
