/* ═══════════════ agent/agent-tools-wasm.js ═══════════════
   WASM 虚拟文件系统工具 — edit-file, read-file, write-file 等
   ═══════════════════════════════════════════════════════ */

const AgentToolsWasm = {
  async execute(toolName, args, ctx) {
    const handler = this[toolName.replace(/-/g, '_')];
    if (!handler) return { success: false, error: `Unknown WASM tool: ${toolName}` };
    try { return await handler.call(this, args, ctx); }
    catch(e) { return { success: false, error: e.message }; }
  },

  async edit_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
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
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.path);
    if (!file) return { success: false, error: `File not found: ${args.path}` };
    const text = new TextDecoder().decode(file.content);
    return { success: true, output: text.slice(0, 8000), path: args.path, size: file.size };
  },

  async write_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    await AgentStorage.saveFile(ctx.agentId, args.path, args.content);
    return { success: true, output: `File written: ${args.path} (${args.content.length} bytes)` };
  },

  async list_dir(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const files = await AgentStorage.listFiles(ctx.agentId, args.path || '/');
    if (!files.length) return { success: true, output: 'Empty directory.' };
    const text = files.map(f => `${f.path} (${f.size} bytes)`).join('\n');
    return { success: true, output: text, files };
  },

  async delete_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    await AgentStorage.deleteFile(ctx.agentId, args.path);
    return { success: true, output: `File deleted: ${args.path}` };
  },

  async search_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const files = await AgentStorage.listFiles(ctx.agentId, args.dir || '/');
    const pattern = args.pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(pattern);
    const matched = files.filter(f => regex.test(f.path));
    return { success: true, output: matched.length ? matched.map(f => f.path).join('\n') : 'No files matched.' };
  },

  async file_diff(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
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

  async file_search(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const files = await AgentStorage.listFiles(ctx.agentId, args.dir || '/');
    const regex = new RegExp(args.pattern);
    const results = [];
    for (const f of files) {
      const file = await AgentStorage.readFile(ctx.agentId, f.path);
      if (!file) continue;
      const text = new TextDecoder().decode(file.content);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) results.push(`${f.path}:${i+1}: ${lines[i].trim()}`);
      }
    }
    return { success: true, output: results.length ? results.slice(0, 50).join('\n') : 'No matches.' };
  },

  async install_package(args, ctx) {
    // 通过 Pyodide micropip 安装
    const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js');
    return AgentSandboxPython.installPackage(args.package, ctx);
  },

  async data_analysis(args, ctx) {
    const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js');
    return AgentSandboxPython.execute({
      language: 'python',
      code: `import json, pandas as pd, numpy as np\n_data = json.loads('''${args.data}''')\n${args.operation}`
    }, ctx);
  },

  async run_pipeline(args, ctx) {
    const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js');
    let steps; try { steps = JSON.parse(args.steps); } catch { return { success: false, error: 'Invalid steps JSON' }; }
    let output = '';
    for (const step of steps) {
      output += `=== ${step.name} ===\n`;
      const result = await AgentSandboxPython.execute({ language: 'python', code: step.code }, ctx);
      output += (result.output || result.error || '') + '\n\n';
    }
    return { success: true, output };
  },

  async csv_process(args, ctx) {
    return this.data_analysis({ data: args.data, operation: `df = pd.read_csv(io.StringIO('''${args.data}'''))\n${args.operation}` }, ctx);
  },

  async json_process(args, ctx) {
    // JS 原生处理 JSON
    try {
      let data = JSON.parse(args.data);
      const op = args.operation;
      if (op.startsWith('.')) {
        const parts = op.slice(1).split('.');
        for (const p of parts) data = data[p];
      } else if (op.startsWith('filter:')) {
        const expr = op.slice(7);
        data = Array.isArray(data) ? data.filter(item => eval(expr)) : data;
      } else if (op.startsWith('map:')) {
        const expr = op.slice(4);
        data = Array.isArray(data) ? data.map(item => eval(expr)) : data;
      }
      return { success: true, output: JSON.stringify(data, null, 2) };
    } catch(e) { return { success: false, error: e.message }; }
  },

  async regex_match(args, ctx) {
    const regex = new RegExp(args.pattern, 'g');
    const matches = [...args.text.matchAll(regex)];
    if (!matches.length) return { success: true, output: 'No matches.' };
    const text = matches.map((m, i) => `${i+1}. ${m[0]}`).join('\n');
    return { success: true, output: text, matches: matches.map(m => m[0]) };
  },

  async text_process(args, ctx) {
    let text = args.text;
    const op = args.operation.toLowerCase();
    if (op.includes('upper')) text = text.toUpperCase();
    else if (op.includes('lower')) text = text.toLowerCase();
    else if (op.includes('trim')) text = text.trim();
    else if (op.includes('split')) text = text.split(/\s+/).join('\n');
    else if (op.includes('reverse')) text = text.split('').reverse().join('');
    else if (op.includes('replace')) {
      const parts = args.operation.match(/replace\s+(\S+)\s+with\s+(\S+)/i);
      if (parts) text = text.split(parts[1]).join(parts[2]);
    }
    return { success: true, output: text };
  },

  async base64_codec(args, ctx) {
    if (args.action === 'encode') return { success: true, output: btoa(args.data) };
    if (args.action === 'decode') return { success: true, output: atob(args.data) };
    return { success: false, error: 'Unknown action' };
  },

  async hash_compute(args, ctx) {
    const algo = args.algorithm || 'SHA-256';
    const data = new TextEncoder().encode(args.data);
    const hash = await crypto.subtle.digest(algo, data);
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    return { success: true, output: hex };
  },

  async export_data(args, ctx) {
    // 这个工具实际在 native tools 里实现，这里转发
    const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js');
    return AgentToolsNative.export_data(args, ctx);
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = AgentToolsWasm;

export { AgentToolsWasm };
export default AgentToolsWasm;
