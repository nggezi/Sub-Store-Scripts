# 脚本规范

本仓库用于存放 Sub-Store「脚本操作」脚本，一个脚本一个文件夹。新增脚本请遵循以下规范。

## 1. 目录结构

```
scripts/<中文脚本名>/
├── README.md
└── script.js
```

可选：
```
scripts/<中文脚本名>/
├── README.md
├── script.js
└── source/              # 源配置（如从 JSON 转换而来）
    └── xxx.json
```

## 2. 命名

- 文件夹用中文，格式为 `平台+动作`，如 `mihomo节点域名替换`、`入口落地检测`。
- 代码文件固定叫 `script.js`。
- README 的 H1 标题 = 文件夹名。

## 3. script.js 代码规范

### 3.1 入口

```js
async function operator(proxies = [], targetPlatform, context) {
  // ...
  return proxies
}
```

### 3.2 配置

- 可调变量与开关集中在脚本**顶部 `CONFIG` 对象**里，方便统一修改；运行时可用 `$arguments` 覆盖。
- 参数从 `$arguments` 读取（对应 Sub-Store 的「键/值」），不硬编码；敏感映射一律走参数。
- 引用 Sub-Store 全局变量（`$arguments`、`$content` 等）前用 `typeof x !== "undefined"` 守卫。

### 3.3 错误处理（重要）

**绝对不要 `throw`**。Sub-Store 的 `ApplyOperator` 捕获 operator 的任何异常后会回退到 `nodeFunc`（快捷脚本形式），而函数式脚本的 `async function operator` 在那种包装下**只是被声明、从不被调用**，结果原样返回节点——日志里只有一行 error，输出看起来完全正常，等于整条链静默不执行。

参数校验失败时的正确做法：

```js
// 错误：throw 会导致静默失效
if (!known.includes(provider)) {
  throw new Error(`无效的 DNS 提供方 "${provider}"`)
}

// 正确：记日志 + 回退到安全默认值
if (!known.includes(provider)) {
  console.error(`[SCOPE] ERROR: 无效的 DNS 提供方 "${provider}"，已回退到 Ali`)
  return 'Ali'
}
```

### 3.4 日志

用 `[SCOPE]` 前缀输出日志，便于在 Sub-Store 日志页筛选：

```js
console.log(`[SCOPE] INFO: 检测结果 —— 落地 ${withGeo}/${total}，入口 ${withEntrance}/${total}`)
console.error('[SCOPE] ERROR: http-meta 不可达，落地检测会全部失败')
```

### 3.5 降级策略

检测失败时**不要输出空订阅**。根据实际拿到的数据决定行为：

```js
// 两项全废时返回原节点，而不是空列表
if (total > 0 && withGeo === 0 && withEntrance === 0) {
  console.error('[SCOPE] ERROR: 入口与落地检测全部失败，返回原节点')
  return out
}
```

### 3.6 代码风格

- 关键逻辑写中文注释，说明「为什么这么做」，便于日后维护。
- 输入解析要容错：忽略空行、`#` 注释、缩进、首尾引号。
- 匹配用精确匹配，未命中的节点保持原样，不误伤。
- 不加多余依赖，纯原生 JS，保持单文件可直接粘贴。
- 代码里不写死个人订阅数据、密钥等敏感信息。

## 4. 使用 ProxyUtils.process

脚本可以用官方 API `ProxyUtils.process` 跑完整条处理链，效果与导入 JSON 配置一致：

```js
const process = [
  { type: 'Quick Setting Operator', args: { udp: 'ENABLED' } },
  { type: 'Script Operator', args: { mode: 'link', content: 'https://...' } },
  // ...
]
return await ProxyUtils.process(proxies, process, targetPlatform, source, opts, raw, {})
```

**注意**：
- `source` / `raw` / `$options` 从 `context` 透传，让链内脚本拿到相同上下文
- 可以分多段调用 `ProxyUtils.process`，中间统计检测成功率

## 5. README 规范

固定四块：

1. 用途
2. 参数（键/值 + 示例）
3. 匹配规则 / 行为
4. 脚本位置（链接 `script.js`）

## 6. Git 规范

- 一个脚本一个 commit，消息简短英文（如 `Add entrance/geo detection script`）。
- 直接推 `main`。
- 同步在根 `README.md` 的脚本列表加一行。

## 7. 测试规范

脚本应该可以离线测试。推荐用 Sub-Store 后端的 `ProxyUtils.process` 跑真实处理链：

```js
import { ProxyUtils } from '@/core/proxy-utils'

const out = await ProxyUtils.process(
  [{ name: 'test', server: '1.1.1.1', port: 80, type: 'ss' }],
  [{ type: 'Script Operator', args: { mode: 'script', content: '...' } }],
  'Surge', undefined, undefined, undefined, {},
)
```

测试要点：
- 验证 process 链结构与预期一致
- 验证参数非法时不抛错、回退到默认值
- 验证检测失败时不输出空订阅
- 验证 `context` 为 undefined 时不报错

## 8. 常见坑

### 8.1 参数写错会静默失效

见 3.3。**绝对不要 `throw`**。

### 8.2 检测失败导致空订阅

落地检测需要 http-meta，入口检测需要 MMDB 或在线 API。任何一边失败都可能导致节点被筛掉。脚本应该：
- 探测 http-meta 可达性，不可达时跳过落地检测
- 统计检测成功率，单边失败时降级而不是全丢

### 8.3 DNS 解析失败导致节点丢失

`filter=IPOnly` 会把 server 不是 IP 的节点丢掉。如果 DNS 解析失败，域名节点会静默消失。建议用 `filter=disabled` 保留解析失败的节点。

### 8.4 多厂商 DNS 并发

单厂商 DNS 可能被 ban。用 `provider=Custom` + 多个 DoH 地址（换行分隔），Sub-Store 会并发查询：

```
#dns4=Custom&dnsUrl=https://dns.alidns.com/dns-query%0Ahttps://dns.google/dns-query%0Ahttps://cloudflare-dns.com/dns-query
```

### 8.5 还原域名

解析成功的节点 `server` 会被替换成 IP，原域名保存在 `_domain`。输出前可以还原：

```js
if ($server._domain) {
  $server.server = $server._domain
  delete $server._domain
}
```
