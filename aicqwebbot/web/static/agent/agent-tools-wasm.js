/* ═══════════════ agent/agent-tools-wasm.js ═══════════════
   WASM 虚拟文件系统工具 — edit-file, read-file, write-file 等
   ═══════════════════════════════════════════════════════ */

// [ADD 2026-10-07 r19] cache-buster for ALL dynamic agent-module imports
// (synced from apishare b4caac0) — bare URLs hit the browser's long static
// cache and can run a stale pre-saveFiles agent-storage.js. Keep in sync
// with agent-engine.js._AGENT_VER.
const _AGENT_VER = '20261007h';

const AgentToolsWasm = {
  async execute(toolName, args, ctx) {
    const handler = this[toolName.replace(/-/g, '_')];
    if (!handler) return { success: false, error: `Unknown WASM tool: ${toolName}` };
    try { return await handler.call(this, args, ctx); }
    catch(e) { return { success: false, error: e.message }; }
  },

  async edit_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    if (args.action === 'read') return this.read_file(args, ctx);
    if (args.action === 'write') return this.write_file({ path: args.path, content: args.content }, ctx);
    if (args.action === 'append') {
      const existing = await AgentStorage.readFile(ctx.agentId, args.path);
      const oldContent = existing ? new TextDecoder().decode(existing.content) : '';
      return this.write_file({ path: args.path, content: oldContent + args.content }, ctx);
    }
    if (args.action === 'delete') return this.delete_file(args, ctx);
    return { success: false, error: 'Unknown action: ' + args.action };
  },

  async read_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.path);
    if (!file) return { success: false, error: `File not found: ${args.path}` };
    const text = new TextDecoder().decode(file.content);
    return { success: true, output: text.slice(0, 8000), path: args.path, size: file.size };
  },

  async write_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    await AgentStorage.saveFile(ctx.agentId, args.path, args.content);
    // [ADD 2026-09-07 v0.4.8] HTML 产物自动投递到聊天（独立壳）：用户让智能体"做个网页/
    // 可视化页面"时，写完 .html 聊天里应立刻出现渲染预览卡 —— aicq.me 全量前端本就有
    // 此效果（file-card + 预览按钮），独立壳此前什么都不显示，用户必须自己去文件管理器翻。
    // 仅投递 .html/.htm 交付物；.py/.csv/.json 等中间产物留在文件管理器，避免刷屏。
    if (/\.html?$/i.test(String(args.path || ''))) {
      try {
        const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js?v=' + _AGENT_VER);
        const text = String(args.content ?? '');
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const fname = String(args.path).split('/').pop();
        AgentToolsNative._emitFileChunk(ctx, fname, 'text/html', `data:text/html;base64,${btoa(bin)}`, bytes.length);
      } catch (e) { console.warn('[write-file] html preview emit failed:', e); }
    }
    return { success: true, output: `File written: ${args.path} (${args.content.length} bytes)` };
  },

  async list_dir(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const files = await AgentStorage.listFiles(ctx.agentId, args.path || '/');
    if (!files.length) return { success: true, output: 'Empty directory.' };
    const text = files.map(f => `${f.path} (${f.size} bytes)`).join('\n');
    return { success: true, output: text, files };
  },

  async delete_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    await AgentStorage.deleteFile(ctx.agentId, args.path);
    return { success: true, output: `File deleted: ${args.path}` };
  },

  async search_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const files = await AgentStorage.listFiles(ctx.agentId, args.dir || '/');
    const pattern = args.pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(pattern);
    const matched = files.filter(f => regex.test(f.path));
    return { success: true, output: matched.length ? matched.map(f => f.path).join('\n') : 'No files matched.' };
  },

  async file_diff(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const f1 = await AgentStorage.readFile(ctx.agentId, args.file1);
    const f2 = await AgentStorage.readFile(ctx.agentId, args.file2);
    if (!f1) return { success: false, error: `File not found: ${args.file1}` };
    if (!f2) return { success: false, error: `File not found: ${args.file2}` };
    const lines1 = new TextDecoder().decode(f1.content).split('\n');
    const lines2 = new TextDecoder().decode(f2.content).split('\n');
    const maxLen = Math.max(lines1.length, lines2.length);
    let diff = [];
    for (let i = 0; i < maxLen; i++) {
      if (lines1[i] !== lines2[i]) {
        if (lines1[i] !== undefined) diff.push(`- ${lines1[i]}`);
        if (lines2[i] !== undefined) diff.push(`+ ${lines2[i]}`);
      }
    }
    return { success: true, output: diff.length ? diff.join('\n') : 'Files are identical.' };
  },

  async install_package(args, ctx) {
    // 通过 Pyodide micropip 安装
    const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js?v=' + _AGENT_VER);
    return AgentSandboxPython.installPackage(args.package, ctx);
  },

};

if (typeof module !== 'undefined' && module.exports) module.exports = AgentToolsWasm;

export { AgentToolsWasm };
export default AgentToolsWasm;
