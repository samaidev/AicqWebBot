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
    // [ADD 2026-09-07 v0.4.8] HTML 产物自动投递到聊天（独立壳）：用户让智能体"做个网页/
    // 可视化页面"时，写完 .html 聊天里应立刻出现渲染预览卡 —— aicq.me 全量前端本就有
    // 此效果（file-card + 预览按钮），独立壳此前什么都不显示，用户必须自己去文件管理器翻。
    // 仅投递 .html/.htm 交付物；.py/.csv/.json 等中间产物留在文件管理器，避免刷屏。
    if (/\.html?$/i.test(String(args.path || ''))) {
      try {
        const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js');
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
    // [FIX 2026-09-06] ①数据用 JSON.stringify 生成安全的 Python 字符串字面量
    //   （原 '''...''' 模板遇引号/反斜杠/换行直接语法错误）；
    // ② pandas/numpy 预导入探针 —— 未装时沙箱会自动 micropip 安装（见 sandbox）
    const raw = JSON.stringify(String(args.data ?? ''));
    const op = String(args.operation || '');
    // operation 预设速捷：纯聚合词（mean/max/min/sum/count/describe/head/tail）自动展开成 Python 代码
    const presets = {
      mean: 'print(float(pd.Series(_data).mean()) if not isinstance(_data, dict) else pd.DataFrame(_data).mean())',
      max: 'print(pd.Series(_data).max())', min: 'print(pd.Series(_data).min())',
      sum: 'print(pd.Series(_data).sum())', count: 'print(len(_data))',
      describe: 'print(pd.Series(_data).describe())', head: 'print(pd.Series(_data).head())',
      info: 'print(pd.Series(_data).info())',
    };
    const code = (presets[op.trim().toLowerCase()] || op);
    return AgentSandboxPython.execute({
      language: 'python',
      code: `import json, io
import pandas as pd  # optional
import numpy as np  # optional\n_data = json.loads(${raw})\n${code}`
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
    // [FIX 2026-09-06] 原 io.StringIO 未 import io（NameError）+ ''' 模板注入。
    const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js');
    const raw = JSON.stringify(String(args.data ?? ''));
    const op = String(args.operation || 'print(df.head())');
    const presets = {
      parse: 'print(df.to_string())', head: 'print(df.head())',
      describe: 'print(df.describe())', info: 'print(df.info())',
      summary: 'print(df.describe())', rows: 'print(len(df))',
    };
    const code = presets[op.trim().toLowerCase()] || op;
    return AgentSandboxPython.execute({
      language: 'python',
      code: `import json, io\nimport pandas as pd  # optional\n_df_raw = ${raw}\ndf = pd.read_csv(io.StringIO(_df_raw))\n${code}`
    }, ctx);
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
    // [FIX 2026-09-06] SubtleCrypto 只认 'SHA-256' 这类大写带连字符的名字，
    // LLM 常写 sha256/sha-384 等会被拒（"Algorithm: Unrecognized name"）。
    // 归一化 + 补充 MD5（SubtleCrypto 不提供，用内置实现）。
    const RAW = String(args.algorithm || 'sha-256').trim().toLowerCase().replace(/\s|-|\/|_/g, '');
    const MAP = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
    const data = new TextEncoder().encode(String(args.data ?? ''));
    if (RAW === 'md5' || RAW === 'md') {
      const hex = this._md5Hex(String(args.data ?? ''));
      return { success: true, output: hex };
    }
    const algo = MAP[RAW];
    if (!algo) return { success: false, error: `Unsupported algorithm: ${args.algorithm}. Supported: md5, sha1, sha256, sha384, sha512` };
    const hash = await crypto.subtle.digest(algo, data);
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    return { success: true, output: hex };
  },

  // 紧凑 MD5（RFC 1321，仅用于 hash-compute 工具）
  _md5Hex(str) {
    const rl = (n, c) => (n << c) | (n >>> (32 - c));
    const au = (x, y) => { const l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); };
    const cm = (q, a, b, x, s, t) => au(rl(au(au(a, q), au(x, t)), s), b);
    const ff = (a, b, c, d, x, s, t) => cm((b & c) | (~b & d), a, b, x, s, t);
    const gg = (a, b, c, d, x, s, t) => cm((b & d) | (c & ~d), a, b, x, s, t);
    const hh = (a, b, c, d, x, s, t) => cm(b ^ c ^ d, a, b, x, s, t);
    const ii = (a, b, c, d, x, s, t) => cm(c ^ (b | ~d), a, b, x, s, t);
    const utf8 = new TextEncoder().encode(str);
    const bl = utf8.length;
    const words = [];
    for (let i = 0; i < bl; i++) words[i >> 2] = (words[i >> 2] || 0) | (utf8[i] << ((i % 4) * 8));
    words[bl >> 2] = (words[bl >> 2] || 0) | (0x80 << ((bl % 4) * 8));
    const n = (((bl + 8) >> 6) + 1) * 16;
    for (let i = 0; i < n; i++) words[i] = words[i] || 0;
    words[n - 2] = bl * 8;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < n; i += 16) {
      const [oa, ob, oc, od] = [a, b, c, d];
      const x = (k) => words[i + k] || 0;
      a=ff(a,b,c,d,x(0),7,-680876936); d=ff(d,a,b,c,x(1),12,-389564586); c=ff(c,d,a,b,x(2),17,606105819); b=ff(b,c,d,a,x(3),22,-1044525330);
      a=ff(a,b,c,d,x(4),7,-176418897); d=ff(d,a,b,c,x(5),12,1200080426); c=ff(c,d,a,b,x(6),17,-1473231341); b=ff(b,c,d,a,x(7),22,-45705983);
      a=ff(a,b,c,d,x(8),7,1770035416); d=ff(d,a,b,c,x(9),12,-1958414417); c=ff(c,d,a,b,x(10),17,-42063); b=ff(b,c,d,a,x(11),22,-1990404162);
      a=ff(a,b,c,d,x(12),7,1804603682); d=ff(d,a,b,c,x(13),12,-40341101); c=ff(c,d,a,b,x(14),17,-1502002290); b=ff(b,c,d,a,x(15),22,1236535329);
      a=gg(a,b,c,d,x(1),5,-165796510); d=gg(d,a,b,c,x(6),9,-1069501632); c=gg(c,d,a,b,x(11),14,643717713); b=gg(b,c,d,a,x(0),20,-373897302);
      a=gg(a,b,c,d,x(5),5,-701558691); d=gg(d,a,b,c,x(10),9,38016083); c=gg(c,d,a,b,x(15),14,-660478335); b=gg(b,c,d,a,x(4),20,-405537848);
      a=gg(a,b,c,d,x(9),5,568446438); d=gg(d,a,b,c,x(14),9,-1019803690); c=gg(c,d,a,b,x(3),14,-187363961); b=gg(b,c,d,a,x(8),20,1163531501);
      a=gg(a,b,c,d,x(13),5,-1444681467); d=gg(d,a,b,c,x(2),9,-51403784); c=gg(c,d,a,b,x(7),14,1735328473); b=gg(b,c,d,a,x(12),20,-1926607734);
      a=hh(a,b,c,d,x(5),4,-378558); d=hh(d,a,b,c,x(8),11,-2022574463); c=hh(c,d,a,b,x(11),16,1839030562); b=hh(b,c,d,a,x(14),23,-35309556);
      a=hh(a,b,c,d,x(1),4,-1530992060); d=hh(d,a,b,c,x(4),11,1272893353); c=hh(c,d,a,b,x(7),16,-155497632); b=hh(b,c,d,a,x(10),23,-1094730640);
      a=hh(a,b,c,d,x(13),4,681279174); d=hh(d,a,b,c,x(0),11,-358537222); c=hh(c,d,a,b,x(3),16,-722521979); b=hh(b,c,d,a,x(6),23,76029189);
      a=hh(a,b,c,d,x(9),4,-640364487); d=hh(d,a,b,c,x(12),11,-421815835); c=hh(c,d,a,b,x(15),16,530742520); b=hh(b,c,d,a,x(2),23,-995338651);
      a=ii(a,b,c,d,x(0),6,-198630844); d=ii(d,a,b,c,x(7),10,1126891415); c=ii(c,d,a,b,x(14),15,-1416354905); b=ii(b,c,d,a,x(5),21,-57434055);
      a=ii(a,b,c,d,x(12),6,1700485571); d=ii(d,a,b,c,x(3),10,-1894986606); c=ii(c,d,a,b,x(10),15,-1051523); b=ii(b,c,d,a,x(1),21,-2054922799);
      a=ii(a,b,c,d,x(8),6,1873313359); d=ii(d,a,b,c,x(15),10,-30611744); c=ii(c,d,a,b,x(6),15,-1560198380); b=ii(b,c,d,a,x(13),21,1309151649);
      a=ii(a,b,c,d,x(4),6,-145523070); d=ii(d,a,b,c,x(11),10,-1120210379); c=ii(c,d,a,b,x(2),15,718787259); b=ii(b,c,d,a,x(9),21,-343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    const hex = (num) => { let s = ''; for (let j = 0; j < 4; j++) s += ((num >> (j * 8 + 4)) & 0xF).toString(16) + ((num >> (j * 8)) & 0xF).toString(16); return s; };
    return hex(a) + hex(b) + hex(c) + hex(d);
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
