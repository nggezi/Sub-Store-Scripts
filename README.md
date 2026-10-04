# Sub-Store Scripts

Sub-Store「脚本操作」脚本合集。

## 脚本列表

| 脚本 | 说明 |
| --- | --- |
| [mihomo节点域名替换](./scripts/mihomo节点域名替换) | 根据 `hosts` 映射表批量替换 mihomo 节点 `server` 为别名域名 |
| [节点多IP裂变](./scripts/节点多IP裂变) | 用 DoH（可带 ECS）解析域名节点为多个入口 IP，并把每个 IP 裂变成一个节点 |
| [节点多IP裂变-入口版](./scripts/节点多IP裂变-入口版) | 同上，但命名前缀用 IP 归属地（城市+运营商，如 深电/广腾） |
| [入口落地检测](./scripts/入口落地检测) | 一个脚本跑完 11 步链：域名解析→入口检测→落地检测→改名排序，托管后贴链接即可用 |

## 脚本链接

复制以下链接到 Sub-Store「脚本操作」：

| 脚本 | 链接 |
| --- | --- |
| mihomo节点域名替换 | `https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/mihomo%E8%8A%82%E7%82%B9%E5%9F%9F%E5%90%8D%E6%9B%BF%E6%8D%A2/script.js` |
| 节点多IP裂变 | `https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/%E8%8A%82%E7%82%B9%E5%A4%9AIP%E8%A3%82%E5%8F%98/script.js` |
| 节点多IP裂变-入口版 | `https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/%E8%8A%82%E7%82%B9%E5%A4%9AIP%E8%A3%82%E5%8F%98-%E5%85%A5%E5%8F%A3%E7%89%88/script.js` |
| 入口落地检测 | `https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/%E5%85%A5%E5%8F%A3%E8%90%BD%E5%9C%B0%E6%A3%80%E6%B5%8B/script.js` |

带参数示例（入口落地检测）：

```
# 默认（优先本地 GeoIP 库，DNS 走多厂商 DoH，输出还原域名）
https://raw.githubusercontent.com/nggezi/Sub-Store-Scripts/main/scripts/%E5%85%A5%E5%8F%A3%E8%90%BD%E5%9C%B0%E6%A3%80%E6%B5%8B/script.js

# 强制在线 IP 库
.../script.js#internal=false

# 关闭还原域名（保持 IP）
.../script.js#restore_domain=false

# 自定义 http-meta 地址
.../script.js#http_meta_host=192.168.1.100&http_meta_port=9999
```

## 目录结构

```
scripts/
└── <script-name>/
    ├── README.md   # 脚本说明与用法
    └── script.js   # 脚本代码
```

## 使用方法

1. 打开 Sub-Store → 订阅 → 添加「脚本操作」。
2. 将对应目录下 `script.js` 的内容粘贴到脚本框。
3. 按各脚本 README 的说明填写参数。

## 脚本规范

新增脚本请遵循 [CONTRIBUTING.md](./CONTRIBUTING.md)。
