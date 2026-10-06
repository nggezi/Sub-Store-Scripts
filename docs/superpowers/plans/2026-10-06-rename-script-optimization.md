# 入口落地检测（rename）脚本优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成用户澄清后新纳入范围的 `scripts/入口落地检测/script.js`（用户口中的 "rename" 脚本）的优化：修复已发现的真 bug + 补齐多 DoH 源限速防护 + 让文档与代码一致。

**Architecture:** 脚本是一个单文件 `async function operator(proxies, targetPlatform, context)`，内部用 `ProxyUtils.process` 分三段（PRE/DETECT/POST）跑 11 步处理链。本次不改变三段结构，只做局部函数增强 + 配置项补齐 + 注释/文档同步。

**Tech Stack:** 纯 JavaScript（无构建、无依赖），Sub-Store Node.js/Docker 运行时；仓库测试台 `_tests/run.js`（node:vm 注入假运行时，`node _tests/run.js`）；E20C 实机（OpenWrt 容器 `sub-store`）用 nct automation 脚本 + `POST /api/preview/sub` 验证。

## Global Constraints

- 中间文件一律放项目内：`_e20c/`（实机调试产物）、`_tests/`（测试台）。禁止 `%TEMP%` / `/tmp`。
- 改完必须 `node --check scripts/入口落地检测/script.js` 且 `node _tests/run.js` 全绿。
- 不加无用注释；注释用中文，解释「为什么」而非「是什么」。
- 作者身份仅本仓库：`nggezi <2559214917@qq.com>`。**非用户明确要求，不 commit、不 push。**
- `hasLocalGeoip(ProxyUtils)` 必须保持 `ProxyUtils` 由调用方传入（测试会注入假 MMDB）。
- Script Filter / Script Operator 的 script-mode `content` **必须是完整的函数定义**（`async function filter(...){...}` / `async function operator(...){...}`），不能是裸语句——`dh(name, content)` 会拼成 `new Function(..., content + " return " + name)`。
- 用户已确认：**rename = 入口落地检测，也要优化**（推翻此前“不要改”的约束）。

---

### Task 1: 补回步骤 4 的 `filter=IPOnly`（+ `#filter6` 开关）

**背景（bug）:** 源 JSON（`source/entrance-geo-test-http-meta.json` 第 4 步）IPv6 解析是 `filter:"IPOnly"`，但脚本化后第 4 步写成了 `filter:'disabled'`，语义与源配置不一致：IPv6 解析失败 / 标了 `_no-resolve` 的域名节点不再被过滤掉。用户要求“对齐源配置 + 可优化”，用户拍板采用**同时加 `filter6` 开关**的方案（默认对齐源 = IPOnly，需要旧行为传 `#filter6=disabled`）。

**Files:**
- Modify: `scripts/入口落地检测/script.js`（约 3 处：CONFIG、args 解析、第 4 步 args）
- Test: `_tests/run.js`（新增 1 条断言）

**Interfaces:**
- Produces: `filter6` 配置项（`args.filter6` → 覆盖 `CONFIG.filter6`，取值 `'IPOnly'` | `'disabled'`），供 README 记录。

- [ ] **Step 1: 写失败测试**

在 `_tests/run.js` 的「入口落地检测」回归块内、`入口落地检测: 好库...` 那条 check 之后追加：

```js
    // 步骤 4（IPv6 解析）的 filter 应默认对齐源 JSON = IPOnly，并可用 #filter6 覆盖
    check('入口落地检测: 第4步 filter 默认 IPOnly', /type:\s*dns6[\s\S]*?filter:\s*filter6/.test(src) && /filter6\s*=\s*args\.filter6[\s\S]*?CONFIG\.filter6/.test(src), 'filter6 未接入');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node _tests/run.js`
Expected: `FAIL 入口落地检测: 第4步 filter 默认 IPOnly  -> filter6 未接入`，并保持其余全绿（`27 passed, 1 failed`）。

- [ ] **Step 3: 实现**

在 `CONFIG` 对象里、`restoreDomain: true,` 这一行**之前**插入：

```js
    // 步骤 4（IPv6 解析）的过滤模式，对齐源 JSON（entrance-geo-test-http-meta.json）
    //   'IPOnly'   = 只保留已成 IP 的节点（源 JSON 行为，默认）
    //   'disabled' = 不过滤，解析失败的域名节点保留（旧脚本行为，用 #filter6=disabled 还原）
    filter6: 'IPOnly',
```

在 `const restoreDomain = ...` 之后插入：

```js
  const filter6 = args.filter6 === undefined ? CONFIG.filter6 : String(args.filter6)
```

把第 4 步（IPv6 Resolve Domain Operator）的 args 改为：

```js
      args: { provider: dns6, type: 'IPv6', filter: filter6, cache: 'enabled', url: dnsUrl },
```

更新第 4 步上方的注释为：

```js
    // 再补一轮 IPv6；默认 filter=IPOnly 只保留已成 IP 的节点（对齐源 JSON），可用 #filter6=disabled 改为不过滤
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node _tests/run.js`
Expected: `28 passed, 0 failed`。

- [ ] **Step 5: Commit（用户确认后再执行）**

```bash
git add scripts/入口落地检测/script.js _tests/run.js
git commit -m "fix(入口落地检测): 步骤4 IPv6 filter 默认对齐源JSON(IPOnly) + 加 #filter6 开关"
```

---

### Task 2: 提取 `parseProbeIps` 帮助函数（消除探针 IP 的硬编码重复）

**背景（可读性）:** `hasLocalGeoip` 里 `PROBE_IPS` 数组硬编码在函数体内，注释和数值耦合。抽成模块级常量 `PROBE_IPS` + 纯函数 `pickGeoipProbe(mmdb)` 便于测试与复用（真实 IP 列表与“取第一个命中”的逻辑分离）。

**Files:**
- Modify: `scripts/入口落地检测/script.js`（`hasLocalGeoip` 上方 + 函数体）
- Test: `_tests/run.js`

**Interfaces:**
- Consumes: `ProxyUtils.MMDB` 实例（有 `geoip(ip)` / `ipaso(ip)`）
- Produces: `const PROBE_IPS = [...]`（模块级）；`function pickGeoipProbe(mmdb)` 返回 `{ country, asn }`（可能为 `{}` 的字段）

- [ ] **Step 1: 写失败测试**

在 `_tests/run.js` 文件末尾 `console.log(results.join('\n'))` 之前插入：

```js
  // ---------------- 入口落地检测：pickGeoipProbe 纯函数 ----------------
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/入口落地检测/script.js'), 'utf8');
    check('入口落地检测: 定义 PROBE_IPS 常量', /const PROBE_IPS\s*=\s*\[/.test(src), 'no PROBE_IPS');
    check('入口落地检测: 定义 pickGeoipProbe', /function pickGeoipProbe\s*\(/.test(src), 'no pickGeoipProbe');
  }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node _tests/run.js`
Expected: 新增 2 条 FAIL，其余全绿（`28 passed, 2 failed`）。

- [ ] **Step 3: 实现**

把 `hasLocalGeoip` 函数体里从 `const PROBE_IPS = [...]` 到 `if (country && asn) break; }` 这段替换为对 `pickGeoipProbe` 的调用。

在 `hasLocalGeoip` **上方**（`// 本地 GeoIP 库是否真的可用...` 注释之前）插入：

```js
// GeoIP 库探针：探针 IP 不能用 1.1.1.1 —— 它是 Cloudflare 任播地址，
// GeoLite2-Country 里只有 registeredCountry 没有 country，geoip() 返回 undefined，
// 会让「好库被误判为坏库」。轮询几个 host 段稳定、必然有 country 记录的 IP。
const PROBE_IPS = ['8.8.8.8', '114.114.114.114', '223.5.5.5']

// 从 MMDB 实例探测库是否可用：任一探针 IP 同时查到 country 和 asn 即算可用。
// 单独抽出来是为了能脱离 Sub-Store 运行时做纯函数测试。
function pickGeoipProbe(mmdb) {
  let country, asn
  for (const ip of PROBE_IPS) {
    if (!country && mmdb && mmdb.geoip) country = mmdb.geoip(ip)
    if (!asn && mmdb && mmdb.ipaso) asn = mmdb.ipaso(ip)
    if (country && asn) break
  }
  return { country, asn }
}
```

把 `hasLocalGeoip` 内原探针段改为：

```js
  try {
    const mmdb = new ProxyUtils.MMDB();
    const { country, asn } = pickGeoipProbe(mmdb);
    if (!country || !asn) {
      console.error(`[SCOPE] ERROR: MMDB 文件存在但查询失败（geoip=${country}, ipaso=${asn}），回退在线库`);
    }
    return !!(country && asn);
  } catch (e) {
```

（保留原 catch 块不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node _tests/run.js`
Expected: `30 passed, 0 failed`。再跑 `node --check scripts/入口落地检测/script.js`，Expected: 无输出（退出码 0）。

- [ ] **Step 5: Commit（用户确认后再执行）**

```bash
git add scripts/入口落地检测/script.js _tests/run.js
git commit -m "refactor(入口落地检测): 抽 pickGeoipProbe 纯函数 + PROBE_IPS 常量"
```

---

### Task 3: 多 DoH 源 + 失败换源重试（与另外三个脚本一致）

**背景（用户核心诉求）:** 用户明确要求「除了 rename 脚本其他三个」都做多 DoH 源轮询 + 失败换源重试 + 连续失败线性退避来对抗 DoH 限速（`HTTP/2: headers timeout`）。现在用户澄清 rename（入口落地检测）也要优化——但此脚本的 DoH 是交给 Sub-Store 原生 `Resolve Domain Operator` 处理的（`provider=Custom` + `url` 多行，Sub-Store 会并发查询），**脚本本身不实现 resolve**，因此「轮询/退避」在原生 operator 里不可控。本任务的可落地优化是：**把默认 `dnsUrl` 的 DoH 源从 5 个扩展为包含国内直连优先的稳定集合，并在注释/文档里说明换源失败的实际行为**，避免用户误以为脚本能自动退避。

**Files:**
- Modify: `scripts/入口落地检测/script.js`（`CONFIG.dnsUrl` 注释 + 值）
- Test: `_tests/run.js`（新增 1 条断言：dnsUrl 至少含 5 个 https DoH，且含国内源）

**Interfaces:**
- Produces: `CONFIG.dnsUrl` 字符串（换行分隔的 DoH 列表），可用 `#dnsUrl=...` 覆盖。

- [ ] **Step 1: 写失败测试**

在 `_tests/run.js` 文件末尾 `console.log(results.join('\n'))` 之前插入：

```js
  // ---------------- 入口落地检测：默认 DoH 源集合 ----------------
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/入口落地检测/script.js'), 'utf8');
    const m = src.match(/dnsUrl:\s*'([^']+)'/);
    const urls = m ? m[1].split('\n') : [];
    check('入口落地检测: 默认 DoH >= 5 个', urls.filter((u) => /^https:\/\//.test(u)).length >= 5, 'count=' + urls.length);
    check('入口落地检测: 默认 DoH 含国内源(alidns/doh.pub)', /alidns\.com|doh\.pub/.test(m ? m[1] : ''), m ? m[1] : 'no dnsUrl');
  }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node _tests/run.js`
Expected: 至少一条 FAIL（若当前 dnsUrl 已是 5 个 https 含国内源，则改为断言“含 quad9/dns.google/dns.alidns.com 三选二 + 注释含换源说明”）。先确认当前值再定断言。

- [ ] **Step 3: 实现**

将 `CONFIG.dnsUrl` 改为（国内源置前，排障时优先命中，且保留注释说明换源行为）：

```js
    // provider=Custom 时的 DoH 地址，多个用换行分隔，Sub-Store 会对整组并发查询。
    // 注：换源/限速退避由 Sub-Store 原生 Resolve Domain Operator 处理，脚本不介入；
    //     单源被 ban 时并发组里其它源仍能出结果，故这里放多家（国内源置前）。
    dnsUrl: 'https://dns.alidns.com/dns-query\nhttps://doh.pub/dns-query\nhttps://dns.google/dns-query\nhttps://cloudflare-dns.com/dns-query\nhttps://dns.quad9.net/dns-query',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node _tests/run.js`
Expected: 全绿。`node --check scripts/入口落地检测/script.js` 无输出。

- [ ] **Step 5: Commit（用户确认后再执行）**

```bash
git add scripts/入口落地检测/script.js _tests/run.js
git commit -m "chore(入口落地检测): 默认 DoH 源国内优先并说明换源行为"
```

---

### Task 4: 文档与代码对齐（README 修复）

**背景（文档 bug）:** `README.md` 已与实际代码不一致，会误导用户：
- 第 16 行：IPv6 步骤写 `filter=IPOnly` —— Task 1 后将正确；
- 第 34–35 行：`dns4`/`dns6` 默认值写 `Ali` —— 实际代码默认 `Custom`；
- 第 45 行：说「默认改为国内直连的 `Ali`」—— 实际默认是 `Custom` 多厂商 DoH；
- 第 51 行：说探针用 `1.1.1.1` —— 已改为 `8.8.8.8` 轮询（b14 修复）；
- 第 55 行 / 第 59 行 / 第 70 行：仍描述「入口和落地都测到才保留 / remove_failed 各生效一次」—— 与「保留所有节点 + 单边兜底」的实际行为矛盾。

**Files:**
- Modify: `scripts/入口落地检测/README.md`

- [ ] **Step 1: 逐项 `edit` 修正**

依次把上述 5 处改为与代码一致的内容：
- 第 16 行 `filter=IPOnly` 保留（Task 1 后正确），但补一句「可用 `#filter6=disabled` 关闭」。
- 参数表 `dns4` / `dns6` 默认值 `Ali` → `Custom`。
- 删除/重写第 45 行的「默认改为 Ali」说明，改为「默认 `Custom` 多厂商 DoH，国内源置前」。
- 探针描述 `1.1.1.1` → `8.8.8.8 / 114.114.114.114 / 223.5.5.5 轮询任一命中`。
- 「匹配规则/行为」段：`存活条件` 改为「解析失败/检测失败的节点**保留**，按单边信息命名」；删除 `remove_failed 也在两个检测脚本里各生效一次`；`未命中不改写` 改为「未命中保留原名字而非筛掉」。

- [ ] **Step 2: 校对**

Run: `node _tests/run.js`
Expected: 全绿（README 不影响测试，仅确认无回归）。

人工检查：README 里所有 `#参数` 名（`internal`/`dns4`/`dns6`/`dnsUrl`/`filter6`/`http_meta_host`/`http_meta_port`/`restore_domain`/`retries`/`timeout`）都能在 `script.js` 的 `args.*` 里找到对应读取。

- [ ] **Step 3: Commit（用户确认后再执行）**

```bash
git add scripts/入口落地检测/README.md
git commit -m "docs(入口落地检测): README 对齐实际代码（默认Custom多DoH/探针/保留所有节点）"
```

---

### Task 5: E20C 端到端验证（内联本地版 + 远程版）

**Files:**
- Test: `_e20c/preview_body_local.json`（需用 `make_local_body.js` 重新内联最新脚本）、`_e20c/preview_body_sanhuo_nocache.json`

- [ ] **Step 1: 重新生成内联提交体**

Run: `node _e20c/make_local_body.js`（把最新 `scripts/入口落地检测/script.js` 内联成 Script Operator `mode:'script'`，输出 `_e20c/preview_body_local.json`）。
Expected: 生成成功，脚本字符数更新。

- [ ] **Step 2: 上传并后台跑预览**

用 `sftp_upload` 传 `_e20c/preview_body_local.json` → `/mnt/mmc0-4/sub-store-data/_preview_body.json`，再用 nct 脚本 `_run2file`（scriptId `snippet-muviim3j-k339ba`）执行短命令 `docker exec -d sub-store node /opt/app/data/_do_preview.js`。

- [ ] **Step 3: 读结果**

等 25–40s，`sftp_read_file('/mnt/mmc0-4/sub-store-data/_preview_out.txt')`。
Expected: `original 12 → processed 12`；命名含真实 ISP 名与上标去重；无 `dh(...) is not a function`。

- [ ] **Step 4: 检查日志**

nct 跑 `docker logs --since 5m sub-store 2>&1 | tail -80 > /mnt/mmc0-4/sub-store-data/_logs2.txt`，读该文件。
Expected: `[SCOPE] INFO: 归属地数据源 = 本地 GeoIP 库`、`检测结果 —— 落地 12/12，入口 12/12`、无 `MMDB ... 回退在线库`、无 `Script Filter` 报错。

- [ ] **Step 5: 远程版验证**（仅在用户要求 push 后）

推送后，对 `_e20c/preview_body_sanhuo_nocache.json`（URL 带 `#noCache`）重复 Step 2–4，确认远程 raw 脚本同步生效。

---

## Self-Review

**1. Spec coverage:** 用户要求「rename（入口落地检测）也要优化」。本计划覆盖：真 bug 对齐源配置（Task 1）、代码质量/可测试性（Task 2）、DoH 诉求的可行部分 + 诚实说明（Task 3）、文档一致性（Task 4）、实机验证（Task 5）。已覆盖。

**2. Placeholder scan:** 无 TBD/TODO；每个改动步骤都给了完整代码/命令。

**3. Type consistency:** `filter6`（Task 1）在 README（Task 4）参数表用同名；`PROBE_IPS` / `pickGeoipProbe`（Task 2）命名在测试与实现中一致；`dnsUrl`（Task 3）保持既有键名。

**风险提示：** Task 3 的「多 DoH 换源重试」在本脚本中受限于 Sub-Store 原生 operator，脚本层无法做到像另外三个脚本那样的自研轮询/退避。已如实转化为「默认源集合优化 + 注释说明」。若用户坚持要自研退避，需要把步骤 3/4 从原生 Resolve Domain Operator 换成自研脚本（改动大，建议单独立项）。
