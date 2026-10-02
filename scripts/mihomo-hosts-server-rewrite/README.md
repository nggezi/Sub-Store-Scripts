# mihomo-hosts-server-rewrite

根据 `hosts` 映射表，把所有代理节点的 `server` 字段批量替换为别名域名；未命中的 server 保持原样。

## 用途

本地 mihomo 配置依赖 `hosts` 段做域名映射（把原始节点 server 替换成别名域名），但 Sub-Store 处理本地文件时不会自动应用 `hosts`。本脚本在「脚本操作」阶段手动完成替换。

## 参数

在「脚本操作」的参数中填写 **键 / 值** 两个框：

- 键：`hosts`
- 值：整段 YAML（含 `hosts:` 头、缩进均可）

示例：

```yaml
hosts:
  9689b1ce-43dc-4623-b35c-b41757bc39bd.sankuaei.com: e8b6cd12-66ba-43e2-bfb3-10c3584317a1.definition-meaning.top
  ab9cf853-935b-4a2c-b04b-9aa3d72e8219.sankuaei.com: c7222970-cd14-4802-86e3-162dd3746ae4.definition-meaning.top
```

映射方向：冒号左边（key）= 原始 server，右边（value）= 替换后的别名域名。

## 匹配规则

- 精确匹配节点 `server` 与映射的 key。
- 未命中的节点不做修改。
- 自动忽略空行、`#` 注释、`hosts:` 头、缩进与首尾引号。

## 脚本

见 [script.js](./script.js)。把内容粘贴到 Sub-Store 脚本框即可。
