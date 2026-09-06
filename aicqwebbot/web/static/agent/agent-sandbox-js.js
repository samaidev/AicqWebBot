/* ═══════════════ agent/agent-sandbox-js.js ═══════════════
   QuickJS 懒加载管理 — 首次 exec-js 时才加载 (~1MB)
   也支持直接 eval (更快但无沙箱隔离)
   ════════════════════════════════════════════════════════ */

const AgentSandboxJS = {
  _quickJS: null,
  _loading: null,

  async getQuickJS() {
    if (this._quickJS) return this._quickJS;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      // 加载 QuickJS WASM
      await this._loadScript('https://cdn.jsdelivr.net/npm/quickjs-emscripten@0.31.0/dist/esmodule-host.js');
      // 由于 esmodule 加载较复杂，fallback 到 eval 模式
      // 实际生产可以用 Web Worker 隔离
      console.log('[QuickJS] Using eval mode (Web Worker isolation TODO)');
      this._quickJS = 'eval-mode';
      return this._quickJS;
    })();

    return this._loading;
  },

  async execute(args, ctx) {
    // 先恢复虚拟文件系统到全局变量
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const fsData = {};
    const files = await AgentStorage.listFiles(ctx.agentId, '/');
    for (const f of files) {
      const file = await AgentStorage.readFile(ctx.agentId, f.path);
      if (file) fsData[f.path] = new TextDecoder().decode(file.content);
    }

    // 构建沙箱环境
    let output = '';
    const sandbox = {
      console: {
        log: (...args) => { output += args.join(' ') + '\n'; },
        error: (...args) => { output += args.join(' ') + '\n'; },
        warn: (...args) => { output += args.join(' ') + '\n'; },
      },
      _fs: fsData,
      _readFile: (path) => fsData[path] || null,
      _writeFile: (path, content) => { fsData[path] = content; },
      _listDir: (dir) => Object.keys(fsData).filter(k => k.startsWith(dir)),
      _deleteFile: (path) => { delete fsData[path]; },
      fetch: async (url, opts) => {
        // 通过 aicq 代理
        const resp = await fetch('/api/v1/agent/web-proxy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, mode: 'raw', method: opts?.method || 'GET',
            headers: opts?.headers || {}, body: opts?.body || '' })
        });
        return { ok: resp.ok, status: resp.status, text: () => resp.text(), json: () => resp.json() };
      },
      JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp,
      parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
      btoa, atob, TextEncoder, TextDecoder, crypto,
      setTimeout, setInterval, clearTimeout, clearInterval,
      URL
    };

    try {
      // 用 Function 构造器创建沙箱（比 eval 稍安全）
      const fn = new Function(...Object.keys(sandbox), args.code || '');
      const result = fn(...Object.values(sandbox));
      if (result !== undefined) output += String(result) + '\n';

      // 持久化文件系统变更
      for (const [path, content] of Object.entries(fsData)) {
        await AgentStorage.saveFile(ctx.agentId, path, content);
      }

      return { success: true, output: output.slice(0, 8000) || 'Code executed (no output).' };
    } catch(e) {
      return { success: false, error: e.message, output };
    }
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

if (typeof window !== 'undefined') window.AgentSandboxJS = AgentSandboxJS;

export { AgentSandboxJS };
export default AgentSandboxJS;
