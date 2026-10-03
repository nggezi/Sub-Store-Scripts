# Sub-Store Scripts

Sub-Store「脚本操作」脚本合集。

## 脚本列表

| 脚本 | 说明 |
| --- | --- |
| [mihomo节点域名替换](./scripts/mihomo节点域名替换) | 根据 `hosts` 映射表批量替换 mihomo 节点 `server` 为别名域名 |
| [节点多IP裂变](./scripts/节点多IP裂变) | 用 DoH（可带 ECS）解析域名节点为多个入口 IP，并把每个 IP 裂变成一个节点 |
| [入口落地检测](./scripts/入口落地检测) | 整合 xream 官方脚本，一次完成域名解析→入口检测→落地检测→重命名 |

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
