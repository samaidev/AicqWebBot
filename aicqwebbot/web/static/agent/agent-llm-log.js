/* ═══════════════ agent/agent-llm-log.js ═══════════════
   LLM 调用日志 — 环形缓冲最近 100 条 + localStorage 持久化
   [2026-09-04] 应用户需求：设置页可查看每次 LLM 调用的
   时间 / 模型 / Status / Latency / Tokens(in/out) / Content，
   Content 点击可见完整输入输出。滚动更新，超出 100 条自动淘汰最旧。
   被 agent-engine.js（埋点）和 agent-settings.js（展示）使用。
   ═══════════════════════════════════════════════════════ */

const LLMLog = {
  MAX: 100,                        // 最多保留 100 条，避免占用空间
  LS_KEY: 'aicq_agent_llm_logs',
  _mem: null,                      // 内存缓存（完整版，input/output 较长）

  // ── 内部：加载 ──
  _load() {
    if (this._mem) return this._mem;
    try {
      const raw = localStorage.getItem(this.LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      this._mem = Array.isArray(arr) ? arr : [];
    } catch (e) { this._mem = []; }
    return this._mem;
  },

  // ── 内部：持久化（截断超长字段，防止 localStorage 爆量）──
  _persist() {
    const cut = (s) => s ? String(s).slice(0, 3000) : '';
    const slim = this._mem.map(e => ({
      ...e, input: cut(e.input), output: cut(e.output)
    }));
    try {
      localStorage.setItem(this.LS_KEY, JSON.stringify(slim));
    } catch (e) {
      // 配额超限 → 砍半重试一次
      try {
        this._mem = this._mem.slice(0, Math.ceil(this._mem.length / 2));
        localStorage.setItem(this.LS_KEY, JSON.stringify(
          this._mem.map(x => ({ ...x, input: cut(x.input), output: cut(x.output) }))
        ));
      } catch (e2) { /* 放弃持久化，内存版本仍在 */ }
    }
  },

  // ── 记录一条调用（engine 埋点入口）──
  // entry: { provider, model, status, latency_ms, tokens_in, tokens_out,
  //          tokens_est, msg_count, input, output, error, agent_id, phase }
  record(entry) {
    const list = this._load();
    const e = {
      id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      provider: entry.provider || '',
      model: entry.model || '',
      status: (entry.status === undefined || entry.status === null) ? 'ERR' : entry.status,
      latency_ms: entry.latency_ms || 0,
      tokens_in: (entry.tokens_in === undefined || entry.tokens_in === null) ? null : entry.tokens_in,
      tokens_out: (entry.tokens_out === undefined || entry.tokens_out === null) ? null : entry.tokens_out,
      tokens_est: !!entry.tokens_est,
      msg_count: (entry.msg_count === undefined || entry.msg_count === null) ? null : entry.msg_count,
      input: entry.input || '',          // 序列化后的输入（已脱敏 dataURI）
      output: entry.output || '',        // 输出 content + tool_calls 摘要
      error: entry.error || '',
      agent_id: entry.agent_id || '',
      phase: entry.phase || ''           // scnet/accumulation 分段标签
    };
    list.unshift(e);                     // 最新在前
    if (list.length > this.MAX) list.length = this.MAX;
    // 内存版也截断（防 dataURI 撑爆内存；20k 字符足够调试）
    e.input = e.input.slice(0, 20000);
    e.output = e.output.slice(0, 20000);
    this._persist();
    // 通知设置页刷新（滚动更新）
    try { window.dispatchEvent(new CustomEvent('llm-log-updated')); } catch (err) {}
    return e;
  },

  // ── 读取（最新在前）──
  list() { return this._load(); },

  // ── 清空 ──
  clear() {
    this._mem = [];
    try { localStorage.removeItem(this.LS_KEY); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('llm-log-updated')); } catch (err) {}
  },

  // ── 工具：messages 数组 → 可读文本（脱敏图片 dataURI）──
  serializeMessages(messages) {
    if (!Array.isArray(messages)) return String(messages ?? '');
    return messages.map(m => {
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) {
        content = m.content.map(c => {
          if (c.type === 'text') return c.text || '';
          if (c.type === 'image_url') {
            const u = (typeof c.image_url === 'string') ? c.image_url : (c.image_url && c.image_url.url) || '';
            return (u.startsWith('data:'))
              ? '[inline image ' + Math.round(u.length * 3 / 4 / 1024) + 'KB]'
              : '[image url] ' + u.slice(0, 200);
          }
          return '[' + (c.type || 'part') + ']';
        }).join('\n');
      } else if (m.content !== undefined) content = JSON.stringify(m.content);
      if (m.tool_calls && m.tool_calls.length) {
        content += (content ? '\n' : '') + m.tool_calls.map(tc =>
          `[tool_call] ${tc.function?.name || '?'}(${(tc.function?.arguments || '').slice(0, 500)})`).join('\n');
      }
      return `── [${m.role}] ──\n${content}`;
    }).join('\n\n')
      // dataURI 脱敏（analyze-image 等场景可能内联大图）
      .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
        (mm) => '[image ' + Math.round(mm.length * 3 / 4 / 1024) + 'KB]');
  },

  // ── 工具：粗略 token 估算（≈4 字符/token）──
  estimateTokens(text) { return Math.ceil((text || '').length / 4); },

  // ── 工具：从 OpenAI 兼容响应提取 usage ──
  usageFrom(data) {
    const u = data && data.usage;
    if (!u) return null;
    return {
      tin: (u.prompt_tokens !== undefined) ? u.prompt_tokens : null,
      tout: (u.completion_tokens !== undefined) ? u.completion_tokens : null
    };
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = LLMLog;

export default LLMLog;
