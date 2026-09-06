/* ═══════════════ agent/agent-files.js ═══════════════
   文件管理页面 — 在 agent 头像下面点击进去
   功能：浏览/打开/下载/删除/上传 虚拟FS文件 + Key查看
   ═════════════════════════════════════════════════════ */

// [2026-09-07] i18n helper — 宿主页面提供 t()（aicq.me 全量字典 / 独立壳 shim）。
// 键缺失时回退到英文文案，保证英文用户不会再看到纯中文面板。
function _T(k, en) {
  try {
    const v = (typeof t === 'function') ? t(k)
      : (typeof window !== 'undefined' && typeof window.t === 'function' ? window.t(k) : undefined);
    return (v && v !== k) ? v : (en || k);
  } catch (e) { return en || k; }
}

async function openFileManager(agentId) {
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

  let modal = document.getElementById('fileManagerModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'fileManagerModal';
  modal.className = 'modal-overlay open';
  modal.style.display = 'flex';
  document.body.appendChild(modal);

  await renderFileList(agentId, '/');
}

async function renderFileList(agentId, currentDir) {
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  const modal = document.getElementById('fileManagerModal');
  if (!modal) return;

  const files = await AgentStorage.listFiles(agentId, currentDir);
  const fsSize = await AgentStorage.getFSSize(agentId);
  const fsSizeMB = (fsSize / 1024 / 1024).toFixed(1);
  const maxMB = 800;

  // 按目录分组
  // currentDir 规范化：始终以 / 开头，结尾无 /（根目录除外）
  const normDir = (currentDir === '/' || !currentDir) ? '/' : currentDir.replace(/\/+$/, '');
  const dirs = new Set();
  const fileItems = [];
  for (const f of files) {
    if (!f.path) continue;
    // 计算相对当前目录的相对路径
    let relPath;
    if (normDir === '/') {
      // 根目录：去掉开头的 / 即可
      relPath = f.path.replace(/^\//, '');
    } else {
      // 子目录：去掉 "/<dir>/" 前缀
      const prefix = normDir + '/';
      if (f.path === normDir) {
        // 当前目录自身是个文件（罕见），当作文件显示
        relPath = f.path.split('/').pop();
      } else if (f.path.startsWith(prefix)) {
        relPath = f.path.slice(prefix.length);
      } else {
        // 不在当前目录下，跳过
        continue;
      }
    }
    if (!relPath) continue;
    if (relPath.includes('/')) {
      // 子目录
      const dirName = relPath.split('/')[0];
      dirs.add(dirName);
    } else {
      fileItems.push({ ...f, name: relPath });
    }
  }

  // 获取路径面包屑
  const parts = normDir.split('/').filter(Boolean);
  let breadcrumb = `<a onclick="renderFileList('${agentId}','/')" style="cursor:pointer;color:var(--accent,#c00019)">${_T('ag_fs_root','Root')}</a>`;
  let pathSoFar = '';
  for (const p of parts) {
    pathSoFar += '/' + p;
    breadcrumb += ` / <a onclick="renderFileList('${agentId}','${pathSoFar}')" style="cursor:pointer;color:var(--accent,#c00019)">${p}</a>`;
  }

  modal.innerHTML = `
    <div class="modal modal-wide" style="max-width:900px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>📁 ${_T('ag_fs_title','File Manager')} — ${fsSizeMB}MB / ${maxMB}MB</h3>
        <div style="display:flex;gap:8px">
          <button class="btn-action" onclick="uploadToAgentFS('${agentId}','${currentDir}')">📤 ${_T('ag_fs_upload','Upload')}</button>
          <button class="btn-secondary" onclick="showAgentKeys('${agentId}')">🔑 ${_T('ag_fs_keys','Keys')}</button>
          <button class="btn-secondary" onclick="document.getElementById('fileManagerModal').remove()">${_T('ag_close','Close')}</button>
        </div>
      </div>

      <!-- 容量条 -->
      <div style="background:#e0d0bc;border-radius:6px;height:6px;margin-bottom:16px;overflow:hidden">
        <div style="background:${fsSizeMB/maxMB > 0.9 ? 'red' : 'green'};height:100%;width:${Math.min(fsSizeMB/maxMB*100, 100)}%"></div>
      </div>

      <!-- 面包屑 -->
      <div style="font-size:13px;margin-bottom:12px">${breadcrumb}</div>

      ${files.length === 0 && dirs.size === 0 ? `
        <div style="text-align:center;padding:40px;color:var(--text-muted)">
          <p>📁 ${_T('ag_fs_empty','Empty directory')}</p>
          <p style="font-size:13px;margin-top:8px">${_T('ag_fs_empty_hint','Click "Upload" to add files, or ask the agent to create files with the exec-code / edit-file tools')}</p>
        </div>
      ` : `
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid var(--beige,#e0d0bc)">
              <th style="text-align:left;padding:6px">${_T('ag_fs_name','Name')}</th>
              <th style="text-align:right;padding:6px;width:100px">${_T('ag_fs_size','Size')}</th>
              <th style="text-align:right;padding:6px;width:160px">${_T('ag_fs_mtime','Modified')}</th>
              <th style="text-align:center;padding:6px;width:200px">${_T('ag_fs_actions','Actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${normDir !== '/' ? `<tr style="border-bottom:1px solid #eee"><td colspan="4" style="padding:6px"><a onclick="renderFileList('${agentId}','${normDir.split('/').slice(0,-1).join('/') || '/'}')" style="cursor:pointer">📁 ..</a></td></tr>` : ''}
            ${[...dirs].sort().map(d => `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px"><a onclick="renderFileList('${agentId}','${normDir === '/' ? '/' + d : normDir + '/' + d}')" style="cursor:pointer">📁 ${d}/</a></td>
                <td style="text-align:right;padding:6px;color:var(--text-muted)">—</td>
                <td style="text-align:right;padding:6px;color:var(--text-muted)">—</td>
                <td></td>
              </tr>
            `).join('')}
            ${fileItems.sort((a,b) => a.name.localeCompare(b.name)).map(f => {
              const ext = f.name.split('.').pop()?.toLowerCase();
              const icon = _fileIcon(ext);
              const sizeStr = f.size < 1024 ? f.size + 'B' : f.size < 1024*1024 ? (f.size/1024).toFixed(1)+'KB' : (f.size/1024/1024).toFixed(1)+'MB';
              const dateStr = f.last_accessed ? new Date(f.last_accessed).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).slice(0, 16) : '—';
              const isPreviewable = ['txt','json','md','csv','js','py','html','css','xml','yaml','yml','log','sh','sql'].includes(ext);
              return `
                <tr style="border-bottom:1px solid #eee" id="filerow_${agentId}_${f.path.replace(/[^a-zA-Z0-9]/g,'_')}">
                  <td style="padding:6px">${icon} ${f.name}</td>
                  <td style="text-align:right;padding:6px;color:var(--text-muted)">${sizeStr}</td>
                  <td style="text-align:right;padding:6px;color:var(--text-muted)">${dateStr}</td>
                  <td style="text-align:center;padding:6px">
                    ${isPreviewable ? `<button onclick="openFileViewer('${agentId}','${f.path}')" style="border:none;background:none;cursor:pointer;font-size:14px" title="${_T('ag_fs_open','Open / preview')}">👁</button>` : ''}
                    ${['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext) ? `<button onclick="openFileViewer('${agentId}','${f.path}')" style="border:none;background:none;cursor:pointer;font-size:14px" title="${_T('ag_fs_preview_img','Preview image')}">🖼</button>` : ''}
                    <button onclick="downloadFromAgentFS('${agentId}','${f.path}')" style="border:none;background:none;cursor:pointer;font-size:14px" title="${_T('ag_fs_download','Download')}">⬇</button>
                    <button onclick="deleteFromAgentFS('${agentId}','${f.path}','${f.name}')" style="border:none;background:none;cursor:pointer;font-size:14px;color:red" title="${_T('ag_fs_delete','Delete')}">🗑</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// ─── 文件图标 ───
function _fileIcon(ext) {
  const icons = {
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼', svg: '🖼', bmp: '🖼',
    pdf: '📄', doc: '📄', docx: '📄', ppt: '📄', pptx: '📄',
    xls: '📊', xlsx: '📊', csv: '📊',
    zip: '📦', tar: '📦', gz: '📦', rar: '📦', '7z': '📦',
    mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬', mov: '🎬',
    txt: '📝', md: '📝', json: '📝', js: '📝', py: '📝', html: '🌐', htm: '🌐', css: '📝',
    default: '📄'
  };
  return icons[ext] || icons.default;
}

// ─── 打开/预览文件 ───
async function openFileViewer(agentId, path) {
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  const file = await AgentStorage.readFile(agentId, path);
  if (!file) { toast(_T('ag_fs_not_found','File not found'), 'error'); return; }

  const ext = path.split('.').pop()?.toLowerCase();
  const filename = path.split('/').pop();

  // 创建查看器 modal
  let viewer = document.getElementById('fileViewerModal');
  if (viewer) viewer.remove();
  viewer = document.createElement('div');
  viewer.id = 'fileViewerModal';
  viewer.className = 'modal-overlay open';
  viewer.style.display = 'flex';
  document.body.appendChild(viewer);

  let contentHtml = '';
  let rawHtml = null;   // HTML 文件原始文本（非空 = 本次打开的是 html，弹窗内直接渲染）
  let htmlToolbar = ''; // HTML 查看器顶部工具条（渲染/源码切换 + 新窗口）

  if (['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)) {
    // 图片预览
    const blob = new Blob([file.content]);
    const url = URL.createObjectURL(blob);
    contentHtml = `<img src="${url}" style="max-width:100%;max-height:70vh;border-radius:8px" />`;
    // 自动释放
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } else if (['html','htm'].includes(ext)) {
    // HTML 渲染预览 — 默认直接展示真实渲染效果（sandbox iframe，脚本可运行但隔离主页面）
    // [FIX 2026-09-05] 之前 html 落入文本分支只看源码，现改为弹窗内渲染 + 可切换源码
    rawHtml = new TextDecoder().decode(file.content);
    const srcCap = 200000;
    const escapedSrc = rawHtml.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0, srcCap)
      + (rawHtml.length > srcCap ? '\n…' + _T('ag_fs_src_trunc','Source too long — showing first 200k chars only; download to view the full text') : '');
    contentHtml = `
      <iframe id="htmlRenderFrame" sandbox="allow-scripts allow-forms allow-popups allow-modals"
        style="width:100%;height:72vh;border:1px solid var(--beige,#e0d0bc);border-radius:8px;background:#fff"></iframe>
      <pre id="htmlSourcePre" style="display:none;background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:8px;overflow:auto;max-height:72vh;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-all">${escapedSrc}</pre>`;
    htmlToolbar = `
      <button class="btn-secondary" id="htmlViewRenderBtn" onclick="_toggleHtmlFileView('render')" style="font-weight:bold">🖥 ${_T('ag_fs_render','Rendered')}</button>
      <button class="btn-secondary" id="htmlViewSourceBtn" onclick="_toggleHtmlFileView('source')">📝 ${_T('ag_fs_source','Source')}</button>
      <button class="btn-secondary" onclick="_openHtmlInNewTab()" title="${_T('ag_fs_newtab_title','Open fully in a new browser tab')}">↗ ${_T('ag_fs_newtab','New tab')}</button>`;
  } else if (['txt','json','md','csv','js','py','css','xml','yaml','yml','log','sh','sql'].includes(ext)) {
    // 文本预览
    const text = new TextDecoder().decode(file.content);
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    contentHtml = `<pre style="background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:8px;overflow:auto;max-height:70vh;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-all">${escaped.slice(0, 50000)}</pre>`;
  } else if (ext === 'pdf') {
    // PDF 预览
    const blob = new Blob([file.content], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    contentHtml = `<embed src="${url}" type="application/pdf" style="width:100%;height:70vh;border-radius:8px" />`;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } else {
    contentHtml = `<p style="text-align:center;padding:40px;color:var(--text-muted)">${_T('ag_fs_no_preview','Preview not supported for .{ext} — download to view').replace('{ext}', ext)}</p>`;
  }

  // HTML 渲染预览用更宽的弹窗（页面常见 1200px 宽设计）
  const modalMaxWidth = rawHtml != null ? '1200px' : '900px';

  viewer.innerHTML = `
    <div class="modal modal-wide" style="max-width:${modalMaxWidth};max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>${_fileIcon(ext)} ${filename}</h3>
        <div style="display:flex;gap:8px">
          ${htmlToolbar}
          <button class="btn-action" onclick="downloadFromAgentFS('${agentId}','${path}')">⬇ ${_T('ag_fs_download','Download')}</button>
          <button class="btn-secondary" onclick="document.getElementById('fileViewerModal').remove()">${_T('ag_close','Close')}</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${path} · ${file.size} bytes</div>
      ${contentHtml}
    </div>
  `;
  viewer.onclick = (e) => { if (e.target === viewer) viewer.remove(); };

  if (rawHtml != null) {
    // srcdoc 通过 DOM 属性赋值，避免模板字符串转义问题
    const frame = document.getElementById('htmlRenderFrame');
    if (frame) frame.srcdoc = rawHtml;
    window._currentHtmlFileHtml = rawHtml;
  }
}

// ─── HTML 查看器：渲染效果 / 源码 切换 ───
window._toggleHtmlFileView = function(mode) {
  const frame = document.getElementById('htmlRenderFrame');
  const pre = document.getElementById('htmlSourcePre');
  const rb = document.getElementById('htmlViewRenderBtn');
  const sb = document.getElementById('htmlViewSourceBtn');
  if (!frame || !pre) return;
  frame.style.display = mode === 'render' ? '' : 'none';
  pre.style.display = mode === 'render' ? 'none' : '';
  if (rb) rb.style.fontWeight = mode === 'render' ? 'bold' : 'normal';
  if (sb) sb.style.fontWeight = mode === 'render' ? 'normal' : 'bold';
};

// ─── HTML 查看器：新标签页完整打开 ───
window._openHtmlInNewTab = function() {
  const html = window._currentHtmlFileHtml;
  if (!html) { toast(_T('ag_fs_html_unavail','HTML content unavailable'), 'error'); return; }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
};

// ─── 下载文件 ───
async function downloadFromAgentFS(agentId, path) {
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  const file = await AgentStorage.readFile(agentId, path);
  if (!file) { toast(_T('ag_fs_not_found','File not found'), 'error'); return; }
  const blob = new Blob([file.content]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = path.split('/').pop();
  a.click();
  URL.revokeObjectURL(a.href);
  toast(_T('ag_fs_downloaded','Downloaded: ') + a.download, 'success');
}

// ─── 删除文件 ───
async function deleteFromAgentFS(agentId, path, filename) {
  if (!confirm(_T('ag_fs_del_confirm','Delete {name}?').replace('{name}', filename))) return;
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  await AgentStorage.deleteFile(agentId, path);
  toast(_T('ag_fs_deleted','Deleted: ') + filename, 'success');
  // 刷新当前目录
  const currentDir = path.split('/').slice(0, -1).join('/') || '/';
  renderFileList(agentId, currentDir);
}

// ─── 上传文件 ───
async function uploadToAgentFS(agentId, destDir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const destPath = (destDir === '/' ? '' : destDir) + '/' + file.name;
    await AgentStorage.saveFile(agentId, destPath, buf);
    toast(_T('ag_fs_uploaded','Uploaded: {name} ({kb}KB)').replace('{name}', file.name).replace('{kb}', (file.size/1024).toFixed(1)), 'success');
    renderFileList(agentId, destDir);
  };
  input.click();
}

// ─── Key 查看 ───
async function showAgentKeys(agentId) {
  const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
  const config = await AgentStorage.getConfig(agentId);
  if (!config) return;

  let keyModal = document.getElementById('agentKeysModal');
  if (keyModal) keyModal.remove();
  keyModal = document.createElement('div');
  keyModal.id = 'agentKeysModal';
  keyModal.className = 'modal-overlay open';
  keyModal.style.display = 'flex';
  document.body.appendChild(keyModal);

  const llm = config.llm_config || {};
  const maskedKey = llm.api_key ? llm.api_key.slice(0, 6) + '••••••' + llm.api_key.slice(-4) : '—';
  const maskedCookie = llm.cookie ? llm.cookie.slice(0, 20) + '••••' : '—';
  const maskedPrivKey = config.key_pair?.private_key ? config.key_pair.private_key.slice(0, 20) + '••••' : '—';

  keyModal.innerHTML = `
    <div class="modal" style="max-width:600px">
      <h3>🔑 ${_T('ag_fs_keys','Keys')} — ${config.name}</h3>

      <div style="margin-top:16px">
        <h4>${_T('ag_fs_identity','Agent Identity')}</h4>
        <table style="width:100%;font-size:13px">
          <tr><td style="padding:4px;color:var(--text-muted)">Agent ID</td><td style="padding:4px"><code>${config.agent_id}</code></td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Owner ID</td><td style="padding:4px"><code>${config.owner_id || '—'}</code></td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Public Key</td><td style="padding:4px"><code style="font-size:11px;word-break:break-all">${config.key_pair?.public_key || '—'}</code></td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Private Key</td><td style="padding:4px">
            <code style="font-size:11px;word-break:break-all" id="privKeyMasked">${maskedPrivKey}</code>
            <button onclick="toggleKeyVisibility('privKey','${config.key_pair?.private_key||''}','${maskedPrivKey}')" style="border:none;background:none;cursor:pointer;font-size:12px;margin-left:4px">${_T('ag_fs_show','Show')}</button>
            <button onclick="copyToClipboard('${config.key_pair?.private_key||''}')" style="border:none;background:none;cursor:pointer;font-size:12px">${_T('ag_fs_copy','Copy')}</button>
          </td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Access Token</td><td style="padding:4px">
            <code style="font-size:11px;word-break:break-all" id="tokenMasked">${(config.access_token||'').slice(0,20)}••••</code>
            <button onclick="copyToClipboard('${config.access_token||''}')" style="border:none;background:none;cursor:pointer;font-size:12px;margin-left:4px">${_T('ag_fs_copy','Copy')}</button>
          </td></tr>
        </table>
      </div>

      <div style="margin-top:16px">
        <h4>${_T('ag_fs_llm_cfg','LLM Config')}</h4>
        <table style="width:100%;font-size:13px">
          <tr><td style="padding:4px;color:var(--text-muted)">Provider</td><td style="padding:4px">${llm.provider || '—'}</td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Base URL</td><td style="padding:4px"><code>${llm.base_url || '—'}</code></td></tr>
          <tr><td style="padding:4px;color:var(--text-muted)">Model</td><td style="padding:4px"><code>${llm.model || llm.model_id || '—'}</code></td></tr>
          ${llm.api_key ? `
          <tr><td style="padding:4px;color:var(--text-muted)">API Key</td><td style="padding:4px">
            <code id="apiKeyMasked">${maskedKey}</code>
            <button onclick="toggleKeyVisibility('apiKey','${llm.api_key}','${maskedKey}')" style="border:none;background:none;cursor:pointer;font-size:12px;margin-left:4px">${_T('ag_fs_show','Show')}</button>
            <button onclick="copyToClipboard('${llm.api_key}')" style="border:none;background:none;cursor:pointer;font-size:12px">${_T('ag_fs_copy','Copy')}</button>
          </td></tr>` : ''}
          ${llm.cookie ? `
          <tr><td style="padding:4px;color:var(--text-muted)">Cookie</td><td style="padding:4px">
            <code id="cookieMasked" style="word-break:break-all">${maskedCookie}</code>
            <button onclick="toggleKeyVisibility('cookie','${llm.cookie}','${maskedCookie}')" style="border:none;background:none;cursor:pointer;font-size:12px;margin-left:4px">${_T('ag_fs_show','Show')}</button>
            <button onclick="copyToClipboard('${llm.cookie}')" style="border:none;background:none;cursor:pointer;font-size:12px">${_T('ag_fs_copy','Copy')}</button>
          </td></tr>` : ''}
        </table>
      </div>

      <div class="btn-row" style="margin-top:20px">
        <button class="btn-secondary" onclick="document.getElementById('agentKeysModal').remove()">${_T('ag_close','Close')}</button>
      </div>
    </div>
  `;
  keyModal.onclick = (e) => { if (e.target === keyModal) keyModal.remove(); };
}

function toggleKeyVisibility(keyId, realValue, maskedValue) {
  const el = document.getElementById(keyId + 'Masked');
  const btn = el.nextElementSibling;
  if (el.textContent === maskedValue) {
    el.textContent = realValue;
    btn.textContent = _T('ag_fs_hide','Hide');
  } else {
    el.textContent = maskedValue;
    btn.textContent = _T('ag_fs_show','Show');
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast(_T('ag_fs_copied','Copied'), 'success'));
}

// 暴露
window.openFileManager = openFileManager;
window.renderFileList = renderFileList;
window.openFileViewer = openFileViewer;
window.downloadFromAgentFS = downloadFromAgentFS;
window.deleteFromAgentFS = deleteFromAgentFS;
window.uploadToAgentFS = uploadToAgentFS;
window.showAgentKeys = showAgentKeys;
window.toggleKeyVisibility = toggleKeyVisibility;
window.copyToClipboard = copyToClipboard;

export { openFileManager, showAgentKeys };
