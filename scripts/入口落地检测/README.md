# 节点入口 & 落地检测

把 xream 官方的 `entrance.js`（入口检测）和 `geo.js`（落地检测）合并成一个脚本，一次完成：域名解析 → 入口检测 → 落地检测 → 重命名。

## 原理

| 阶段 | 做什么 | 环境要求 |
| --- | --- | --- |
| 域名解析 | 把域名节点解析成 IP（入口检测需要 IP） | 任意（DoH） |
| 入口检测 | 直接 HTTP 请求 `ip-api.com`，查节点服务器 IP 的归属 | 任意 |
| 落地检测 | 通过代理发请求，查出口 IP 的归属 | Loon / Surge / Egern |
| 重命名 | 用国旗 + ASO 重命名节点 | 任意 |

- **入口** = 节点服务器本身的 IP（VPS 所在地）
- **落地** = 通过节点连接后，出口 IP 的归属（流量最终从哪里出去）

官方方案需要多个操作串联（域名解析 → 去重 → entrance.js → geo.js → 过滤 → 重命名 → 排序），本脚本把它们合并成一个。

## 运行环境

- **入口检测**：任意环境可用（直接 HTTP 请求）
- **落地检测**：需要 Loon / Surge / Egern（通过代理发请求）
  - 纯 Node.js 版 Sub-Store 无法做落地检测（需配合 http-meta），脚本会自动跳过落地阶段，只做入口检测

## 参数说明

配置位于脚本顶部 `CONFIG` 对象：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `resolve` | `true` | 是否先把域名节点解析成 IP |
| `doh` | `https://223.6.6.6/dns-query` | DoH 服务器 |
| `resolveType` | `A` | 解析记录类型（A / AAAA） |
| `entranceApi` | `http://ip-api.com/json/{{proxy.server}}?lang=zh-CN` | 入口检测 API |
| `exitApi` | `http://ip-api.com/json?lang=zh-CN` | 落地检测 API |
| `timeout` | `5000` | 请求超时（毫秒） |
| `retries` | `1` | 重试次数 |
| `retryDelay` | `1000` | 重试间隔（毫秒） |
| `concurrency` | `10` | 并发数 |
| `removeFailed` | `false` | 是否移除检测失败的节点 |
| `cache` | `true` | 是否使用缓存 |
| `rename` | `true` | 是否重命名为「入口 ➮ 落地」格式 |
| `restoreDomain` | `false` | 是否把 server 还原为原始域名 |

## 使用方法

1. 打开 Sub-Store → 订阅 → 添加「脚本操作」；
2. 将 `script.js` 内容整体粘贴到脚本框（无需额外参数）；
3. 按需修改顶部 `CONFIG`；
4. 保存并刷新订阅。

## 输出格式

重命名后的节点名：

- 入口 ≠ 落地：`🇺🇸 AS123 ➮ 🇯🇵 AS456 [vmess]`
- 入口 = 落地：`🇯🇵 AS456 [vmess]`
- 仅入口（环境不支持落地）：`🇺🇸 AS123 [vmess]`

## 注意事项

- 落地检测会让请求数翻倍，注意调节 `timeout` 和 `concurrency`。
- 已开启缓存（`scriptResourceCache`），避免重复请求被风控。
- 首次运行可能较慢（节点多、需逐个检测），后续会命中缓存。
- 部分 CDN IP 可能无法获取 countryCode。
- 如需还原域名，开启 `restoreDomain`（需先开启 `resolve`）。
- 基于 [xream/scripts](https://github.com/xream/scripts) 的 `entrance.js` 和 `geo.js` 整合。
