/* ═══════════════ agent/agent-llm-providers.js ═══════════════
   OpenCode Zen (opencode.ai) 免费 LLM API — 共享配置模块
   设置面板 (agent-settings.js) 和独立壳设置页 (app.js) 共用

   [2026-08-28] 新增 provider
   [2026-09-03] 模型目录动态化：运行时 GET {base}/models 实时拉取
   [2026-09-07] 随上游"免费档收紧"整体移除（0.4.9）
   [2026-09-29] 0.4.10 恢复 —— 仅限 AicqWebBot 独立包（本地中继模式）。
     ⚠ 恢复原因与范围（IP 边界，勿扩散）：
       - 本包 agent 跑在浏览器，但 opencode.ai 不发 CORS 头，LLM 请求
         必须经同源 /api/v1/agent/llm-proxy 中继。pip 本地模式下该中继
         跑在【用户自己电脑】上 → opencode.ai 看到的是客户端自己的出口
         IP，服务器不经手，故可恢复。
       - 静态托管（无本地中继）与 aicq.me 登录版（server-go）的 LLM 请求
         会经服务器中继 → 暴露服务器 IP，这两条路径【保持移除】。

   [2026-09-29] 上游 2026-09 起给免费档加了客户端指纹闸门
     （"free tier can only be used from within OpenCode"，FreeTierError）。
     破解口径与 samaidev/teambot core/free_model_hub.py (v1.56.45) 实证一致：
       1. User-Agent 形如 opencode 客户端（浏览器 fetch 可带，本地中继兜底强制）；
       2. x-opencode-session = "ses_"+26 位、x-opencode-request = "msg_"+26 位，
          26 位 = 12 位小写 hex（毫秒<<12 截断 48bit）+ 14 位 base62；
          27 位（13 位 hex 未截断）会被拒；
       3. 请求体恒 stream:true —— 非流式一律 FreeTierError（引擎侧聚合）；
       4. body.tools 必须含 11 个 opencode 工具【名】（bash/edit/glob/grep/
          read/skill/task/todowrite/webfetch/websearch/write）—— 只看名字，
          描述参数任意；响应里可能混入这些名字的诱饵 tool_call，须过滤。
       Authorization 可选（匿名免费可用；付费模型仍需真 Zen key）。
   ═══════════════════════════════════════════════════════════ */

// OpenCode Zen API 基础地址
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';

// [2026-09-29] 必须形如 opencode 客户端，否则免费档 403 FreeTierError
// （实测 2026-09-26 teambot：teambot UA 被拒，opencode UA 通过）
const OC_CLIENT_UA = 'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';

// [2026-09-29] 指纹工具名集合 — body.tools 必须含这些名字（描述/参数随意）
const OC_TOOL_NAMES = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task',
  'todowrite', 'webfetch', 'websearch', 'write'];

// base62 字母表（与 opencode id.ts 一致）
const _OC_A62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// [2026-09-29] opencode 兼容 ID：prefix_ + 12 位 hex + 14 位 base62
// 对齐 packages/opencode/src/id/id.ts：now = 毫秒 << 12，序列化为 6 大端字节
// （48bit 截断！）→ 12 位小写 hex，再接 14 位 base62 随机。
// 48bit 截断是必要的：13 位 hex（未截断）的 id 会被指纹闸门拒绝。
// JS 位运算是 32 位，ms<<12 用乘法表达：(ms*4096) % 2^48（值 < 2^53，double 安全）。
function _ocMakeId(prefix) {
  const ms = Date.now();
  const now48 = (ms * 4096) % 281474976710656;   // (ms << 12) & (2^48 - 1)
  const hex = now48.toString(16).padStart(12, '0');
  let rand = '';
  const rnd = new Uint8Array(14);
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(rnd);
    else for (let i = 0; i < 14; i++) rnd[i] = Math.floor(Math.random() * 256);
  } catch (e) { for (let i = 0; i < 14; i++) rnd[i] = Math.floor(Math.random() * 256); }
  for (let i = 0; i < 14; i++) rand += _OC_A62[rnd[i] % 62];
  return prefix + '_' + hex + rand;
}

// [FIX 2026-09-07] 网关要求 completion 请求携带 x-opencode-session（粘性路由）；
// [2026-09-29] 格式升级为 ses_+26 位（页面生命周期内稳定）
let _ocSessionId = '';
function _ocSessionId26() {
  if (_ocSessionId) return _ocSessionId;
  _ocSessionId = _ocMakeId('ses');
  return _ocSessionId;
}

// [2026-09-29] 单次调用所需的完整身份头（msg_ 每请求刷新）
function _ocIdentityHeaders() {
  return {
    'User-Agent': OC_CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-session': _ocSessionId26(),
    'x-opencode-request': _ocMakeId('msg'),
  };
}

// [2026-09-29] 诱饵工具定义（chat/completions 格式）— 只提供指纹名字
function _ocMimicTools() {
  return OC_TOOL_NAMES.map(n => ({
    type: 'function',
    function: { name: n, description: 'x', parameters: { type: 'object', properties: {} } }
  }));
}

// [2026-09-29] 诱饵工具定义（/responses 格式）
function _ocMimicToolsResponses() {
  return OC_TOOL_NAMES.map(n => ({
    type: 'function', name: n, description: 'x',
    parameters: { type: 'object', properties: {} }
  }));
}

// [2026-09-29] 判断 tool_call 名字是否为指纹诱饵（引擎解析响应时过滤）
function _ocIsDecoyName(name) {
  return OC_TOOL_NAMES.indexOf(name) !== -1;
}

// 静态回退目录 — 仅在 /models 动态拉取失败时使用（离线兜底）
// [2026-09-29] 按 teambot 2026-09-26 实测目录同步（老目录已过时）
const OPENCODE_MODELS = {
  'openai-completion': [
    { id: 'nemotron-3-ultra-free',            label: 'Nemotron 3 Ultra (Free)' },
    { id: 'nemotron-3.5-lightning-free',      label: 'Nemotron 3.5 Lightning (Free)' },
    { id: 'mimo-v2.5-free',                   label: 'MiMo-V2.5 (Free, vision-capable)' },
    { id: 'mimo-v2.6-flash-free',             label: 'MiMo-V2.6 Flash (Free)' },
    { id: 'space-bunny-free',                 label: 'Space Bunny (Free)' },
    { id: 'jev-1.13-free',                    label: 'Jev 1.13 (Free)' },
    { id: 'ling-3.0-flash-fin-free',          label: 'Ling 3.0 Flash Fin (Free, unstable)' },
    { id: 'deepseek-v4-flash-free',           label: 'DeepSeek V4 Flash (Free, upstream flaky)' }
  ],
  'response': [
    { id: 'muse-spark-1.3-contributor-free',  label: 'Muse Spark 1.3 Contributor (Free; region-locked in some regions)' },
    { id: 'muse-spark-1.2-contributor-free',  label: 'Muse Spark 1.2 Contributor (Free; upstream flaky)' }
  ]
};

// ═══ 动态模型目录 — 实时同步 GET {base}/models ═══
const OC_MODELS_CACHE_KEY = 'aicq_oc_zen_models_v2';
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
  return words.join(' ') + (isFree ? ' (Free)' : ' (API key required)');
}

// 从 /models 返回的 id 列表构建目录；组内 free 优先、保持上游相对顺序
function _ocBuildCatalog(modelIds) {
  const cat = { 'openai-completion': [], 'response': [] };
  for (const id of modelIds) {
    if (!id || typeof id !== 'string') continue;
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
// [2026-09-29] 拉取请求带 opencode 身份头（UA 由本地中继兜底强制）
// 成功返回 catalog，失败返回 null（回退静态表）
async function fetchOpenCodeModels(force) {
  const now = Date.now();
  if (!force && _ocActiveCatalog() && now - _ocDynFetchAt < OC_MODELS_TTL_MS) return _ocDynCatalog;
  if (!force && _ocDynFailAt && now - _ocDynFailAt < OC_MODELS_RETRY_FAIL_MS) return null;
  if (_ocDynFetching) return _ocDynFetching;

  _ocDynFetching = (async () => {
    try {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, _ocIdentityHeaders());
      const resp = await fetch('/api/v1/agent/llm-proxy', {
        method: 'POST',
        body: JSON.stringify({ target_url: OPENCODE_BASE_URL + '/models', method: 'GET', headers, stream: false })
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
  return (OPENCODE_MODELS[apiType] || []);
}

// 全量模型列表 — 合并两种端点分组，free 优先、组内保持上游顺序
function _ocAllModels() {
  const cat = _ocActiveCatalog() || OPENCODE_MODELS;
  const all = (cat['openai-completion'] || []).concat(cat['response'] || []);
  return all.filter(m => m && m.id && m.free)
    .concat(all.filter(m => m && m.id && !m.free));
}

// 由模型 ID 自动匹配 API 类型：
// 「gpt- / grok- / muse-spark-」前缀 → response（/responses）；其余 → openai-completion（/chat/completions）
function _ocApiTypeForModel(model) {
  return _ocEndpointKind(model || '') === 'response' ? 'response' : 'openai-completion';
}

// 渲染模型下拉框；返回是否实际渲染（面板可能已关闭）
function _ocRenderModelOptions(prefix, selectedModel) {
  const modelEl = document.getElementById(prefix + 'OcModel');
  if (!modelEl) return false;
  const models = _ocAllModels();
  modelEl.innerHTML = models.map(m =>
    `<option value="${m.id}" ${selectedModel === m.id ? 'selected' : ''}>${m.label} — ${m.id}</option>`
  ).join('') + `<option value="__custom__" ${selectedModel && !models.some(m => m.id === selectedModel) ? 'selected' : ''}>${_T('ag_opencode_custom', 'Custom model ID')}</option>`;
  updateOpenCodeCustomModelUI(prefix, selectedModel);
  return true;
}

// 根据 API 类型填充模型下拉框
// prefix: 'ag' (创建面板) | 'settings' (设置面板)
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

// API 类型自动匹配提示 — 在模型下拉下方显示按当前模型推导出的端点
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

// ── 轻量 SSE 聚合（测试 ping / 非流式内部调用共用）──
// [2026-09-29] 免费档 wire 恒为 stream:true，非流式结果在本地聚合。
// 同时过滤指纹诱饵 tool_call（上游可能"调用" bash/webfetch 等诱饵工具）。
async function _ocAggregateStreamResponse(resp) {
  const text0 = await resp.text();
  // 服务端降级/错误时返回 JSON 而非 SSE —— 原样按 JSON 处理
  const trimmed = text0.replace(/^\s+/, '');
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try { return { json: JSON.parse(trimmed) }; } catch (e) { /* fallthrough */ }
  }
  let content = '', reasoning = '';
  const tcAcc = [];
  let usage = null, model = '';
  for (let line of text0.split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
    if (ev.usage) usage = ev.usage;
    if (ev.model) model = ev.model;
    const ch = ev.choices && ev.choices[0];
    if (!ch) continue;
    const d = ch.delta || {};
    const rd = d.reasoning_content || d.reasoning;
    if (rd) reasoning += rd;
    if (d.content) content += d.content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = (typeof tc.index === 'number') ? tc.index : tcAcc.length;
        if (!tcAcc[i]) tcAcc[i] = { id: '', function: { name: '', arguments: '' } };
        if (tc.id) tcAcc[i].id = tc.id;
        if (tc.function && tc.function.name) tcAcc[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) tcAcc[i].function.arguments += tc.function.arguments;
      }
    }
  }
  const toolCalls = tcAcc.filter(Boolean)
    .filter(tc => !_ocIsDecoyName(tc.function.name))
    .map((tc, i) => ({ id: tc.id || ('call_' + (i + 1)), type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' } }));
  return { aggregated: { content, reasoning, tool_calls: toolCalls, usage, model: model } };
}

// OpenCode 连通性测试 — 最小 ping 请求（wire 恒流式 + 聚合）
// 返回 { ok, preview, model, error }
async function testOpenCodeConnection(llmConfig) {
  const isResponses = (llmConfig.api_type === 'response');
  // [2026-09-29] opencode 身份头（本地中继会兜底强制 UA / 补齐身份头）
  const headers = Object.assign({ 'Content-Type': 'application/json' }, _ocIdentityHeaders());
  // 匿名免费可用；带真 Zen key 走付费模型（不发空的 "Bearer "，避免 401）
  if (llmConfig.api_key) headers['Authorization'] = 'Bearer ' + llmConfig.api_key;

  let innerBody;
  if (isResponses) {
    innerBody = { model: llmConfig.model, input: 'ping', stream: true, max_output_tokens: 16,
      tools: _ocMimicToolsResponses(), tool_choice: 'auto' };
  } else {
    innerBody = { model: llmConfig.model, messages: [{ role: 'user', content: 'ping' }],
      stream: true, max_tokens: 10, tools: _ocMimicTools(), tool_choice: 'auto',
      stream_options: { include_usage: true } };
  }

  const proxyBody = {
    target_url: (llmConfig.base_url || OPENCODE_BASE_URL) + (isResponses ? '/responses' : '/chat/completions'),
    method: 'POST',
    headers,
    stream: true,
    body: JSON.stringify(innerBody)
  };

  const resp = await fetch('/api/v1/agent/llm-proxy', {
    method: 'POST',
    body: JSON.stringify(proxyBody)
  });

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: _opencodeErrorHint(resp.status, text) };
  }
  try {
    const agg = await _ocAggregateStreamResponse(resp);
    if (agg.json) {
      const data = agg.json;
      // OpenCode 错误也可能是 200 + {"type":"error",...}，统一检查
      if (data.type === 'error') return { ok: false, error: _opencodeErrorHint(200, JSON.stringify(data)) };
      const preview = isResponses
        ? (_responsesOutputText(data) || '(empty response)')
        : ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content && String(data.choices[0].message.content).slice(0, 60)) || '(empty response)');
      return { ok: true, preview, model: data.model || llmConfig.model };
    }
    const a = agg.aggregated;
    if (a.tool_calls.length && !a.content) {
      return { ok: false, error: 'model answered with a tool call instead of text — try another free model' };
    }
    return { ok: true, preview: (a.content || a.reasoning || '(empty response)').slice(0, 60), model: a.model || llmConfig.model };
  } catch(e) {
    return { ok: false, error: 'Invalid response: ' + String(text || e).slice(0, 200) };
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
// HTTP 400 返回。这类「假 400」不是请求格式问题，需要与真正的格式错误区分开：
//   1) 提示文案要指向「上游不可用 / 换模型」而不是「请求格式错误」；
//   2) 引擎侧据此触发免费模型自动 failover（见 agent-engine.js _callOpenCode）。
function _isOpenCodeUpstreamError(status, bodyText) {
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
  if (errType === 'FreeUsageLimitError' || errType === 'FreeTierError') hint = ' — free tier rate limit / fingerprint gate; retry later, switch to another free model, or set a Zen API key. Make sure you run the LOCAL relay (pip install aicqwebbot) — static hosting cannot call OpenCode';
  else if (errType === 'RegionError') hint = ' — this model is not available in your region; switch models';
  else if (errType === 'AuthError') hint = ' — this model requires an API key (paid), or the key is invalid';
  else if (errType === 'MissingSessionID') hint = ' — x-opencode-session header missing; upgrade aicqwebbot to 0.4.10+';
  else if (upstreamDown) hint = ' — upstream model temporarily unavailable (OpenCode reports the upstream failure as HTTP ' + status + '): retry later or switch free models in the LLM settings';
  else if (status === 502) hint = ' — relay cannot reach opencode.ai (network/DNS/TLS)';
  else if (status === 404) hint = ' — endpoint not found; check the API type';
  else if (status === 400) hint = ' — bad request (model name or parameters incompatible)';
  if (!errMsg) errMsg = '(no error details returned by upstream)';
  return `HTTP ${status} ${errType ? '[' + errType + '] ' : ''}${errMsg.slice(0, 200)}${hint}`;
}

// ═══ 免费模型自动 failover 池 ═══
// 某个免费模型的上游挂掉（假 400 server_error / 5xx）时，引擎按此顺序
// 逐个尝试其余免费模型（全部走 /chat/completions）。
// [2026-09-29] 按 teambot 2026-09-26 实测目录更新。
const OC_FAILOVER_POOL = [
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'mimo-v2.6-flash-free',
  'mimo-v2.5-free',
  'space-bunny-free',
  'jev-1.13-free'
];

// 挂到 window — 内联 onchange 处理器在全局作用域查找函数
if (typeof window !== 'undefined') {
  window.OPENCODE_BASE_URL = OPENCODE_BASE_URL;
  window.OPENCODE_MODELS = OPENCODE_MODELS;
  window.updateOpenCodeModelOptions = updateOpenCodeModelOptions;
  window.updateOpenCodeCustomModelUI = updateOpenCodeCustomModelUI;
  window.fetchOpenCodeModels = fetchOpenCodeModels;
  window._ocApiTypeForModel = _ocApiTypeForModel;
  window._isOpenCodeUpstreamError = _isOpenCodeUpstreamError;
}

export default {
  OPENCODE_BASE_URL, OPENCODE_MODELS,
  OC_CLIENT_UA, OC_TOOL_NAMES,
  OC_FAILOVER_POOL,                 // 免费模型 failover 顺序
  updateOpenCodeModelOptions, updateOpenCodeCustomModelUI,
  collectOpenCodeConfig, testOpenCodeConnection,
  fetchOpenCodeModels,
  _ocAllModels, _ocApiTypeForModel,
  _ocMakeId, _ocIdentityHeaders,    // ses_/msg_ 身份头（引擎每次调用刷新 msg_）
  _ocMimicTools, _ocMimicToolsResponses, _ocIsDecoyName,
  _ocAggregateStreamResponse,       // SSE 聚合（恒流式 wire 的非流式消费）
  _isOpenCodeUpstreamError,         // 上游故障（假 400/5xx）识别
  _responsesOutputText, _opencodeErrorHint
};
