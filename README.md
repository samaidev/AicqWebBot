<div align="center">

# 🤖 AicqWebBot

**Your browser is the agent's container.**

*Your browser is the agent's container.* — [中文说明](README.zh-CN.md)

</div>

---

**AicqWebBot** is a browser-native AI agent runtime. `pip install` it, run one line, open localhost, paste your model key — and a full agent (LLM loop, 50+ tools, WASM code sandbox, memory) starts running **entirely inside your browser tab**.

The local server it starts is a *thin, stateless relay*: it only proxies your model API calls (to bypass browser CORS) and serves static files. **Zero execution happens on the server.** Your API key, your conversation history, your files — everything stays on your machine.

## 🚀 Quick start (3 lines)

```bash
pip install aicqwebbot
```

```python
import aicqwebbot
aicqwebbot.run(8386)
```

```
Open http://localhost:8386 → pick a free model (no key needed) or paste
your OpenAI-compatible key → chat.
```

Want it even simpler? Try the live demo spaces — no install at all:

- 🤗 Hugging Face: <https://huggingface.co/spaces/samaiccgroup/AicqWebBot>
- 🧲 ModelScope: <https://www.modelscope.cn/studios/samaiccgroup/AicqWebBot>

## 🧠 Why this is different

| | Traditional agent stacks | AicqWebBot |
|---|---|---|
| Agent loop (brain) | Server container | **Your browser tab** |
| Code execution (hands) | Sandbox containers (E2B/Modal/...) | **WASM sandbox in your browser** (Pyodide / QuickJS) |
| Memory & files | Database container | **IndexedDB on your device** |
| Model calls | LLM gateway container | Local relay or direct — your key, your machine |
| Scaling cost | Grows with users × execution time | **Zero** — every user brings their own compute |
| Blast radius | Untrusted code runs on YOUR server | Untrusted code runs on the USER's own browser — the best-tested sandbox on Earth (Chromium) |

The insight: **containers are scarce on servers, but the browser is a free, pre-installed, perfectly isolated container on every machine on the planet.** AicqWebBot simply stops paying rent on server containers that the browser already replaces.

## 🛠 What's in the box

The bundled agent runtime (a zero-modification build of the [aicq.me](https://aicq.me) web agent) ships with:

- **50+ built-in tools** — web search, web read, HTTP client, file system (virtual FS), doc/xlsx/pdf/ppt creation, charts, image drawing, QR codes, email, clipboard, translate, weather, task planning, and more
- **Code sandbox** — Python (Pyodide / numpy / pandas) or JavaScript (QuickJS), executing as WebAssembly inside your tab
- **Context compression** — long conversations are automatically summarized so memory usage stays bounded
- **Vision** — send images, the agent analyzes them with a vision model
- **Streaming UI** — live reasoning, tool-call cards, markdown rendering

## 🔧 Architecture

```
pip install aicqwebbot && aicqwebbot.run(8386)
        │
        ▼
┌─ localhost:8386 (thin Python relay) ─────────────────┐
│  GET  /                      config page / chat UI   │
│  GET  /static/*              agent runtime bundle    │
│  POST /api/v1/agent/llm-proxy     -> your LLM API    │
│  POST /api/v1/agent/search-proxy  -> web search      │
│  POST /api/v1/agent/web-proxy     -> page fetcher    │
└──────────────────────────────────────────────────────┘
        │
        ▼
  Your browser tab = the agent's container
  ┌───────────────────────────────────────────────┐
  │  agent loop · 50 tools · WASM sandbox         │
  │  memory (IndexedDB) · virtual file system     │
  └───────────────────────────────────────────────┘
```

## 🔐 Privacy model

- Your API key lives in your browser's storage and is only sent as an `Authorization` header to **your chosen model provider**, relayed verbatim through the local proxy (in-memory only, never persisted or logged).
- Agent memory, conversation history, and virtual files never leave your device.
- The relay keeps no sessions, no accounts, no database. Delete the browser data and everything is gone — your machine, your data.

## 📦 Deployment options

| Target | Command | Notes |
|---|---|---|
| Local machine | `aicqwebbot.run(8386)` | The default experience |
| Hugging Face Space | push `deploy/hf/` | Free, one-container demo |
| ModelScope Studio | push `deploy/modelscope/` | Same, for the CN community |
| Any server / intranet | `aicqwebbot.run(port)` behind nginx | Stateless — scale horizontally for free |

## 🧩 Where the code comes from

`aicqwebbot/web/static/agent/*` is the exact browser agent runtime that powers [aicq.me](https://aicq.me)'s local agents (agent-engine, tool registry, WASM sandboxes, IndexedDB storage). It is synchronized automatically from the private `samaidev/aicq` monorepo — fixes upstream flow downstream with every release.

## 📄 License

Apache-2.0
