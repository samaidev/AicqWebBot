/* ═══════════════ agent/agent-workflow-ui.js ═══════════════
   工作流管理页面 — 在 agent 头像下面点击进去
   功能：创建/编辑/删除/运行工作流，查看运行记录
   ═══════════════════════════════════════════════════════════ */

async function openWorkflowManager(agentId) {
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  const config = await AgentStorage.getConfig(agentId);
  if (!config) { toast('Agent not found', 'error'); return; }

  // 加载样式
  if (!document.getElementById('agent-styles')) {
    const link = document.createElement('link');
    link.id = 'agent-styles'; link.rel = 'stylesheet';
    link.href = '/static/agent/agent-styles.css';
    document.head.appendChild(link);
  }

  // 创建 modal
  let modal = document.getElementById('workflowModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'workflowModal';
  modal.className = 'modal-overlay open';
  modal.style.display = 'flex';
  document.body.appendChild(modal);

  await renderWorkflowList(agentId);
}

async function renderWorkflowList(agentId) {
  const modal = document.getElementById('workflowModal');
  if (!modal) return;
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  const workflows = await AgentWorkflow.list(agentId);
  // [FIX 2026-09-04] HTML 转义（工作流名可由 LLM 通过 workflow 工具创建）
  const _escH = (typeof esc === 'function') ? esc
    : (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  modal.innerHTML = `
    <div class="modal modal-wide" style="max-width:800px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>📋 工作流管理 — <span style="font-size:14px;color:var(--text-muted)">${workflows.length} 个工作流</span></h3>
        <div>
          <button class="btn-action" onclick="showWorkflowEditor('${agentId}',null)">+ 新建工作流</button>
          <button class="btn-secondary" onclick="document.getElementById('workflowModal').remove()">关闭</button>
        </div>
      </div>

      ${workflows.length === 0 ? `
        <div style="text-align:center;padding:40px;color:var(--text-muted)">
          <p>暂无工作流</p>
          <p style="font-size:13px;margin-top:8px">点击「新建工作流」创建你的第一个自动化工作流</p>
        </div>
      ` : `
        <div id="workflowList">
          ${workflows.map(wf => `
            <div class="workflow-item" style="padding:12px;border:1px solid var(--beige,#e0d0bc);border-radius:8px;margin-bottom:8px;background:#faf8f5">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                  <strong>${_escH(wf.name)}</strong>
                  ${wf.enabled ? '<span style="color:green;font-size:12px;margin-left:8px">● 启用</span>' : '<span style="color:gray;font-size:12px;margin-left:8px">○ 禁用</span>'}
                  <span style="font-size:11px;color:var(--text-muted);margin-left:8px">${wf.steps.length} 步 · 运行 ${wf.run_count||0} 次</span>
                </div>
                <div style="display:flex;gap:4px">
                  <button class="btn-action" style="padding:4px 12px;font-size:12px" onclick="runWorkflow('${agentId}','${wf.id}')">▶ 运行</button>
                  <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="showWorkflowEditor('${agentId}','${wf.id}')">✏ 编辑</button>
                  <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="showWorkflowRuns('${agentId}','${wf.id}')">📜 记录</button>
                  <button class="btn-secondary" style="padding:4px 12px;font-size:12px;color:red" onclick="deleteWorkflow('${agentId}','${wf.id}')">🗑</button>
                </div>
              </div>
              ${wf.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${_escH(wf.description)}</div>` : ''}
              ${wf.last_status ? `<div style="font-size:11px;margin-top:4px">上次: <span style="color:${wf.last_status==='success'?'green':'red'}">${wf.last_status}</span> · ${wf.last_run_at?.slice(0,19)||''}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

// ─── 工作流编辑器 ───
async function showWorkflowEditor(agentId, workflowId) {
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  const wf = workflowId ? await AgentWorkflow.get(agentId, workflowId) : null;
  const stepTypes = AgentWorkflow.STEP_TYPES;
  const AgentTools = (await import('/static/agent/agent-tools.js')).default;
  // [FIX 2026-09-04] HTML 转义
  const _escH = (typeof esc === 'function') ? esc
    : (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const modal = document.getElementById('workflowModal');
  modal.innerHTML = `
    <div class="modal modal-wide" style="max-width:800px;max-height:90vh;overflow-y:auto">
      <h3>${wf ? '编辑工作流' : '新建工作流'}</h3>

      <div class="form-group">
        <label>名称</label>
        <input type="text" id="wfName" value="${_escH(wf?.name || '')}" placeholder="每日新闻摘要">
      </div>
      <div class="form-group">
        <label>描述</label>
        <input type="text" id="wfDesc" value="${_escH(wf?.description || '')}" placeholder="搜索新闻 → 总结 → 发送">
      </div>

      <div class="form-group">
        <label>步骤</label>
        <div id="wfSteps" style="border:1px solid var(--beige,#e0d0bc);border-radius:8px;padding:8px;min-height:60px;background:#fff">
          ${(wf?.steps || []).map((s, i) => renderStepRow(i, s, stepTypes, AgentTools)).join('')}
          ${!wf?.steps?.length ? '<p style="color:var(--text-muted);text-align:center;padding:20px">点击下方按钮添加步骤</p>' : ''}
        </div>
        <button class="btn-secondary" style="margin-top:8px" onclick="addWorkflowStep()">+ 添加步骤</button>
      </div>

      <div class="form-group">
        <label>定时触发 (可选)</label>
        <select id="wfSchedule">
          <option value="" ${!wf?.schedule?'selected':''}>不触发</option>
          <option value="interval" ${wf?.schedule?.startsWith('interval')?'selected':''}>定时间隔</option>
          <option value="daily" ${wf?.schedule?.startsWith('daily')?'selected':''}>每天定时</option>
        </select>
        <input type="text" id="wfScheduleDetail" value="${_escH(wf?.schedule?.split('::')[1]||wf?.schedule?.split(':')[1]||'')}" placeholder="间隔秒数(如3600) 或 时间(如09:00)" style="margin-top:4px">
      </div>

      <div class="btn-row" style="margin-top:16px">
        <button class="btn-secondary" onclick="renderWorkflowList('${agentId}')">返回列表</button>
        <button class="btn-action" onclick="saveWorkflow('${agentId}','${workflowId||''}')">保存</button>
      </div>
    </div>
  `;

  // 存当前步骤数据到全局
  window._wfSteps = JSON.parse(JSON.stringify(wf?.steps || []));
  window._wfStepTypes = stepTypes;
  window._wfAgentTools = AgentTools;
  window._wfAgentId = agentId;
}

function renderStepRow(index, step, stepTypes, agentTools) {
  const st = stepTypes.find(t => t.type === step.type) || stepTypes[0];
  const isSkill = step.type === 'skill';
  // [FIX 2026-09-04] HTML 转义（LLM 可通过 workflow 工具创建含引号/标签的名称参数，
  // 未转义会破坏表单甚至注入脚本）
  const _escH = (typeof esc === 'function') ? esc
    : (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // 如果是 skill 步骤，列出可选工具
  let paramsHtml = '';
  if (isSkill) {
    const toolList = agentTools.getToolList();
    paramsHtml = `
      <select class="wf-step-param" data-param="name" style="width:200px">
        ${toolList.map(t => `<option value="${_escH(t.name)}" ${step.params?.name===t.name?'selected':''}>${_escH(t.name)}</option>`).join('')}
      </select>
      <input type="text" class="wf-step-param" data-param="_extra" placeholder="额外参数 JSON (可选)" value="${_escH(step.params?._extra||'')}" style="flex:1;margin-top:4px">
    `;
  } else {
    const required = st.requiredParams || [];
    paramsHtml = required.map(p => `
      <input type="text" class="wf-step-param" data-param="${_escH(p)}" placeholder="${_escH(p)} (必填)" value="${_escH(step.params?.[p]||'')}" style="width:100%;margin-top:4px">
    `).join('');
    paramsHtml += `<input type="text" class="wf-step-param" data-param="_extra" placeholder="其他参数 JSON (可选)" value="${_escH(step.params?._extra||'')}" style="width:100%;margin-top:4px">`;
  }

  return `
    <div class="wf-step-row" data-index="${index}" style="padding:8px;border:1px solid #eee;border-radius:6px;margin-bottom:6px;background:#faf8f5">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;color:var(--text-muted)">${index+1}.</span>
        <select class="wf-step-type" onchange="updateStepType(${index},this.value)" style="width:160px">
          ${stepTypes.map(t => `<option value="${t.type}" ${step.type===t.type?'selected':''}>${t.name}</option>`).join('')}
        </select>
        <input type="text" class="wf-step-name" placeholder="步骤名称" value="${_escH(step.name||'')}" style="width:120px">
        <div style="display:flex;gap:4px;align-items:center">
          <button onclick="moveStep(${index},-1)" style="border:none;background:none;cursor:pointer">↑</button>
          <button onclick="moveStep(${index},1)" style="border:none;background:none;cursor:pointer">↓</button>
          <button onclick="removeStep(${index})" style="border:none;background:none;cursor:pointer;color:red">✕</button>
        </div>
      </div>
      <div style="margin-top:4px" class="wf-step-params">${paramsHtml}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${st.desc}</div>
    </div>
  `;
}

// [FIX 2026-09-04] 重渲染前把 DOM 中已填写的值同步回 _wfSteps，
// 修复增删/移动/切换类型后所有已填参数丢失的严重问题
function _syncStepsFromDOM() {
  if (!window._wfSteps) window._wfSteps = [];
  const rows = document.querySelectorAll('.wf-step-row');
  if (rows.length !== window._wfSteps.length) return; // DOM 与状态不一致时不动，避免错乱
  rows.forEach((row, i) => {
    if (!window._wfSteps[i]) return;
    window._wfSteps[i].type = row.querySelector('.wf-step-type').value;
    window._wfSteps[i].name = row.querySelector('.wf-step-name').value;
    const params = { ...(window._wfSteps[i].params || {}) };
    row.querySelectorAll('.wf-step-param').forEach(input => {
      const key = input.dataset.param;
      if (!key) return;
      if (key === '_extra') {
        // _extra 是原始 JSON 文本，原样保留，让用户继续编辑未写完的 JSON
        params._extra = input.value;
      } else if (input.value.trim()) {
        params[key] = input.value;
      }
    });
    window._wfSteps[i].params = params;
  });
}

function addWorkflowStep() {
  _syncStepsFromDOM();
  window._wfSteps.push({ type: 'skill', name: '', params: {} });
  refreshStepList();
}

function removeStep(index) {
  _syncStepsFromDOM();
  window._wfSteps.splice(index, 1);
  refreshStepList();
}

function moveStep(index, dir) {
  _syncStepsFromDOM();
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= window._wfSteps.length) return;
  [window._wfSteps[index], window._wfSteps[newIndex]] = [window._wfSteps[newIndex], window._wfSteps[index]];
  refreshStepList();
}

function updateStepType(index, type) {
  _syncStepsFromDOM();
  window._wfSteps[index].type = type;
  window._wfSteps[index].params = {}; // 切换类型重置该步参数（其他步骤的参数已同步保留）
  refreshStepList();
}

function refreshStepList() {
  const container = document.getElementById('wfSteps');
  container.innerHTML = window._wfSteps.map((s, i) =>
    renderStepRow(i, s, window._wfStepTypes, window._wfAgentTools)
  ).join('') || '<p style="color:var(--text-muted);text-align:center;padding:20px">点击下方按钮添加步骤</p>';
}

function collectSteps() {
  const rows = document.querySelectorAll('.wf-step-row');
  const steps = [];
  rows.forEach((row, i) => {
    const type = row.querySelector('.wf-step-type').value;
    const name = row.querySelector('.wf-step-name').value;
    const params = {};
    row.querySelectorAll('.wf-step-param').forEach(input => {
      const key = input.dataset.param;
      if (key === '_extra' && input.value.trim()) {
        try { Object.assign(params, JSON.parse(input.value)); } catch(e) {}
      } else if (key && input.value.trim()) {
        params[key] = input.value;
      }
    });
    steps.push({ type, name, params });
  });
  return steps;
}

async function saveWorkflow(agentId, workflowId) {
  // [FIX 2026-09-04] agentId 守卫：未传时回退到当前编辑上下文，仍缺失则明确报错，
  // 避免静默写入 workflows_undefined 孤儿数据
  agentId = agentId || window._wfAgentId;
  if (!agentId) { toast('缺少 agentId，无法保存工作流', 'error'); return; }
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  const name = document.getElementById('wfName').value.trim() || 'Untitled';
  const desc = document.getElementById('wfDesc').value.trim();
  const steps = collectSteps();
  const schedule = document.getElementById('wfSchedule').value;
  const scheduleDetail = document.getElementById('wfScheduleDetail').value.trim();
  let scheduleStr = '';
  if (schedule === 'interval') scheduleStr = `interval::${scheduleDetail || '3600'}`;
  else if (schedule === 'daily') scheduleStr = `daily:${scheduleDetail || '09:00'}`;

  const data = { name, description: desc, steps, schedule: scheduleStr };

  if (workflowId) {
    await AgentWorkflow.update(agentId, workflowId, data);
    toast('工作流已更新', 'success');
  } else {
    await AgentWorkflow.create(agentId, data);
    toast('工作流已创建', 'success');
  }
  renderWorkflowList(agentId);
}

// ─── 运行工作流 ───
async function runWorkflow(agentId, workflowId) {
  agentId = agentId || window._wfAgentId;
  if (!agentId || !workflowId) { toast('缺少 agentId 或 workflowId，无法运行', 'error'); return; }
  toast('正在运行工作流...', 'info');
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  const result = await AgentWorkflow.run(agentId, workflowId);
  if (result.success) {
    toast('工作流运行成功 ✅', 'success');
    showWorkflowRuns(agentId, workflowId);
  } else {
    toast('工作流运行失败: ' + (result.run?.error || result.error), 'error');
  }
  renderWorkflowList(agentId);
}

// ─── 运行记录 ───
async function showWorkflowRuns(agentId, workflowId) {
  agentId = agentId || window._wfAgentId;
  if (!agentId) { toast('缺少 agentId，无法查看运行记录', 'error'); return; }
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  const runs = await AgentWorkflow.listRuns(agentId, workflowId, 20);
  const modal = document.getElementById('workflowModal');
  // [FIX 2026-09-04] HTML 转义
  const _escH = (typeof esc === 'function') ? esc
    : (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  modal.innerHTML = `
    <div class="modal modal-wide" style="max-width:800px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>📜 运行记录</h3>
        <button class="btn-secondary" onclick="renderWorkflowList('${agentId}')">返回列表</button>
      </div>

      ${runs.length === 0 ? '<p style="text-align:center;color:var(--text-muted);padding:40px">暂无运行记录</p>' : runs.map(run => `
        <div style="padding:12px;border:1px solid var(--beige,#e0d0bc);border-radius:8px;margin-bottom:8px;background:#faf8f5">
          <div style="display:flex;justify-content:space-between">
            <strong style="color:${run.status==='success'?'green':'red'}">${run.status === 'success' ? '✅' : '❌'} ${_escH(run.workflow_name)}</strong>
            <span style="font-size:12px;color:var(--text-muted)">${run.started_at?.slice(0,19) || ''}</span>
          </div>
          ${run.error ? `<div style="color:red;font-size:12px;margin-top:4px">${_escH(run.error)}</div>` : ''}
          <div style="margin-top:8px">
            ${run.steps.map(s => `
              <div style="font-size:12px;padding:2px 0">
                ${s.status==='success'?'✅':'❌'} ${s.id}. ${_escH(s.name)} (${s.type})
                ${s.error ? `<span style="color:red"> — ${_escH(String(s.error).slice(0,100))}</span>` : ''}
                ${s.result ? `<span style="color:var(--text-muted)"> — ${_escH(String(s.result).slice(0,100))}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function deleteWorkflow(agentId, workflowId) {
  agentId = agentId || window._wfAgentId;
  if (!agentId || !workflowId) { toast('缺少 agentId 或 workflowId，无法删除', 'error'); return; }
  if (!confirm('确定删除此工作流？')) return;
  const { AgentWorkflow } = await import('/static/agent/agent-workflow.js?v=20260904d');
  await AgentWorkflow.delete(agentId, workflowId);
  toast('已删除', 'success');
  renderWorkflowList(agentId);
}

// 暴露
window.openWorkflowManager = openWorkflowManager;
window.renderWorkflowList = renderWorkflowList;
window.showWorkflowEditor = showWorkflowEditor;
window.addWorkflowStep = addWorkflowStep;
window.removeStep = removeStep;
window.moveStep = moveStep;
window.updateStepType = updateStepType;
window.refreshStepList = refreshStepList;
window.collectSteps = collectSteps;
window.saveWorkflow = saveWorkflow;
window.runWorkflow = runWorkflow;
window.showWorkflowRuns = showWorkflowRuns;
window.deleteWorkflow = deleteWorkflow;

export { openWorkflowManager };
