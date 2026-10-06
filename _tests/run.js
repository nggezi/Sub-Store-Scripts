// 本地 mock 测试台：加载仓库里 4 个脚本，注入假的 Sub-Store 运行时，验证行为。
// 运行：node _tests/run.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push('  OK   ' + name); }
  else { fail++; results.push('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// 载入某个脚本的 operator 函数：在文件末尾追加 `this.__op = operator`，
// 不改变脚本自身的函数声明方式（改声明为表达式会破坏其返回行为）。
function loadOperator(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return src + '\n; this.__op = operator;';
}

function makeProxyUtils(over = {}) {
  const base = {
    isIP: (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s || '')) || /^[0-9a-f:]+$/i.test(String(s || '')) && String(s || '').includes(':'),
    doh: async () => ({ answers: [] }),
    getFlag: (cc) => (cc ? '[flag:' + cc + ']' : ''),
    process: async (list) => list,
    MMDB: function MMDB() { return { geoip: () => ({}), ipaso: () => ({}) }; },
  };
  return Object.assign(base, over);
}

// 在沙箱里跑 operator(...)
async function runScript(rel, { proxies, args, utils, substore, cache, httpClient, options }) {
  const code = loadOperator(rel);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    ProxyUtils: utils,
    $arguments: args,
    $substore: substore,
    $httpClient: httpClient,
    $utils: undefined,
    $options: options,
    scriptResourceCache: cache,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: rel });
  const opFn = sandbox.__op;
  return await opFn(proxies, 'ClashMeta', { source: undefined, raw: undefined });
}

(async () => {
  // ---------------- 入口版：核心 bug 场景 ----------------
  {
    // DoH 全失败（限速）时：应保留原名、且不泄漏 _domain/_resolved_ips
    const utils = makeProxyUtils({ doh: async () => { throw new Error('HTTP/2: headers timeout'); } });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: '香港 A01', type: 'vless', server: 'hk01.alilago.org', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Prime Security Corp.","country":"香港","countryCode":"HK"}' }) } },
      cache: new Map(),
    });
    const n = out[0];
    check('入口版: DoH全失败仍输出1条', out.length === 1, JSON.stringify(out));
    check('入口版: DoH全失败保留原名', n && n.name === '香港 A01', n && n.name);
    check('入口版: 不泄漏 _domain', n && !('_domain' in n), Object.keys(n || {}).join(','));
    check('入口版: 不泄漏 _resolved_ips', n && !('_resolved_ips' in n), Object.keys(n || {}).join(','));
  }

  {
    // DoH 解析出 1 个海外 IP，geoip 成功 -> 命名「香港119」之类；且字段不泄漏
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '27.44.143.211' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: '香港 A01', type: 'vless', server: 'hk01.alilago.org', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Prime Security Corp.","country":"香港","countryCode":"HK"}' }) } },
      cache: new Map(),
    });
    const n = out[0];
    check('入口版: 海外按 国家+IP首段 命名', n && /^香港27/.test(n.name), n && n.name);
    check('入口版: server 换成 IP', n && n.server === '27.44.143.211', n && n.server);
    check('入口版: 输出不泄漏内部字段', n && !('_domain' in n) && !('_resolved_ips' in n), Object.keys(n || {}).join(','));
  }

  {
    // 旧版脚本可能在缓存里写入「只有 operator 字段的空壳」geo（无 countryCode）。
    // 新版 geoip 必须识别为无效缓存并重新查询，否则命名会永远回退成线路名。
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '27.44.143.211' }] }) });
    const dirtyCache = new Map();
    dirtyCache.set('geo:27.44.143.211', { operator: '' }); // 旧格式脏缓存
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: '香港 A01', type: 'vless', server: 'hk01.alilago.org', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Prime Security Corp.","country":"香港","countryCode":"HK"}' }) } },
      cache: dirtyCache,
    });
    const n = out[0];
    check('入口版: 旧格式脏geo缓存不被复用(仍按真实查询命名)', n && /^香港27/.test(n.name), n && n.name);
    check('入口版: 新版geo缓存key带版本前缀', [...dirtyCache.keys()].some((k) => k === 'geo:v2:27.44.143.211'), [...dirtyCache.keys()].join(','));
  }

  {
    // 国内 IP + 命中 ispMap -> 运营商+IP首段
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '119.36.124.169' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'X', type: 'trojan', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"China Unicom","country":"中国","countryCode":"CN"}' }) } },
      cache: new Map(),
    });
    check('入口版: 国内命中运营商 -> 联通119', out[0] && out[0].name === '联通119 - X', out[0] && out[0].name);
  }

  {
    // 多线路同 IP -> 合并一条，不重复
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '1.2.3.4' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'X', type: 'vmess', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"China Mobile","country":"中国","countryCode":"CN"}' }) } },
      cache: new Map(),
    });
    check('入口版: 三线路同IP合并为1条', out.length === 1, 'len=' + out.length);
  }

  {
    // server 已是 IP：应原样保留，即使带 stale _resolved_ips 也不应误裂变
    const utils = makeProxyUtils();
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'orig', type: 'ss', server: '27.44.143.211', port: 443, _domain: 'hk01.alilago.org', _resolved_ips: [{ name: '移动', result: ['9.9.9.9'] }] }],
      args: {},
      utils,
      substore: { info: () => {} },
      cache: new Map(),
    });
    const n = out[0];
    check('入口版: server已是IP原样保留(不误裂变)', out.length === 1 && n.server === '27.44.143.211', 'len=' + out.length + ' server=' + (n && n.server));
    check('入口版: IP节点剥离stale内部字段', n && !('_domain' in n) && !('_resolved_ips' in n), Object.keys(n || {}).join(','));
  }

  {
    // 海外 IP，但 ip-api 返回英文 country（"United States"）+ countryCode US
    // -> 应用中文兜底表，命名「美国8」而不是「United States8」
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '8.8.8.8' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'X', type: 'vless', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Google LLC","country":"United States","countryCode":"US"}' }) } },
      cache: new Map(),
    });
    check('入口版: 英文国家名兜底成中文(美国8)', out[0] && out[0].name === '美国8 - X', out[0] && out[0].name);
  }
  {
    // 国内未命中运营商 + 有国家 -> 中国+首段（不因 operator 为空而丢国家）
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '111.13.1.1' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'X', type: 'vless', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Some ISP","country":"中国","countryCode":"CN"}' }) } },
      cache: new Map(),
    });
    check('入口版: 国内未命中运营商 -> 中国111', out[0] && out[0].name === '中国111 - X', out[0] && out[0].name);
  }
  {
    // IPv6 解析：firstSeg 不产出 16 进制串，前缀退化为「国家/地区」
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '2001:db8::1' }] }) });
    const out = await runScript('scripts/节点多IP裂变-入口版/script.js', {
      proxies: [{ name: 'X', type: 'vless', server: 'a.example.com', port: 443 }],
      args: { type: 'AAAA' },
      utils,
      substore: { info: () => {}, http: { get: async () => ({ body: '{"status":"success","isp":"Google LLC","country":"United States","countryCode":"US"}' }) } },
      cache: new Map(),
    });
    check('入口版: IPv6 不复用首段(前缀=国家)', out[0] && out[0].name === '美国 - X', out[0] && out[0].name);
  }

  // ---------------- 节点多IP裂变（EDNS 命名版） ----------------
  {
    const utils = makeProxyUtils({ doh: async (o) => ({ answers: [{ type: 'A', data: o.edns === '111.47.229.151' ? '10.0.0.1' : '10.0.0.2' }] }) });
    const out = await runScript('scripts/节点多IP裂变/script.js', {
      proxies: [{ name: 'X', type: 'vless', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {} },
      cache: new Map(),
    });
    check('裂变: 两个不同IP -> 2条', out.length === 2, 'len=' + out.length + ' ' + JSON.stringify(out));
    check('裂变: 命名用线路首字', Array.isArray(out) && out.every((n) => /^[移电联]/.test(n.name)), JSON.stringify(out));
    check('裂变: 不泄漏内部字段', Array.isArray(out) && out.every((n) => !('_domain' in n) && !('_resolved_ips' in n)), JSON.stringify(out));
  }
  {
    // 同IP被三线路命中 -> 合并成一条，前缀 移/电/联
    const utils = makeProxyUtils({ doh: async () => ({ answers: [{ type: 'A', data: '10.0.0.9' }] }) });
    const out = await runScript('scripts/节点多IP裂变/script.js', {
      proxies: [{ name: 'X', type: 'vless', server: 'a.example.com', port: 443 }],
      args: {},
      utils,
      substore: { info: () => {} },
      cache: new Map(),
    });
    check('裂变: 三线路同IP合并为1条', out.length === 1, 'len=' + out.length);
    check('裂变: 合并前缀 移/电/联', out[0] && out[0].name === '移/电/联 - X', out[0] && out[0].name);
  }

  // ---------------- mihomo 域名替换 ----------------
  {
    const utils = makeProxyUtils();
    const txt = '# comment\nexample.com: node1.example.net\nfoo.bar :   baz.qux\nhosts:\n\n"quoted.com": "q.net"\n';
    const out = await runScript('scripts/mihomo节点域名替换/script.js', {
      proxies: [
        { name: 'a', server: 'example.com', port: 1 },
        { name: 'b', server: 'foo.bar', port: 2 },
        { name: 'c', server: 'quoted.com', port: 3 },
        { name: 'd', server: 'untouched.com', port: 4 },
      ],
      args: txt,
      utils,
      substore: {},
      cache: new Map(),
    });
    check('mihomo: 命中替换', Array.isArray(out) && out[0] && out[0].server === 'node1.example.net' && out[1].server === 'baz.qux', JSON.stringify(out));
    check('mihomo: 引号键替换', Array.isArray(out) && out[2] && out[2].server === 'q.net', JSON.stringify(out));
    check('mihomo: 未命中原样', Array.isArray(out) && out[3] && out[3].server === 'untouched.com', JSON.stringify(out));
  }
  {
    const utils = makeProxyUtils();
    let out, err = '';
    try {
      out = await runScript('scripts/mihomo节点域名替换/script.js', {
        proxies: [{ name: 'a', server: 'example.com', port: 1 }],
        args: '',
        utils,
        substore: {},
        cache: new Map(),
      });
    } catch (e) { err = e && e.stack; }
    check('mihomo: 空参数原样返回', Array.isArray(out) && out[0] && out[0].server === 'example.com', err || JSON.stringify(out));
  }
  {
    // 原型污染防护：server 恰为 __proto__ / constructor 时不应被原型链命中
    const utils = makeProxyUtils();
    const out = await runScript('scripts/mihomo节点域名替换/script.js', {
      proxies: [
        { name: 'a', server: '__proto__', port: 1 },
        { name: 'b', server: 'constructor', port: 2 },
        { name: 'c', server: 'toString', port: 3 },
      ],
      args: 'normal.com: node1.net',
      utils,
      substore: {},
      cache: new Map(),
    });
    check('mihomo: 原型键不被误改', Array.isArray(out) && out[0].server === '__proto__' && out[1].server === 'constructor' && out[2].server === 'toString', JSON.stringify(out));
  }
  {
    // 不可变：命中替换时返回新对象，不原地改输入
    const utils = makeProxyUtils();
    const input = [{ name: 'a', server: 'example.com', port: 1 }];
    const out = await runScript('scripts/mihomo节点域名替换/script.js', {
      proxies: input,
      args: 'example.com: node1.example.net',
      utils,
      substore: {},
      cache: new Map(),
    });
    check('mihomo: 命中替换不原地改输入', input[0].server === 'example.com' && out[0].server === 'node1.example.net' && out[0] !== input[0], 'in=' + input[0].server + ' out=' + out[0].server);
  }

  // ---------------- 入口落地检测（rename，不改）: 只做 smoke ----------------
  {
    const utils = makeProxyUtils({ process: async (list) => list });
    let ok = true, err = '';
    try {
      await runScript('scripts/入口落地检测/script.js', {
        proxies: [{ name: '香港 A01', type: 'vless', server: 'hk01.alilago.org', port: 443 }],
        args: {},
        utils,
        substore: { info: () => {}, http: { get: async () => ({ body: 'ok' }) } },
        cache: new Map(),
        options: {},
      });
    } catch (e) { ok = false; err = e && e.message; }
    check('入口落地检测: smoke 不抛错', ok, err);
  }

  // ---------------- 回归：Script Filter/Operator 的 content 必须是完整函数定义 ----------------
  // Sub-Store 用 dh(name, content) 拼成 new Function(..., content + " return name")，
  // 因此 content 必须是 `function filter(...){...}` / `async function operator(...){...}` 源码；
  // 写成 `return true` 之类的裸语句会提前 return 出非函数值并抛
  // `TypeError: dh(...) is not a function`，导致整步被丢弃。
  {
    function dh(name, script) {
      const params = ['$arguments', '$options', '$substore', 'lodash', 'ProxyUtils', 'yaml', 'Buffer', 'b64d', 'b64e', 'DOMAIN_RESOLVERS', 'scriptResourceCache', 'flowUtils', 'produceArtifact', 'require'];
      return new Function(...params, `${script}\n return ${name}`)({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, undefined);
    }
    const src = fs.readFileSync(path.join(ROOT, 'scripts/入口落地检测/script.js'), 'utf8');
    const m = src.match(/type:\s*'Script Filter'[\s\S]*?content:\s*'([^']*(?:\\'[^']*)*)'/);
    check('入口落地检测: 找到 Script Filter step', !!m, 'regex miss');
    if (m) {
      const content = m[1].replace(/\\'/g, "'");
      let fn, err = '';
      try { fn = dh('filter', content); } catch (e) { err = e.message; }
      check('入口落地检测: Script Filter content 编译为函数', typeof fn === 'function', err || ('typeof=' + typeof fn));
      if (typeof fn === 'function') {
        const input = [{ name: 'a' }, { name: 'b' }];
        let kept;
        try { kept = await fn(input, 'ClashMeta', {}); } catch (e) { err = e.message; }
        check('入口落地检测: Script Filter 保留全部节点', Array.isArray(kept) && kept.length === 2, err || ('len=' + (kept && kept.length)));
      }
    }
    check('入口落地检测: 不再含裸 return true 过滤器', !/content:\s*'return true'/.test(src), 'still has return true');
    check('入口落地检测: entranceUrl 不含 remove_failed', !/entrance\.js#[^']*remove_failed/.test(src), 'still remove_failed');
    // 探针 IP 不能用 1.1.1.1：Cloudflare 任播地址在 GeoLite2-Country 里只有
    // registeredCountry 没 country，geoip() 返回 undefined，会让好库被误判为坏库。
    check('入口落地检测: GeoIP 探针不用 1.1.1.1', !/geoip\(\s*'1\.1\.1\.1'\s*\)/.test(src), 'still probes 1.1.1.1');
    // 模拟「好库」：8.8.8.8 有记录，1.1.1.1 无记录。探针修复后应判定库可用（internal=true）。
    {
      const goodUtils = makeProxyUtils({
        process: async (list) => list,
        MMDB: function MMDB() {
          return {
            geoip: (ip) => (ip === '1.1.1.1' ? undefined : 'US'),
            ipaso: (ip) => (ip === '1.1.1.1' ? undefined : 'Google LLC'),
          };
        },
      });
      let sawLocal = '';
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a) => { sawLocal += a.join(' '); };
      console.error = () => {};
      try {
        await runScript('scripts/入口落地检测/script.js', {
          proxies: [{ name: 'x', type: 'vless', server: '1.2.3.4', port: 443 }],
          args: {},
          utils: goodUtils,
          substore: { info: () => {}, http: { get: async () => ({ body: 'ok' }) } },
          cache: new Map(),
          options: {},
        });
      } catch (e) { /* smoke */ }
      console.log = origLog;
      console.error = origErr;
      check('入口落地检测: 好库(仅非任播IP有记录)判定为可用', /本地 GeoIP 库/.test(sawLocal), sawLocal.slice(0, 160));
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
