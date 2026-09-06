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
      console.log('[Pyodide] Loaded successfully');
      return this._pyodide;
    })();

    return this._loading;
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

    try {
      await pyodide.runPythonAsync(args.code || '');
      // 持久化文件系统
      await this._saveFS(ctx.agentId);
      return { success: true, output: output.slice(0, 8000) || 'Code executed (no output).' };
    } catch(e) {
      return { success: false, error: e.message, output: output };
    }
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
        const content = this._pyodide.runPython(`
          with open('${path}', 'rb') as f:
            f.read()
        `);
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
