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
    const isStatic = !!window.__STATIC_MODE;
    const prov = existing && existing.llm_config ? (existing.llm_config.provider || 'opencode') : (isStatic ? 'openai' : 'opencode');
    $('f_provider').value = (prov === 'opencode' && !isStatic) ? 'opencode' : 'openai';
    syncProvider();
    if (isStatic) {
      // static hosting: no local relay — the free anonymous provider cannot be
      // reached directly (its API blocks browser CORS), so hide that option
      $('f_provider').querySelector('option[value="opencode"]').disabled = true;
    }
    if (existing) {
      $('f_name').value = existing.name || '';
      $('f_prompt').value = existing.system_prompt || '';
      $('f_baseurl').value = (existing.llm_config && existing.llm_config.base_url) || '';
      $('f_model').value = (existing.llm_config && existing.llm_config.model) || '';
      $('f_apikey').value = (existing.llm_config && existing.llm_config.api_key) || '';
      $('f_freeKey').value = (existing.llm_config && existing.llm_config.api_key) || '';
      if (existing.llm_config && existing.llm_config.model) $('f_freeModel').value = existing.llm_config.model;
      $('f_sandbox').value = existing.sandbox_type || 'javascript';
    }
  }

  function syncProvider() {
    const free = $('f_provider').value === 'opencode';
    $('grpFree').style.display = free ? 'block' : 'none';
    $('grpOpenAI').style.display = free ? 'none' : 'block';
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
      const llm = isFree ? {
        provider: 'opencode',
        base_url: '',                      // engine default: opencode.ai/zen/v1
        api_key: $('f_freeKey').value.trim(),
        model: $('f_freeModel').value,
      } : {
        provider: 'openai',
        base_url: $('f_baseurl').value.trim().replace(/\/+$/, ''),
        api_key: $('f_apikey').value.trim(),
        model: $('f_model').value.trim(),
      };
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
  $('btnSettings').addEventListener('click', async () => {
    const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
    const id = localStorage.getItem(AGENT_ID_KEY);
    const cfg = id ? await AgentStorage.getConfig(id) : null;
    await showSetup(cfg);
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
  //   llm-proxy    -> direct connect to the model API (BYOK, CORS-aware)
  //   search-proxy -> DuckDuckGo Instant Answer API (CORS-open)
  //   web-proxy    -> direct fetch (gracefully degrades when CORS blocks)
  const RealFetch = window.fetch.bind(window);

  function jsonResp(obj, status) {
    return Promise.resolve(new Response(JSON.stringify(obj),
      { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }

  async function shimProxy(url, init) {
    if (url.includes('/api/v1/agent/llm-proxy')) {
      try {
        const p = JSON.parse(init && init.body || '{}');
        return RealFetch(p.target_url, {
          method: p.method || 'POST', headers: p.headers || {}, body: p.body,
        });
      } catch (e) { return jsonResp({ error: 'bad proxy request: ' + e }, 400); }
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
        console.log('[AicqWebBot] static mode: no local relay — LLM calls connect directly (BYOK)');
      }
    })
    .catch(() => {
      window.__STATIC_MODE = true;
      window.fetch = shimProxy;
      console.log('[AicqWebBot] static mode (no relay reachable): direct LLM connections enabled');
    })
    .finally(() => { window.__modeReady = true; });
})();
