/* ═══════════════ agent/agent-settings.js ═══════════════
   智能体设置面板 — 点击头像打开
   功能：修改系统提示词、LLM配置、调整工具、ClawHub skill安装/卸载
   ═══════════════════════════════════════════════════════ */

// [2026-09-07] OpenCode Zen 免费模型已下线（上游取消免费额度），供应商选项与
// agent-llm-providers.js 依赖已全部移除，仅保留 BYOK / scnet / chat-accumulation 等通道

// [2026-09-07] i18n helper — 宿主页面提供 t()（aicq.me 全量字典 / 独立壳 shim）。
// 键缺失时回退到英文文案，保证英文用户不会再看到纯中文面板。
function _T(k, en) {
  try {
    const v = (typeof t === 'function') ? t(k)
      : (typeof window !== 'undefined' && typeof window.t === 'function' ? window.t(k) : undefined);
    return (v && v !== k) ? v : (en || k);
  } catch (e) { return en || k; }
}

async function openSettings(agentId) {
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const AgentTools = (await import('/static/agent/agent-tools.js?v=20260904b')).default;
  const config = await AgentStorage.getConfig(agentId);
  if (!config) { toast('Agent config not found', 'error'); return; }
  // [2026-09-07] 遗留 opencode 配置迁移：免费通道已下线，面板按 openai 兼容展示，
  // 保存任意 tab 即持久化为 openai（base_url/key/model 原样保留，引擎走通用路径）
  if (config.llm_config && config.llm_config.provider === 'opencode') {
    config.llm_config.provider = 'openai';
  }

  // 加载样式
  if (!document.getElementById('agent-styles')) {
    const link = document.createElement('link');
    link.id = 'agent-styles'; link.rel = 'stylesheet';
    link.href = '/static/agent/agent-styles.css';
    document.head.appendChild(link);
  }

  const allTools = AgentTools.getToolList();
  const enabledTools = new Set(config.tools || []);

  // 创建 modal
  let modal = document.getElementById('agentSettingsModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'agentSettingsModal';
  modal.className = 'modal-overlay open';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal modal-wide" style="max-width:700px;max-height:90vh;overflow-y:auto">
      <h3>⚙️ ${config.name} ${_T('ag_settings_title','Settings')}</h3>
      <div class="auth-tabs" style="margin-bottom:16px">
        <button class="auth-tab active" onclick="switchSettingsTab('prompt')">${_T('ag_tab_prompt','Prompt')}</button>
        <button class="auth-tab" onclick="switchSettingsTab('llm')">${_T('ag_tab_llm','LLM Config')}</button>
        <button class="auth-tab" onclick="switchSettingsTab('tools')">${_T('ag_tab_tools','Tools')}</button>
        <button class="auth-tab" onclick="switchSettingsTab('clawhub')">ClawHub</button>
        <button class="auth-tab" onclick="switchSettingsTab('llmlog')">${_T('ag_tab_llmlog','LLM Log')}</button>
        <button class="auth-tab" onclick="switchSettingsTab('data')">${_T('ag_tab_data','Data')}</button>
      </div>

      <!-- 提示词 -->
      <div id="settingsPrompt" class="settings-tab">
        <div class="form-group">
          <label>${t('ag_system_prompt')}</label>
          <textarea id="settingsSystemPrompt" rows="8" style="min-height:200px">${config.system_prompt || ''}</textarea>
        </div>
        <button class="btn-action" onclick="saveSettings('${agentId}','prompt')">${t('ag_save')}</button>
      </div>

      <!-- LLM配置 -->
      <div id="settingsLlm" class="settings-tab" style="display:none">
        <div class="form-group">
          <label>${t('ag_provider_label')}</label>
          <select id="settingsLlmProvider" onchange="updateSettingsLlmUI()">
            <option value="scnet" ${config.llm_config?.provider==='scnet'?'selected':''}>${t('ag_provider_scnet')}</option>
            <option value="chat-accumulation" ${config.llm_config?.provider==='chat-accumulation'?'selected':''}>${t('ag_provider_accum')}</option>
            <option value="deepseek" ${config.llm_config?.provider==='deepseek'?'selected':''}>DeepSeek</option>
            <option value="openai" ${config.llm_config?.provider==='openai'?'selected':''}>OpenAI</option>
            <option value="custom" ${config.llm_config?.provider==='custom'?'selected':''}>${t('ag_provider_custom')}</option>
          </select>
        </div>
        <div id="settingsLlmFields"></div>
        <div class="btn-row" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-action" onclick="saveSettings('${agentId}','llm')">${t('ag_save')}</button>
          <button class="btn-secondary" onclick="testLLMConnection('${agentId}')" id="testLlmBtn">${t('ag_test_btn')}</button>
        </div>
        <div id="llmTestResult" style="margin-top:12px;font-size:13px"></div>
      </div>

      <!-- 工具 -->
      <div id="settingsTools" class="settings-tab" style="display:none">
        <div class="tool-actions" style="margin-bottom:8px">
          <a onclick="document.querySelectorAll('#settingsToolsList input').forEach(c=>c.checked=true)">${_T('ag_select_all','Select All')}</a> |
          <a onclick="document.querySelectorAll('#settingsToolsList input').forEach(c=>c.checked=false)">${_T('ag_deselect_all','Deselect All')}</a>
        </div>
        <div class="agent-tools-list" id="settingsToolsList">
          ${allTools.map(t => `<label class="tool-checkbox"><input type="checkbox" value="${t.name}" ${enabledTools.has(t.name)?'checked':''}> ${t.name} <span class="tool-desc">${t.description.slice(0,60)}</span></label>`).join('')}
        </div>
        <button class="btn-action" onclick="saveSettings('${agentId}','tools')" style="margin-top:12px">${t('ag_save')}</button>
      </div>

      <!-- ClawHub -->
      <div id="settingsClawhub" class="settings-tab" style="display:none">
        <div class="form-group">
          <label>${_T('ag_clawhub_search_label','Search ClawHub Skills')}</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="clawhubSearchInput" placeholder="${_T('ag_clawhub_search_ph','Search skills...')}" style="flex:1" onkeypress="if(event.key==='Enter')clawhubSearch()">
            <button class="btn-action" onclick="clawhubSearch()">${_T('ag_search_btn','Search')}</button>
          </div>
        </div>
        <div id="clawhubResults" style="margin-top:12px"></div>
        <hr style="margin:16px 0">
        <h4>${_T('ag_installed_skills','Installed Skills')}</h4>
        <div id="installedSkills" style="margin-top:8px"></div>
      </div>

      <!-- LLM日志 -->
      <!-- [2026-09-04] 每次调用 LLM 的日志列表（环形最近 100 条），Content 点击看详情 -->
      <div id="settingsLlmLog" class="settings-tab" style="display:none">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-muted,#888)" id="llmLogSummary"></span>
          <span style="flex:1"></span>
          <a onclick="refreshLlmLog()" style="cursor:pointer;font-size:12px">${_T('ag_refresh','Refresh')}</a>
          <span style="color:#ddd">|</span>
          <a onclick="clearLlmLog()" style="cursor:pointer;font-size:12px;color:#c00">${_T('ag_clear','Clear')}</a>
        </div>
        <div id="llmLogTableWrap" style="overflow-x:auto"></div>
      </div>

      <!-- 数据 -->
      <div id="settingsData" class="settings-tab" style="display:none">
        <button class="btn-action" onclick="exportAgentData('${agentId}')">📥 ${t('ag_export')}</button>
        <button class="btn-secondary" onclick="document.getElementById('importAgentFile').click()" style="margin-left:8px">📥 ${t('ag_import')}</button>
        <input type="file" id="importAgentFile" accept=".json" style="display:none" onchange="importAgentData('${agentId}',event)">
        <hr style="margin:16px 0">
        <button class="btn-secondary" onclick="deleteAgent('${agentId}')" style="color:red">🗑️ ${t('ag_delete') || 'Delete Agent'}</button>
      </div>

      <div class="btn-row" style="margin-top:20px">
        <button class="btn-secondary" onclick="document.getElementById('agentSettingsModal').remove()">${t('ag_close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  // 初始化 LLM 配置字段
  updateSettingsLlmUI(config.llm_config);
  // 加载已安装 skills
  loadInstalledSkills(agentId);
}

function switchSettingsTab(tab) {
  document.querySelectorAll('#agentSettingsModal .auth-tab').forEach((t, i) => {
    const tabs = ['prompt','llm','tools','clawhub','llmlog','data'];
    t.classList.toggle('active', tabs[i] === tab);
  });
  ['Prompt','Llm','Tools','Clawhub','LlmLog','Data'].forEach(name => {
    const el = document.getElementById('settings' + name);
    if (el) el.style.display = (name.toLowerCase() === tab) ? 'block' : 'none';
  });
  // [2026-09-04] 切到 LLM日志 tab 时渲染列表
  if (tab === 'llmlog') refreshLlmLog();
}

function updateSettingsLlmUI(existingConfig) {
  const provider = document.getElementById('settingsLlmProvider').value;
  const fields = document.getElementById('settingsLlmFields');
  const cfg = existingConfig || {};

  if (provider === 'scnet') {
    fields.innerHTML = `
      <div class="form-group"><label>${t('ag_scnet_cookie')}</label><textarea id="settingsScnetCookie" rows="3">${cfg.cookie||''}</textarea></div>
      <div class="form-group"><label>${t('ag_model_id')}</label>
        <select id="settingsScnetModel">
          <option value="520" ${cfg.model_id==520?'selected':''}>DeepSeek-V4-Flash</option>
          <option value="510" ${cfg.model_id==510?'selected':''}>DeepSeek-V4-Pro</option>
          <option value="17" ${cfg.model_id==17?'selected':''}>Qwen3-30B</option>
          <option value="120" ${cfg.model_id==120?'selected':''}>Qwen3-235B</option>
          <option value="410" ${cfg.model_id==410?'selected':''}>MiniMax-M2.5</option>
        </select>
      </div>`;
  } else if (provider === 'chat-accumulation') {
    const baseUrl = cfg.base_url || '';
    fields.innerHTML = `
      <div class="form-group"><label>${t('ag_base_url')}</label><input type="text" id="settingsBaseUrl" value="${baseUrl}" placeholder="${t('ag_base_url_ph')}"></div>
      <div class="form-group"><label>${t('ag_api_key')}</label><input type="password" id="settingsApiKey" value="${cfg.api_key||''}"></div>
      <div class="form-group"><label>${t('ag_model')}</label><input type="text" id="settingsModel" value="${cfg.model||''}" placeholder="${t('ag_model_ph')}"></div>
      <div class="form-group" style="padding:10px;background:#e8f4fd;border-radius:6px;border:1px solid #b3d9f2;font-size:12px;color:#0066cc">
        ${t('ag_accum_desc')}
      </div>`;
  } else {
    const baseUrl = cfg.base_url || (provider==='deepseek'?'https://api.deepseek.com/v1':provider==='openai'?'https://api.openai.com/v1':'');
    fields.innerHTML = `
      ${provider==='custom' ? `<div class="form-group"><label>${t('ag_base_url')}</label><input type="text" id="settingsBaseUrl" value="${baseUrl}" placeholder="${t('ag_base_url_ph')}"></div>` : ''}
      <div class="form-group"><label>${t('ag_api_key')}</label><input type="password" id="settingsApiKey" value="${cfg.api_key||''}"></div>
      <div class="form-group"><label>${t('ag_model')}</label><input type="text" id="settingsModel" value="${cfg.model||''}" placeholder="${t('ag_model_ph')}"></div>
      ${(provider==='openai'||provider==='custom') ? `
      <!-- [2026-09-06] API 协议选择：Chat Completions / Responses（gpt-5.x 等新模型推荐 Responses） -->
      <div class="form-group"><label>API 协议 / API protocol</label>
        <select id="settingsApiType">
          <option value="openai-completion" ${(cfg.api_type||'openai-completion')!=='openai-response'?'selected':''}>Chat Completions — POST /chat/completions</option>
          <option value="openai-response" ${cfg.api_type==='openai-response'?'selected':''}>Responses — POST /responses (OpenAI Responses API)</option>
        </select>
      </div>` : ''}
      <div class="form-group" style="margin-top:12px;padding:10px;background:#faf8f5;border-radius:6px;border:1px solid var(--beige,#e0d0bc)">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="settingsCompatMode" ${cfg.compat_mode?'checked':''} style="width:auto">
          <span>${t('ag_compat_mode')}</span>
        </label>
        <div style="font-size:11px;color:var(--text-muted,#999);margin-top:4px;margin-left:24px">
          ${t('ag_compat_hint')}
        </div>
      </div>`;
  }
}

async function saveSettings(agentId, tab) {
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const config = await AgentStorage.getConfig(agentId);
  if (!config) return;

  if (tab === 'prompt') {
    config.system_prompt = document.getElementById('settingsSystemPrompt').value;
  } else if (tab === 'llm') {
    const provider = document.getElementById('settingsLlmProvider').value;
    config.llm_config = { provider };
    if (provider === 'scnet') {
      config.llm_config.cookie = document.getElementById('settingsScnetCookie').value;
      config.llm_config.model_id = parseInt(document.getElementById('settingsScnetModel').value);
    } else if (provider === 'chat-accumulation') {
      config.llm_config.api_key = document.getElementById('settingsApiKey').value;
      config.llm_config.model = document.getElementById('settingsModel').value;
      config.llm_config.base_url = document.getElementById('settingsBaseUrl')?.value || '';
      // session_id 自动管理，不从表单读取
    } else {
      config.llm_config.api_key = document.getElementById('settingsApiKey').value;
      config.llm_config.model = document.getElementById('settingsModel').value;
      config.llm_config.base_url = provider==='deepseek' ? 'https://api.deepseek.com/v1' :
        provider==='openai' ? 'https://api.openai.com/v1' :
        document.getElementById('settingsBaseUrl')?.value || '';
      // [2026-09-06] API 协议（openai/custom 显示下拉；deepseek 无下拉时归位 chat）
      config.llm_config.api_type = document.getElementById('settingsApiType')?.value || 'openai-completion';
      // 兼容模式开关
      const compatCheckbox = document.getElementById('settingsCompatMode');
      config.llm_config.compat_mode = compatCheckbox ? compatCheckbox.checked : false;
    }
  } else if (tab === 'tools') {
    config.tools = Array.from(document.querySelectorAll('#settingsToolsList input:checked')).map(c => c.value);
  }

  await AgentStorage.saveConfig(agentId, config);
  await AgentStorage.saveToKV('local_agent_' + agentId, config);
  toast(t('ag_settings_saved'), 'success');
}

// ─── 测试 LLM 连通性 ───
// 读取当前 LLM 配置 tab 里的表单值（不需要先保存），发送一个最小测试请求
async function testLLMConnection(agentId) {
  const resultEl = document.getElementById('llmTestResult');
  const btn = document.getElementById('testLlmBtn');
  if (!resultEl || !btn) return;

  // 收集当前 tab 的配置（不依赖 saveSettings）
  const provider = document.getElementById('settingsLlmProvider').value;
  let llmConfig = { provider };
  if (provider === 'scnet') {
    llmConfig.cookie = document.getElementById('settingsScnetCookie')?.value.trim() || '';
    llmConfig.model_id = parseInt(document.getElementById('settingsScnetModel')?.value || '520');
    if (!llmConfig.cookie) {
      resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_cookie') + '</span>';
      return;
    }
  } else if (provider === 'chat-accumulation') {
    llmConfig.api_key = document.getElementById('settingsApiKey')?.value.trim() || '';
    llmConfig.model = document.getElementById('settingsModel')?.value.trim() || '';
    llmConfig.base_url = document.getElementById('settingsBaseUrl')?.value.trim() || '';
    if (!llmConfig.api_key) { resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_apikey') + '</span>'; return; }
    if (!llmConfig.model) { resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_model') + '</span>'; return; }
    if (!llmConfig.base_url) { resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_baseurl') + '</span>'; return; }
  } else {
    llmConfig.api_key = document.getElementById('settingsApiKey')?.value.trim() || '';
    llmConfig.model = document.getElementById('settingsModel')?.value.trim() || '';
    if (provider === 'deepseek') llmConfig.base_url = 'https://api.deepseek.com/v1';
    else if (provider === 'openai') llmConfig.base_url = 'https://api.openai.com/v1';
    else llmConfig.base_url = document.getElementById('settingsBaseUrl')?.value.trim() || '';
    // [2026-09-06] API 协议（与聊天路径一致）
    llmConfig.api_type = document.getElementById('settingsApiType')?.value || 'openai-completion';
    // 读取兼容模式开关
    const compatCheckbox = document.getElementById('settingsCompatMode');
    llmConfig.compat_mode = compatCheckbox ? compatCheckbox.checked : false;
    if (!llmConfig.api_key) {
      resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_apikey') + '</span>';
      return;
    }
    if (!llmConfig.model) {
      resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_model_name') + '</span>';
      return;
    }
    if (!llmConfig.base_url) {
      resultEl.innerHTML = '<span style="color:#c00">' + t('ag_fill_baseurl') + '</span>';
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = t('ag_testing_btn');
  resultEl.innerHTML = '<span style="color:var(--text-muted,#999)">⏳ ' + t('ag_testing') + '</span>';

  const startTime = Date.now();
  try {
    // 构建测试请求 — 发送一个最小的 ping 消息
    const proxyBody = provider === 'scnet' ? {
      target_url: 'https://www.scnet.cn/acx/chatbot/v1/chat/completion',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': llmConfig.cookie,
        'Accept': 'text/event-stream',
        'Origin': 'https://www.scnet.cn',
        'Referer': 'https://www.scnet.cn/ui/chatbot/test',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0'
      },
      body: JSON.stringify({
        // scnet API 要求 conversationId 是数字 long，不能是字符串
        conversationId: Date.now(),
        content: 'ping',
        thinkingEnable: false, onlineEnable: false,
        modelId: llmConfig.model_id || 520,
        textFile: [], imageFile: [], autoRun: 0, clusterId: ''
      }),
      stream: true
    } : provider === 'chat-accumulation' ? {
      // chat-accumulation 测试: 用标准 OpenAI 格式发 ping
      // session_id 在测试时不用（测试只验证连通性）
      target_url: llmConfig.base_url + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.api_key}`
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 10
      }),
      stream: false
    } : llmConfig.api_type === 'openai-response' ? {
      // [2026-09-06] Responses 协议连通性测试：POST {base}/responses，Responses 格式 ping
      target_url: llmConfig.base_url.replace(/\/+$/, '') + '/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.api_key}`
      },
      body: JSON.stringify({
        model: llmConfig.model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        stream: false,
        store: false,
        max_output_tokens: 16
      }),
      stream: false
    } : {
      target_url: llmConfig.base_url + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.api_key}`
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: 'user', content: 'ping' }],
        // 兼容模式不发 tools — 模拟实际聊天请求
        // 不兼容模式也不发 tools（测试只验证连通性，不带工具可以避免 503）
        stream: false,
        max_tokens: 10
      }),
      stream: false
    };

    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.accessToken },
      body: JSON.stringify(proxyBody)
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!resp.ok) {
      // 读取错误详情
      let errDetail = '';
      try {
        const errText = await resp.text();
        try {
          const errJson = JSON.parse(errText);
          const raw = errJson.error || errJson.message || errText;
          errDetail = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch { errDetail = errText; }
      } catch {}
      let hint = '';
      if (resp.status === 502) hint = _T('ag_err_502_hint',' — proxy cannot reach the LLM API (DNS/network/TLS)');
      else if (resp.status === 401 || resp.status === 403) hint = _T('ag_err_auth_hint',' — auth failed: check API Key or Cookie');
      else if (resp.status === 404) hint = _T('ag_err_404_hint',' — URL not found: check base_url');
      resultEl.innerHTML = `<span style="color:#c00">❌ HTTP ${resp.status}${hint}</span><br><span style="font-size:12px;color:var(--text-muted,#999)">${_T('ag_detail_label','Detail: ')}${String(errDetail).slice(0,300)}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
      return;
    }

    // 测试通过后，如果非兼容模式且非 scnet/chat-accumulation，提示 tools 风险
    const compatNote = (!llmConfig.compat_mode && provider !== 'scnet' && provider !== 'chat-accumulation')
      ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted,#999);padding:6px 8px;background:#fff3cd;border-radius:4px">${t('ag_compat_note')}</div>`
      : '';

    // 解析响应内容
    if (provider === 'scnet') {
      // scnet 返回 SSE 流，检查是否能拿到任何 contentType=1001 的内容
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let gotContent = false;
      let errMsg = '';
      const deadline = Date.now() + 30000;  // 30s timeout
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (buf.includes('\n\n')) {
          const idx = buf.indexOf('\n\n');
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const obj = JSON.parse(line.slice(5).trim());
              if (obj.contentType === '1001' && obj.content) { gotContent = true; }
              else if (obj.contentType && obj.contentType !== '1002' && obj.content) { errMsg = obj.content; }
            } catch {}
          }
        }
        if (gotContent || errMsg) break;
      }
      if (errMsg) {
        resultEl.innerHTML = `<span style="color:#c00">❌ ${t('ag_test_scnet_err')}${errMsg}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
      } else if (gotContent) {
        resultEl.innerHTML = `<span style="color:green">✅ ${t('ag_test_scnet_ok')}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
      } else {
        resultEl.innerHTML = `<span style="color:#c00">❌ ${t('ag_test_scnet_empty')}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
      }
    } else {
      // OpenAI 兼容
      const text = await resp.text();
      let modelInfo = '';
      let contentPreview = '';
      try {
        const data = JSON.parse(text);
        modelInfo = data.model || llmConfig.model;
        // [2026-09-06] Responses 协议解析：output_text / output[].content[].text
        if (llmConfig.api_type === 'openai-response') {
          let _pv = data.output_text || '';
          if (!_pv && Array.isArray(data.output)) {
            for (const item of data.output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const c of item.content) { if (c.type === 'output_text' && c.text) _pv += c.text; }
              }
            }
          }
          contentPreview = (_pv || _T('ag_empty_response','(empty response)')).slice(0, 50);
        } else {
          contentPreview = data.choices?.[0]?.message?.content?.slice(0, 50) || _T('ag_empty_response','(empty response)');
        }
        if (data.error) {
          resultEl.innerHTML = `<span style="color:#c00">❌ ${t('ag_test_llm_err')}${data.error.message || data.error}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
          return;
        }
      } catch {
        contentPreview = text.slice(0, 50);
      }
      // Responses 协议无 compat 概念，不提示 tools 风险
      const _note = (llmConfig.api_type === 'openai-response') ? '' : compatNote;
      resultEl.innerHTML = `<span style="color:green">✅ ${t('ag_test_ok')}</span><br><span style="font-size:12px">${t('ag_model_label')}: <code>${modelInfo}</code> (${llmConfig.api_type || 'openai-completion'})</span><br><span style="font-size:12px">${t('ag_response_preview')}: ${contentPreview}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>${_note}`;
    }
  } catch(e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    resultEl.innerHTML = `<span style="color:#c00">❌ ${t('ag_test_exception')}${e.message}</span><br><span style="font-size:11px;color:var(--text-muted,#999)">${t('ag_elapsed')} ${elapsed}s</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = t('ag_test_btn');
  }
}

// ─── ClawHub ───
async function clawhubSearch() {
  const query = document.getElementById('clawhubSearchInput').value.trim();
  if (!query) return;
  const results = document.getElementById('clawhubResults');
  results.innerHTML = '<p>' + _T('ag_searching','Searching...') + '</p>';

  try {
    const resp = await fetch('https://clawhub.ai/api/v1/search?q=' + encodeURIComponent(query) + '&limit=20');
    const data = await resp.json();
    const skills = Array.isArray(data) ? data : (data.results || []);
    if (!skills.length) { results.innerHTML = '<p>' + _T('ag_no_skills','No skills found') + '</p>'; return; }

    results.innerHTML = skills.map(s => `
      <div class="clawhub-skill-item">
        <div><strong>${s.name || s.slug}</strong></div>
        <div style="font-size:12px;color:var(--text-muted)">${s.description || ''}</div>
        <button class="btn-action" style="margin-top:4px;padding:2px 8px;font-size:12px" onclick="installClawhubSkill('${s.slug || s.name}')">${_T('ag_install','Install')}</button>
      </div>
    `).join('');
  } catch(e) {
    results.innerHTML = '<p style="color:red">' + _T('ag_search_failed','Search failed: ') + e.message + '</p>';
  }
}

async function installClawhubSkill(slug) {
  const agentId = document.getElementById('agentSettingsModal').querySelector('.btn-action').getAttribute('onclick')?.match(/'([^']+)'/)?.[1] || '';
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;

  try {
    // 获取 skill 详情
    const resp = await fetch('https://clawhub.ai/api/v1/skills/' + slug);
    const skillInfo = await resp.json();

    await AgentStorage.saveSkill(agentId, {
      slug, name: skillInfo.name || slug,
      description: skillInfo.description || '',
      prompt: skillInfo.prompt || skillInfo.system_prompt || '',
      tools: skillInfo.tools || [],
      version: skillInfo.version || '',
      source: 'clawhub'
    });

    toast('Skill ' + slug + ' ' + _T('ag_install_ok','installed successfully'), 'success');
    loadInstalledSkills(agentId);
  } catch(e) {
    toast(_T('ag_install_failed','Install failed: ') + e.message, 'error');
  }
}

async function loadInstalledSkills(agentId) {
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const skills = await AgentStorage.getSkills(agentId);
  const el = document.getElementById('installedSkills');
  if (!el) return;
  if (!skills.length) { el.innerHTML = '<p style="color:var(--text-muted)">' + _T('ag_no_installed_skills','No skills installed yet') + '</p>'; return; }
  el.innerHTML = skills.map(s => `
    <div class="clawhub-skill-item">
      <div><strong>${s.name}</strong> <span style="font-size:11px;color:var(--text-muted)">v${s.version||'1.0'}</span></div>
      <div style="font-size:12px;color:var(--text-muted)">${s.description?.slice(0,80)||''}</div>
      <button class="btn-secondary" style="margin-top:4px;padding:2px 8px;font-size:12px;color:red" onclick="uninstallClawhubSkill('${agentId}','${s.slug}')">${_T('ag_uninstall','Uninstall')}</button>
    </div>
  `).join('');
}

async function uninstallClawhubSkill(agentId, slug) {
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  await AgentStorage.removeSkill(agentId, slug);
  toast(_T('ag_skill_uninstalled','Skill uninstalled'), 'success');
  loadInstalledSkills(agentId);
}

// ─── 数据导出/导入/删除 ───
async function exportAgentData(agentId) {
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const data = await AgentStorage.exportAgent(agentId);
  if (!data) { toast(_T('ag_no_data','No data to export'), 'error'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `agent_${agentId}_export.json`;
  a.click();
  toast(t('ag_exported'), 'success');
}

async function importAgentData(agentId, event) {
  const file = event.target.files[0];
  if (!file) return;
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const text = await file.text();
  const data = JSON.parse(text);
  await AgentStorage.importAgent(data);
  toast(t('ag_imported'), 'success');
}

async function deleteAgent(agentId) {
  if (!confirm(t('ag_delete_confirm') || 'Are you sure? All data will be deleted, including friend relationship and owner binding on the server.')) return;
  const AgentStorage = (await import('/static/agent/agent-storage.js?v=20260904b')).default;
  const config = await AgentStorage.getConfig(agentId);
  // Close WS
  if (window.AgentEngine?._agentWS?.[agentId]) {
    try { window.AgentEngine._agentWS[agentId].close(); } catch(e) {}
    delete window.AgentEngine._agentWS[agentId];
  }
  // Delete local data
  await AgentStorage.deleteAgent(agentId);

  // Remove friend relationship on server (bidirectional)
  try {
    await fetch('/api/v1/friends/' + agentId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + S.accessToken }
    });
  } catch(e) { console.warn('[deleteAgent] Failed to remove friend:', e); }

  // Clear owner_id binding on the agent's server account
  // This unbinds the agent from the owner so it can be re-bound later
  if (config?.access_token) {
    try {
      await fetch('/api/v1/accounts/me', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.access_token
        },
        body: JSON.stringify({ owner_id: '' })
      });
    } catch(e) { console.warn('[deleteAgent] Failed to clear owner_id:', e); }
  }

  // Also try to remove the agent from the server's friend list via the agent's token
  // (agent removes the owner as friend, completing the bidirectional removal)
  if (config?.access_token && S.account?.id) {
    try {
      await fetch('/api/v1/friends/' + S.account.id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + config.access_token }
      });
    } catch(e) { console.warn('[deleteAgent] Failed to remove owner from agent friends:', e); }
  }

  // Clear friends cache and force refresh (bypasses race condition guard)
  if (S.account?.id) await LocalDB.setKV('aicq_friends_' + S.account.id, null);
  S._forceFriendsRefresh = true; // Bypass race condition guard in loadFriends
  document.getElementById('agentSettingsModal')?.remove();
  if (typeof loadFriends === 'function') await loadFriends();
  // [2026-08-29] 删除完成 → 刷新创建 tab 可见性（本账号已无智能体 → 按钮恢复显示）
  try { if (window.AICQAgent && window.AICQAgent.refreshCreateTab) window.AICQAgent.refreshCreateTab(); } catch(e) {}
  toast(t('ag_deleted') || 'Agent deleted', 'success');
}

// ═══════ [2026-09-04] LLM 调用日志（设置页 tab 渲染）═══════
// 数据来自 agent-llm-log.js（环形最近 100 条 + localStorage 持久化），
// engine 每次真实调用 LLM 后写入；本页滚动更新（监听 llm-log-updated 事件）。
let _llmLogRows = [];  // 当前列表快照（详情按 id 查找）

function _llmEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _llmFmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
}

function _llmFmtLatency(ms) {
  if (!ms && ms !== 0) return '-';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function _llmFmtTokens(e) {
  const fi = (n) => (n === null || n === undefined) ? '-' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const est = e.tokens_est ? '~' : '';
  return `${est}${fi(e.tokens_in)} / ${est}${fi(e.tokens_out)}`;
}

// Status 徽标：2xx 绿 / 4xx-5xx 红 / ERR 红 / 有 error 文本黄
function _llmStatusBadge(e) {
  const hasErr = !!e.error;
  const s = String(e.status);
  let bg = '#e8f6e8', color = '#1a7a1a';
  if (s === 'ERR' || /^[45]/.test(s) || (hasErr && s.startsWith('2'))) { bg = '#fdeaea'; color = '#c00'; }
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${bg};color:${color};white-space:nowrap">${s === 'ERR' ? 'ERR' : _llmEsc(s)}${e.phase === 'SSE' ? ' ·SSE' : ''}</span>`;
}

// Content 摘要：输出前 40 字 / 工具调用名 / 错误信息
function _llmContentSummary(e) {
  if (e.error) return '❌ ' + e.error.slice(0, 60);
  let out = (e.output || '').trim();
  const tcLine = out.split('\n').find(l => l.startsWith('[tool_calls]'));
  if (tcLine) return '🔧 ' + tcLine.replace('[tool_calls] ', '').slice(0, 50);
  if (!out) return _T('ag_empty_response','(empty response)');
  return out.slice(0, 40).replace(/\n/g, ' ') + (out.length > 40 ? '…' : '');
}

async function refreshLlmLog() {
  const wrap = document.getElementById('llmLogTableWrap');
  const summary = document.getElementById('llmLogSummary');
  if (!wrap) return;
  try {
    const LLMLog = (await import('/static/agent/agent-llm-log.js?v=20260904b')).default;
    _llmLogRows = LLMLog.list();
  } catch (e) {
    wrap.innerHTML = '<p style="color:red;font-size:12px">' + _T('ag_log_module_failed','Log module load failed: ') + _llmEsc(e.message) + '</p>';
    return;
  }
  const rows = _llmLogRows;
  if (summary) {
    summary.textContent = rows.length
      ? _T('ag_log_summary','Last {n} entries (cap 100, oldest auto-evicted)').replace('{n}', rows.length)
      : _T('ag_log_empty_hint','No logs yet — every LLM call is recorded here automatically after you chat with the agent');
  }
  if (!rows.length) {
    wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted,#999);font-size:13px">' +
      _T('ag_log_empty1','📭 No LLM call logs yet') + '<br><span style="font-size:11px">' + _T('ag_log_empty2','Send the agent a message — model / latency / tokens / input & output get recorded here in real time') + '</span></div>';
    return;
  }
  const trs = rows.map(e => {
    const st = _llmStatusBadge(e);
    const content = _llmContentSummary(e);
    return `<tr style="border-bottom:1px solid #f0ebe3;cursor:pointer" onclick="showLlmLogDetail('${e.id}')" title="${_T('ag_log_row_title','Click to view full input/output')}">
      <td style="padding:6px 8px;white-space:nowrap;font-size:12px;color:var(--text-muted,#666)">${_llmFmtTime(e.ts)}</td>
      <td style="padding:6px 8px;font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_llmEsc(e.model)}">${_llmEsc(e.model || '-')}</td>
      <td style="padding:6px 8px">${st}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${_llmFmtLatency(e.latency_ms)}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap;color:#555">${_llmFmtTokens(e)}</td>
      <td style="padding:6px 8px;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${e.error ? '#c00' : '#333'}">${_llmEsc(content)}</td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;min-width:560px">
      <thead>
        <tr style="border-bottom:2px solid #e5ddcf;background:#faf8f5">
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">${_T('ag_log_time','Time')}</th>
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">${_T('ag_log_model','Model')}</th>
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">Status</th>
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">Latency</th>
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">Tokens (in/out)</th>
          <th style="padding:7px 8px;text-align:left;font-size:11px;color:#998;font-weight:600">Content</th>
        </tr>
      </thead>
      <tbody>${trs}</tbody>
    </table>`;
}

async function clearLlmLog() {
  if (!confirm(_T('ag_log_clear_confirm','Clear all LLM call logs?'))) return;
  const LLMLog = (await import('/static/agent/agent-llm-log.js?v=20260904b')).default;
  LLMLog.clear();
  refreshLlmLog();
}

// 详情弹层：完整输入（按 role 分段）+ 输出
function showLlmLogDetail(id) {
  const e = _llmLogRows.find(x => x.id === id);
  if (!e) return;
  let old = document.getElementById('llmLogDetailOverlay');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'llmLogDetailOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
  const inputTxt = e.input || _T('ag_log_no_input','(no input recorded)');
  const outputTxt = e.output || _T('ag_log_no_output','(empty)');
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:820px;width:100%;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.25)">
      <div style="padding:14px 18px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-size:14px">${_T('ag_log_detail_title','LLM Call Detail')}</strong>
        ${_llmStatusBadge(e)}
        <span style="font-size:12px;color:#666">${_llmEsc(e.model)}</span>
        <span style="font-size:12px;color:#999">${_llmFmtTime(e.ts)} · ${_llmFmtLatency(e.latency_ms)} · ${_llmFmtTokens(e)}${e.phase ? ' · ' + _llmEsc(e.phase) : ''}</span>
        <span style="flex:1"></span>
        <button class="btn-secondary" onclick="document.getElementById('llmLogDetailOverlay').remove()">${_T('ag_close','Close')}</button>
      </div>
      ${e.error ? `<div style="margin:10px 18px 0;padding:10px 12px;background:#fdeaea;border:1px solid #f3c1c1;border-radius:8px;color:#c00;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto">❌ ${_llmEsc(e.error)}</div>` : ''}
      <div style="padding:12px 18px;overflow-y:auto;flex:1">
        <div style="font-size:12px;font-weight:700;color:#555;margin-bottom:6px">${_T('ag_log_input','Input')} (${e.msg_count !== null && e.msg_count !== undefined ? e.msg_count + ' ' + _T('ag_log_msgs','messages') : '—'})</div>
        <pre style="margin:0 0 16px;padding:12px;background:#f8f6f2;border:1px solid #eee5d8;border-radius:8px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto;font-family:ui-monospace,Menlo,Consolas,monospace">${_llmEsc(inputTxt)}</pre>
        <div style="font-size:12px;font-weight:700;color:#555;margin-bottom:6px">${_T('ag_log_output','Output')}</div>
        <pre style="margin:0;padding:12px;background:#f4f9f4;border:1px solid #dcecdc;border-radius:8px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow-y:auto;font-family:ui-monospace,Menlo,Consolas,monospace">${_llmEsc(outputTxt)}</pre>
      </div>
    </div>`;
  ov.onclick = (ev) => { if (ev.target === ov) ov.remove(); };
  document.body.appendChild(ov);
}

// [2026-09-04] 滚动更新：engine 记录新日志时自动刷新列表（单例监听，不随 modal 关闭移除）
function _ensureLlmLogAutoRefresh() {
  if (window._llmLogAutoRefreshInstalled) return;
  window._llmLogAutoRefreshInstalled = true;
  window.addEventListener('llm-log-updated', () => {
    const tab = document.getElementById('settingsLlmLog');
    if (tab && tab.style.display !== 'none' && document.getElementById('agentSettingsModal')) {
      refreshLlmLog();
    }
  });
}
_ensureLlmLogAutoRefresh();

// 暴露
window.openSettings = openSettings;
window.switchSettingsTab = switchSettingsTab;
window.updateSettingsLlmUI = updateSettingsLlmUI;
window.saveSettings = saveSettings;
window.testLLMConnection = testLLMConnection;
window.clawhubSearch = clawhubSearch;
window.installClawhubSkill = installClawhubSkill;
window.loadInstalledSkills = loadInstalledSkills;
window.uninstallClawhubSkill = uninstallClawhubSkill;
window.exportAgentData = exportAgentData;
window.importAgentData = importAgentData;
window.deleteAgent = deleteAgent;
// [2026-09-04] LLM 日志 tab
window.refreshLlmLog = refreshLlmLog;
window.clearLlmLog = clearLlmLog;
window.showLlmLogDetail = showLlmLogDetail;

export { openSettings };
