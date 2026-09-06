/* ═══════════════ agent/agent-workflow.js ═══════════════
   工作流引擎 — 参考 teambot core/workflow_engine.py
   功能：CRUD + 步骤执行 + 模板变量 + 定时触发
   ═══════════════════════════════════════════════════════ */

const AgentWorkflow = {
  // ─── CRUD ───
  async list(agentId) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const workflows = await AgentStorage.getFromKV(`workflows_${agentId}`) || [];
    return workflows;
  },

  async get(agentId, workflowId) {
    const list = await this.list(agentId);
    return list.find(w => w.id === workflowId) || null;
  },

  async create(agentId, data) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const list = await this.list(agentId);
    const wf = {
      id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: data.name || 'Untitled Workflow',
      description: data.description || '',
      steps: data.steps || [],
      variables: data.variables || {},
      enabled: data.enabled !== false,
      schedule: data.schedule || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_status: '',
      last_run_at: null,
      run_count: 0,
      agent_id: agentId
    };
    list.push(wf);
    await AgentStorage.saveToKV(`workflows_${agentId}`, list);
    return wf;
  },

  async update(agentId, workflowId, updates) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const list = await this.list(agentId);
    const idx = list.findIndex(w => w.id === workflowId);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...updates, updated_at: new Date().toISOString() };
    await AgentStorage.saveToKV(`workflows_${agentId}`, list);
    return list[idx];
  },

  async delete(agentId, workflowId) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const list = await this.list(agentId);
    const filtered = list.filter(w => w.id !== workflowId);
    await AgentStorage.saveToKV(`workflows_${agentId}`, filtered);
    return true;
  },

  // ─── 执行 ───
  async run(agentId, workflowId, options = {}) {
    const wf = await this.get(agentId, workflowId);
    if (!wf) return { success: false, error: 'Workflow not found' };
    if (!wf.enabled) return { success: false, error: 'Workflow is disabled' };

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const run = {
      id: runId, workflow_id: workflowId, workflow_name: wf.name,
      status: 'running', started_at: new Date().toISOString(),
      steps: [], agent_id: agentId
    };

    // 构建执行上下文
    const context = {
      steps: {},
      variables: { ...wf.variables },
      secrets: {}, // TODO: 从配置加载
      agentid: agentId,
      now: () => new Date().toISOString()
    };

    // 执行步骤
    for (let i = 0; i < wf.steps.length; i++) {
      const step = { ...wf.steps[i], id: i + 1 };
      const stepResult = await this._executeStep(step, context, agentId);
      run.steps.push({ id: step.id, name: step.name || `Step ${i+1}`, type: step.type, ...stepResult });

      // 存到 context 供后续步骤引用
      context.steps[i + 1] = stepResult;

      if (stepResult.status === 'failed' && !step.continue_on_error) {
        run.status = 'failed';
        run.error = `Step ${i+1} failed: ${stepResult.error}`;
        break;
      }

      // condition 步骤：如果条件为 false 且有 on_false 跳转
      if (step.type === 'condition' && stepResult.result === false) {
        const onFalse = step.params?.on_false;
        if (onFalse === 'skip_remaining') { run.status = 'success'; break; }
        if (typeof onFalse === 'number' && onFalse > 0 && onFalse <= wf.steps.length) {
          i = onFalse - 2; // 跳转到指定步骤 (-2 因为循环会 +1)
        }
      }
    }

    if (run.status !== 'failed') run.status = 'success';
    run.completed_at = new Date().toISOString();

    // 保存运行记录
    await this._saveRun(agentId, run);

    // 更新工作流状态
    await this.update(agentId, workflowId, {
      last_status: run.status,
      last_run_at: run.completed_at,
      run_count: (wf.run_count || 0) + 1
    });

    return { success: run.status === 'success', run };
  },

  async _saveRun(agentId, run) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const runs = await AgentStorage.getFromKV(`workflow_runs_${agentId}`) || [];
    runs.unshift(run);
    if (runs.length > 50) runs.length = 50; // 保留最近50条
    await AgentStorage.saveToKV(`workflow_runs_${agentId}`, runs);
  },

  async listRuns(agentId, workflowId, limit = 20) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const runs = await AgentStorage.getFromKV(`workflow_runs_${agentId}`) || [];
    let filtered = workflowId ? runs.filter(r => r.workflow_id === workflowId) : runs;
    return filtered.slice(0, limit);
  },

  // ─── 步骤执行 ───
  async _executeStep(step, context, agentId) {
    const params = this._renderParams(step.params || {}, context);
    const stepType = step.type;

    try {
      let result;
      switch (stepType) {
        case 'delay': result = await this._stepDelay(params); break;
        case 'api_call': result = await this._stepApiCall(params); break;
        case 'condition': result = this._stepCondition(params, context); break;
        case 'skill': result = await this._stepSkill(params, context, agentId); break;
        case 'code': result = await this._stepCode(params, context, agentId); break;
        case 'llm': result = await this._stepLLM(params, context, agentId); break;
        case 'web_search': result = await this._stepWebSearch(params, agentId); break;
        case 'web_read': result = await this._stepWebRead(params, agentId); break;
        case 'send_message': result = await this._stepSendMessage(params, context, agentId); break;
        case 'email': result = await this._stepEmail(params, agentId); break;
        case 'set_variable': result = this._stepSetVariable(params, context); break;
        case 'transform': result = this._stepTransform(params, context); break;
        default: return { status: 'failed', result: null, error: `Unknown step type: ${stepType}` };
      }
      return { status: 'success', result, error: null };
    } catch(e) {
      return { status: 'failed', result: null, error: e.message };
    }
  },

  // ─── 步骤类型实现 ───

  // [FIX 2026-09-04] 主人 JWT：S 是顶层 let 声明（不在 window 上），
  // 之前用 window.S?.accessToken 拿到的永远是 undefined → 代理调用 401 假成功/失败
  _ownerToken() {
    if (typeof S !== 'undefined' && S?.accessToken) return S.accessToken;
    return window.S?.accessToken || '';
  },

  async _stepDelay(params) {
    const seconds = parseFloat(params.seconds || 1);
    await new Promise(r => setTimeout(r, seconds * 1000));
    return `Delayed ${seconds}s`;
  },

  async _stepApiCall(params) {
    const token = this._ownerToken();
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        url: params.url, mode: 'raw',
        method: params.method || 'GET',
        headers: params.headers || {},
        body: params.body || ''
      })
    });
    const data = await resp.json().catch(() => ({}));
    // [FIX 2026-09-04] 检查代理层错误（403 SSRF 拦截 / 502 上游失败等），正确标记 failed
    if (!resp.ok) {
      throw new Error(`web-proxy HTTP ${resp.status}${data?.error ? ': ' + (data.error.message || data.error) : ''}`);
    }
    // 上游响应可能被代理包成 {status, body, error} 结构
    if (data?.error) {
      throw new Error(`upstream error: ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error)}`);
    }
    if (typeof data?.status === 'number' && data.status >= 400) {
      throw new Error(`upstream HTTP ${data.status}`);
    }
    return data.body || '';
  },

  _stepCondition(params, context) {
    const expr = params.expression || 'true';
    try {
      // 安全 eval：用 Function 构造器
      const fn = new Function('steps', 'variables', 'secrets', `return (${expr})`);
      const result = fn(context.steps, context.variables, context.secrets);
      return result;
    } catch(e) {
      return false;
    }
  },

  async _stepSkill(params, context, agentId) {
    // 调用 agent 的工具
    const skillName = params.name;
    if (!skillName) throw new Error('skill step requires "name" parameter');

    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const config = await AgentStorage.getConfig(agentId);
    if (!config) throw new Error('Agent config not found');

    // 检查工具是否启用
    if (!config.tools?.includes(skillName)) {
      throw new Error(`Skill "${skillName}" is not enabled for this agent`);
    }

    const skillArgs = { ...params };
    delete skillArgs.name;
    const ctx = { agentId, sessionId: `wf_${context.workflow_id || ''}`, ws: window.AgentEngine?._agentWS?.[agentId], agentConfig: config };

    // 调用原生工具或 WASM 工具
    const AgentTools = (await import('/static/agent/agent-tools.js')).default;
    const category = AgentTools._getCategory(skillName);

    if (category === 'wasm') {
      const { AgentToolsWasm } = await import('/static/agent/agent-tools-wasm.js');
      return await AgentToolsWasm.execute(skillName, skillArgs, ctx);
    } else {
      const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js');
      return await AgentToolsNative.execute(skillName, skillArgs, ctx);
    }
  },

  async _stepCode(params, context, agentId) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const config = await AgentStorage.getConfig(agentId);
    const sandboxType = config?.sandbox_type || 'javascript';

    const args = { language: params.language || sandboxType, code: params.code || '' };
    const ctx = { agentId, sessionId: 'workflow', ws: window.AgentEngine?._agentWS?.[agentId], agentConfig: config };

    if (sandboxType === 'python') {
      const { AgentSandboxPython } = await import('/static/agent/agent-sandbox-python.js');
      return await AgentSandboxPython.execute(args, ctx);
    } else {
      const { AgentSandboxJS } = await import('/static/agent/agent-sandbox-js.js');
      return await AgentSandboxJS.execute(args, ctx);
    }
  },

  async _stepLLM(params, context, agentId) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const config = await AgentStorage.getConfig(agentId);
    if (!config) throw new Error('Agent config not found');

    // 构建单次 LLM 调用
    const messages = [
      { role: 'system', content: params.system || 'You are a helpful assistant.' },
      { role: 'user', content: params.prompt || '' }
    ];

    // 使用引擎的 LLM 调用方法
    if (window.AgentEngine) {
      const result = await window.AgentEngine._callLLM(messages, [], '', config, 'workflow');
      return result.content || result.error || '';
    }
    throw new Error('AgentEngine not available');
  },

  async _stepWebSearch(params, agentId) {
    const token = this._ownerToken();
    const resp = await fetch('/api/v1/agent/search-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ query: params.query, engine: params.engine || '' })
    });
    if (!resp.ok) {
      // [FIX 2026-09-04] 代理返回错误时抛错，让步骤正确标记为 failed
      let msg = `search-proxy HTTP ${resp.status}`;
      try { const j = await resp.json(); if (j?.error) msg += `: ${j.error.message || j.error}`; } catch(e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    // [FIX 2026-09-04] 将结构化结果格式化为可读文本，供后续 LLM/消息步骤直接使用
    if (data && Array.isArray(data.results) && data.results.length > 0) {
      return data.results.map((r, i) =>
        `${i + 1}. ${r.title || ''}\n   URL: ${r.url || ''}\n   摘要: ${r.snippet || r.summary || r.description || ''}`
      ).join('\n\n');
    }
    // 兜底：非标准结构时保留 JSON 序列化输出（不再是 [object Object]）
    return (typeof data === 'object' && data !== null)
      ? (this._stringifyValue(data).slice(0, 4000) || '')
      : String(data ?? '');
  },

  async _stepWebRead(params, agentId) {
    const token2 = this._ownerToken();
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token2 },
      body: JSON.stringify({ url: params.url, mode: 'html' })
    });
    const data = await resp.json();
    return data.body || '';
  },

  async _stepSendMessage(params, context, agentId) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const config = await AgentStorage.getConfig(agentId);
    // [FIX 2026-09-04] 缺省目标从"agent 自己"（会被引擎忽略，消息黑洞）改为"主人账号"；
    // 两者都拿不到时明确报错，而不是静默发给自己
    const target = params.target_id || config?.owner_id || '';
    if (!target) {
      throw new Error('send_message 步骤缺少 target_id 参数（且 agent 配置中无 owner_id），无法确定接收者');
    }
    if (target === agentId) {
      throw new Error('send_message 目标不能是 agent 自己（消息会被引擎忽略），请在 target_id 中填写接收者账号 ID');
    }
    const ws = window.AgentEngine?._agentWS?.[agentId];
    if (!ws || ws.readyState !== 1) throw new Error('Agent WS not connected');
    ws.send(JSON.stringify({
      type: 'message', to: target,
      content: params.content, content_type: 'text'
    }));
    return `Message sent to ${target}`;
  },

  async _stepEmail(params, agentId) {
    const { AgentToolsNative } = await import('/static/agent/agent-tools-native.js');
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const config = await AgentStorage.getConfig(agentId);
    const result = await AgentToolsNative.send_email(params, { agentId, agentConfig: config });
    // [FIX 2026-09-04] send_email 返回 {success:false, error} 时抛错，让步骤正确标记 failed
    if (result && typeof result === 'object' && result.success === false) {
      throw new Error(result.error || 'send_email failed');
    }
    return result;
  },

  _stepSetVariable(params, context) {
    const varName = params.name;
    const varValue = params.value;
    if (varName) {
      context.variables[varName] = varValue;
      return `Set ${varName} = ${JSON.stringify(varValue)}`;
    }
    return 'No variable name';
  },

  _stepTransform(params, context) {
    // 数据转换：JSON path / filter / map / format
    const input = params.input;
    const operation = params.operation || 'identity';
    let result = input;
    if (operation === 'json_extract') {
      try { result = JSON.parse(input); for (const key of (params.path || '').split('.')) result = result?.[key]; } catch(e) {}
    } else if (operation === 'split') {
      result = String(input).split(params.delimiter || ',');
    } else if (operation === 'join') {
      result = Array.isArray(input) ? input.join(params.delimiter || ',') : String(input);
    } else if (operation === 'replace') {
      result = String(input).split(params.from || '').join(params.to || '');
    } else if (operation === 'uppercase') {
      result = String(input).toUpperCase();
    } else if (operation === 'lowercase') {
      result = String(input).toLowerCase();
    }
    return result;
  },

  // ─── 模板变量渲染 ───
  _renderParams(params, context) {
    const rendered = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (typeof value === 'string') {
        rendered[key] = this._renderTemplate(value, context);
      } else {
        rendered[key] = value;
      }
    }
    return rendered;
  },

  _renderTemplate(text, context) {
    return text.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
      expr = expr.trim();
      // {{steps.N.result}}
      const stepMatch = expr.match(/^steps\.(\d+)\.(result|error|status)$/);
      if (stepMatch) {
        const step = context.steps[parseInt(stepMatch[1])];
        if (!step) return '';
        // [FIX 2026-09-04] 对象/数组结果序列化为 JSON，避免渲染成 "[object Object]"
        return this._stringifyValue(step[stepMatch[2]]);
      }
      // {{variables.xxx}}
      const varMatch = expr.match(/^variables\.(\w+)$/);
      if (varMatch) return this._stringifyValue(context.variables[varMatch[1]] ?? '');
      // {{secrets.xxx}}
      const secretMatch = expr.match(/^secrets\.(\w+)$/);
      if (secretMatch) return this._stringifyValue(context.secrets?.[secretMatch[1]] ?? '');
      // {{agentid}}
      if (expr === 'agentid') return String(context.agentid || '');
      // {{now}}
      if (expr === 'now') return new Date().toISOString();
      return match; // 未匹配，保留原样
    });
  },

  // [FIX 2026-09-04] 统一结果字符串化：对象/数组 → JSON，其余 String()
  _stringifyValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v, null, 2); } catch(e) { return String(v); }
    }
    return String(v);
  },

  // ═══ [FIX 2026-09-04] 定时触发调度器 ═══
  // 之前 UI 可配置 schedule（interval::秒 / daily:HH:MM）但没有任何调度器执行它，是死功能。
  // 现由前端页面内轮询触发：页面打开期间每 60s 检查一次（浏览器关闭即停止，无服务端执行）。
  _schedulerAgents: new Set(),
  _schedulerTimer: null,

  startScheduler(agentId) {
    if (!agentId) return;
    this._schedulerAgents.add(agentId);
    if (this._schedulerTimer) return; // 已有全局 tick，登记即可
    this._schedulerTimer = setInterval(() => this._schedulerTick(), 60 * 1000);
    console.log('[AgentWorkflow] Scheduler started (agents: ' + [...this._schedulerAgents].join(',') + ')');
  },

  async _schedulerTick() {
    for (const agentId of this._schedulerAgents) {
      try {
        const workflows = await this.list(agentId);
        const now = Date.now();
        for (const wf of workflows) {
          if (!wf.enabled || !wf.schedule) continue;
          // 防止上一次调度运行尚未结束时重复触发
          if (this._schedRunning && this._schedRunning.has(wf.id)) continue;
          if (wf.schedule.startsWith('interval::')) {
            const seconds = parseInt(wf.schedule.split('::')[1]) || 0;
            if (seconds < 60) continue; // 最小间隔 60s，防止误配置打爆
            const last = wf._sched_last_run || 0;
            if (now - last < seconds * 1000) continue;
            this._runScheduled(agentId, wf.id);
          } else if (wf.schedule.startsWith('daily:')) {
            const hhmm = wf.schedule.split(':')[1] || '';
            const today = new Date().toISOString().slice(0, 10);
            const nowHHMM = new Date().toTimeString().slice(0, 5);
            if (hhmm !== nowHHMM) continue;
            if (wf._sched_last_date === today) continue; // 今天已触发
            this._runScheduled(agentId, wf.id, today);
          }
        }
      } catch(e) {
        console.warn('[AgentWorkflow] Scheduler tick error for', agentId, e);
      }
    }
  },

  async _runScheduled(agentId, workflowId, today) {
    if (!this._schedRunning) this._schedRunning = new Set();
    this._schedRunning.add(workflowId);
    try {
      // 先写标记再运行：即使页面中途刷新也不会在同一分钟内重复触发
      const marker = today ? { _sched_last_date: today } : { _sched_last_run: Date.now() };
      await this.update(agentId, workflowId, marker);
      console.log('[AgentWorkflow] Scheduled run:', workflowId);
      await this.run(agentId, workflowId);
    } catch(e) {
      console.warn('[AgentWorkflow] Scheduled run failed:', workflowId, e);
    } finally {
      this._schedRunning.delete(workflowId);
    }
  },

  // ─── 支持的步骤类型列表（供 UI 使用）───
  STEP_TYPES: [
    { type: 'skill', name: '调用 Skill', desc: '调用 agent 的已注册工具（web-search, exec-code 等）', requiredParams: ['name'] },
    { type: 'code', name: '执行代码', desc: '在 WASM 沙箱中执行代码', requiredParams: ['code'] },
    { type: 'llm', name: '调用 LLM', desc: '调用 LLM 生成文本（分析、总结、翻译等）', requiredParams: ['prompt'] },
    { type: 'api_call', name: 'HTTP 请求', desc: '发送 HTTP 请求到指定 URL', requiredParams: ['url'] },
    { type: 'web_search', name: '网页搜索', desc: '搜索引擎查询', requiredParams: ['query'] },
    { type: 'web_read', name: '读取网页', desc: '抓取网页正文内容', requiredParams: ['url'] },
    { type: 'condition', name: '条件判断', desc: '根据条件表达式决定执行路径', requiredParams: ['expression'] },
    { type: 'delay', name: '延时等待', desc: '等待指定秒数', requiredParams: ['seconds'] },
    { type: 'send_message', name: '发送消息', desc: '通过 AICQ 发送消息', requiredParams: ['content'] },
    { type: 'email', name: '发送邮件', desc: '通过 SMTP API 发送邮件', requiredParams: ['to', 'subject', 'body'] },
    { type: 'set_variable', name: '设置变量', desc: '设置工作流变量', requiredParams: ['name', 'value'] },
    { type: 'transform', name: '数据转换', desc: 'JSON 提取、分割、替换等数据转换', requiredParams: ['input', 'operation'] },
  ]
};

if (typeof window !== 'undefined') window.AgentWorkflow = AgentWorkflow;

export { AgentWorkflow };
export default AgentWorkflow;
