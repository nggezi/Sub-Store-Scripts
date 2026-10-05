/**
 * mihomo 节点域名替换 —— Sub-Store「脚本操作」
 * ------------------------------------------------------------------
 * 作用：
 *   把订阅里「server 为某个域名」的节点，按用户提供的 hosts 映射，替换成另一个域名。
 *   例如把 `example.com` 换成 `node1.example.net`：只改 server，端口/uuid/协议等原样保留。
 *
 * 参数（$arguments）：
 *   传一段 hosts 文本（键: 值，每行一条，`#` 开头为注释），例如：
 *     example.com: node1.example.net
 *     foo.bar:     baz.qux
 *   也支持 JSON 对象形式：{ "hosts": "..." } 或 { "example.com": "..." }。
 *
 * 注意：
 *   - 只替换能匹配上映射表的 server，未命中的节点原样保留；
 *   - 兼容 key/value 两侧带引号、冒号后多个空格等写法；
 *   - 空值/注释行会被忽略。
 */
async function operator(proxies, targetPlatform, context) {
  // 取出 hosts 文本：兼容字符串、JSON 字符串、对象（hosts 字段或首个值）。
  const text = extractHostsText(typeof $arguments !== 'undefined' ? $arguments : '');

  // 解析成 域名 -> 域名 的映射表。
  const hosts = parseHosts(text);

  // 无有效映射表时原样返回，避免误改。
  if (Object.keys(hosts).length === 0) return proxies || [];

  return (proxies || []).map((p) => {
    if (p && p.server && hosts[p.server] != null) p.server = hosts[p.server];
    return p;
  });
}

// 从各种形式的入参里取出 hosts 文本。
function extractHostsText(arg) {
  if (arg && typeof arg === 'object') {
    // 优先取 hosts 字段，否则取第一个值
    const v = arg.hosts != null ? arg.hosts : Object.values(arg)[0];
    return v == null ? '' : String(v);
  }
  let s = String(arg || '').trim();
  // 字符串形式的 JSON：{...} 或 "..."，尝试解析后递归取文本
  if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return extractHostsText(parsed);
      return String(parsed == null ? '' : parsed);
    } catch (e) { /* 解析失败就当普通文本 */ }
  }
  return s;
}

// 解析 hosts 文本：每行 `key: value`，忽略空行与 `#` 注释。
function parseHosts(text) {
  const hosts = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // key 允许带引号；分隔符为冒号（value 去掉首尾引号）
    const m = t.match(/^["']?([^"':]+?)["']?\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    // 跳过 hosts 这个分组名本身和空值
    if (key && key !== 'hosts' && val) hosts[key] = val;
  }
  return hosts;
}
