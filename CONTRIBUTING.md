# 脚本规范

本仓库用于存放 Sub-Store「脚本操作」脚本，一个脚本一个文件夹。新增脚本请遵循以下规范。

## 1. 目录结构

```
scripts/<中文脚本名>/
├── README.md
└── script.js
```

## 2. 命名

- 文件夹用中文，格式为 `平台+动作`，如 `mihomo节点域名替换`、`mihomo规则精简`。
- 代码文件固定叫 `script.js`。
- README 的 H1 标题 = 文件夹名。

## 3. script.js 代码规范

- 入口固定：`async function operator(proxies, targetPlatform, context) { ... }`，返回 `proxies` 数组。
- 可调变量与开关集中在脚本**顶部 `CONFIG` 对象**里，方便统一修改；运行时可用 `$arguments` 覆盖。
- 关键逻辑写中文注释，说明「为什么这么做」，便于日后维护。
- 参数从 `$arguments` 读取（对应 Sub-Store 的「键/值」），不硬编码；敏感映射一律走参数。
- 引用 Sub-Store 全局变量（`$arguments`、`$content` 等）前用 `typeof x !== "undefined"` 守卫，避免未定义报错导致脚本整体失效。
- 输入解析要容错：忽略空行、`#` 注释、缩进、首尾引号。
- 匹配用精确匹配，未命中的节点保持原样，不误伤。
- 不加多余依赖，纯原生 JS，保持单文件可直接粘贴。
- 代码里不写死个人订阅数据、密钥等敏感信息。

## 4. README 规范

固定四块：

1. 用途
2. 参数（键/值 + 示例）
3. 匹配规则 / 行为
4. 脚本位置（链接 `script.js`）

## 5. Git 规范

- 一个脚本一个 commit，消息简短英文（如 `Add mihomo nodes domain rewrite`）。
- 直接推 `main`。
- 同步在根 `README.md` 的脚本列表加一行。
