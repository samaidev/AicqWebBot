/* ═══════════════ aicqwebbot web/app.js ═══════════════
   Shell UI + host shim that lets the UNMODIFIED aicq.me agent runtime
   (agent-engine.js + tools + WASM sandbox + IndexedDB storage) run inside
   this standalone page:

   1. window.WebSocket is patched: the engine's `new WebSocket('/ws?token=')`
      gets a LocalBus instead. Engine output frames (stream_chunk / stream_end)
      are routed to the chat renderer; user input is delivered into the engine
      through the same WS message contract used by aicq.me.
   2. LLM / search / web proxies: the local server answers at the SAME
      same-origin paths as aicq.me — zero engine changes needed.
   3. All agent state (config, history, memory, virtual FS) lives in the
      browser's IndexedDB via agent-storage.js — exactly like aicq.me.
   ═════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── tiny helpers ──
  const $ = (id) => document.getElementById(id);
  const AGENT_ID_KEY = 'aicqwebbot_agent_id';
  const DEFAULT_TOOLS = ['web-search', 'web-read', 'url-read', 'save-memory', 'recall-memory',
    'task-plan', 'system-info', 'weather', 'qr-code', 'translate', 'exec-code',
    'create-image', 'create-chart', 'read-clipboard', 'write-clipboard'];
  let AGENT_VER = String(Date.now()); // cache-buster for local bundle

  function _agUrl(name) { return `/static/agent/${name}?v=${AGENT_VER}`; }

  // ═══════════ 0. Theme — light (day) is the default ═══════════

  const THEME_KEY = 'aicqwebbot_theme';
  let THEME = 'light';
  function applyTheme(t) {
    THEME = (t === 'dark') ? 'dark' : 'light';
    document.documentElement.dataset.theme = THEME;
    try { localStorage.setItem(THEME_KEY, THEME); } catch (e) {}
    const b = $('btnTheme');
    if (b) b.textContent = THEME === 'dark' ? '☀️' : '🌙';
  }
  try { applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'); }
  catch (e) { applyTheme('light'); }
  $('btnTheme').addEventListener('click', () => applyTheme(THEME === 'dark' ? 'light' : 'dark'));

  // ═══════════ 0b. Host shims for the aicq.me bundle modules ═══════════
  // agent-settings.js / agent-files.js were written for aicq.me's page which
  // provides toast(), the i18n t() and the session object S. The bundle files
  // themselves are zero-modification copies — the host supplies the shims.

  // ── toast (bottom-center, auto-dismiss) ──
  function toast(msg, type) {
    let box = document.getElementById('webbotToast');
    if (!box) { box = document.createElement('div'); box.id = 'webbotToast'; document.body.appendChild(box); }
    box.textContent = String(msg == null ? '' : msg);
    box.className = 'webbot-toast show' + (type ? ' ' + type : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => box.classList.remove('show'), 2600);
  }
  window.toast = toast;

  // ── S: minimal session object (the local relay never checks auth) ──
  window.S = window.S || { accessToken: 'local', account: null };

  // ── t(): English i18n dictionary for the settings modal (ag_* keys) ──
  const AG_I18N = {
    ag_system_prompt: 'System Prompt',
    ag_save: 'Save',
    ag_provider_label: 'Provider',
    ag_provider_opencode: 'OpenCode Zen (Free / Anonymous)',
    ag_provider_scnet: 'scnet.cn (Browser Cookie)',
    ag_provider_accum: 'Chat-Accumulation (API Key)',
    ag_provider_custom: 'Custom (OpenAI-compatible)',
    ag_scnet_cookie: 'Cookie (copy from www.scnet.cn browser)',
    ag_model_id: 'Model ID',
    ag_base_url: 'Base URL',
    ag_base_url_ph: 'https://api.example.com/v1',
    ag_api_key: 'API Key',
    ag_model: 'Model',
    ag_model_ph: 'model-name',
    ag_opencode_model: 'Model (free models work anonymously)',
    ag_opencode_custom_model: 'Custom model ID',
    ag_opencode_key_hint: 'API Key optional — leave blank for anonymous free access (rate-limited). Fill a Zen key for paid models / higher limits.',
    ag_opencode_free_note: 'Free anonymous models (live-verified 2026-09): nemotron-3-ultra / nemotron-3.5-lightning / ling-3.0-flash-fin (chat/completions), muse-spark-1.3 (responses — usually requires a real Zen key; region-locked in some regions). Streaming + tool calling work out of the box; free models are text-only. The catalog auto-syncs from GET /models and dead upstream models are filtered; if one still errors, the engine auto-fails-over to another free model.',
    ag_compat_mode: 'Compat Mode (no function calling)',
    ag_compat_hint: 'For API proxies without OpenAI function calling support. Symptom: test passes but chat gets 503/400 → check this.',
    ag_accum_desc: '<strong>Chat-Accumulation Mode:</strong><br>• Session ID auto-managed, no manual input needed<br>• Three-phase send: ①system prompt → ②tools list → ③user message, avoids token limits<br>• Tool calls use <code>&lt;tool_call&gt;</code> text format (no tools parameter)<br>• For OpenAI-compatible APIs with session accumulation (e.g. one-api/new-api forwarding to scnet)',
    ag_test_btn: 'Test Connection',
    ag_testing_btn: 'Testing...',
    ag_testing: 'Testing...',
    ag_test_ok: 'Connection OK',
    ag_test_scnet_ok: 'Connection OK — scnet responded successfully',
    ag_test_scnet_err: 'scnet error: ',
    ag_test_scnet_empty: 'scnet returned no content (Cookie may have expired)',
    ag_test_llm_err: 'LLM error: ',
    ag_test_exception: 'Exception: ',
    ag_elapsed: 'Elapsed',
    ag_model_label: 'Model',
    ag_response_preview: 'Response preview',
    ag_compat_note: 'Actual chat sends tools parameter. If chat gets 503/400, check "Compat Mode"',
    ag_fill_cookie: 'Please fill Cookie first',
    ag_fill_apikey: 'Please fill API Key first',
    ag_fill_model: 'Please fill Model first',
    ag_fill_model_name: 'Please fill Model name first',
    ag_fill_baseurl: 'Please fill Base URL first',
    ag_settings_saved: 'Settings saved',
    ag_export: 'Export Agent Data',
    ag_import: 'Import',
    ag_exported: 'Exported',
    ag_imported: 'Imported successfully',
    ag_delete: 'Delete Agent',
    ag_delete_confirm: 'Delete this agent? ALL local data (config, virtual FS, history, memory) will be permanently deleted.',
    ag_deleted: 'Agent deleted',
    ag_close: 'Close',
    // [2026-09-07] Settings tabs / ClawHub / LLM log / File manager — EN strings
    // consumed by agent-settings.js / agent-files.js via the _T(key, enFallback) helper
    ag_settings_title: 'Settings',
    ag_tab_prompt: 'Prompt',
    ag_tab_llm: 'LLM Config',
    ag_tab_tools: 'Tools',
    ag_tab_llmlog: 'LLM Log',
    ag_tab_data: 'Data',
    ag_select_all: 'Select All',
    ag_deselect_all: 'Deselect All',
    ag_clawhub_search_label: 'Search ClawHub Skills',
    ag_clawhub_search_ph: 'Search skills...',
    ag_search_btn: 'Search',
    ag_installed_skills: 'Installed Skills',
    ag_refresh: 'Refresh',
    ag_clear: 'Clear',
    ag_err_502_hint: ' — proxy cannot reach the LLM API (DNS/network/TLS)',
    ag_err_auth_hint: ' — auth failed: check API Key or Cookie',
    ag_err_404_hint: ' — URL not found: check base_url',
    ag_detail_label: 'Detail: ',
    ag_empty_response: '(empty response)',
    ag_searching: 'Searching...',
    ag_no_skills: 'No skills found',
    ag_install: 'Install',
    ag_install_ok: 'installed successfully',
    ag_search_failed: 'Search failed: ',
    ag_install_failed: 'Install failed: ',
    ag_no_installed_skills: 'No skills installed yet',
    ag_uninstall: 'Uninstall',
    ag_skill_uninstalled: 'Skill uninstalled',
    ag_no_data: 'No data to export',
    ag_log_module_failed: 'Log module load failed: ',
    ag_log_summary: 'Last {n} entries (cap 100, oldest auto-evicted)',
    ag_log_empty_hint: 'No logs yet — every LLM call is recorded here automatically after you chat with the agent',
    ag_log_empty1: '📭 No LLM call logs yet',
    ag_log_empty2: 'Send the agent a message — model / latency / tokens / input & output get recorded here in real time',
    ag_log_row_title: 'Click to view full input/output',
    ag_log_time: 'Time',
    ag_log_model: 'Model',
    ag_log_clear_confirm: 'Clear all LLM call logs?',
    ag_log_no_input: '(no input recorded)',
    ag_log_no_output: '(empty)',
    ag_log_detail_title: 'LLM Call Detail',
    ag_log_input: 'Input',
    ag_log_msgs: 'messages',
    ag_log_output: 'Output',
    ag_fs_root: 'Root',
    ag_fs_title: 'File Manager',
    ag_fs_upload: 'Upload',
    ag_fs_keys: 'Keys',
    ag_fs_empty: 'Empty directory',
    ag_fs_empty_hint: 'Click "Upload" to add files, or ask the agent to create files with the exec-code / edit-file tools',
    ag_fs_name: 'Name',
    ag_fs_size: 'Size',
    ag_fs_mtime: 'Modified',
    ag_fs_actions: 'Actions',
    ag_fs_open: 'Open / preview',
    ag_fs_preview_img: 'Preview image',
    ag_fs_download: 'Download',
    ag_fs_delete: 'Delete',
    ag_fs_not_found: 'File not found',
    ag_fs_src_trunc: 'Source too long — showing first 200k chars only; download to view the full text',
    ag_fs_render: 'Rendered',
    ag_fs_source: 'Source',
    ag_fs_newtab: 'New tab',
    ag_fs_newtab_title: 'Open fully in a new browser tab',
    ag_fs_no_preview: 'Preview not supported for .{ext} — download to view',
    ag_fs_html_unavail: 'HTML content unavailable',
    ag_fs_downloaded: 'Downloaded: ',
    ag_fs_del_confirm: 'Delete {name}?',
    ag_fs_deleted: 'Deleted: ',
    ag_fs_uploaded: 'Uploaded: {name} ({kb}KB)',
    ag_fs_identity: 'Agent Identity',
    ag_fs_show: 'Show',
    ag_fs_hide: 'Hide',
    ag_fs_copy: 'Copy',
    ag_fs_llm_cfg: 'LLM Config',
    ag_fs_copied: 'Copied',
    ag_file_rendered: 'Rendered',
    ag_file_source: 'Source',
    ag_file_newtab: 'New tab',
    ag_file_download_tip: 'Download to your device',
    ag_file_html_hint: 'Agent-created HTML — rendered preview below',
    ag_file_trunc: 'Source too long — showing first 100k chars; use ⬇ or New tab for the full page'
  };
  window.t = (k) => AG_I18N[k] || k;

  // ═══════════ 1. LocalBus — the engine's "WebSocket" ═══════════

  class LocalBus {
    constructor(url) {
      this.url = url;
      this.readyState = 1;           // always OPEN — engine checks this everywhere
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._pingInterval = null;
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }
    send(raw) {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'online' || msg.type === 'ping') return;  // no server to greet
      if (msg.type === 'stream_chunk') { UI.onChunk(msg); return; }
      if (msg.type === 'stream_end') { UI.onEnd(msg); return; }
      // group_message / other engine outbound frames: ignore (standalone = 1:1)
    }
    deliver(msgObj) {
      // Feed an inbound frame into the engine (same shape aicq.me WS sends)
      if (this.onmessage) this.onmessage({ data: JSON.stringify(msgObj) });
    }
    close() {
      this.readyState = 3;
      if (this._pingInterval) clearInterval(this._pingInterval);
      if (this.onclose) this.onclose();
    }
  }

  const RealWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('/ws?token=')) {
      window.__localBus = new LocalBus(url);
      return window.__localBus;
    }
    return protocols !== undefined ? new RealWebSocket(url, protocols) : new RealWebSocket(url);
  };
  window.WebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;

  // ═══════════ 2. Chat renderer ═══════════

  const UI = {
    cs: 'cs_' + Date.now(),
    currentStream: null,   // {el, textEl, statusEl, streamId, reasoningEl}
    // [2026-09-06] 本次回复已渲染节点的登记表：
    //   replyNodes  — 本次回复产生过的所有 DOM 节点（文本气泡 + 工具卡）
    //   replyTools  — 已渲染过卡片的 tool_call id 集合
    // stream_end 到达时若带权威 content_order，则把本次回复整体拆除重放，
    // 保证「文本→工具卡→文本」顺序正确且不重复（修复末尾气泡被全量拼接覆盖的缺陷）。
    replyNodes: [],
    replyTools: new Set(),

    esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    md(text) {
      // lightweight markdown: fenced code, inline code, bold
      let html = this.esc(text);
      html = html.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code}</code></pre>`);
      html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      return html;
    },

    addUser(text) {
      const el = document.createElement('div');
      el.className = 'msg user';
      el.textContent = text;
      $('msgFlow').appendChild(el);
      this.scroll();
    },

    ensureStream() {
      if (this.currentStream) return this.currentStream;
      const wrap = document.createElement('div');
      wrap.className = 'msg agent';
      const reasoning = document.createElement('div');
      reasoning.className = 'reasoning hidden';
      const body = document.createElement('div');
      const status = document.createElement('div');
      status.className = 'status hidden';
      wrap.appendChild(reasoning); wrap.appendChild(body); wrap.appendChild(status);
      $('msgFlow').appendChild(wrap);
      this.currentStream = { wrap, reasoning, body, status, text: '', streamId: null, done: false };
      this.replyNodes.push(wrap);   // 登记进本次回复的节点表
      return this.currentStream;
    },

    onChunk(msg) {
      if (msg.chat_session_id && msg.chat_session_id !== this.cs) return; // stale session
      const st = this.ensureStream();
      if (msg.stream_id) st.streamId = msg.stream_id;
      const t = msg.chunkType || 'text';
      const d = msg.data;
      if (t === 'text' && typeof d === 'string') {
        st.text += d;
        st.body.innerHTML = this.md(st.text);
        st.status.classList.add('hidden');
      } else if (t === 'thinking' && typeof d === 'string') {
        st.status.textContent = d;
        st.status.classList.remove('hidden');
      } else if (t === 'reasoning' || t === 'reasoning_delta') {
        st.reasoning.classList.remove('hidden');
        st.reasoning.textContent += (typeof d === 'string') ? d : '';
      } else if (t === 'reasoning_end') {
        /* keep reasoning collapsed visible */
      } else if (t === 'clear_text') {
        st.text = ''; st.body.innerHTML = '';
      } else if (t === 'tool_call' && d && typeof d === 'object') {
        st.status.classList.add('hidden');
        const card = Tools.card(d);
        $('msgFlow').appendChild(card.el);
        Tools.byId[d.id] = card;
        this.replyNodes.push(card.el);              // 卡片也登记进本次回复
        if (d.id) this.replyTools.add(d.id);
        this.currentStream = null;   // next text chunk starts a fresh bubble
        this.scroll();
      } else if (t === 'tool_result' && d && typeof d === 'object') {
        Tools.result(d);
      } else if (t === 'v2_media' && d && typeof d === 'object') {
        const url = d.url || d.media_url || '';
        const data = d.data || d.media_data || '';
        if (data && String(data).startsWith('data:image')) {
          const img = document.createElement('img');
          img.className = 'chat-img'; img.src = data;
          st.body.appendChild(img);
        } else if (url) {
          const img = document.createElement('img');
          img.className = 'chat-img'; img.src = url;
          st.body.appendChild(img);
        }
      } else if (t === 'file' && d && typeof d === 'object' && d.data) {
        // [ADD 2026-09-07 v0.4.8] 智能体投递的文件（独立壳通道，agent-tools-native.js
        // _emitFileChunk 发出）：图片内联 / HTML 渲染预览卡 / 通用下载卡。
        // 不登记进 replyNodes —— stream_end 的权威重放只重建 text/tool 节点，
        // 登记了反而会把文件卡拆掉。
        st.status.classList.add('hidden');
        this.currentStream = null;   // 文件卡独立成块，下段文本另起气泡
        $('msgFlow').appendChild(this.fileCard(d));
      }
      this.scroll();
    },

    onEnd(msg) {
      if (msg.chat_session_id && msg.chat_session_id !== this.cs) return;
      const st = this.currentStream;
      if (st) st.status.classList.add('hidden');

      // [2026-09-06] 权威重放：stream_end 带 content_order（text/tool 顺序）时，
      // 把本次回复已渲染的节点整体拆除，按权威顺序重建：
      //   • 文本段独立成泡（不再全量拼接进最后一个泡 — 修复重复渲染缺陷）
      //   • 工具卡必现：即使 tool_call 实时帧丢失/未渲染，也由 tool_calls 数据补齐
      //     （含命令参数 input 与返回结果 result）
      const order = Array.isArray(msg.content_order) ? msg.content_order : [];
      const segs = Array.isArray(msg.text_segments) ? msg.text_segments : [];
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (order.length > 1 && (segs.length || calls.length)) {
        // 拆除本次回复已渲染的节点（气泡/卡片），保留 reasoning（挂在第一个气泡上）
        const reasoning = st ? st.reasoning : null;
        for (const n of this.replyNodes) n.remove();
        this.replyNodes = []; this.replyTools.clear();
        let ti = 0, ci = 0;
        for (const kind of order) {
          if (kind === 'text' && ti < segs.length) {
            const seg = segs[ti++];
            const wrap = document.createElement('div');
            wrap.className = 'msg agent';
            if (reasoning && !reasoning.isConnected) { wrap.appendChild(reasoning); }
            const body = document.createElement('div');
            body.innerHTML = this.md(String(seg || ''));
            wrap.appendChild(body);
            $('msgFlow').appendChild(wrap);
          } else if (kind === 'tool' && ci < calls.length) {
            const tc = calls[ci++];
            if (!tc) continue;
            const card = Tools.card({ name: tc.name || 'tool', input: tc.input || {}, id: tc.id || ('tc_missing_' + ci) });
            const ok = tc.success !== false && !tc.error;
            card.stateEl.textContent = ok ? '✓' : '✗';
            card.stateEl.className = 'tc-state ' + (ok ? 'ok' : 'err');
            const out = card.body.querySelector('.tc-out');
            if (out) out.innerHTML = `<b>📤 output — result</b>\n${UI.esc(String(tc.result || tc.error || '').slice(0, 4000))}`;
            $('msgFlow').appendChild(card.el);
            if (tc.id) Tools.byId[tc.id] = card;
          }
        }
      } else if (st) {
        // 简单路径（纯文本回复）：沿用权威 text_segments
        if (Array.isArray(msg.text_segments) && msg.text_segments.length) {
          st.body.innerHTML = msg.text_segments.map(s => this.md(s)).join('');
        }
      }
      this.replyNodes = []; this.replyTools.clear();
      this.currentStream = null;
      this.scroll();
    },

    // [ADD 2026-09-07 v0.4.8] 文件卡：图片内联；HTML 渲染预览（iframe sandbox +
    // 渲染/源码切换 + 新窗口 + 下载，对应 aicq.me 全量前端的 file-card + 预览按钮）；
    // 其它文件提供下载。d = { filename, mime, size, data(dataURI) }。
    fileCard(d) {
      const name = String(d.filename || 'file');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const uri = String(d.data || '');
      const size = Number(d.size) || 0;
      const sizeStr = size ? (size < 1024 ? size + ' B' : size < 1048576 ? (size / 1024).toFixed(1) + ' KB' : (size / 1048576).toFixed(1) + ' MB') : '';
      const isImg = !/html/.test(String(d.mime || '')) &&
        (/^image\//.test(String(d.mime || '')) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext));
      const isHtml = ext === 'html' || ext === 'htm' || /^text\/html/.test(String(d.mime || ''));

      const el = document.createElement('div');
      el.className = 'msg agent file-msg';

      // 图片：直接内联（点击=下载）
      if (isImg && !isHtml) {
        const img = document.createElement('img');
        img.className = 'chat-img'; img.src = uri; img.alt = name;
        img.title = name + (sizeStr ? ' · ' + sizeStr : '');
        img.onclick = () => UI.downloadURI(name, uri);
        el.appendChild(img);
        return el;
      }

      // HTML 源码（UTF-8 安全解码）
      let htmlText = '';
      if (isHtml) {
        try { htmlText = decodeURIComponent(escape(atob(uri.split(',')[1] || ''))); }
        catch (e) { htmlText = ''; }
      }

      const head = document.createElement('div');
      head.className = 'fc-head';
      head.innerHTML =
        `<span class="fc-icon">${isHtml ? '🌐' : '📄'}</span>` +
        `<span class="fc-name">${this.esc(name)}</span>` +
        (sizeStr ? `<span class="fc-size">${sizeStr}</span>` : '') +
        `<span class="fc-actions">` +
        (isHtml
          ? `<button data-act="render" class="on">🖥 ${t('ag_file_rendered')}</button>` +
            `<button data-act="source">📝 ${t('ag_file_source')}</button>` +
            `<button data-act="tab">↗ ${t('ag_file_newtab')}</button>`
          : '') +
        `<button data-act="download" title="${t('ag_file_download_tip')}">⬇</button>` +
        `</span>`;
      el.appendChild(head);

      let frame = null, pre = null;
      if (isHtml && htmlText) {
        frame = document.createElement('iframe');
        frame.className = 'fc-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
        el.appendChild(frame);
        pre = document.createElement('pre');
        pre.className = 'fc-src hidden';
        const CAP = 100000;
        pre.textContent = htmlText.slice(0, CAP) + (htmlText.length > CAP ? '\n… ' + t('ag_file_trunc') : '');
        el.appendChild(pre);
        // srcdoc 用 DOM 属性赋值，规避转义问题（同 agent-files.js 的做法）
        frame.srcdoc = htmlText;
      } else {
        const hint = document.createElement('div');
        hint.className = 'fc-hint';
        hint.textContent = name + (sizeStr ? ' · ' + sizeStr : '');
        el.appendChild(hint);
      }

      head.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button') : null;
        const act = (btn && btn.dataset) ? btn.dataset.act : null;
        if (!act) return;
        if (act === 'download') { UI.downloadURI(name, uri); return; }
        if (act === 'tab') {
          const u = URL.createObjectURL(new Blob([htmlText], { type: 'text/html' }));
          window.open(u, '_blank');
          setTimeout(() => URL.revokeObjectURL(u), 120000);
          return;
        }
        if (!frame) return;
        if (act === 'render') {
          frame.style.display = ''; pre.classList.add('hidden');
          head.querySelectorAll('.fc-actions button').forEach(b => b.classList.toggle('on', b.dataset.act === 'render'));
        } else if (act === 'source') {
          frame.style.display = 'none'; pre.classList.remove('hidden');
          head.querySelectorAll('.fc-actions button').forEach(b => b.classList.toggle('on', b.dataset.act === 'source'));
        }
      });
      return el;
    },

    downloadURI(filename, uri) {
      const a = document.createElement('a');
      a.href = uri;
      a.download = filename || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Downloaded: ' + (filename || ''), 'success');
    },

    scroll() {
      const f = $('msgFlow');
      f.scrollTop = f.scrollHeight;
    },

    reset() {
      $('msgFlow').innerHTML = '';
      this.currentStream = null;
      this.replyNodes = []; this.replyTools.clear();
    }
  };

  // ═══════════ 3. Tool cards ═══════════

  const Tools = {
    byId: {},

    card(d) {
      // [2026-09-06] 工具调用卡片默认展开（选项卡式）：命令参数 + 返回结果直接可见，
      // 仍可点击头部折叠。结构化为两段：input / output。
      const el = document.createElement('div');
      el.className = 'tool-card open';
      const head = document.createElement('div');
      head.className = 'tc-head';
      head.innerHTML = `<span class="tc-arrow">▾</span><span>🛠</span><span class="tc-name">${UI.esc(d.name || 'tool')}</span><span class="tc-state">…</span>`;
      const body = document.createElement('div');
      body.className = 'tc-body';
      body.innerHTML = `<div class="tc-sec"><b>⚙ input — command &amp; params</b>\n${UI.esc(JSON.stringify(d.input || {}, null, 2))}</div>`
        + `<div class="tc-sec tc-out"><b>📤 output — result</b>\n<span class="tc-pending">running…</span></div>`;
      head.addEventListener('click', () => {
        el.classList.toggle('open');
        const a = head.querySelector('.tc-arrow');
        if (a) a.textContent = el.classList.contains('open') ? '▾' : '▸';
      });
      el.appendChild(head); el.appendChild(body);
      return { el, body, stateEl: head.querySelector('.tc-state'), id: d.id || '' };
    },

    result(d) {
      const card = this.byId[d.id || ''];
      if (!card) return;
      const ok = d.success !== false && !d.error;
      card.stateEl.textContent = ok ? '✓' : '✗';
      card.stateEl.className = 'tc-state ' + (ok ? 'ok' : 'err');
      const out = card.body.querySelector('.tc-out');
      if (out) {
        out.innerHTML = `<b>📤 output — result</b>\n${UI.esc(String(d.output || d.error || '').slice(0, 4000))}`;
      } else {
        card.body.innerHTML = card.body.innerHTML.replace(/\n\n<b>output<\/b>[\s\S]*$/, '');
        card.body.innerHTML += `\n\n<b>output</b>\n${UI.esc(String(d.output || d.error || '').slice(0, 4000))}`;
      }
      UI.scroll();
    }
  };

  window.__UI = UI; // expose for debugging

  // ═══════════ 4. Setup panel ═══════════

  // ── OpenCode free-model catalog — powered by the bundle's provider module ──
  // (agent-llm-providers.js: dynamic /models catalog + static fallback +
  //  /responses vs /chat/completions auto-routing by model prefix)
  const OC_FALLBACK_MODELS = [   // keep in sync with agent-llm-providers.js OPENCODE_MODELS
    { id: 'nemotron-3-ultra-free',       label: 'Nemotron 3 Ultra (Free)' },
    { id: 'nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning (Free)' },
    { id: 'ling-3.0-flash-fin-free',     label: 'Ling 3.0 Flash Fin (Free)' },
    { id: 'mimo-v2.5-free',              label: 'MiMo-V2.5 (Free, rate-limited sometimes)' },
    { id: 'muse-spark-1.3-contributor-free', label: 'Muse Spark 1.3 Contributor (Zen key usually required; region-locked)' },
  ];
  const OC_DEFAULT_BASE = 'https://opencode.ai/zen/v1';
  const ocApiTypeFor = (m) => /^(gpt-|grok-|muse-spark-)/.test(m || '') ? 'response' : 'openai-completion';
  let OC_MOD = null; // agent-llm-providers.js module ref

  function renderFreeModels(selected) {
    const sel = $('f_freeModel');
    const models = (OC_MOD && OC_MOD._ocAllModels) ? OC_MOD._ocAllModels() : OC_FALLBACK_MODELS;
    sel.innerHTML = models.map(m => `<option value="${m.id}">${m.label}</option>`).join('')
      + '<option value="__custom__">Custom model ID…</option>';
    if (selected && models.some(m => m.id === selected)) {
      sel.value = selected;
    } else if (selected) {
      sel.value = '__custom__';
      $('f_freeModelCustom').value = selected;
    } else {
      sel.value = (models[0] && models[0].id) || '';
    }
    updateFreeModelUI();
  }

  function updateFreeModelUI() {
    const custom = $('f_freeModel').value === '__custom__';
    $('f_freeModelCustomGroup').style.display = custom ? 'block' : 'none';
    const model = custom ? $('f_freeModelCustom').value.trim() : $('f_freeModel').value;
    $('f_ocApiHint').textContent = model
      ? ('→ ' + (ocApiTypeFor(model) === 'response' ? '/responses (OpenAI Responses API)' : '/chat/completions (OpenAI Chat API)'))
      : '';
  }

  async function loadFreeModels(selected) {
    try { OC_MOD = await import(_agUrl('agent-llm-providers.js')); } catch (e) { OC_MOD = null; }
    renderFreeModels(selected);
    // dynamic /models refresh: via the local relay (pip mode); silently
    // falls back to the built-in catalog when direct (static hosting)
    if (OC_MOD && OC_MOD.fetchOpenCodeModels) {
      OC_MOD.fetchOpenCodeModels(false).then(cat => {
        if (!cat) return;
        const cur = $('f_freeModel').value === '__custom__'
          ? ($('f_freeModelCustom').value.trim() || selected || '')
          : ($('f_freeModel').value || selected || '');
        renderFreeModels(cur);
      });
    }
  }

  async function loadToolChips(selected) {
    const mod = await import(_agUrl('agent-tools.js'));
    const all = (mod.default.ALL_TOOLS || []).map(t => t.name);
    const box = $('f_tools');
    box.innerHTML = '';
    all.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'tool-chip' + (selected.includes(name) ? ' on' : '');
      chip.textContent = name;
      chip.addEventListener('click', () => chip.classList.toggle('on'));
      chip.dataset.tool = name;
      box.appendChild(chip);
    });
  }

  function selectedTools() {
    return [...document.querySelectorAll('#f_tools .tool-chip.on')].map(c => c.dataset.tool);
  }

  async function showSetup(existing) {
    $('setupPanel').classList.remove('hidden');
    $('chatPanel').classList.add('hidden');
    await loadToolChips(existing && existing.tools ? existing.tools : DEFAULT_TOOLS);
    const llmc = (existing && existing.llm_config) || {};
    const prov = llmc.provider || 'opencode';   // free models = zero-config default
    $('f_provider').value = (prov === 'openai') ? 'openai' : 'opencode';
    syncProvider();
    // static hosting: free OpenCode models need the local relay (their API
    // sends no CORS headers) — say so honestly; BYOK to CORS-open endpoints
    // still works directly from the browser
    $('staticNote').classList.toggle('hidden', !window.__STATIC_MODE);
    if (existing) {
      $('f_name').value = existing.name || '';
      $('f_prompt').value = existing.system_prompt || '';
      $('f_baseurl').value = llmc.base_url || '';
      $('f_model').value = llmc.model || '';
      $('f_apikey').value = llmc.api_key || '';
      $('f_freeKey').value = llmc.api_key || '';
      $('f_sandbox').value = existing.sandbox_type || 'python';
      if (prov !== 'openai') await loadFreeModels(llmc.model || '');
      else { $('f_apitype').value = (llmc.api_type === 'openai-response') ? 'openai-response' : 'openai-completion'; updateApiHint(); }
    } else {
      $('f_sandbox').value = 'python';   // Pyodide by default
      updateApiHint();
      if (prov !== 'openai') await loadFreeModels('');
    }
  }

  function syncProvider() {
    const free = $('f_provider').value === 'opencode';
    $('grpFree').style.display = free ? 'block' : 'none';
    $('grpOpenAI').style.display = free ? 'none' : 'block';
    if (!free) updateApiHint();
    if (free && !$('f_freeModel').options.length) loadFreeModels('');
  }

  // [2026-09-06] API 协议提示（Chat Completions vs Responses）
  function updateApiHint() {
    const el = $('f_apiHint');
    if (!el) return;
    el.textContent = $('f_apitype').value === 'openai-response'
      ? '→ POST {base}/responses — OpenAI Responses API (native function calling, gpt-5.x)'
      : '→ POST {base}/chat/completions — OpenAI Chat Completions API';
  }

  async function saveSetup(ev) {
    ev.preventDefault();
    const btn = $('btnSave');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
      // reuse the same agent_id so history/config persists across edits
      let agentId = localStorage.getItem(AGENT_ID_KEY);
      if (!agentId) {
        agentId = 'ai_local_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(AGENT_ID_KEY, agentId);
      }
      const isFree = $('f_provider').value === 'opencode';
      let llm;
      if (isFree) {
        const custom = $('f_freeModel').value === '__custom__';
        const model = custom ? $('f_freeModelCustom').value.trim() : $('f_freeModel').value;
        if (!model) throw new Error('choose or enter a model');
        llm = {
          provider: 'opencode',
          base_url: (OC_MOD && OC_MOD.OPENCODE_BASE_URL) || OC_DEFAULT_BASE,
          api_key: $('f_freeKey').value.trim(),
          model: model,
          api_type: (OC_MOD && OC_MOD._ocApiTypeForModel) ? OC_MOD._ocApiTypeForModel(model) : ocApiTypeFor(model),
        };
      } else {
        llm = {
          provider: 'openai',
          // [2026-09-06] 留空时默认官方端点；api_type = openai-completion | openai-response
          base_url: ($('f_baseurl').value.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
          api_key: $('f_apikey').value.trim(),
          model: $('f_model').value.trim(),
          api_type: $('f_apitype').value || 'openai-completion',
        };
      }
      if (!isFree && (!llm.api_key || !llm.model)) {
        throw new Error('model and API key are required for OpenAI-compatible providers (base URL defaults to https://api.openai.com/v1)');
      }
      const config = {
        agent_id: agentId,
        name: $('f_name').value.trim() || 'AicqWebBot',
        system_prompt: $('f_prompt').value.trim(),
        llm_config: llm,
        tools: selectedTools(),
        sandbox_type: $('f_sandbox').value,
        access_token: 'local',
        owner_id: 'local_owner',
        room_id: 'local',
        created_at: new Date().toISOString(),
      };
      await AgentStorage.saveConfig(agentId, config);
      await startChat(config);
    } catch (e) {
      alert('Save failed: ' + (e && e.message));
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Start Chat';
    }
  }

  // ═══════════ 5. Chat boot ═══════════

  let currentAgentId = null;

  async function startChat(config) {
    $('setupPanel').classList.add('hidden');
    $('chatPanel').classList.remove('hidden');
    $('agentName').textContent = config.name || 'AicqWebBot';
    UI.cs = 'cs_' + Date.now();
    $('csLabel').textContent = 'session ' + UI.cs.slice(3, 11);
    currentAgentId = config.agent_id;

    const mod = await import(_agUrl('agent-engine.js'));
    const AgentEngine = mod.default || mod;
    window.__engine = AgentEngine;
    await AgentEngine.connectAgent(config);
    console.log('[AicqWebBot] agent online:', config.agent_id);
  }

  function sendCurrent() {
    const box = $('inputBox');
    const text = box.value.trim();
    if (!text || !window.__localBus) return;
    UI.addUser(text);
    box.value = '';
    box.style.height = 'auto';
    window.__localBus.deliver({
      type: 'direct_message',
      from: 'local_user',
      to: currentAgentId,
      content: text,
      id: 'm_' + Date.now(),
      chat_session_id: UI.cs,
      data: {
        from_id: 'local_user', to_id: currentAgentId,
        content: text, id: 'm_' + Date.now(), chat_session_id: UI.cs
      }
    });
  }

  // ═══════════ 6. Wire up & boot ═══════════

  $('setupForm').addEventListener('submit', saveSetup);
  $('f_provider').addEventListener('change', syncProvider);
  $('f_freeModel').addEventListener('change', updateFreeModelUI);
  $('f_freeModelCustom').addEventListener('input', updateFreeModelUI);
  $('f_apitype').addEventListener('change', updateApiHint);
  $('btnSend').addEventListener('click', sendCurrent);
  $('inputBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  $('inputBox').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  });
  $('btnNewSession').addEventListener('click', () => {
    UI.cs = 'cs_' + Date.now();
    $('csLabel').textContent = 'session ' + UI.cs.slice(3, 11);
    UI.reset();
  });
  // ═══════════ 6b. Settings & file-manager entries ═══════════
  // ⚙ opens the ORIGINAL aicq.me settings modal (zero-modification copy):
  //   prompt / LLM config / tools / ClawHub / LLM log / data (import·export·delete)
  // 📁 opens the original file-manager modal over the agent's virtual FS.
  let _settingsMod = null;

  async function openFullSettings() {
    if (!currentAgentId) return;
    if (!_settingsMod) {
      _settingsMod = await import(_agUrl('agent-settings.js'));
      // wrap deleteAgent: standalone shell must also drop its agent-id key
      // and bounce back to the setup panel after the bundle's own cleanup
      const origDelete = window.deleteAgent;
      if (typeof origDelete === 'function') {
        window.deleteAgent = async function (agentId) {
          await origDelete(agentId);
          try { localStorage.removeItem(AGENT_ID_KEY); } catch (e) {}
          setTimeout(() => location.reload(), 700);
        };
      }
    }
    window.openSettings(currentAgentId);
  }

  $('btnSettings').addEventListener('click', openFullSettings);
  $('btnFiles').addEventListener('click', async () => {
    if (!currentAgentId) return;
    await import(_agUrl('agent-files.js'));
    window.openFileManager(currentAgentId);
  });

  // ═══════════ 6c. History sessions panel ☰ ═══════════
  // [2026-09-06] 列出 IndexedDB（agent-storage）里该 agent 的全部历史会话；
  // 点击任一会话 → 回切（UI.cs = 该会话 id）并重放完整记录：
  // 用户消息 / 智能体回复 / 工具调用卡片（含命令参数与返回结果）。
  // 回切后继续在该会话里聊天：引擎按 sessionId 加载历史上下文，无缝续聊。
  async function openHistory() {
    if (!currentAgentId) return;
    const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
    const sessions = await AgentStorage.listSessions(currentAgentId);
    document.getElementById('historyModal')?.remove();

    const fmt = (iso) => {
      try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (e) { return iso || ''; }
    };
    const rows = sessions.length
      ? sessions.map((s, i) => `
          <div class="hist-row" data-sid="${UI.esc(s.session_id)}">
            <div class="hist-title">${UI.esc(s.title || '(no text)')}</div>
            <div class="hist-meta">${s.message_count} msgs · ${fmt(s.last_at)} · <code>${UI.esc(s.session_id.slice(0, 13))}</code></div>
            <button class="hist-del" data-del="${UI.esc(s.session_id)}" title="Delete this session">🗑</button>
          </div>`).join('')
      : '<p style="color:var(--muted);font-size:13px;padding:8px 0">No sessions yet. Start chatting — every session is stored locally in your browser (IndexedDB) and listed here.</p>';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'historyModal';
    modal.innerHTML = `
      <div class="modal">
        <h3>🕘 History sessions</h3>
        <p style="font-size:12px;color:var(--muted);margin:2px 0 12px">All sessions live in your browser's IndexedDB. Click one to switch back and continue it.</p>
        <div class="hist-list">${rows}</div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn-secondary" id="btnHistClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.querySelector('#btnHistClose').onclick = () => modal.remove();
    modal.querySelectorAll('.hist-row').forEach(row => {
      row.addEventListener('click', () => loadHistorySession(row.dataset.sid));
    });
    // [2026-09-07] Per-session delete: 🗑 removes the whole session from IndexedDB
    // (agent_conversations rows + agent_sessions cuttime row). If the deleted
    // session is the one currently open, the chat resets to a fresh session.
    modal.querySelectorAll('.hist-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.del;
        if (!sid) return;
        if (!confirm('Delete this session? All its messages will be removed from IndexedDB.')) return;
        try {
          const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
          const ok = await AgentStorage.deleteSession(currentAgentId, sid);
          if (!ok) throw new Error('deleteSession failed');
          if (UI.cs === sid) {
            UI.cs = 'cs_' + Date.now();
            $('csLabel').textContent = 'session ' + UI.cs.slice(3, 11);
            UI.reset();
          }
          toast('Session deleted');
          modal.remove();
          openHistory();   // refresh list
        } catch (err) {
          console.error('[AicqWebBot] session delete failed:', err);
          toast('Delete failed: ' + err.message, 'error');
        }
      });
    });
  }

  // 回切并重放某个历史会话的完整记录
  async function loadHistorySession(sessionId) {
    if (!sessionId || !currentAgentId) return;
    const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
    const records = await AgentStorage.getConversations(currentAgentId, sessionId, 0);
    document.getElementById('historyModal')?.remove();

    UI.cs = sessionId;   // 关键：继续该会话（引擎按此 sessionId 取历史上下文）
    $('csLabel').textContent = 'session ' + sessionId.slice(3, 11);
    UI.reset();
    $('msgFlow').innerHTML = '';

    const pending = {};   // tool_call_id → card（role:'tool' 记录回填结果用）
    const textOf = (c) => {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
      return JSON.stringify(c || '');
    };
    for (const m of records) {
      if (!m || !m.role) continue;
      if (m.role === 'user') {
        const t = textOf(m.content);
        if (t) UI.addUser(t);
      } else if (m.role === 'assistant') {
        const t = textOf(m.content);
        if (t && t.trim()) {
          const el = document.createElement('div');
          el.className = 'msg agent';
          el.innerHTML = UI.md(t);
          $('msgFlow').appendChild(el);
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
            const card = Tools.card({ name: tc.function?.name || 'tool', input: args, id: tc.id || '' });
            $('msgFlow').appendChild(card.el);
            pending[tc.id || ''] = card;
            // [ADD 2026-09-07 v0.4.8] 历史回放附件 chip —— 工具产出过文件（write-file 的
            // path / create-* 的 filename）时补一个「打开预览」入口，内容从虚拟 FS 懒加载，
            // 不往会话库里塞 base64。文件本身一直在文件管理器里，chip 只是快捷方式。
            const _fp = String(args.path || args.filename || args.dest_path || '');
            const _ext = (_fp.split('.').pop() || '').toLowerCase();
            if (_fp && ['html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'md', 'txt', 'json'].includes(_ext)) {
              const chip = document.createElement('button');
              chip.className = 'hist-file-chip';
              chip.textContent = '📎 ' + _fp.split('/').pop();
              chip.title = _fp;
              chip.onclick = async () => {
                if (!document.getElementById('agent-styles')) {
                  const link = document.createElement('link');
                  link.id = 'agent-styles'; link.rel = 'stylesheet';
                  link.href = '/static/agent/agent-styles.css';
                  document.head.appendChild(link);
                }
                if (!window.openFileViewer) await import(_agUrl('agent-files.js'));
                window.openFileViewer(currentAgentId, _fp.startsWith('/') ? _fp : '/' + _fp);
              };
              $('msgFlow').appendChild(chip);
            }
          }
        }
      } else if (m.role === 'tool') {
        const card = pending[m.tool_call_id || ''];
        if (card) {
          const ok = !String(m.content || '').startsWith('Error');
          card.stateEl.textContent = ok ? '✓' : '✗';
          card.stateEl.className = 'tc-state ' + (ok ? 'ok' : 'err');
          const out = card.body.querySelector('.tc-out');
          if (out) out.innerHTML = `<b>📤 output — result</b>\n${UI.esc(String(m.content || '').slice(0, 4000))}`;
        }
      }
    }
    UI.scroll();
    console.log('[AicqWebBot] history session loaded:', sessionId, records.length, 'records');
  }

  $('btnHistory').addEventListener('click', openHistory);

  (async function boot() {
    // wait (max 1.5s) for static/relay mode detection before first render
    const t0 = Date.now();
    while (!window.__modeReady && Date.now() - t0 < 1500) {
      await new Promise(r => setTimeout(r, 50));
    }
    try {
      const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
      const id = localStorage.getItem(AGENT_ID_KEY);
      const cfg = id ? await AgentStorage.getConfig(id) : null;
      if (cfg && cfg.llm_config) {
        await startChat(cfg);
        // [2026-09-06] 刷新后自动恢复最近会话（含工具卡片与结果重放）——
        // 用户不再面对空白聊天页误以为「数据没存 / 没有 indexdb」。
        // 恢复即续聊：UI.cs 切回该会话 id，引擎按此加载历史上下文。
        try {
          const sessions = await AgentStorage.listSessions(cfg.agent_id);
          if (sessions && sessions.length) {
            await loadHistorySession(sessions[0].session_id);
            console.log('[AicqWebBot] last session auto-restored:', sessions[0].session_id);
          }
        } catch (e) { console.warn('[AicqWebBot] auto-restore failed:', e); }
      } else {
        await showSetup(null);
      }
    } catch (e) {
      console.error('[AicqWebBot] boot error:', e);
      await showSetup(null);
    }
  })();

  // expose LocalBus deliver for tests
  window.__deliver = (obj) => window.__localBus && window.__localBus.deliver(obj);

  // ═══════════ 7. Static-hosting mode ═══════════
  // When the shell is served from a purely static host (HF Static Space,
  // GitHub Pages, any CDN) there is no local relay — /healthz will not
  // return JSON. In that mode we shim fetch so the UNMODIFIED engine's
  // proxy calls resolve client-side:
  //   llm-proxy    -> aicq.me PUBLIC RELAY (keyless, rate-limited, CORS-open)
  //                   for opencode.ai targets — their API sends no CORS
  //                   headers so the browser can never read it directly;
  //                   other OpenAI-compatible endpoints connect directly
  //                   (BYOK; CORS-open providers work out of the box)
  //   search-proxy -> aicq.me PUBLIC SEARCH RELAY (multi-engine, then DDG IA fallback)
  //   web-proxy    -> aicq.me PUBLIC WEB RELAY (read-only fetch; direct-fetch fallback)
  const RealFetch = window.fetch.bind(window);

  // Public relay on aicq.me: protocol identical to /api/v1/agent/llm-proxy,
  // but keyless and restricted to opencode.ai upstreams. CORS-open.
  const PUBLIC_RELAY_URL = 'https://aicq.me/api/v1/public/llm-relay';
  const OC_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai\//i;

  function jsonResp(obj, status) {
    return Promise.resolve(new Response(JSON.stringify(obj),
      { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }

  async function shimProxy(url, init) {
    // [FIX 2026-09-07] 非 string url（Request/URL 对象 —— Pyodide/Emscripten
    // 内部加载 wasm/包时就是这么调的）直接透传，绝不碰 .includes：
    // 此前 "url.includes is not a function" 直接炸掉 Pyodide 的 wasm 实例化。
    if (typeof url !== 'string') return RealFetch(url, init);
    if (url.includes('/api/v1/agent/llm-proxy')) {
      let p;
      try { p = JSON.parse(init && init.body || '{}'); }
      catch (e) { return jsonResp({ error: 'bad proxy request: ' + e }, 400); }
      const target = String(p.target_url || '');
      // 1) opencode.ai sends no CORS headers — relay through aicq.me's public
      //    relay (keyless for free models, BYOK key inside the body for paid).
      if (OC_HOST_RE.test(target)) {
        try {
          return await RealFetch(PUBLIC_RELAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          });
        } catch (e) { /* relay unreachable — fall through to direct */ }
      }
      // 2) everything else connects directly (BYOK; CORS-open providers work)
      try {
        return await RealFetch(target, {
          method: p.method || 'POST', headers: p.headers || {}, body: p.body,
        });
      } catch (e) {
        // Direct connect failed — almost always browser CORS. Be honest:
        const hint = 'Direct browser connection blocked (CORS or offline). '
          + 'Free OpenCode models are relayed via aicq.me (public relay); if that '
          + 'failed too it may be rate-limited — retry in a minute, or run your own '
          + 'relay: pip install aicqwebbot, then aicqwebbot.run(8386).';
        return jsonResp({ error: hint }, 502);
      }
    }
    if (url.includes('/api/v1/agent/search-proxy')) {
      try {
        const q = (JSON.parse(init && init.body || '{}').query) || '';
        // [2026-09-06] 首选 aicq.me 公共搜索中继（生产多引擎竞速：bing/360/ddg/
        // baidu/brave/toutiao，真实结果）；DDG IA API 只是最后兜底（它不是真搜索）。
        try {
          const r0 = await RealFetch('https://aicq.me/api/v1/public/search-relay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q }),
          });
          if (r0.ok) {
            const d0 = await r0.json();
            if (Array.isArray(d0.results) && d0.results.length) return jsonResp({ results: d0.results });
          }
        } catch (e) { /* relay unreachable — fall back below */ }
        const r = await RealFetch('https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(q));
        const d = await r.json();
        const results = (d.RelatedTopics || [])
          .filter(t => t.FirstURL && t.Text)
          .slice(0, 10)
          .map(t => ({ title: t.Text.split(' - ')[0], url: t.FirstURL, summary: t.Text }));
        return jsonResp({ results });
      } catch (e) { return jsonResp({ error: 'search failed: ' + e }, 502); }
    }
    if (url.includes('/api/v1/agent/web-proxy')) {
      // [2026-09-07] web_read/url_read 在静态形态原先直连 fetch —— 绝大多数网站
      // 不发 CORS 头，工具必挂（用户实测 web_read 跨域被拦）。现改走 aicq.me
      // 公共 web 中继（协议与登录版 web-proxy 完全一致：{url,mode,method,headers,
      // body} -> {status, body}；SSRF 校验 + 头白名单 + 限流）。中继不可达时
      // 回退旧的直连路径（CORS-open 站点仍可用）。
      let p0;
      try { p0 = JSON.parse(init && init.body || '{}'); }
      catch (e) { return jsonResp({ error: 'bad proxy request: ' + e }, 400); }
      try {
        const rw = await RealFetch('https://aicq.me/api/v1/public/web-relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p0),
        });
        if (rw.ok) {
          const dw = await rw.json();
          return jsonResp({ status: dw.status, body: dw.body || '', mode: p0.mode });
        }
      } catch (e) { /* relay unreachable — fall through to direct */ }
      try {
        const r = await RealFetch(p0.url, {
          method: p0.method || 'GET', headers: p0.headers || {},
          body: p0.body && (p0.method || 'GET').toUpperCase() !== 'GET' ? p0.body : undefined,
        });
        const text = await r.text();
        return jsonResp({ status: r.status, body: text.slice(0, 20000) });
      } catch (e) {
        return jsonResp({ status: 0, body: 'Direct fetch blocked (CORS or offline), and the aicq.me public web relay was unreachable: ' + e }, 200);
      }
    }
    return RealFetch(url, init);
  }

  fetch('/healthz')
    .then(r => (r.ok && (r.headers.get('content-type') || '').includes('json')))
    .then(ok => {
      if (!ok) {
        window.__STATIC_MODE = true;
        window.fetch = shimProxy;
        // [2026-09-07] 沙箱网络桥（同步 XHR）的目标端点：静态形态没有同源
        // web-proxy，指向 aicq.me 公共 web-relay；其余形态默认同源。
        window.__AICQ_PROXY_TARGET__ = 'https://aicq.me/api/v1/public/web-relay';
        console.log('[AicqWebBot] static mode: no local relay — free OpenCode models go through the aicq.me public relay, BYOK endpoints connect directly');
      }
    })
    .catch(() => {
      window.__STATIC_MODE = true;
      window.fetch = shimProxy;
      window.__AICQ_PROXY_TARGET__ = 'https://aicq.me/api/v1/public/web-relay';
      console.log('[AicqWebBot] static mode (no relay reachable): free models via aicq.me public relay, BYOK direct');
    })
    .finally(() => { window.__modeReady = true; });
})();
