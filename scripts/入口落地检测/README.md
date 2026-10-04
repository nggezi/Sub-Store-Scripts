# 入口落地检测

把两份「入口 & 落地 检测」处理配置（`entrance-geo-test-http-meta*.json`）脚本化成一个 `script.js`：用 Sub-Store 官方脚本 API `ProxyUtils.process` 在脚本里跑完整条处理链，效果与导入 JSON 配置一致，但可以托管到 GitHub、在脚本操作里直接贴链接。

默认 `internal=auto`——**有本地 GeoIP 库就用本地库，缺库自动回退在线 ip-api**，不用手动选。

## 用途

一次跑完 11 步处理链，输出按「入口 ➮ 落地」改好名、排好序的节点：

| # | 步骤 | 作用 |
| --- | --- | --- |
| 1 | 快速设置 | `udp` / `tfo` / `skip-cert-verify` 置 `ENABLED` |
| 2 | 正则筛选 | 丢掉 `#` / `//` 开头的注释行 |
| 3 | 域名解析 | Google 解析 IPv4 |
| 4 | 域名解析 | Cloudflare 解析 IPv6，`filter=IPOnly` 只留已成 IP 的节点 |
| 5 | 去重 | 按 `server+port+type` 去重，清掉 `_geo` / `_entrance` |
| 6 | 落地检测 | xream `http_meta_geo.js`，经 http-meta 查出口 IP 归属 → `_geo` |
| 7 | 入口检测 | xream `entrance.js`，查节点服务器 IP 归属 → `_entrance` |
| 8 | 脚本筛选 | 只保留 `_geo` 和 `_entrance` 都拿到的节点 |
| 9 | 重命名 | `🇺🇸 运营商 ➮ 🇯🇵 运营商 [类型]`，入口=落地时只留落地 |
| 10 | 排序 | 按名称升序 |
| 11 | 重名加角标 | 重名节点追加 `⁰¹²³⁴⁵⁶⁷⁸⁹` 上标 |

**入口** = 节点服务器本身的 IP 归属；**落地** = 经节点转发后出口 IP 的归属。两者不同说明有中转。

## 参数

配置在脚本顶部 `CONFIG`，用脚本链接 `#` 后的键值覆盖。

| 键 | 默认值 | 示例 | 说明 |
| --- | --- | --- | --- |
| `internal` | `auto` | `#internal` / `#internal=false` | 归属地数据源。`auto` 优先本地 GeoIP 库、缺库自动回退在线；`true` 强制本地；`false` 强制在线 IP 库（ip-api.com） |
| `dns4` | `Ali` | `#dns4=Google` | 步骤 3（IPv4 解析）的 DNS 提供方 |
| `dns6` | `Ali` | `#dns6=Cloudflare` | 步骤 4（IPv6 解析）的 DNS 提供方 |
| `dnsUrl` | `''` | `#dnsUrl=https://dns.alidns.com/dns-query` | `provider=Custom` 时的 DNS 地址，多个用换行分隔 |
| `retries` | `1` | `#retries=2` | 每个检测请求的重试次数 |
| `timeout` | `1999` | `#timeout=3000` | 每个检测请求的超时（毫秒） |

可选 DNS 提供方：`Ali`（223.6.6.6）/ `Tencent`（119.28.28.28）/ `Google` / `Cloudflare` / `Custom` / `IP-API`。

> **DNS 默认值与源 JSON 不同，这是有意改动。** 源 JSON 用 `Google` + `Cloudflare`，两者在国内可能不通；解析失败不会报错（只打日志），但步骤 4 的 `filter=IPOnly` 会把仍是域名的节点**静默丢掉**，表现为订阅里节点莫名减少。故默认改为国内直连的 `Ali`。要还原源 JSON 行为：`#dns4=Google&dns6=Cloudflare`。
>
> 注意 `IP-API` 不支持解析 IPv6，设 `dns6=IP-API` 会被脚本提前拦下报错——Sub-Store 原生行为是直接抛错导致整链失败。

`internal` 会同时改变三处：落地/入口两个脚本的 `internal` 参数、以及重命名取的字段（在线库用 `country`/`isp`，GeoIP 库用 `countryCode`/`aso`）。

`auto` 的探测逻辑：代理 App 版有 `$utils.geoip`/`$utils.ipaso` 即认为可用；Node.js 版构造 `ProxyUtils.MMDB()` 并用 `1.1.1.1` 试查 country + asn，两者都有值才算可用（文件缺失会抛错，被 catch 后回退在线）。实际走了哪套数据源会打进日志：`归属地数据源 = 本地 GeoIP 库 / 在线 IP 库`。

## 匹配规则 / 行为

- **存活条件**：入口和落地**都**测到才保留，缺任一项即被步骤 8 丢弃（`remove_failed` 也在两个检测脚本里各生效一次）。
- **去重键**：`server` + `port` + `type` 三者全同视为重复，只留第一条。
- **`filter=IPOnly`**：步骤 4 之后仍不是 IP 的域名节点会被丢掉（解析失败、或标了 `_no-resolve`）。**解析失败不会报错**，所以 DNS 选不通的提供方会让域名节点静默消失——见上方 DNS 说明。
- **重名判定**：步骤 11 按**改名后**的 `name` 判重，追加上标且不加连接符（`link` 为空）。
- **未命中不改写**：解析不到、检测失败的节点不会被硬改名，而是直接被筛掉。

### 降级策略（重要）

脚本分三段执行（预处理 → 检测 → 后处理），中间统计检测成功率，**任何一边全失败都不会输出空订阅**：

| 场景 | 行为 | 日志 |
| --- | --- | --- |
| http-meta 不可达 | 跳过落地检测，只用入口信息改名 | `http-meta 不可达（127.0.0.1:9876）…` |
| 本地 GeoIP 库不可用 | 跳过入口检测，只用落地信息改名 | `MMDB 不可用（…），回退在线库` |
| 两边都失败 | 跳过改名，返回原节点 | `入口与落地检测全部失败…` |
| 单边部分失败 | 按原版行为丢弃失败节点 | `检测结果 —— 落地 X/Y，入口 Z/W` |

降级时节点名只有单边信息（如 `🇺🇸 ISP-1 [ss]`，没有 `➮`），便于识别。

> **为什么需要降级**：Sub-Store 的 `ApplyOperator` 会捕获脚本异常并回退到 `nodeFunc`（快捷脚本形式），而本脚本的 `async function operator` 在那种包装下**只是被声明、从不被调用**，结果原样返回节点——日志里只有一行 error，输出看起来完全正常。所以检测失败不能靠抛错表达，只能靠计数 + 降级。

### 运行前提

1. **只适用于 Node.js / Docker 版**。步骤 6 的 `http_meta_geo.js` 会连本地 http-meta，而且它的 `/start` 调用没有 try/catch——App 版（Surge/Loon）没有 http-meta，整条链会直接报错。App 版请用 xream 的 [`geo.js`](https://zhetengsha.eu.org/blog/posts/1269)（经代理发请求，无需 http-meta），那是另一条链。
2. **需要本地跑 [http-meta](https://github.com/xream/http-meta)**，默认 `127.0.0.1:9876`。Docker 版用带 `http-meta` tag 的镜像（`xream/sub-store:http-meta`）即内置，端口默认无需配置。**如果日志出现 `http-meta 不可达`，说明它没在运行**——脚本会降级为只用入口信息，不会输出空订阅，但落地信息会缺失。
3. **用本地 GeoIP 库时**：Node.js 版设 `SUB_STORE_MMDB_COUNTRY_PATH` / `SUB_STORE_MMDB_ASN_PATH`（country 和 asn **两个都要**，否则重名改名会缺字段）；代理 App 版需 `$utils.geoip` / `$utils.ipaso`（Surge、Loon build ≥ 692）。
4. **Node.js 版需设置 `SUB_STORE_FRONTEND_BACKEND_PATH`**，否则脚本操作不生效（Sub-Store 通用要求）。
5. 两个检测脚本都会发外部请求，节点多时较慢；已开 `cache`，可在前端配缓存 TTL，或用定时同步（`SUB_STORE_BACKEND_SYNC_CRON`）预热缓存，避免白天手动拉取超时。

### 日志

脚本用 `[SCOPE]` 前缀输出日志，便于在 Sub-Store 日志页筛选：

```
[SCOPE] INFO: 归属地数据源 = 本地 GeoIP 库（internal=auto）
[SCOPE] INFO: 检测结果 —— 落地 12/12，入口 12/12
```

异常时会有 `[SCOPE] ERROR:` 说明原因和修复方向。

## 脚本位置

[script.js](./script.js)

用法：订阅 → **节点操作** → **脚本操作** → 填本文件的 raw 链接，可带 `#` 参数。

```
# 默认：优先本地 GeoIP 库（缺库自动回退），DNS 走国内 Ali
https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/入口落地检测/script.js

# 强制本地 GeoIP 库
https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/入口落地检测/script.js#internal

# 强制在线 IP 库（ip-api.com）
https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/入口落地检测/script.js#internal=false

# 换 DNS（例：还原源 JSON 的 Google + Cloudflare）
.../script.js#dns4=Google&dns6=Cloudflare

# 用自定义 DoH
.../script.js#dns4=Custom&dnsUrl=https://dns.alidns.com/dns-query
```

同目录下的 `entrance-geo-test-http-meta.json` 与 `entrance-geo-test-http-meta-internal-geoip.json` 是本脚本的源配置，需要导入式用法时仍可直接导入 Sub-Store。
