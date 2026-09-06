/* ═══════════════ agent/agent-llm-providers.js ═══════════════
   OpenCode Zen (opencode.ai) 免费匿名 LLM API — 共享配置模块
   创建面板 (agent-create.js) 和设置面板 (agent-settings.js) 共用
   [2026-08-28] 新增 provider
   [2026-09-03] 模型目录动态化：运行时 GET {base}/models 实时拉取
   （经 /api/v1/agent/llm-proxy 中继，绕过浏览器 CORS），
   localStorage 缓存 30 分钟 + single-flight；拉取失败回退下方静态目录。
   端点归类按官方文档 (opencode.ai/docs/zen) 前缀规则：
   「gpt- / grok- / muse-spark-」前缀走 /responses；「claude- / qwen / gemini-」
   前缀走 messages / google 协议（本面板暂不支持，不展示）；其余默认 chat/completions。
   ═══════════════════════════════════════════════════════════ */

// OpenCode Zen API 基础地址
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';

// 静态回退目录 — 仅在 /models 动态拉取失败时使用（离线兑底）
// [2026-09-03] 按当日 GET /models 实测（66 个模型 / 8 个 free）同步：
//   新增 muse-spark-1.3-contributor-free；动态拉取上线后此表仅在离线时兜底
// 排除 ling-3.0-flash-fin-free（空回复不稳定）
const OPENCODE_MODELS = {
  'openai-completion': [
    { id: 'nemotron-3-ultra-free',       label: 'Nemotron 3 Ultra (Free)' },
    { id: 'nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning (Free)' },
    { id: 'ling-3.0-flash-fin-free',     label: 'Ling 3.0 Flash Fin (Free)' },
    { id: 'mimo-v2.5-free',              label: 'MiMo-V2.5 (Free, rate-limited sometimes)' }
  ],
  'response': [
    { id: 'muse-spark-1.3-contributor-free', label: 'Muse Spark 1.3 Contributor (Zen key usually required; region-locked in some regions)' },
    { id: 'gpt-5.4-nano',                    label: 'GPT 5.4 Nano (needs API Key)' },
    { id: 'gpt-5.4-mini',                    label: 'GPT 5.4 Mini (needs API Key)' },
    { id: 'grok-build-0.1',                  label: 'Grok Build 0.1 (needs API Key)' }
  ]
};

// [2026-09-06] Verified dead / retired models — filtered out of BOTH the dynamic
// catalog and the static fallback. GET /models still lists them, but selecting
// one only produces an immediate upstream error.
const OC_DEAD_MODELS = new Set([
  'laguna-s-2.1-free',              // "Model is not supported" (live test 2026-09-06)
  'deepseek-v4-flash-free',         // "Model is unavailable" (live test 2026-09-06)
  'muse-spark-1.2-contributor-free' // retired upstream, only 1.3 remains
]);

// ═══ [2026-09-03] 动态模型目录 — 实时同步 GET {base}/models ═══
const OC_MODELS_CACHE_KEY = 'aicq_oc_zen_models_v1';
const OC_MODELS_TTL_MS = 30 * 60 * 1000;        // 缓存有效期 30 分钟
const OC_MODELS_RETRY_FAIL_MS = 5 * 60 * 1000;  // 拉取失败后的静默重试间隔

let _ocDynCatalog = null;    // { 'openai-completion': [...], 'response': [...] }
let _ocDynFetchAt = 0;       // 上次成功拉取时间戳
let _ocDynFailAt = 0;        // 上次失败时间戳（防止高频重试打爆代理）
let _ocDynFetching = null;   // single-flight promise
const _ocOpenPanels = new Set(); // 已打开面板 prefix — 拉取成功后重渲染

// 模型 id → 端点归属（依据 opencode.ai/docs/zen Endpoints 表前缀规则；
// 未匹配前缀默认 chat/completions，新上线模型多为 openai-compatible）
function _ocEndpointKind(id) {
  if (/^(gpt-|grok-|muse-spark-)/.test(id)) return 'response';
  if (/^(claude-|qwen|gemini-)/.test(id)) return 'unsupported'; // messages/google 协议，本面板暂不支持
  return 'openai-completion';
}

// id → 人类可读 label：'nemotron-3-ultra-free' → 'Nemotron 3 Ultra (Free)'
function _ocModelLabel(id) {
  const isFree = id.endsWith('-free');
  const core = isFree ? id.slice(0, -'-free'.length) : id;
  const upper = { gpt: 'GPT', glm: 'GLM', ai: 'AI', llm: 'LLM' };
  const words = core.split('-').filter(Boolean).map(w =>
    upper[w] || (/^[0-9]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  return words.join(' ') + (isFree ? ' (Free)' : ' (需 API Key)');
}

// 从 /models 返回的 id 列表构建目录；组内 free 优先、保持上游相对顺序
function _ocBuildCatalog(modelIds) {
  const cat = { 'openai-completion': [], 'response': [] };
  for (const id of modelIds) {
    if (!id || typeof id !== 'string') continue;
    if (OC_DEAD_MODELS.has(id)) continue;   // [2026-09-06] skip dead upstream models
    const kind = _ocEndpointKind(id);
    if (kind === 'unsupported' || !cat[kind]) continue;
    cat[kind].push({ id, label: _ocModelLabel(id), free: id.endsWith('-free') });
  }
  for (const k of Object.keys(cat)) {
    cat[k] = cat[k].filter(m => m.free).concat(cat[k].filter(m => !m.free));
  }
  return cat;
}

function _ocReadCache() {
  try {
    const raw = localStorage.getItem(OC_MODELS_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || !obj.catalog) return null;
    if (Date.now() - obj.ts > OC_MODELS_TTL_MS) return null;
    return obj;
  } catch(e) { return null; }
}

function _ocWriteCache(catalog) {
  try { localStorage.setItem(OC_MODELS_CACHE_KEY, JSON.stringify({ ts: Date.now(), catalog })); } catch(e) {}
}

// 当前生效目录：内存 → localStorage 缓存 → null（调用方回退静态表）
function _ocActiveCatalog() {
  if (_ocDynCatalog) return _ocDynCatalog;
  const cached = _ocReadCache();
  if (cached) { _ocDynCatalog = cached.catalog; _ocDynFetchAt = cached.ts; return _ocDynCatalog; }
  return null;
}

// 动态拉取模型目录 — 经 /api/v1/agent/llm-proxy GET {base}/models
// （浏览器直连 opencode.ai 会被 CORS 拦截；llm-proxy 服务端中继无此限制）
// 成功返回 catalog，失败返回 null（回退静态表）
async function fetchOpenCodeModels(force) {
  const now = Date.now();
  if (!force && _ocActiveCatalog() && now - _ocDynFetchAt < OC_MODELS_TTL_MS) return _ocDynCatalog;
  if (!force && _ocDynFailAt && now - _ocDynFailAt < OC_MODELS_RETRY_FAIL_MS) return null;
  if (_ocDynFetching) return _ocDynFetching;

  _ocDynFetching = (async () => {
    try {
      const token = (typeof S !== 'undefined' && S && S.accessToken) ? S.accessToken : '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/v1/agent/llm-proxy', {
        method: 'POST', headers,
        body: JSON.stringify({ target_url: OPENCODE_BASE_URL + '/models', method: 'GET', headers: {}, stream: false })
      });
      if (!resp.ok) throw new Error('proxy HTTP ' + resp.status);
      const data = await resp.json();
      const ids = Array.isArray(data && data.data) ? data.data.map(m => m && m.id).filter(Boolean) : [];
      if (!ids.length) throw new Error('empty /models response');
      const catalog = _ocBuildCatalog(ids);
      if (!catalog['openai-completion'].length && !catalog['response'].length) throw new Error('no usable models');
      _ocDynCatalog = catalog; _ocDynFetchAt = Date.now(); _ocDynFailAt = 0;
      _ocWriteCache(catalog);
      return catalog;
    } catch(e) {
      _ocDynFailAt = Date.now();
      console.warn('[OpenCode] 动态拉取模型列表失败，回退静态目录:', e && e.message);
      return null;
    } finally {
      _ocDynFetching = null;
    }
  })();
  return _ocDynFetching;
}

// 当前 API 类型应使用的模型列表：动态目录优先，静态表兑底
function _ocModelsForType(apiType) {
  const dyn = _ocActiveCatalog();
  if (dyn && dyn[apiType] && dyn[apiType].length) return dyn[apiType];
  return (OPENCODE_MODELS[apiType] || []).filter(m => !OC_DEAD_MODELS.has(m.id));
}

// [2026-09-03d] 全量模型列表 — 合并两种端点分组，free 优先、组内保持上游顺序。
// UI 一次性列出所有模型，API 类型由所选模型 ID 自动推导，不再让用户先选类型
function _ocAllModels() {
  const cat = _ocActiveCatalog() || OPENCODE_MODELS;
  const all = (cat['openai-completion'] || []).concat(cat['response'] || []);
  return all.filter(m => m && m.id && !OC_DEAD_MODELS.has(m.id) && m.free)
    .concat(all.filter(m => m && m.id && !OC_DEAD_MODELS.has(m.id) && !m.free));
}

// [2026-09-03d] 由模型 ID 自动匹配 API 类型：
// 「gpt- / grok- / muse-spark-」前缀 → response（/responses）；其余 → openai-completion（/chat/completions）。
// 自定义模型 ID 同样按前缀推导；claude/qwen/gemini 等不受支持协议的前缀兑底为 openai-completion
function _ocApiTypeForModel(model) {
  return _ocEndpointKind(model || '') === 'response' ? 'response' : 'openai-completion';
}

// 渲染模型下拉框；返回是否实际渲染（面板可能已关闭）
// [2026-09-03d] 渲染全量模型列表（不再按 API 类型过滤），并刷新自动匹配端点提示
function _ocRenderModelOptions(prefix, selectedModel) {
  const modelEl = document.getElementById(prefix + 'OcModel');
  if (!modelEl) return false;
  const models = _ocAllModels();
  modelEl.innerHTML = models.map(m =>
    `<option value="${m.id}" ${selectedModel === m.id ? 'selected' : ''}>${m.label} — ${m.id}</option>`
  ).join('') + `<option value="__custom__" ${selectedModel && !models.some(m => m.id === selectedModel) ? 'selected' : ''}>${t('ag_opencode_custom')}</option>`;
  updateOpenCodeCustomModelUI(prefix, selectedModel);
  return true;
}

// 根据 API 类型填充模型下拉框
// prefix: 'ag' (创建面板) | 'settings' (设置面板)
// [2026-09-03] 渲染时以后台方式触发 /models 动态拉取；拿到新目录后
// 重渲染所有已打开面板并保留当前选择（首次打开先用缓存/静态表立即渲染）
function updateOpenCodeModelOptions(prefix, selectedModel) {
  _ocOpenPanels.add(prefix);
  _ocRenderModelOptions(prefix, selectedModel);
  fetchOpenCodeModels(false).then(catalog => {
    if (!catalog) return;
    for (const p of _ocOpenPanels) {
      const el = document.getElementById(p + 'OcModel');
      if (!el) { _ocOpenPanels.delete(p); continue; }
      const customEl = document.getElementById(p + 'OcModelCustom');
      const cur = (el.value === '__custom__')
        ? ((customEl && customEl.value.trim()) || '__custom__')
        : el.value;
      _ocRenderModelOptions(p, cur);
    }
  });
}

// 选择「自定义模型 ID」时显示文本输入框
// [2026-09-03d] 同时刷新 API 类型自动匹配提示（模型选择变化 / 自定义 ID 输入时都会触发）
function updateOpenCodeCustomModelUI(prefix, forceValue) {
  const modelEl = document.getElementById(prefix + 'OcModel');
  const customGroup = document.getElementById(prefix + 'OcCustomModelGroup');
  const customInput = document.getElementById(prefix + 'OcModelCustom');
  if (!modelEl || !customGroup) return;
  if (modelEl.value === '__custom__') {
    customGroup.style.display = 'block';
    if (forceValue && customInput && !customInput.value) customInput.value = forceValue;
  } else {
    customGroup.style.display = 'none';
  }
  _ocUpdateApiTypeHint(prefix);
}

// [2026-09-03d] API 类型自动匹配提示 — 在模型下拉下方显示按当前模型推导出的端点
// （替代旧的手选 API 类型下拉；端点路径本身自解释，无需 i18n）
function _ocUpdateApiTypeHint(prefix) {
  const modelEl = document.getElementById(prefix + 'OcModel');
  const customEl = document.getElementById(prefix + 'OcModelCustom');
  const hintEl = document.getElementById(prefix + 'OcApiTypeHint');
  if (!modelEl || !hintEl) return;
  let model = modelEl.value;
  if (model === '__custom__') model = customEl ? customEl.value.trim() : '';
  if (!model) { hintEl.textContent = ''; return; }
  const apiType = _ocApiTypeForModel(model);
  hintEl.textContent = '→ ' + (apiType === 'response' ? '/responses' : '/chat/completions');
}

// 从表单收集 OpenCode LLM 配置（创建面板/设置面板通用）
// 返回 llmConfig 片段；model 为空时返回 { error: tkey }
// [2026-09-03d] api_type 不再读取手选下拉（已移除），改由模型 ID 自动匹配推导
function collectOpenCodeConfig(prefix) {
  const modelEl = document.getElementById(prefix + 'OcModel');
  const customEl = document.getElementById(prefix + 'OcModelCustom');
  const keyEl = document.getElementById(prefix + 'OcApiKey');
  const model = (modelEl && modelEl.value === '__custom__')
    ? (customEl ? customEl.value.trim() : '')
    : (modelEl ? modelEl.value : '');
  if (!model) return { error: 'ag_enter_model' };
  return {
    api_type: _ocApiTypeForModel(model),
    model,
    api_key: (keyEl ? keyEl.value.trim() : ''),
    base_url: OPENCODE_BASE_URL
  };
}

// OpenCode 连通性测试 — 两种 API 类型各自发一个最小 ping 请求
// 返回 { ok, preview, model, error }
async function testOpenCodeConnection(llmConfig) {
  const isResponses = (llmConfig.api_type === 'response');
  const headers = { 'Content-Type': 'application/json' };
  // 匿名免费：没有 key 就不带 Authorization 头
  if (llmConfig.api_key) headers['Authorization'] = 'Bearer ' + llmConfig.api_key;

  const proxyBody = {
    target_url: (llmConfig.base_url || OPENCODE_BASE_URL) + (isResponses ? '/responses' : '/chat/completions'),
    method: 'POST',
    headers,
    stream: false,
    body: isResponses
      ? JSON.stringify({ model: llmConfig.model, input: 'ping', stream: false, max_output_tokens: 16 })
      : JSON.stringify({ model: llmConfig.model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 10 })
  };

  const resp = await fetch('/api/v1/agent/llm-proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.accessToken },
    body: JSON.stringify(proxyBody)
  });

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: _opencodeErrorHint(resp.status, text) };
  }
  try {
    const data = JSON.parse(text);
    // OpenCode 错误也可能是 200 + {"type":"error",...}，统一检查
    if (data.type === 'error') return { ok: false, error: _opencodeErrorHint(200, text) };
    let preview = '';
    if (isResponses) {
      preview = (data.output_text || _responsesOutputText(data) || '(空响应)');
    } else {
      preview = (data.choices?.[0]?.message?.content?.slice(0, 60) || '(空响应)');
    }
    return { ok: true, preview, model: data.model || llmConfig.model };
  } catch(e) {
    return { ok: false, error: 'Invalid JSON: ' + text.slice(0, 200) };
  }
}

// 从 Responses API 响应对象提取 output_text
function _responsesOutputText(data) {
  if (!data || !Array.isArray(data.output)) return '';
  let out = '';
  for (const item of data.output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) out += c.text;
      }
    }
  }
  return out;
}

// [FIX 2026-09-05] 上游故障识别 — OpenCode Zen 网关把上游提供商的故障也包装成
// HTTP 400 返回（实测：deepseek-v4-flash-free 上游下线时返回
//   HTTP 400 {"error":{"type":"server_error","message":"Error from provider
//   (Console): Upstream request failed: Model is unavailable."}} ）。
// 这类「假 400」不是请求格式问题，需要与真正的格式错误区分开：
//   1) 提示文案要指向「上游不可用 / 换模型」而不是「请求格式错误」；
//   2) 引擎侧据此触发免费模型自动 failover（见 agent-engine.js _callOpenCode）。
function _isOpenCodeUpstreamError(status, bodyText) {
  // 502/503/529/408 一律视为上游问题
  if (status === 502 || status === 503 || status === 529 || status === 408) return true;
  try {
    const j = JSON.parse(bodyText);
    const et = (j.error && j.error.type) || '';
    const em = ((j.error && (j.error.message || j.error)) || j.message || '').toString();
    if (et === 'server_error') return true;   // OpenCode 上游故障的标准签名
    return /upstream request failed|upstream error|model is unavailable|service temporarily|overloaded|temporarily/i.test(em);
  } catch(e) {
    return /upstream|unavailable|overloaded|temporarily/i.test(bodyText || '');
  }
}

// OpenCode 错误信息转成用户可读的提示
// [FIX 2026-09-05] 三处增强：
//   1) 兼容裸 {"error":{...}} 格式（不带 type:'error' 外壳）— 此前 errType 丢失；
//   2) 「假 400」上游故障单独提示（不再误导为「请求格式错误」）；
//   3) 错误详情为空时给出兜底文案，避免出现「HTTP 400  — 」空心报错。
function _opencodeErrorHint(status, bodyText) {
  let errType = '', errMsg = '';
  try {
    const j = JSON.parse(bodyText);
    if (j.type === 'error' && j.error) {
      errType = j.error.type || '';
      errMsg = j.error.message || '';
    } else if (j.error && typeof j.error === 'object') {
      errType = j.error.type || '';
      errMsg = j.error.message || '';
    } else {
      errMsg = (j.error && j.error.message) || j.message || bodyText;
    }
  } catch(e) { errMsg = bodyText; }
  errMsg = String(errMsg || '').trim();
  const upstreamDown = _isOpenCodeUpstreamError(status, bodyText);
  let hint = '';
  if (errType === 'FreeUsageLimitError') hint = ' — 免费额度限流，稍后再试 / 换个免费模型 / 填写 Zen API Key';
  else if (errType === 'RegionError') hint = ' — 该模型在当前区域不可用，请换模型';
  else if (errType === 'AuthError') hint = ' — 该模型需要 API Key（付费模型），或 Key 无效';
  else if (upstreamDown) hint = ' — 上游模型暂时不可用（OpenCode 将上游故障报为 HTTP ' + status + '）：稍后重发，或在 LLM 配置里换个免费模型';
  else if (status === 502) hint = ' — 代理无法连接 opencode.ai（网络/DNS/TLS）';
  else if (status === 404) hint = ' — 端点不存在，检查 API 类型';
  else if (status === 400) hint = ' — 请求格式错误（模型名或参数不兼容）';
  if (!errMsg) errMsg = '(上游未返回错误详情)';
  return `HTTP ${status} ${errType ? '[' + errType + '] ' : ''}${errMsg.slice(0, 200)}${hint}`;
}

// ═══ [FIX 2026-09-05] 免费模型自动 failover 池 ═══
// 某个免费模型的上游挂掉（假 400 server_error / 5xx）时，引擎按此顺序
// 逐个尝试其余免费模型（全部走 /chat/completions，匿名可用）。
// 与静态目录 OPENCODE_MODELS['openai-completion'] 保持同步。
const OC_FAILOVER_POOL = [
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'ling-3.0-flash-fin-free',
  'mimo-v2.5-free'
];

// 挂到 window — 内联 onchange 处理器在全局作用域查找函数
if (typeof window !== 'undefined') {
  window.OPENCODE_BASE_URL = OPENCODE_BASE_URL;
  window.OPENCODE_MODELS = OPENCODE_MODELS;
  window.updateOpenCodeModelOptions = updateOpenCodeModelOptions;
  window.updateOpenCodeCustomModelUI = updateOpenCodeCustomModelUI;
  window.fetchOpenCodeModels = fetchOpenCodeModels; // [2026-09-03] 供控制台调试
  window._ocApiTypeForModel = _ocApiTypeForModel;   // [2026-09-03d] 供控制台调试
  window._isOpenCodeUpstreamError = _isOpenCodeUpstreamError; // [FIX 2026-09-05] 供控制台调试
}

export default {
  OPENCODE_BASE_URL, OPENCODE_MODELS,
  OC_FAILOVER_POOL,          // [FIX 2026-09-05] 免费模型 failover 顺序
  updateOpenCodeModelOptions, updateOpenCodeCustomModelUI,
  collectOpenCodeConfig, testOpenCodeConnection,
  fetchOpenCodeModels,
  _ocAllModels, _ocApiTypeForModel,
  _isOpenCodeUpstreamError,  // [FIX 2026-09-05] 上游故障（假 400/5xx）识别
  _responsesOutputText, _opencodeErrorHint
};
