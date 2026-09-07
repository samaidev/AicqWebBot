/* ═══════════════ agent/agent-sandbox-python.js ═══════════════
   Pyodide 懒加载管理 — 首次 exec-code 时才加载 (~10MB)
   ═══════════════════════════════════════════════════════════ */

const AgentSandboxPython = {
  _pyodide: null,
  _loading: null,

  async getPyodide() {
    if (this._pyodide) return this._pyodide;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      // 加载 Pyodide CDN
      await this._loadScript('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');
      this._pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/'
      });
      // 预加载常用包
      try {
        await this._pyodide.loadPackage(['micropip']);
      } catch(e) { console.warn('[Pyodide] micropip load failed:', e); }
      // [ADD 2026-09-07] 沙箱网络桥：urllib.request.urlopen -> 内置 web 代理
      // （登录代理 / pip 本地 server.py 代理 / 静态形态公共 web-relay 三形态全通）。
      // Pyodide 无 socket，裸 urllib 必炸；pyfetch 只能访问 CORS-open 站点。
      // 补丁后 LLM 在沙箱里用命令行风格代码即可访问任意公开 URL（含 GitHub
      // API / raw.githubusercontent.com 实现 git 类操作），零跨域报错。
      try {
        await this._installNetworkShim();
      } catch(e) { console.warn('[Pyodide] network shim install failed:', e); }
      console.log('[Pyodide] Loaded successfully');
      return this._pyodide;
    })();

    return this._loading;
  },

  // 同步 XHR 桥：沙箱代码是同步风格，fetch 无法直接桥接；同步 XHR 在主线程
  // 仍可用（浏览器有 deprecation 警告但功能正常）。目标端点运行时读取
  // window.__AICQ_PROXY_TARGET__（静态壳会指到 aicq.me 公共 web-relay，
  // 其余形态默认同源 /api/v1/agent/web-proxy）。
  _ensureJSBridge() {
    if (typeof window === 'undefined') return false;
    if (window.__aicqProxySync) return true;
    window.__aicqProxySync = function(url, method, headersJson, body) {
      try {
        const target = window.__AICQ_PROXY_TARGET__ || '/api/v1/agent/web-proxy';
        // [FIX] 跨域目标（静态形态 → aicq.me 中继）必须走 CORS「简单请求」：
        // Content-Type: text/plain 且不加任何自定义头（含 Authorization）→
        // 免预检。实测带 application/json 的跨域同步 XHR 会被浏览器拦死
        // （"Failed to execute 'send' on 'XMLHttpRequest'"）。服务端
        // （gin ShouldBindJSON / FastAPI request.json）都按 JSON 解析 body，
        // 不依赖该头。
        const cross = /^https?:\/\//i.test(target) && target.indexOf(location.origin) !== 0;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', target, false); // sync — sandbox code is synchronous
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        const tk = (window.S && S.accessToken) || localStorage.getItem('aicq_at') || '';
        if (tk && !cross) xhr.setRequestHeader('Authorization', 'Bearer ' + tk);
        xhr.send(JSON.stringify({
          url: String(url || ''), mode: 'raw',
          method: String(method || 'GET').toUpperCase(),
          headers: JSON.parse(headersJson || '{}'),
          body: body ? String(body) : ''
        }));
        let d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) {
          return JSON.stringify({ status: 0, body: 'proxy returned non-JSON (HTTP ' + xhr.status + ')' });
        }
        // [FIX] 代理自身失败（502 {"error":...}）时透传真实原因，便于排查
        if (!d.status && d.error) return JSON.stringify({ status: 0, body: String(d.error) });
        return JSON.stringify({ status: d.status || 0, body: d.body || '' });
      } catch (e) {
        return JSON.stringify({ status: 0, body: 'sandbox network bridge error: ' + (e && e.message || e) });
      }
    };
    return true;
  },

  async _installNetworkShim() {
    if (!this._ensureJSBridge()) return;
    if (this._netShimInstalled) return;
    await this._pyodide.runPythonAsync(`
import json as _pxjson
import urllib.request as _pxur
import urllib.error as _pxue
from js import __aicqProxySync as _pxbridge

class _PxResponse:
    def __init__(self, status, body, url):
        self.status = status
        self._body = body
        self.url = url
    def read(self):
        return self._body.encode('utf-8')
    def getcode(self):
        return self.status
    def geturl(self):
        return self.url
    def close(self):
        pass
    def getheader(self, name, default=None):
        return default
    def info(self):
        import email.message
        m = email.message.Message()
        m['content-type'] = 'text/plain; charset=utf-8'
        return m
    @property
    def headers(self):
        return self.info()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

def _px_urlopen(url, *args, **kwargs):
    # [FIX] urlopen(Request) 时 Request 是第一个参数 url 本身，不在 args[0]
    req = url if isinstance(url, _pxur.Request) else None
    if req is None and args and isinstance(args[0], _pxur.Request):
        req = args[0]
    data = kwargs.pop('data', None)
    if data is None and len(args) >= 2 and args[1] is not None:
        data = args[1]
    method = kwargs.pop('method', None)
    headers = dict(kwargs.pop('headers', None) or {})
    if req is not None:
        url = req.full_url
        if data is None:
            data = req.data
        if not method:
            method = req.get_method()
        for k, v in (req.header_items() or []):
            headers.setdefault(k, v)
    if not method:
        method = 'POST' if data is not None else 'GET'
    if isinstance(data, (bytes, bytearray)):
        data = bytes(data).decode('utf-8', 'replace')
    elif data is not None and not isinstance(data, str):
        data = str(data)
    raw = _pxbridge(str(url), str(method).upper(), _pxjson.dumps(headers), data or '')
    r = _pxjson.loads(str(raw))
    st = int(r.get('status') or 0)
    body = r.get('body') or ''
    if st == 0:
        raise _pxue.URLError(body or 'proxy request failed')
    if st >= 400:
        # 与真 urllib 语义一致：HTTP 错误抛 HTTPError，e.read() 可读错误体
        import io as _pxio
        raise _pxue.HTTPError(str(url), st, 'HTTP Error ' + str(st), None, _pxio.BytesIO(body.encode('utf-8')))
    return _PxResponse(st, body, str(url))

_pxur.urlopen = _px_urlopen
`);
    this._netShimInstalled = true;
    console.log('[Pyodide] network shim installed: urllib.request.urlopen -> built-in web proxy (no CORS)');
  },

  async execute(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    let pyodide;
    try {
      pyodide = await this.getPyodide();
    } catch(e) {
      return { success: false, error: 'Failed to load Pyodide: ' + e.message };
    }

    // 恢复虚拟文件系统
    await this._restoreFS(ctx.agentId);

    // 重定向 stdout/stderr
    let output = '';
    pyodide.setStdout({ batched: (text) => { output += text + '\n'; } });
    pyodide.setStderr({ batched: (text) => { output += text + '\n'; } });

    // [FIX 2026-09-06] 缺包自动安装重试：ModuleNotFoundError: No module named 'X'
    // → micropip/loadPackage 安装后自动重跑一次（每次会话每个包只试一次）。
    // data-analysis / csv-process / install-package 及 LLM 生成的 pandas 代码因此开箱即用。
    this._autoInstalled = this._autoInstalled || new Set();
    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await pyodide.runPythonAsync(args.code || '');
        result = { success: true, output: output.slice(0, 8000) || 'Code executed (no output).' };
        break;
      } catch(e) {
        const m = /ModuleNotFoundError: No module named '([A-Za-z0-9_.-]+)'/.exec(e.message || '');
        if (m && attempt === 0) {
          const pkg = m[1].split('.')[0];
          if (!this._autoInstalled.has(pkg)) {
            this._autoInstalled.add(pkg);
            output += `[auto-install] ${pkg} not found — installing via micropip...\n`;
            try {
              // Pyodide 发行版内置包走 loadPackage（快），纯 Python 包走 micropip
              const known = ['pandas','numpy','matplotlib','scipy','sympy','regex','pillow',
                'beautifulsoup4','lxml','openpyxl','python-pptx','reportlab','fsspec'];
              if (known.includes(pkg)) await pyodide.loadPackage(pkg);
              else await pyodide.runPythonAsync(`import micropip; await micropip.install('${pkg.replace(/'/g, '')}')`);
              output += `[auto-install] ${pkg} installed — retrying code.\n`;
              output = '';
              pyodide.setStdout({ batched: (text) => { output += text + '\n'; } });
              pyodide.setStderr({ batched: (text) => { output += text + '\n'; } });
              continue;
            } catch (ie) {
              return { success: false, error: `${e.message}\n[auto-install] failed for '${pkg}': ${ie.message}`, output };
            }
          }
        }
        return { success: false, error: e.message, output: output };
      }
    }
    // 持久化文件系统
    if (result) {
      // [ADD 2026-09-07 v0.4.8] 快照差分投递：执行前记录 .html 基线（path→size），
      // 执行后把「新增或变化」的 HTML 投递到聊天（限独立壳，见 _emitFileChunk）。
      // 不能无差别全发 —— _saveFS 每次执行都重存 /home 全部文件，会刷屏；且
      // exec-code 是默认沙箱，模型"做个网页"最常走的就是这条路。
      const before = new Map();
      try {
        for (const f of await AgentStorage.listFiles(ctx.agentId, '/')) {
          if (/\.html?$/i.test(f.path || '')) before.set(f.path, f.size || 0);
        }
      } catch (e) { /* 基线拿不到就当空 —— 最多多发一次旧文件，可接受 */ }
      await this._saveFS(ctx.agentId);
      try {
        let emitted = 0;
        for (const f of await AgentStorage.listFiles(ctx.agentId, '/')) {
          if (emitted >= 3) break;
          const p = f.path || '';
          if (!/\.html?$/i.test(p)) continue;
          if (before.has(p) && before.get(p) === (f.size || 0)) continue;
          const rec = await AgentStorage.readFile(ctx.agentId, p);
          if (!rec || !rec.content) continue;
          const bytes = new Uint8Array(rec.content);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js');
          AgentToolsNative._emitFileChunk(ctx, p.split('/').pop(), 'text/html', `data:text/html;base64,${btoa(bin)}`, bytes.length);
          emitted++;
        }
      } catch (e) { console.warn('[exec-code] html preview emit failed:', e); }
      return result;
    }
    return { success: false, error: 'execution did not produce a result', output };
  },

  async installPackage(packageName, ctx) {
    let pyodide;
    try { pyodide = await this.getPyodide(); } catch(e) { return { success: false, error: 'Pyodide not loaded' }; }
    try {
      await pyodide.runPythonAsync(`
        import micropip
        await micropip.install('${packageName}')
      `);
      return { success: true, output: `Package ${packageName} installed.` };
    } catch(e) {
      return { success: false, error: 'Install failed: ' + e.message };
    }
  },

  // 虚拟文件系统持久化
  async _saveFS(agentId) {
    if (!this._pyodide) return;
    try {
      const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
      // 列出 /home 目录下所有文件
      const files = this._pyodide.runPython(`
        import os
        result = []
        for root, dirs, filenames in os.walk('/home'):
          for f in filenames:
            path = os.path.join(root, f)
            result.append(path)
        result
      `);
      for (const path of files.toJs()) {
        // [FIX 2026-09-07 v0.4.8] 原 `with open(...): f.read()` 是语句不是表达式，
        // runPython 对纯语句返回 undefined → content.toJs() 抛
        // "Cannot read properties of undefined (reading 'toJs')" 且被 try/catch 吞掉 ——
        // Python 沙箱写的文件其实从来没持久化成功过（VS 始终为空，刷新即丢）。
        // 改为表达式形式 open(...).read()，runPython 正常返回 bytes。
        const content = this._pyodide.runPython(`open(${JSON.stringify(path)}, 'rb').read()`);
        const bytes = new Uint8Array(content.toJs());
        await AgentStorage.saveFile(agentId, path, bytes.buffer, path.startsWith('/home/persistent'));
      }
    } catch(e) { console.warn('[Pyodide] FS save failed:', e); }
  },

  async _restoreFS(agentId) {
    if (!this._pyodide) return;
    try {
      const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
      const files = await AgentStorage.listFiles(agentId, '/');
      for (const f of files) {
        const file = await AgentStorage.readFile(agentId, f.path);
        if (file) {
          const path = f.path;
          this._pyodide.runPython(`
            import os
            os.makedirs(os.path.dirname('${path}'), exist_ok=True)
          `);
          // 写入文件内容
          const bytes = new Uint8Array(file.content);
          this._pyodide.FS.writeFile(path, bytes);
        }
      }
    } catch(e) { console.warn('[Pyodide] FS restore failed:', e); }
  },

  async _loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
};

if (typeof window !== 'undefined') window.AgentSandboxPython = AgentSandboxPython;

export { AgentSandboxPython };
export default AgentSandboxPython;
