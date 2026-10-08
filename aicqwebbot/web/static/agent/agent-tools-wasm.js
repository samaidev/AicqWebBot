/* ═══════════════ agent/agent-tools-wasm.js ═══════════════
   WASM 虚拟文件系统工具 — edit-file, read-file, write-file 等
   ═══════════════════════════════════════════════════════ */

// [ADD 2026-10-07 r19] cache-buster for ALL dynamic agent-module imports
// (synced from apishare b4caac0) — bare URLs hit the browser's long static
// cache and can run a stale pre-saveFiles agent-storage.js. Keep in sync
// with agent-engine.js._AGENT_VER.
const _AGENT_VER = '20261008e';

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

  // [ADD 2026-10-08 r22] 单次读取字符预算 —— read-file/edit-file(read)/read-line/grep
  // 共用。旧 read_file 静默截 8000（模型根本不知道被截断），更大的文件直接把
  // LLM 上下文打爆。20000 与 url-read 的 max_length 上限对齐；截断时结果里
  // 必须带明确标记 + 继续读取的路径（grep 定位 → read-line 翻页）。
  _READ_CAP: 20000,

  async read_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.path);
    if (!file) return { success: false, error: `File not found: ${args.path}` };
    const text = new TextDecoder().decode(file.content);
    const totalLines = text.length ? text.split('\n').length : 0;
    let output = text, truncated = false;
    if (text.length > this._READ_CAP) {
      output = text.slice(0, this._READ_CAP);
      const cut = output.lastIndexOf('\n');
      if (cut > 0) output = output.slice(0, cut); // 只保留完整行，避免半行干扰
      truncated = true;
    }
    const linesShown = truncated ? output.split('\n').length : totalLines;
    const result = { success: true, path: args.path, size: file.size,
                     total_chars: text.length, total_lines: totalLines,
                     lines_shown: linesShown, truncated, output };
    if (truncated) {
      result.note = `TRUNCATED at ${this._READ_CAP} chars (${linesShown}/${totalLines} lines shown). ` +
        `Do NOT re-read the whole file: locate with grep first, then ` +
        (totalLines > linesShown
          ? `read-line(path, offset=${linesShown + 1}) for later sections.`
          : `use exec-js _readFile(path) with .slice(a,b) for char windows (single huge line).`);
    }
    return result;
  },

  // [ADD 2026-10-08 r22] 按行号翻页读大文件 —— read-file 20000 字硬截的配套。
  // offset 与本工具打印的行号一致（1-based），模型可以机械地接续 offset=last+1。
  // 单行超预算（压缩 JS/JSON）时截断该行并给出 exec-js 字符窗口的替代路径。
  async read_line(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.path);
    if (!file) return { success: false, error: `File not found: ${args.path}` };
    const lines = new TextDecoder().decode(file.content).split('\n');
    const total = lines.length;
    let start = parseInt(args.offset, 10); if (!Number.isFinite(start) || start < 1) start = 1;
    let limit = parseInt(args.limit, 10); if (!Number.isFinite(limit) || limit < 1) limit = 400;
    if (start > total) return { success: false, error: `offset ${start} is beyond EOF (file has ${total} lines)` };
    const out = []; let chars = 0, end = start - 1, truncatedLine = false;
    for (let i = start - 1; i < total && end - start + 1 < limit; i++) {
      const prefix = String(i + 1).padStart(6) + '→';
      const need = prefix.length + lines[i].length + 1;
      if (out.length && chars + need > this._READ_CAP) break;
      if (need > this._READ_CAP) { // 单行超整个预算：展示行头后停止
        out.push(prefix + lines[i].slice(0, this._READ_CAP - prefix.length));
        end = i + 1; truncatedLine = true; break;
      }
      out.push(prefix + lines[i]);
      chars += need; end = i + 1;
    }
    const remaining = total - end;
    let output = out.join('\n');
    if (truncatedLine) output += `\n... [line ${end} exceeds the ${this._READ_CAP}-char budget — cut mid-line; for char windows use exec-js _readFile(path).then(t => t.slice(a, b))]`;
    else if (remaining > 0) output += `\n... [${remaining} more lines — continue: read-line(path, offset=${end + 1})]`;
    return { success: true, path: args.path, lines_read: [start, end],
             total_lines: total, remaining, output };
  },

  // [ADD 2026-10-08 r22] 全虚拟 FS 内容检索（ripgrep 风格）—— 在克隆的仓库里
  // 定位代码的标准手段：grep 拿到 path:line 后用 read-line 拉精确区间，
  // 替代"整文件读进上下文"的旧习惯。结果数与字符双上限。
  async grep(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js?v=' + _AGENT_VER)).default;
    if (!args.pattern) return { success: false, error: 'pattern is required' };
    let regex;
    try { regex = new RegExp(args.pattern, args.ignore_case ? 'i' : ''); }
    catch (e) { return { success: false, error: `Invalid regex: ${e.message}. Escape special chars for a literal search.` }; }
    let globRe = null;
    if (args.glob) {
      const g = String(args.glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
      globRe = new RegExp('(^|/)' + g + '$');
    }
    let maxResults = parseInt(args.max_results, 10);
    if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 50;
    if (maxResults > 200) maxResults = 200;
    const files = await AgentStorage.listFiles(ctx.agentId, args.dir || '/');
    const matches = []; let filesSearched = 0, chars = 0, capHit = false;
    for (const f of files) {
      if (matches.length >= maxResults) { capHit = true; break; }
      if (globRe && !globRe.test(f.path)) continue;
      if (f.size > 2 * 1024 * 1024) continue; // 跳过 >2MB（二进制/构建产物）
      const file = await AgentStorage.readFile(ctx.agentId, f.path);
      if (!file) continue;
      filesSearched++;
      const lines = new TextDecoder().decode(file.content).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) { capHit = true; break; }
        if (!regex.test(lines[i])) continue;
        const m = `${f.path}:${i + 1}: ${lines[i].slice(0, 200)}`;
        if (chars + m.length > this._READ_CAP) { capHit = true; break; }
        matches.push(m); chars += m.length + 1;
      }
      if (capHit) break;
    }
    if (!matches.length) return { success: true, output: `No matches for /${args.pattern}/${args.ignore_case ? 'i' : ''} (searched ${filesSearched} files).` };
    let output = matches.join('\n');
    if (capHit) output += `\n... [result cap reached (${matches.length} shown, max_results=${maxResults}) — narrow with dir / glob / a stricter pattern, or continue with more specific searches]`;
    return { success: true, output, match_count: matches.length, files_searched: filesSearched };
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
    // [FIX 2026-10-08 r22] 锚定 glob（旧实现非锚定：pattern "go" 会命中一切含
    // "go" 的路径）+ ** 跨段支持 + 500 条上限。规则：模式在任意深度匹配 ——
    // "*.go" 等价 basename 匹配，"src/*.js" 等价任意层级 src/ 目录下匹配。
    let body = String(args.pattern || '').trim()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    let regex;
    try { regex = new RegExp('^(.*/)?' + body + '$'); }
    catch (e) { return { success: false, error: 'Invalid pattern: ' + e.message }; }
    const matched = files.filter(f => regex.test(f.path));
    const CAP = 500;
    const shown = matched.slice(0, CAP);
    return { success: true, match_count: matched.length, output: shown.length
      ? shown.map(f => f.path).join('\n') + (matched.length > CAP ? `\n... [+${matched.length - CAP} more — narrow with dir or a stricter pattern]` : '')
      : 'No files matched.' };
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
