async function operator(proxies, targetPlatform, context) {
  // 参数：键 edns，值为 JSON 数组，如 [{"name":"联通","ip":"119.36.124.169"},...]
  // 默认值：联通/电信/移动
  const defaultEdns = [
    { name: '联通', ip: '119.36.124.169' },
    { name: '电信', ip: '116.207.181.162' },
    { name: '移动', ip: '111.47.229.151' },
  ];
  const doh = 'https://223.6.6.6/dns-query';
  const type = 'A';

  let edns = defaultEdns;
  try {
    if (typeof $arguments !== 'undefined' && $arguments) {
      let arg = $arguments;
      if (typeof arg === 'string') {
        const s = arg.trim();
        if (s.startsWith('{') || s.startsWith('[')) { try { arg = JSON.parse(s); } catch (e) {} }
      }
      if (arg && typeof arg === 'object') {
        const v = arg.edns != null ? arg.edns : (Array.isArray(arg) ? arg : null);
        if (Array.isArray(v) && v.length) edns = v;
      }
    }
  } catch (e) {}

  const cache = scriptResourceCache;
  const resolve = async (url, domain, type, { name, ip }) => {
    const id = `${url}:${domain}:${type}:${name}:${ip}`;
    const cached = cache.get(id);
    if (cached) return cached;
    const res = await ProxyUtils.doh({ url, domain, type, edns: ip });
    const { answers } = res;
    if (!Array.isArray(answers) || answers.length === 0) throw new Error('No answers');
    let result = answers.filter((i) => i?.type === type).map((i) => i?.data).filter((i) => i);
    if (result.length === 0) throw new Error('No answers');
    result = [...new Set(result.flat())];
    const data = { ip, name, result };
    cache.set(id, data);
    return data;
  };

  await Promise.all(proxies.map(async (p) => {
    if (p && p.server && !ProxyUtils.isIP(p.server)) {
      p._domain = p.server;
      p._resolved_ips = await Promise.all(
        edns.map(({ ip, name }) => resolve(doh, p.server, type, { ip, name }))
      );
    }
  }));

  const list = [];
  proxies.forEach((p = {}) => {
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
        const prefix = names.get(ip).join('/');
        list.push({ ...p, name: `${prefix} ${i + 1} - ${p.name}`, server: ip });
      });
      // 可选：保留原始域名节点
      // list.push({ ...p, name: `原始 - ${p.name}`, server: p._domain });
    } else {
      list.push(p);
    }
  });
  return list;
}
