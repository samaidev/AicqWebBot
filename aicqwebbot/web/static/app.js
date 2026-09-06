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
    ag_close: 'Close'
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
      }
      this.scroll();
    },

    onEnd(msg) {
      if (msg.chat_session_id && msg.chat_session_id !== this.cs) return;
      const st = this.currentStream;
      if (st) {
        st.status.classList.add('hidden');
        // prefer authoritative segments from stream_end
        if (Array.isArray(msg.text_segments) && msg.text_segments.length) {
          st.body.innerHTML = msg.text_segments.map(s => this.md(s)).join('');
        }
        this.currentStream = null;
      }
      this.scroll();
    },

    scroll() {
      const f = $('msgFlow');
      f.scrollTop = f.scrollHeight;
    },

    reset() {
      $('msgFlow').innerHTML = '';
      this.currentStream = null;
    }
  };

  // ═══════════ 3. Tool cards ═══════════

  const Tools = {
    byId: {},

    card(d) {
      const el = document.createElement('div');
      el.className = 'tool-card';
      const head = document.createElement('div');
      head.className = 'tc-head';
      head.innerHTML = `<span>🛠</span><span class="tc-name">${UI.esc(d.name || 'tool')}</span><span class="tc-state">…</span>`;
      const body = document.createElement('div');
      body.className = 'tc-body';
      body.innerHTML = `<b>input</b>\n${UI.esc(JSON.stringify(d.input || {}, null, 2))}`;
      head.addEventListener('click', () => el.classList.toggle('open'));
      el.appendChild(head); el.appendChild(body);
      return { el, body, stateEl: head.querySelector('.tc-state'), id: d.id || '' };
    },

    result(d) {
      const card = this.byId[d.id || ''];
      if (!card) return;
      const ok = d.success !== false && !d.error;
      card.stateEl.textContent = ok ? '✓' : '✗';
      card.stateEl.className = 'tc-state ' + (ok ? 'ok' : 'err');
      card.body.innerHTML = card.body.innerHTML.replace(/\n\n<b>output<\/b>[\s\S]*$/, '');
      card.body.innerHTML += `\n\n<b>output</b>\n${UI.esc(String(d.output || d.error || '').slice(0, 4000))}`;
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
    } else {
      $('f_sandbox').value = 'python';   // Pyodide by default
      if (prov !== 'openai') await loadFreeModels('');
    }
  }

  function syncProvider() {
    const free = $('f_provider').value === 'opencode';
    $('grpFree').style.display = free ? 'block' : 'none';
    $('grpOpenAI').style.display = free ? 'none' : 'block';
    if (free && !$('f_freeModel').options.length) loadFreeModels('');
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
          base_url: $('f_baseurl').value.trim().replace(/\/+$/, ''),
          api_key: $('f_apikey').value.trim(),
          model: $('f_model').value.trim(),
        };
      }
      if (!isFree && (!llm.base_url || !llm.api_key || !llm.model)) {
        throw new Error('base URL, model and API key are required for OpenAI-compatible providers');
      }
      const config = {
        agent_id: agentId,
        name: $('f_name').value.trim() || 'My Agent',
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
    $('agentName').textContent = config.name || 'Agent';
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
  //   search-proxy -> DuckDuckGo Instant Answer API (CORS-open)
  //   web-proxy    -> direct fetch (gracefully degrades when CORS blocks)
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
      try {
        const p = JSON.parse(init && init.body || '{}');
        const r = await RealFetch(p.url, {
          method: p.method || 'GET', headers: p.headers || {},
          body: p.body && (p.method || 'GET').toUpperCase() !== 'GET' ? p.body : undefined,
        });
        const text = await r.text();
        return jsonResp({ status: r.status, body: text.slice(0, 20000) });
      } catch (e) {
        return jsonResp({ status: 0, body: 'Direct fetch blocked (CORS or offline): ' + e }, 200);
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
        console.log('[AicqWebBot] static mode: no local relay — free OpenCode models go through the aicq.me public relay, BYOK endpoints connect directly');
      }
    })
    .catch(() => {
      window.__STATIC_MODE = true;
      window.fetch = shimProxy;
      console.log('[AicqWebBot] static mode (no relay reachable): free models via aicq.me public relay, BYOK direct');
    })
    .finally(() => { window.__modeReady = true; });
})();
