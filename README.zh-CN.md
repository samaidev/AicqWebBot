<div align="center">

# 🤖 AicqWebBot

**浏览器就是智能体的容器。**

*Your browser is the agent's container.* — [English](README.md)

</div>

---

**AicqWebBot** 是一个跑在浏览器里的智能体运行时。`pip install`，一行代码，打开 localhost，填入模型 key——一个完整的智能体（LLM 循环、50+ 工具、WASM 代码沙箱、记忆）**完全在你的浏览器标签页里运行**。

它启动的本地服务是一个**无状态薄中继**：只代理模型 API 调用（绕过浏览器 CORS）和托管静态文件，**服务端零执行**。你的 API key、对话历史、文件——一切都留在你自己的机器上。

## 🚀 快速开始（三行）

```bash
pip install aicqwebbot
```

```python
import aicqwebbot
aicqwebbot.run(8386)
```

```
打开 http://localhost:8386 → 粘贴你的
OpenAI 兼容 key → 直接聊天。
```

不想装？直接用在线演示空间：

- 🤗 Hugging Face: <https://huggingface.co/spaces/samaiccgroup/AicqWebBot>
- 🧲 ModelScope: <https://www.modelscope.cn/studios/samaiccgroup/AicqWebBot>

## 🧠 为什么不一样

| | 传统智能体方案 | AicqWebBot |
|---|---|---|
| 智能体循环（大脑） | 服务端容器 | **你的浏览器标签页** |
| 代码执行（双手） | 沙箱容器（E2B/Modal/…） | **浏览器内 WASM 沙箱**（Pyodide / QuickJS） |
| 记忆与文件 | 数据库容器 | **你设备上的 IndexedDB** |
| 模型调用 | LLM 网关容器 | 本地中继——你的 key、你的机器 |
| 扩容成本 | 随用户数×执行时长增长 | **零**——算力用户自带 |
| 爆炸半径 | 不可信代码跑在你的服务器上 | 不可信代码跑在用户自己的浏览器里——地球上被测试最充分的沙箱（Chromium） |

一句话：**服务端容器是稀缺资源，而浏览器是每台机器上免费、预装、完美隔离的容器。** AicqWebBot 只是不再为浏览器本来就能替代的服务端容器付租金。

## 🛠 里面有什么

内置的智能体运行时（[aicq.me](https://aicq.me) 本地智能体的同款引擎，零修改）：

- **50+ 内置工具**——联网搜索、网页阅读、HTTP 客户端、虚拟文件系统、doc/xlsx/pdf/ppt 生成、图表、画图、二维码、邮件、剪贴板、翻译、天气、任务规划等
- **代码沙箱**——Python（Pyodide / numpy / pandas）或 JavaScript（QuickJS），以 WebAssembly 形式在标签页内执行
- **上下文压缩**——长对话自动摘要，内存占用有界
- **视觉理解**——发图片，智能体用视觉模型分析
- **流式 UI**——实时 reasoning、工具调用卡片、Markdown 渲染

## 🔧 架构

```
pip install aicqwebbot && aicqwebbot.run(8386)
        │
        ▼
┌─ localhost:8386（薄 Python 中继）─────────────────────┐
│  GET  /                      配置页 / 聊天页          │
│  GET  /static/*              智能体运行时 bundle      │
│  POST /api/v1/agent/llm-proxy     -> 你的模型 API     │
│  POST /api/v1/agent/search-proxy  -> 联网搜索         │
│  POST /api/v1/agent/web-proxy     -> 网页抓取         │
└──────────────────────────────────────────────────────┘
        │
        ▼
  你的浏览器标签页 = 智能体的容器
  ┌───────────────────────────────────────────────┐
  │  agent 循环 · 50 工具 · WASM 沙箱             │
  │  记忆（IndexedDB）· 虚拟文件系统              │
  └───────────────────────────────────────────────┘
```

## 🔐 隐私模型

- API key 存在浏览器里，只作为 `Authorization` 头发给**你选择的模型服务商**，经本地代理原样转发（只在内存过路，不落盘、不记录）。
- 智能体的记忆、对话历史、虚拟文件永不离开你的设备。
- 中继没有会话、没有账号、没有数据库。清掉浏览器数据，一切归零——你的机器，你的数据。

## 📦 部署方式

| 目标 | 命令 | 说明 |
|---|---|---|
| 本机 | `aicqwebbot.run(8386)` | 默认体验 |
| Hugging Face Space | 推送 `deploy/hf/` | 免费，单容器演示 |
| ModelScope 创空间 | 推送 `deploy/modelscope/` | 同上，国内社区 |
| 任意服务器/内网 | `aicqwebbot.run(port)` + nginx | 无状态——水平扩展零成本 |

## 🧩 代码来源

`aicqwebbot/web/static/agent/*` 是驱动 [aicq.me](https://aicq.me) 本地智能体的同一套浏览器运行时（agent-engine、工具注册表、WASM 沙箱、IndexedDB 存储），由私有仓 `samaidev/aicq` 自动同步——上游修复随每次发布自动流向本仓。

## 📄 许可证

Apache-2.0
