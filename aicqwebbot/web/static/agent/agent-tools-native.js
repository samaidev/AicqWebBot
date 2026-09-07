/* ═══════════════ agent/agent-tools-native.js ═══════════════
   30个浏览器原生工具实现 — 被 agent-engine.js 按需调用
   ═════════════════════════════════════════════════════════ */

const AgentToolsNative = {
  // [C4] Get auth token for proxy calls
  _authToken(ctx) {
    if (ctx?.agentConfig?.access_token) return ctx.agentConfig.access_token;
    if (typeof S !== 'undefined' && S.accessToken) return S.accessToken;
    return '';
  },

  async execute(toolName, args, context) {
    // context = { agentId, sessionId, ws, agentConfig }
    const handler = this[toolName.replace(/-/g, '_')];
    if (!handler) return { success: false, error: `Unknown tool: ${toolName}` };
    try {
      return await handler.call(this, args, context);
    } catch(e) {
      return { success: false, error: e.message };
    }
  },

  // ── web-search ──
  async web_search(args, ctx) {
    const resp = await fetch('/api/v1/agent/search-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ query: args.query, engine: args.engine || '' })
    });
    if (!resp.ok) return { success: false, error: `Search failed: ${resp.status}` };
    const data = await resp.json();
    const results = (data.results || []).map((r, i) => `${i+1}. ${r.title}\n   URL: ${r.url}\n   ${r.summary||''}`).join('\n\n');
    return { success: true, output: results || 'No results found', results: data.results || [] };
  },

  // ── web-read ──
  async web_read(args, ctx) {
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ url: args.url, mode: 'html' })
    });
    if (!resp.ok) return { success: false, error: `Fetch failed: ${resp.status}` };
    const data = await resp.json();
    // 用 DOMParser 提取正文
    const doc = new DOMParser().parseFromString(data.body || '', 'text/html');
    doc.querySelectorAll('script,style,nav,footer,header,aside').forEach(e => e.remove());
    const title = doc.title || '';
    const text = (doc.body?.innerText || '').slice(0, 8000);
    // [FIX] 检测 Cloudflare / anti-bot 挑战页面
    // 这些页面只返回一个 JS 挑战，不包含实际内容，LLM 看到会困惑
    const _cfSignals = [
      title.includes('Just a moment'),
      text.includes('Enable JavaScript and cookies to continue'),
      text.includes('Checking your browser'),
      text.includes('Please enable JavaScript'),
      text.includes('Attention Required') && text.includes('Cloudflare'),
      title.includes('Access denied'),
    ];
    if (_cfSignals.some(Boolean)) {
      return { success: false, error: 'Target page is protected by Cloudflare/anti-bot — its content cannot be read through the HTTP proxy. Try a different URL or a cached/search version of the page.', output: 'Error: Target page is protected by Cloudflare anti-bot challenge. The page returned a JS challenge instead of actual content. Please try a different URL.' };
    }
    const links = Array.from(doc.querySelectorAll('a[href]')).slice(0, 20).map(a => ({ text: a.innerText.slice(0,80), href: a.href }));
    return { success: true, output: `Title: ${title}\n\n${text}`, title, links };
  },

  // ── url-read ──
  // [FIX 2026-08-29] 完整 HTTP 客户端支持: method / headers / body / status / max_length
  // 之前只支持 GET 且无法带自定义头 —— 智能体无法调用需要 Authorization 的 API
  // (如 GitHub 私有仓库) 或需要 POST JSON body 的端点 (如 samcommand /exec)。
  // 服务端 web-proxy 本就支持这些字段，此处仅补齐客户端透传。
  async url_read(args, ctx) {
    const method = String(args.method || 'GET').toUpperCase().trim();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      return { success: false, error: `Unsupported HTTP method: ${method} (allowed: GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)` };
    }
    // headers: 接受对象或 JSON 字符串
    let headers;
    if (args.headers) {
      if (typeof args.headers === 'object' && !Array.isArray(args.headers)) {
        headers = args.headers;
      } else if (typeof args.headers === 'string') {
        try { headers = JSON.parse(args.headers); }
        catch(e) { return { success: false, error: 'headers must be a JSON object or JSON string, e.g. {"Authorization":"Bearer xxx"}' }; }
      }
      if (headers && typeof headers === 'object') {
        // 值统一转字符串，避免非字符串类型导致代理端序列化异常
        for (const k of Object.keys(headers)) headers[k] = String(headers[k]);
      }
    }
    // body: 仅写操作发送；对象自动序列化
    let body;
    if (method !== 'GET' && method !== 'HEAD' && args.body !== undefined && args.body !== null && args.body !== '') {
      body = (typeof args.body === 'string') ? args.body : JSON.stringify(args.body);
      // 带 body 时确保有 Content-Type（未显式给定时默认 JSON）
      if (body && !headers) headers = {};
      if (body && headers && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const proxyReq = { url: args.url, mode: 'raw', method, headers, body };
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify(proxyReq)
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch(e) {}
      return { success: false, error: `Fetch failed: ${resp.status} ${detail}` };
    }
    const data = await resp.json();
    // 上游 HTTP 状态码透传给 LLM（非 2xx 常见于 API 限流/认证失败，需看到才好排查）
    const upstreamStatus = data.status || 0;
    const maxLen = Math.min(Number(args.max_length) || 8000, 20000);
    const rawBody = data.body || '';
    let output = rawBody, parsed = null;
    // 尝试解析 JSON → 结构化返回，便于 LLM 直接读字段
    const ct = rawBody.slice(0, 50).trim();
    if (ct.startsWith('{') || ct.startsWith('[')) {
      try { parsed = JSON.parse(rawBody); } catch(e) {}
    }
    if (rawBody.length > maxLen) output = rawBody.slice(0, maxLen) + `\n...[truncated, total ${rawBody.length} chars — use max_length param (up to 20000) or fetch a narrower endpoint]`;
    const result = { success: upstreamStatus >= 200 && upstreamStatus < 300, status: upstreamStatus, output };
    if (parsed !== null && JSON.stringify(parsed).length <= maxLen) result.data = parsed;
    if (upstreamStatus >= 400) result.error = `Upstream HTTP ${upstreamStatus} — check status/output for API error details`;
    return result;
  },

  // ── save-memory ──
  async save_memory(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const mem = await AgentStorage.saveMemory(ctx.agentId, args.key, args.content, args.summary || args.content.slice(0,200), args.importance || 0.5, ctx.sessionId);
    return { success: true, output: 'Memory saved.' };
  },

  // ── recall-memory ──
  async recall_memory(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const results = await AgentStorage.searchMemory(ctx.agentId, args.query, args.limit || 10);
    if (!results.length) return { success: true, output: 'No matching memories found.' };
    const text = results.map((m,i) => `${i+1}. [${m.key}] ${m.summary||m.content.slice(0,200)}`).join('\n');
    return { success: true, output: text, results };
  },

  // ── save-knowledge ──
  async save_knowledge(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    await AgentStorage.saveMemory(ctx.agentId, 'knowledge', args.content, args.title, 0.7, ctx.sessionId);
    return { success: true, output: 'Knowledge saved.' };
  },

  // ── search-knowledge ──
  async search_knowledge(args, ctx) {
    return this.recall_memory(args, ctx);
  },

  // ── create-doc (enhanced) ──
  // 支持元素：paragraph (含 runs 富文本), heading, list, table, image, pagebreak
  // 旧格式 (string content) 向后兼容
  async create_doc(args, ctx) {
    // [FIX] Default filename if not provided
    if (!args.filename) args.filename = `document_${Date.now()}.docx`;
    await this._loadScript('https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js');
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    // [FIX] Handle content as array, object, or string
    let elements;
    if (Array.isArray(args.content)) {
      elements = args.content;
    } else if (typeof args.content === 'object' && args.content !== null) {
      elements = [args.content];
    } else if (typeof args.content === 'string') {
      try { elements = JSON.parse(args.content); } catch { elements = [{ type: 'paragraph', text: args.content }]; }
    } else {
      elements = [{ type: 'paragraph', text: String(args.content || '') }];
    }
    if (!Array.isArray(elements)) elements = [elements];

    const alignMap = {
      left: docx.AlignmentType.LEFT, right: docx.AlignmentType.RIGHT,
      center: docx.AlignmentType.CENTER, justify: docx.AlignmentType.JUSTIFIED,
    };
    const children = [];
    for (const e of elements) {
      if (!e || !e.type) { children.push(new docx.Paragraph({ text: String(e || '') })); continue; }
      switch (e.type) {
        case 'heading': {
          children.push(new docx.Paragraph({
            text: e.text || '',
            heading: docx.HeadingLevel[`HEADING_${e.level||1}`],
            alignment: e.align ? alignMap[e.align.toLowerCase()] : undefined,
          }));
          break;
        }
        case 'list': {
          // 支持 items 数组或单条 text
          const items = e.items || [e.text];
          for (const item of items) {
            children.push(new docx.Paragraph({
              text: String(item || ''),
              bullet: { level: e.level || 0 },
            }));
          }
          break;
        }
        case 'paragraph': {
          // 富文本 runs
          if (Array.isArray(e.runs)) {
            children.push(new docx.Paragraph({
              alignment: e.align ? alignMap[e.align.toLowerCase()] : undefined,
              children: e.runs.map(r => new docx.TextRun({
                text: r.text || '',
                bold: r.bold,
                italics: r.italics || r.italic,
                underline: r.underline ? {} : undefined,
                color: r.color,            // hex without #, e.g. 'FF0000'
                size: r.size,              // half-points: 24 = 12pt
                font: r.font,
                highlight: r.highlight,
              })),
            }));
          } else {
            children.push(new docx.Paragraph({
              text: e.text || '',
              alignment: e.align ? alignMap[e.align.toLowerCase()] : undefined,
            }));
          }
          break;
        }
        case 'table': {
          const rows = (e.rows || []).map(row => {
            const cells = (Array.isArray(row) ? row : (row.cells || [])).map(cell => {
              const c = typeof cell === 'string' ? { text: cell } : cell;
              return new docx.TableCell({
                width: c.width ? { size: c.width, type: docx.WidthType.PERCENTAGE } : undefined,
                shading: c.bg ? { fill: c.bg.replace('#','') } : undefined,
                children: [new docx.Paragraph({
                  alignment: c.align ? alignMap[c.align.toLowerCase()] : undefined,
                  children: [new docx.TextRun({
                    text: String(c.text || ''),
                    bold: c.bold, italics: c.italics, color: c.color, size: c.size, font: c.font,
                  })],
                })],
              });
            });
            return new docx.TableRow({ children: cells, tableHeader: row.header });
          });
          children.push(new docx.Table({
            rows,
            width: { size: e.width || 100, type: docx.WidthType.PERCENTAGE },
            columnWidths: e.columnWidths,
          }));
          // 表格后加空段，避免相邻表格合并
          children.push(new docx.Paragraph({ text: '' }));
          break;
        }
        case 'image': {
          let buf;
          if (e.path) {
            const f = await AgentStorage.readFile(ctx.agentId, e.path);
            if (!f) return { success: false, error: `Image not found in VS: ${e.path}` };
            buf = f.content;
          } else if (e.url) {
            const resp = await fetch('/api/v1/agent/web-proxy', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: e.url, mode: 'raw' })
            });
            if (!resp.ok) return { success: false, error: `Image fetch failed: ${resp.status}` };
            const data = await resp.json();
            const bin = atob(data.body);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            buf = arr.buffer;
          } else if (e.base64) {
            const bin = atob(e.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            buf = arr.buffer;
          } else { continue; }
          children.push(new docx.Paragraph({
            alignment: e.align ? alignMap[e.align.toLowerCase()] : docx.AlignmentType.CENTER,
            children: [new docx.ImageRun({
              data: buf,
              transformation: { width: e.width || 400, height: e.height || 300 },
            })],
          }));
          break;
        }
        case 'pagebreak': {
          children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
          break;
        }
        default:
          children.push(new docx.Paragraph({ text: String(e.text || '') }));
      }
    }

    const docOpts = { sections: [{ children }] };
    // 文档级属性
    if (args.properties) {
      try {
        const p = typeof args.properties === 'string' ? JSON.parse(args.properties) : args.properties;
        if (p.creator || p.title || p.description) {
          docOpts.creator = p.creator;
          docOpts.title = p.title;
          docOpts.description = p.description;
        }
        // 页面边距
        if (p.margins && elements[0]) {
          docOpts.sections[0].properties = {
            page: { margin: { top: p.margins.top||1440, bottom: p.margins.bottom||1440, left: p.margins.left||1440, right: p.margins.right||1440 } }
          };
        }
      } catch(_) {}
    }
    const doc = new docx.Document(docOpts);
    const blob = await docx.Packer.toBlob(doc);
    await this._saveToVS(ctx, args.filename, blob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, args.filename, blob);
    return { success: true, output: `Document ${args.filename} created (${children.length} elements) and sent to user.`, files: [args.filename] };
  },

  // ── read-doc ──
  async read_doc(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.filename);
    if (!file) return { success: false, error: 'File not found' };
    await this._loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js');
    const arrayBuffer = file.content;
    const result = await mammoth.extractRawText({ arrayBuffer });
    return { success: true, output: result.value.slice(0, 8000) };
  },

  // ── create-pdf ──
  async create_pdf(args, ctx) {
    // [FIX] Default filename if not provided
    if (!args.filename) args.filename = `document_${Date.now()}.pdf`;
    await this._loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
    const content = args.content || '';
    const pdfDoc = await PDFLib.PDFDocument.create();
    // [FIX 2026-08-29] StandardFonts.Helvetica is WinAnsi-encoded and CANNOT
    // encode CJK — Chinese reports crashed with "WinAnsi cannot encode U+4F60"
    // or produced mojibake. Two-track renderer:
    //   * pure latin text → vector text via Helvetica (small, selectable)
    //   * any CJK → render each page on a <canvas> with system fonts (perfect
    //     CJK coverage, ZERO font downloads) and embed the page as PNG
    const _hasCJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(content);
    if (_hasCJK) {
      await this._renderPdfPagesViaCanvas(pdfDoc, content, args.title || '');
    } else {
      const page = pdfDoc.addPage([595, 842]); // A4
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      const lines = content.split('\n');
      let y = 800;
      for (const line of lines) {
        if (y < 50) { page = pdfDoc.addPage([595, 842]); y = 800; }
        page.drawText(line.slice(0, 80), { x: 50, y, size: 10, font });
        y -= 15;
      }
    }
    const bytes = await pdfDoc.save();
    const pdfBlob = new Blob([bytes]);
    await this._saveToVS(ctx, args.filename, pdfBlob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, args.filename, pdfBlob);
    return { success: true, output: `PDF ${args.filename} created and sent to user.` + (_hasCJK ? ' (CJK text rendered with system fonts)' : ''), files: [args.filename] };
  },

  // [FIX 2026-08-29] Canvas-based PDF page renderer for CJK content.
  // Draws text onto A4-sized canvases (2x density for crisp output) using
  // system fonts (Noto Sans SC / Microsoft YaHei / PingFang — whatever the
  // browser has), then embeds each canvas as a full-page PNG via pdf-lib.
  // Handles wrapping (per-char for CJK), page breaks and an optional title.
  async _renderPdfPagesViaCanvas(pdfDoc, content, title) {
    const S = 2;                                  // 2x pixel density
    const W = 595 * S, H = 842 * S, M = 50 * S;   // A4 @2x, 50pt margins
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const c2d = canvas.getContext('2d');
    const fontSize = 11 * S, lineH = Math.floor(fontSize * 1.55);
    const fontBody = `${fontSize}px "Noto Sans SC","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif`;
    const fontTitle = `600 ${Math.floor(fontSize * 1.5)}px "Noto Sans SC","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif`;

    let page = pdfDoc.addPage([595, 842]);
    const newPage = () => { page = pdfDoc.addPage([595, 842]); c2d.fillStyle = '#ffffff'; c2d.fillRect(0, 0, W, H); return M + fontSize; };
    const flushPage = async () => {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const img = await pdfDoc.embedPng(new Uint8Array(await blob.arrayBuffer()));
      page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    };

    c2d.fillStyle = '#ffffff'; c2d.fillRect(0, 0, W, H);
    let y = M + fontSize;
    if (title) {
      c2d.fillStyle = '#111111'; c2d.font = fontTitle;
      c2d.fillText(title.slice(0, 60), M, y);
      y += Math.floor(lineH * 1.5);
      y += Math.floor(fontSize * 0.4);
    }
    c2d.fillStyle = '#1a1a1a'; c2d.font = fontBody;

    // Wrap: CJK breaks per character, latin per word — measureText decides
    const wrap = (text) => {
      const out = [];
      for (const raw of String(text).split('\n')) {
        if (raw === '') { out.push(''); continue; }
        let line = '';
        for (const ch of raw) {
          if (c2d.measureText(line + ch).width > W - 2 * M) { out.push(line); line = ch; }
          else line += ch;
        }
        out.push(line);
      }
      return out;
    };

    for (const ln of wrap(content)) {
      if (y > H - M) {
        await flushPage();
        y = newPage();
        c2d.fillStyle = '#1a1a1a'; c2d.font = fontBody;
      }
      if (ln) c2d.fillText(ln, M, y);
      y += lineH;
    }
    await flushPage();
  },

  // ── read-pdf ──
  async read_pdf(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.filename);
    if (!file) return { success: false, error: 'File not found' };
    await this._loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: file.content }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      text += (await page.getTextContent()).items.map(item => item.str).join(' ') + '\n';
    }
    return { success: true, output: text.slice(0, 8000) };
  },

  // ── create-xlsx (enhanced) ──
  // 支持：公式、列宽、行高、合并单元格、单元格类型提示、冻结窗格
  // Sheet 格式（向后兼容）：
  //   { name, data: [[v, ...]] }                                   ← 旧格式
  //   { name, cells: [[{v, f, t, ...}|v, ...]], colWidths, rowHeights, merges, freeze }  ← 新格式
  // [FIX 2026-09-05] 「打开显示格式不对」三个实测根因（openpyxl 复现验证）：
  //   1) LLM 传的数字常带引号（"99.5"）→ 存成文本，Excel 打开左对齐+绿三角、无法求和；
  //   2) 公式格只有占位 v=0 且 SheetJS CE 不写 calcPr → 手机/网页预览器(不重算)
  //      合计行全显示 0；
  //   3) SheetJS CE 不支持 ws['!freeze'] → 冻结窗格参数静默丢失。
  // 修复：1) 裸字符串数字自动转 Number（显式 t:'s' 尊重为文本）；
  //       2) 公式 v 缺失时对 SUM/AVERAGE/COUNT/MIN/MAX/四则引用做本地求值作缓存值，
  //          并经 JSZip 注入 fullCalcOnLoad 强制 Excel/WPS 打开时全量重算；
  //       3) 生成后经 JSZip 后处理向 sheetN.xml 注入 <pane state="frozen"/>。
  async create_xlsx(args, ctx) {
    // [FIX] Default filename if not provided
    if (!args.filename) args.filename = `spreadsheet_${Date.now()}.xlsx`;
    await this._loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    await this._loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    let sheets; try { sheets = JSON.parse(args.sheets); } catch { sheets = [{ name: 'Sheet1', data: [[args.sheets]] }]; }
    if (!Array.isArray(sheets)) sheets = [sheets];

    const wb = XLSX.utils.book_new();
    wb.Props = {
      Title: args.title || 'AICQ Agent Workbook',
      Creator: 'AICQ Agent',
      CreatedDate: new Date(),
    };

    for (const s of sheets) {
      let ws;
      // 新格式：cells 数组（每个 cell 可为对象 {v, f, t} 或裸值）
      // [FIX] 两遍处理：先全量转换值单元格（数字字符串→Number），再处理公式，
      //       这样公式缓存值求值时能取到同行/后行已转换的值
      if (Array.isArray(s.cells)) {
        const conv = (s.cells || []).map(row => (row || []).map(cell => {
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'object') {
            if (cell.f) return cell;  // 公式格第二遍处理
            // 显式类型：LLM 明确标 t:'s' 时尊重为文本；t:'n' 但值是数字字符串也转数值
            if (cell.t) {
              if (cell.t === 'n' && typeof cell.v === 'string') {
                const n = this._strToNumber(cell.v);
                return { t: 'n', v: n !== null ? n : cell.v };
              }
              return { t: cell.t, v: cell.v };
            }
            // 裸值：数字字符串自动转 Number（否则 Excel 打开是文本格式）
            if (typeof cell.v === 'string') {
              const n = this._strToNumber(cell.v);
              return n !== null ? n : cell.v;
            }
            return cell.v;
          }
          // 裸字符串：数字字符串自动转 Number
          if (typeof cell === 'string') {
            const n = this._strToNumber(cell);
            return n !== null ? n : cell;
          }
          return cell;
        }));
        // 第二遍：公式格求缓存值（此时 conv 全量就绪）
        const aoa = conv.map(row => (row || []).map(cell => {
          if (cell && typeof cell === 'object' && cell.f) {
            const fv = (cell.v !== undefined && cell.v !== null && cell.v !== '') ? cell.v
              : this._evalSimpleFormula(cell.f, conv);   // [FIX] 缓存值兜底求值
            return { t: cell.t || 'n', f: cell.f, v: fv !== null ? fv : 0 };
          }
          return cell;
        }));
        ws = XLSX.utils.aoa_to_sheet(aoa);
      } else {
        // 旧格式：纯 data 数组（同样做数字字符串转换；首列/表头通常是文本，
        // 但全数字的纯数字串如 "123" 在数据列必然是数字，统一转换收益更大）
        const aoa = (s.data || []).map(row => (row || []).map(v => {
          if (typeof v === 'string') { const n = this._strToNumber(v); return n !== null ? n : v; }
          return v;
        }));
        ws = XLSX.utils.aoa_to_sheet(aoa);
      }

      // 列宽
      if (Array.isArray(s.colWidths)) {
        ws['!cols'] = s.colWidths.map(w => ({ wch: w }));
      }
      // 行高
      if (Array.isArray(s.rowHeights)) {
        ws['!rows'] = s.rowHeights.map(h => ({ hpt: h }));
      }
      // 合并单元格：[[startRow, startCol, endRow, endCol], ...]
      // [FIX] 过滤单格合并（s==e）— 无效合并部分 Excel 版本会报"文件有问题"
      if (Array.isArray(s.merges)) {
        ws['!merges'] = s.merges
          .filter(m => Array.isArray(m) && !(m[0] === m[2] && m[1] === m[3]))
          .map(m => ({ s: { r: m[0], c: m[1] }, e: { r: m[2], c: m[3] } }));
      }
      // 冻结窗格：SheetJS CE 不序列化 !freeze，记录下来在写盘后经 JSZip 注入
      if (s.freeze) {
        ws['!aicqFreeze'] = {
          xSplit: s.freeze.xSplit || 0,
          ySplit: s.freeze.ySplit || 0,
          topLeftCell: s.freeze.topLeftCell || '',
        };
      }

      XLSX.utils.book_append_sheet(wb, ws, s.name || `Sheet${wb.SheetNames.length + 1}`);
    }

    let buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
    // [FIX] JSZip 后处理：冻结窗格 + fullCalcOnLoad（CE 均不直接支持）
    try {
      buf = await this._postProcessXlsx(buf, wb);
    } catch (e) {
      console.warn('[create_xlsx] post-process failed (file still generated):', e);
    }
    // [FIX 2026-09-05] 二进制类型防御：Blob([普通数组]) 会字符串化成 "80,75,..." 文本
    if (Array.isArray(buf)) buf = new Uint8Array(buf);
    const xlsxBlob = new Blob([buf]);
    await this._saveToVS(ctx, args.filename, xlsxBlob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, args.filename, xlsxBlob);
    return { success: true, output: `Excel ${args.filename} created (${sheets.length} sheets) and sent to user.`, files: [args.filename] };
  },

  // [FIX 2026-09-05] 数字字符串 → Number（全匹配才转；逗号千分位/百分号/空白容忍）。
  // 返回 null 表示不是纯数字（保持文本，如电话号/邮编/编号 "010"）。
  _strToNumber(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t) return null;
    // 纯数字（可含小数/负号/千分位逗号/结尾百分号）；前导 0 的编号串不转
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
    if (/^-?0*\d+(\.\d+)?%$/.test(t)) {
      const n = parseFloat(t.slice(0, -1).replace(/,/g, ''));
      if (!isNaN(n) && !/^0\d/.test(t.replace(/^-/, ''))) return n / 100;  // "15%" → 0.15
      return null;
    }
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      const n = parseFloat(t);
      // 前导 0 编号（"007"）与超长数字（电话/单号）保持文本
      if (/^0\d/.test(t.replace(/^-/, '')) || t.replace(/[^0-9]/g, '').length > 15) return null;
      return isNaN(n) ? null : n;
    }
    return null;
  },

  // [FIX 2026-09-05] 简单公式缓存值启发式求值 — 仅支持无函数嵌套的常见形式：
  //   SUM/AVERAGE/COUNT/MIN/MAX(range)、单元格引用四则 A1+B2*2、数字字面量、括号。
  // 求值失败返回 null（调用方保留 0 占位）。aoa 为已构建的二维值数组。
  _evalSimpleFormula(formula, aoa) {
    try {
      let f = String(formula || '').trim();
      if (f.startsWith('=')) f = f.slice(1);
      // 范围函数展开
      f = f.replace(/(SUM|AVERAGE|AVG|COUNT|MIN|MAX)\s*\(\s*([A-Za-z]{1,3}\d+)\s*:\s*([A-Za-z]{1,3}\d+)\s*\)/gi,
        (m, fn, a, b) => {
          const r1 = XLSX.utils.decode_cell(a.toUpperCase());
          const r2 = XLSX.utils.decode_cell(b.toUpperCase());
          const vals = [];
          for (let r = Math.min(r1.r, r2.r); r <= Math.max(r1.r, r2.r); r++) {
            for (let c = Math.min(r1.c, r2.c); c <= Math.max(r1.c, r2.c); c++) {
              const row = aoa[r] || [];
              const v = row[c];
              if (typeof v === 'number') vals.push(v);
              // 字符串数字（LLM 常见传参）也计入求和/均值
              else if (typeof v === 'string') {
                const n = this._strToNumber(v);
                if (n !== null) vals.push(n);
              }
            }
          }
          const name = fn.toUpperCase();
          if (name === 'COUNT') return String(vals.length);
          if (!vals.length) return '0';
          const sum = vals.reduce((a2, b2) => a2 + b2, 0);
          if (name === 'SUM') return String(sum);
          if (name === 'AVERAGE' || name === 'AVG') return String(sum / vals.length);
          if (name === 'MIN') return String(Math.min(...vals));
          if (name === 'MAX') return String(Math.max(...vals));
          return '0';
        });
      // 单元格引用 → 值
      f = f.replace(/\b([A-Za-z]{1,3}\d+)\b/g, (m, ref) => {
        const cell = XLSX.utils.decode_cell(ref.toUpperCase());
        const v = (aoa[cell.r] || [])[cell.c];
        return typeof v === 'number' ? String(v) : (typeof v === 'string' && this._strToNumber(v) !== null ? String(this._strToNumber(v)) : '0');
      });
      // 只剩数字/运算符/括号才安全求值
      if (!/^[-+*/().\d\s]+$/.test(f)) return null;
      const val = Function('"use strict"; return (' + f + ')')();
      return (typeof val === 'number' && isFinite(val)) ? val : null;
    } catch (e) { return null; }
  },

  // [FIX 2026-09-05] xlsx 后处理（SheetJS CE 不支持的功能）：
  //   1) 冻结窗格 — wb 各 sheet 的 !aicqFreeze → sheetN.xml 注入 <pane state="frozen"/>
  //   2) fullCalcOnLoad — workbook.xml 注入 <calcPr/>，Excel/WPS 打开时强制全量重算公式
  async _postProcessXlsx(buf, wb) {
    // 优先用 _loadScript 已挂载的 window.JSZip（dist UMD），失败再走 +esm 动态导入
    let JSZip = (typeof window !== 'undefined' && window.JSZip) || null;
    if (!JSZip) {
      try { JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default; } catch (e) {}
    }
    if (!JSZip) return buf;
    const zip = await JSZip.loadAsync(buf);
    const freezePaneXml = (fr) => {
      const xSplit = Math.max(0, fr.xSplit || 0);
      const ySplit = Math.max(0, fr.ySplit || 0);
      if (!xSplit && !ySplit) return '';
      const attrs = (xSplit ? ` xSplit="${xSplit}"` : '') + (ySplit ? ` ySplit="${ySplit}"` : '');
      const topLeft = fr.topLeftCell || XLSX.utils.encode_cell({ r: ySplit, c: xSplit });
      const activePane = xSplit && ySplit ? 'bottomRight' : (xSplit ? 'topRight' : 'bottomLeft');
      return `<pane${attrs} topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>`
        + `<selection pane="${activePane}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
    };
    for (let i = 0; i < wb.SheetNames.length; i++) {
      const ws = wb.Sheets[wb.SheetNames[i]];
      const fr = ws && ws['!aicqFreeze'];
      if (!fr) continue;
      const name = `xl/worksheets/sheet${i + 1}.xml`;
      const file = zip.file(name);
      if (!file) continue;
      let xml = await file.async('string');
      const paneXml = freezePaneXml(fr);
      if (!paneXml || xml.includes('<pane ')) continue;
      if (xml.includes('</sheetView>')) {
        xml = xml.replace('</sheetView>', paneXml + '</sheetView>');
      } else if (/<sheetView\b[^>]*\/>/.test(xml)) {
        xml = xml.replace(/<sheetView\b([^>]*)\/>/, (m, attrs) => `<sheetView${attrs}>${paneXml}</sheetView>`);
      }
      zip.file(name, xml);
    }
    {
      const file = zip.file('xl/workbook.xml');
      if (file) {
        let xml = await file.async('string');
        if (!xml.includes('<calcPr')) {
          const tag = '<calcPr calcId="0" fullCalcOnLoad="1"/>';
          if (xml.includes('</definedNames>')) xml = xml.replace('</definedNames>', '</definedNames>' + tag);
          else if (xml.includes('</sheets>')) xml = xml.replace('</sheets>', '</sheets>' + tag);
          else xml = xml.replace('</workbook>', tag + '</workbook>');
          zip.file('xl/workbook.xml', xml);
        }
      }
    }
    // [FIX 2026-09-05] type 必须 'uint8array'：'array' 返回普通 JS 数组，
    // new Blob([普通数组]) 会把数组 toString 成 "80,75,3,4,..." 的十进制文本，
    // 产出的 .xlsx 不是合法 zip（实测 openpyxl BadZipFile —— 即用户看到的"打开格式不对"）。
    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  },

  // ── edit-xlsx (NEW) ──
  // 加载现有 .xlsx，原地修改后保存
  // actions: set_cell | add_row | add_sheet | delete_sheet | rename_sheet | list_sheets | get_cell | set_formula | add_merge | set_col_width
  // [FIX 2026-09-05] CE 读写循环会丢冻结窗格、不写 calcPr → 读取时先从原始 zip
  // 解析各 sheet 的冻结参数存入 !aicqFreeze，保存后统一走 _postProcessXlsx 注入；
  // 公式占位值也改用 _evalSimpleFormula 兑底求值（不再固定 0）。
  async edit_xlsx(args, ctx) {
    await this._loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    await this._loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.filename);
    if (!file) return { success: false, error: 'File not found: ' + args.filename };

    const wb = XLSX.read(file.content, { type: 'array' });
    // 从原始 zip 恢复各 sheet 冻结窗格参数（CE 读取/写入均会丢弃）
    try {
      const freezes = await this._readFreezePanes(file.content);
      for (let i = 0; i < wb.SheetNames.length && i < freezes.length; i++) {
        if (freezes[i]) wb.Sheets[wb.SheetNames[i]]['!aicqFreeze'] = freezes[i];
      }
    } catch (e) { console.warn('[edit_xlsx] freeze restore skipped:', e); }
    const action = args.action || 'set_cell';

    const getSheet = () => {
      const name = args.sheet || wb.SheetNames[0];
      const ws = wb.Sheets[name];
      if (!ws) throw new Error(`Sheet "${name}" not found. Available: ${wb.SheetNames.join(', ')}`);
      return { name, ws };
    };

    try {
      switch (action) {
        case 'list_sheets': {
          return { success: true, output: wb.SheetNames.join('\n'), sheets: wb.SheetNames };
        }
        case 'get_cell': {
          const { ws } = getSheet();
          const cell = ws[args.cell];
          if (!cell) return { success: true, output: '(empty)', value: '', formula: '', type: '' };
          // 优先显示值；若仅有公式则显示公式
          const display = cell.v !== undefined ? String(cell.v) : (cell.f ? '=' + cell.f : '(empty)');
          return { success: true, output: `value: ${display}${cell.f ? ' | formula: ' + cell.f : ''}`, value: cell.v, formula: cell.f, type: cell.t };
        }
        case 'set_cell': {
          if (!args.cell) return { success: false, error: 'cell required (e.g. "A1")' };
          const { ws } = getSheet();
          if (!ws[args.cell]) ws[args.cell] = {};
          if (args.formula) {
            // [FIX] 同 set_formula，公式占位值用启发式求值（不再固定 0）
            const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            const fv = this._evalSimpleFormula(args.formula, aoa);
            ws[args.cell] = { t: 'n', f: args.formula, v: fv !== null ? fv : 0 };
          } else if (args.value !== undefined) {
            const v = args.value;
            ws[args.cell] = { t: typeof v === 'number' ? 'n' : (typeof v === 'boolean' ? 'b' : 's'), v: v };
          }
          // [FIX] 扩展 !ref 以包含新单元格（否则 XLSX.write 会丢弃范围外的单元格）
          this._extendRange(ws, args.cell);
          break;
        }
        case 'set_formula': {
          if (!args.cell || !args.formula) return { success: false, error: 'cell and formula required' };
          const { ws } = getSheet();
          // [FIX] 公式占位值：优先用调用方传入的 value，否则启发式求值，避免预览器显示 0
          const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const fv = (args.value !== undefined && args.value !== '') ? args.value : this._evalSimpleFormula(args.formula, aoa);
          ws[args.cell] = { t: 'n', f: args.formula, v: (typeof fv === 'number' && isFinite(fv)) ? fv : 0 };
          // [FIX] 扩展 !ref
          this._extendRange(ws, args.cell);
          break;
        }
        case 'add_row': {
          if (!args.row) return { success: false, error: 'row required (JSON array)' };
          let row; try { row = JSON.parse(args.row); } catch { row = [args.row]; }
          const { ws } = getSheet();
          XLSX.utils.sheet_add_aoa(ws, [row], { origin: -1 });
          break;
        }
        case 'add_sheet': {
          if (!args.sheet_name) return { success: false, error: 'sheet_name required' };
          if (wb.SheetNames.includes(args.sheet_name)) return { success: false, error: 'Sheet already exists' };
          let data = [];
          if (args.data) { try { data = JSON.parse(args.data); } catch { data = [[args.data]]; } }
          const ws = XLSX.utils.aoa_to_sheet(data);
          XLSX.utils.book_append_sheet(wb, ws, args.sheet_name);
          break;
        }
        case 'delete_sheet': {
          if (!args.sheet) return { success: false, error: 'sheet required' };
          const idx = wb.SheetNames.indexOf(args.sheet);
          if (idx < 0) return { success: false, error: 'Sheet not found' };
          wb.SheetNames.splice(idx, 1);
          delete wb.Sheets[args.sheet];
          break;
        }
        case 'rename_sheet': {
          if (!args.old_name || !args.new_name) return { success: false, error: 'old_name and new_name required' };
          const idx = wb.SheetNames.indexOf(args.old_name);
          if (idx < 0) return { success: false, error: 'Sheet not found' };
          wb.SheetNames[idx] = args.new_name;
          wb.Sheets[args.new_name] = wb.Sheets[args.old_name];
          delete wb.Sheets[args.old_name];
          break;
        }
        case 'add_merge': {
          if (!args.range) return { success: false, error: 'range required (e.g. "A1:C1")' };
          const { ws } = getSheet();
          const range = XLSX.utils.decode_range(args.range);
          if (!ws['!merges']) ws['!merges'] = [];
          ws['!merges'].push(range);
          break;
        }
        case 'set_col_width': {
          if (!args.col || !args.width) return { success: false, error: 'col and width required' };
          const { ws } = getSheet();
          if (!ws['!cols']) ws['!cols'] = [];
          const colIdx = typeof args.col === 'number' ? args.col : XLSX.utils.decode_cell(args.col + '1').c;
          ws['!cols'][colIdx] = { wch: args.width };
          break;
        }
        case 'get_range': {
          if (!args.range) return { success: false, error: 'range required (e.g. "A1:C10")' };
          const { ws } = getSheet();
          const range = XLSX.utils.decode_range(args.range);
          const out = [];
          for (let r = range.s.r; r <= range.e.r; r++) {
            const row = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = ws[addr];
              row.push(cell ? (cell.f ? `=${cell.f}` : cell.v) : '');
            }
            out.push(row);
          }
          return { success: true, output: JSON.stringify(out), data: out };
        }
        default:
          return { success: false, error: `Unknown action: ${action}. Supported: list_sheets|get_cell|set_cell|set_formula|add_row|add_sheet|delete_sheet|rename_sheet|add_merge|set_col_width|get_range` };
      }

      let buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
      // [FIX 2026-09-05] 保存后重新注入冻结窗格 + fullCalcOnLoad（CE 读写循环会丢）
      try {
        buf = await this._postProcessXlsx(buf, wb);
      } catch (e) { console.warn('[edit_xlsx] post-process failed:', e); }
      // [FIX 2026-09-05] 同上：防普通数组被 Blob 字符串化
      if (Array.isArray(buf)) buf = new Uint8Array(buf);
      await this._saveToVS(ctx, args.filename, new Blob([buf]));
      return { success: true, output: `Excel ${args.filename} updated (${action}).`, files: [args.filename] };
    } catch (e) {
      return { success: false, error: 'edit-xlsx error: ' + e.message };
    }
  },

  // [FIX 2026-09-05] 从原始 xlsx zip 解析各 sheet 的冻结窗格参数（CE 读不回来）
  // 返回数组，index 对应 sheetN.xml（N=index+1）；无冻结的 sheet 为 null
  async _readFreezePanes(buf) {
    const JSZip = (typeof window !== 'undefined' && window.JSZip) || null;
    if (!JSZip) {
      try { JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default; } catch (e) {}
    }
    if (!JSZip) return [];
    const zip = await JSZip.loadAsync(buf);
    const out = [];
    for (let i = 1; ; i++) {
      const f = zip.file(`xl/worksheets/sheet${i}.xml`);
      if (!f) break;
      const xml = await f.async('string');
      const m = xml.match(/<pane\b[^>]*state="frozen"[^>]*>/);
      if (m) {
        const xs = /xSplit="(\d+)"/.exec(m[0]);
        const ys = /ySplit="(\d+)"/.exec(m[0]);
        const tl = /topLeftCell="([^"]+)"/.exec(m[0]);
        out.push({ xSplit: xs ? +xs[1] : 0, ySplit: ys ? +ys[1] : 0, topLeftCell: tl ? tl[1] : '' });
      } else {
        out.push(null);
      }
    }
    return out;
  },

  // ── read-xlsx ──
  async read_xlsx(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.filename);
    if (!file) return { success: false, error: 'File not found' };
    await this._loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    const wb = XLSX.read(file.content, { type: 'array' });
    let text = '';
    wb.SheetNames.forEach(name => {
      text += `=== ${name} ===\n`;
      text += XLSX.utils.sheet_to_csv(wb.Sheets[name]).slice(0, 4000) + '\n\n';
    });
    return { success: true, output: text };
  },

  // ── create-ppt (enhanced) ──
  // 支持每页：title, content, bullets, images, tables, notes, background, 文本样式
  // 文档级：layout, theme
  async create_ppt(args, ctx) {
    // [FIX] Default filename if not provided
    if (!args.filename) args.filename = `presentation_${Date.now()}.pptx`;
    await this._loadScript('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    // pptxgenjs bundle 注册的是 PptxGenJS（大写），不是 pptxgen
    const PptxGen = window.PptxGenJS || window.pptxgen;
    if (!PptxGen) return { success: false, error: 'Failed to load pptxgenjs library' };
    // [FIX] Handle slides as array OR JSON string
    let slides;
    if (Array.isArray(args.slides)) {
      slides = args.slides;
    } else if (typeof args.slides === 'string') {
      try { slides = JSON.parse(args.slides); } catch { slides = [{ title: args.slides }]; }
    } else {
      slides = [{ title: String(args.slides || '') }];
    }
    if (!Array.isArray(slides)) slides = [slides];

    const pptx = new PptxGen();
    // 文档级布局：LAYOUT_16x9 (默认), LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE
    if (args.layout) pptx.layout = args.layout;
    // 文档级主题色
    if (args.theme && args.theme.background) {
      pptx.defineSlideMaster({
        title: 'theme_master',
        background: { color: args.theme.background },
      });
    }

    for (let i = 0; i < slides.length; i++) {
      const s = slides[i] || {};
      const slide = pptx.addSlide();
      // 应用主题母版
      if (args.theme && args.theme.background && s.use_theme !== false) {
        slide.slideNumber = i + 1;
      }
      // 单页背景
      if (s.background) slide.background = { color: s.background };

      // 标题（支持样式）
      if (s.title) {
        slide.addText(s.title, {
          x: s.title_x ?? 0.5, y: s.title_y ?? 0.3,
          w: s.title_w ?? 9, h: s.title_h ?? 1,
          fontSize: s.title_size || 28,
          bold: s.title_bold !== false,
          italic: s.title_italic || false,
          color: s.title_color || '333333',
          align: s.title_align || 'left',
          fontFace: s.title_font || 'Arial',
        });
      }

      // 副标题
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 0.5, y: 1.3, w: 9, h: 0.6,
          fontSize: s.subtitle_size || 18,
          color: s.subtitle_color || '888888',
          align: s.subtitle_align || 'left',
        });
      }

      // 正文
      if (s.content) {
        slide.addText(s.content, {
          x: s.content_x ?? 0.5, y: s.content_y ?? 2.0,
          w: s.content_w ?? 9, h: s.content_h ?? 4,
          fontSize: s.content_size || 16,
          color: s.content_color || '444444',
          align: s.content_align || 'left',
          valign: s.content_valign || 'top',
          fontFace: s.content_font || 'Arial',
        });
      }

      // 项目符号列表（支持子项）
      if (s.bullets) {
        const bulletItems = s.bullets.map(b => {
          if (typeof b === 'string') return { text: b, options: { bullet: true, color: '444444' } };
          return { text: b.text, options: { bullet: b.level !== undefined ? { code: b.level === 0 ? '2022' : '2013', indent: b.level * 20 } : true, color: b.color || '444444', bold: b.bold, breakLine: true } };
        });
        slide.addText(bulletItems, {
          x: 0.5, y: 2.0, w: 9, h: 4,
          fontSize: s.bullets_size || 16,
          color: s.bullets_color || '444444',
          valign: 'top',
        });
      }

      // 图片（支持 VS 路径、URL、data URL）
      if (Array.isArray(s.images)) {
        for (const img of s.images) {
          let data;
          if (img.path) {
            const f = await AgentStorage.readFile(ctx.agentId, img.path);
            if (!f) { continue; }
            const bytes = new Uint8Array(f.content);
            let bin = '';
            for (let j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
            const ext = img.path.split('.').pop().toLowerCase();
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : (ext === 'svg' ? 'image/svg+xml' : 'image/png');
            data = `data:${mime};base64,${btoa(bin)}`;
          } else if (img.url) {
            // pptxgenjs addImage 支持 path (URL) 直接传
            data = img.url;
          } else if (img.data) {
            data = img.data;
          }
          if (data) {
            slide.addImage({
              data: data.startsWith('data:') ? data : undefined,
              path: !data.startsWith('data:') ? data : undefined,
              x: img.x ?? 1, y: img.y ?? 2,
              w: img.w ?? 4, h: img.h ?? 3,
              rounding: img.rounding || false,
            });
          }
        }
      }

      // 表格
      if (Array.isArray(s.tables)) {
        for (const tbl of s.tables) {
          const rows = (tbl.rows || []).map(row =>
            (Array.isArray(row) ? row : (row.cells || [])).map(cell => {
              const c = typeof cell === 'string' ? { text: cell } : cell;
              return {
                text: String(c.text ?? ''),
                options: {
                  align: c.align || 'left',
                  valign: 'middle',
                  bold: c.bold,
                  color: c.color || '333333',
                  fill: { color: c.bg || 'FFFFFF' },
                  fontSize: c.size || 12,
                  colspan: c.colspan,
                  rowspan: c.rowspan,
                }
              };
            })
          );
          slide.addTable(rows, {
            x: tbl.x ?? 0.5, y: tbl.y ?? 3.5,
            w: tbl.w ?? 9,
            colW: tbl.colW,
            rowH: tbl.rowH,
            border: tbl.border || { type: 'solid', pt: 1, color: 'CFCFCF' },
            autoPage: tbl.autoPage !== false,
            headerRow: tbl.header !== false,
            fill: { color: 'FFFFFF' },
            color: '333333',
            fontSize: 12,
            valign: 'middle',
            align: 'left',
          });
        }
      }

      // 备注
      if (s.notes) slide.addNotes(s.notes);

      // 页码
      if (s.page_number) {
        slide.addText(String(i + 1), { x: 9, y: 7, w: 0.5, h: 0.3, fontSize: 10, color: 'AAAAAA', align: 'right' });
      }
    }

    const blob = await pptx.write({ outputType: 'blob' });
    await this._saveToVS(ctx, args.filename, blob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, args.filename, blob);
    return { success: true, output: `PPT ${args.filename} created (${slides.length} slides) and sent to user.`, files: [args.filename] };
  },

  // ── create-chart ──
  // [FIX 2026-09-05] 根因修复 "Cannot read properties of null"：
  //   工具里的 canvas 从未 append 到 DOM（detached），Chart.js 默认 responsive:true
  //   会按"容器"尺寸把 detached canvas 改写为 0×0（复现实测 style 0px/0px），
  //   零面积 canvas 的 toBlob() 回调得到 null → _saveToVS 里 blob.arrayBuffer()
  //   抛 "Cannot read properties of null (reading 'arrayBuffer')"。
  //   修复：responsive:false + animation:false + blob null 显式报错。
  //   另修：type 缺省/别名兜底（LLM 实测会漏传 type）、v4 正确的 title 位置
  //   （旧代码 options.title 是 v2 语法，v4 下标题静默丢失 → plugins.title）、
  //   data 结构归一化、Chart.js 加载失败给出可行动的错误提示。
  async create_chart(args, ctx) {
    const validTypes = ['line', 'bar', 'radar', 'doughnut', 'pie', 'polarArea', 'bubble', 'scatter'];
    const typeAlias = { barh: 'bar', horizontalbar: 'bar', area: 'line', donut: 'doughnut', polar: 'polarArea', polararea: 'polarArea' };
    const t = String(args.type || 'line').trim().toLowerCase();
    const chartType = validTypes.includes(t) ? t : (typeAlias[t] || 'line');
    let data; try { data = JSON.parse(args.data); } catch { return { success: false, error: 'Invalid data JSON' }; }
    // data 归一化：LLM 可能漏 labels / datasets 传成裸数组
    if (!data || typeof data !== 'object') return { success: false, error: 'Invalid data: expected {"labels":[...],"datasets":[{"label":"...","data":[...]}]}' };
    if (!Array.isArray(data.labels)) data.labels = data.labels != null ? [String(data.labels)] : [];
    if (!Array.isArray(data.datasets)) data.datasets = [{ label: args.title || 'data', data: [] }];
    data.datasets = data.datasets.map(ds => (ds && typeof ds === 'object') ? ds : { data: [] });
    for (const ds of data.datasets) if (!Array.isArray(ds.data)) ds.data = [];
    // [FIX 2026-09-05] labels 缺失时类目轴无锚点 → 实测图面近乎全白；按 dataset 长度合成序号标签
    const maxLen = data.datasets.reduce((m, d) => Math.max(m, (d.data || []).length), 0);
    if (!data.labels.length && maxLen > 0) data.labels = Array.from({ length: maxLen }, (_, i) => String(i + 1));
    await this._loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
    if (typeof Chart === 'undefined') return { success: false, error: 'Chart.js library failed to load (CDN unreachable). Retry once; if still failing, draw with create-image or inline SVG instead.' };
    const canvas = document.createElement('canvas');
    canvas.width = args.width || 800; canvas.height = args.height || 600;
    let chart;
    try {
      chart = new Chart(canvas, {
        type: chartType, data,
        options: {
          responsive: false,   // detached canvas 必须 false，否则被 resize 成 0×0
          animation: false,    // 同步完成绘制，后台标签页/无头环境不依赖 rAF
          devicePixelRatio: 2, // 高清导出
          plugins: {
            legend: { display: data.datasets.length > 1, position: 'top' },
            title: { display: !!args.title, text: args.title || '', font: { size: 16 } },
          },
          scales: ['pie', 'doughnut', 'polarArea'].includes(chartType) ? undefined : {
            x: { grid: { display: false } },
          },
        }
      });
    } catch (e) {
      return { success: false, error: 'Chart render failed: ' + ((e && e.message) || e) };
    }
    await new Promise(r => setTimeout(r, 100));
    // [FIX 2026-09-05] Chart.js 画布默认透明底，PNG 透明区在多数客户端渲染为黑色
    // （与 create-image 当初黑底同源）→ destination-over 在已绘内容下方垫白
    const cctx = canvas.getContext('2d');
    cctx.globalCompositeOperation = 'destination-over';
    cctx.fillStyle = '#FFFFFF';
    cctx.fillRect(0, 0, canvas.width, canvas.height);
    cctx.globalCompositeOperation = 'source-over';
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    try { chart.destroy(); } catch {}
    if (!blob) return { success: false, error: 'Canvas encode failed (toBlob null). Retry; if persists, use create-image instead.' };
    const filename = `chart_${Date.now()}.png`;
    await this._saveToVS(ctx, filename, blob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, filename, blob);
    return { success: true, output: `Chart created: ${filename} (${chartType}, ${canvas.width}x${canvas.height}) and sent to user.`, files: [filename] };
  },

  // ── create-image ──
  // [FIX 2026-09-05] 「总是黑底」两个根因：
  //   1) LLM 常用 "color" 字段名，旧代码只认 "fill" → fillStyle 保持默认黑色，
  //      白底 rect 实际画成全屏黑矩形；
  //   2) canvas 初始为全透明，LLM 忘铺背景时 PNG 透明区在客户端渲染成黑色。
  // 修复：默认铺白底（可被 args.background 覆盖）+ fill 色字段多名称兼容。
  async create_image(args, ctx) {
    const canvas = document.createElement('canvas');
    canvas.width = args.width || 800; canvas.height = args.height || 600;
    let insts; try { insts = JSON.parse(args.instructions); } catch { insts = null; }
    // [FIX 2026-09-05] instructions 格式归一化 — LLM 实测会传 4 种形态（对象包装形态
    // 曾导致 "insts is not iterable"），全部收敛为数组：
    //   1) 数组 [{type...}, ...]（标准）
    //   2) 对象 {"background":"#fff", "elements":[...]}（实测高频，v0.37 工具描述引导出来的）
    //   3) 单条指令对象 {type:"text",...}
    //   4) 纯文本 / 解析失败 → 白底+文字兜底图
    let bgColor = args.background || args.bg || null;
    if (Array.isArray(insts) && insts.length === 1 && insts[0] && typeof insts[0] === 'object' && Array.isArray(insts[0].elements)) {
      bgColor = bgColor || insts[0].background || insts[0].bg || null;
      insts = insts[0].elements;
    } else if (insts && typeof insts === 'object' && !Array.isArray(insts)) {
      if (Array.isArray(insts.elements)) {
        bgColor = bgColor || insts.background || insts.bg || null;
        insts = insts.elements;
      } else if (insts.type) {
        insts = [insts];
      } else {
        const txt = JSON.stringify(insts);
        insts = [{ type: 'rect', x: 0, y: 0, w: canvas.width, h: canvas.height, fill: bgColor || '#FFFFFF' },
                 { type: 'text', x: 80, y: Math.round(canvas.height / 2), text: txt, fill: '#000000', font: '20px sans-serif' }];
      }
    } else if (!Array.isArray(insts)) {
      // 字符串 / null / 解析失败 → 当作纯文本描述
      const txt = insts == null ? String(args.instructions || '') : String(insts);
      insts = [{ type: 'rect', x: 0, y: 0, w: canvas.width, h: canvas.height, fill: bgColor || '#FFFFFF' },
               { type: 'text', x: 80, y: Math.round(canvas.height / 2), text: txt, fill: '#000000', font: '20px sans-serif' }];
    }
    insts = insts.filter(it => it && typeof it === 'object');  // null/非对象元素守卫（曾致读属性抛 null 错）
    // [FIX 2026-09-05] type 字段缺省推断 — LLM 实测会传 {color,font,text,x,y} 这种
    // 不带 type 的元素（用户真实案例），旧逻辑全部分支不匹配 → 画出空白图。
    // 按字段特征推断：text / line / circle / rect（前置到预扫描，扩边计算也能覆盖）
    for (const it of insts) {
      if (it.type) continue;
      if (it.text != null) it.type = 'text';
      else if (it.x1 != null || it.x2 != null || it.y1 != null || it.y2 != null) it.type = 'line';
      else if (it.r != null || it.radius != null) it.type = 'circle';
      else if (it.w != null || it.width != null || it.h != null || it.height != null) it.type = 'rect';
    }
    // [FIX] 画布自适应：LLM 常漏传 width（如只给 height:700 却画 w:1200 的 rect），
    // 内容会被裁掉 → 按指令预扫描自动扩大画布（只扩不缩，上限 4096）
    let maxX = canvas.width, maxY = canvas.height;
    for (const it of insts) {
      const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
      if (it.type === 'rect' || it.type === 'rectangle') {
        maxX = Math.max(maxX, num(it.x) + num(it.w !== undefined ? it.w : it.width));
        maxY = Math.max(maxY, num(it.y) + num(it.h !== undefined ? it.h : it.height));
      } else if (it.type === 'circle') {
        maxX = Math.max(maxX, num(it.x) + num(it.r !== undefined ? it.r : it.radius));
        maxY = Math.max(maxY, num(it.y) + num(it.r !== undefined ? it.r : it.radius));
      } else if (it.type === 'line') {
        maxX = Math.max(maxX, num(it.x1), num(it.x2)); maxY = Math.max(maxY, num(it.y1), num(it.y2));
      } else if (it.type === 'text') {
        const fs = parseInt((String(it.font || '16px').match(/(\d+(?:\.\d+)?)px/) || [])[1] || '16', 10);
        maxX = Math.max(maxX, num(it.x) + String(it.text || '').length * fs * 0.62);
        maxY = Math.max(maxY, num(it.y) + fs);
      }
    }
    canvas.width = Math.min(Math.ceil(maxX), 4096);
    canvas.height = Math.min(Math.ceil(maxY), 4096);
    const c = canvas.getContext('2d');
    // 默认白底 — 消除 PNG 透明区渲染为黑底的问题（可被 args.background 或包装对象 background 覆盖）
    c.fillStyle = bgColor || '#FFFFFF';
    c.fillRect(0, 0, canvas.width, canvas.height);
    for (const inst of insts) {
      // 色值字段兼容：fill / color / fillStyle / bg / background（LLM 常用 color）
      const fill = inst.fill || inst.color || inst.fillStyle || inst.bg || inst.background;
      if (fill) c.fillStyle = fill;
      if (inst.stroke) c.strokeStyle = inst.stroke;
      if (inst.line_width || inst.lineWidth) c.lineWidth = inst.line_width || inst.lineWidth;
      if (inst.font) c.font = inst.font;
      if (inst.type === 'rect' || inst.type === 'rectangle') {
        const w = (inst.w !== undefined ? inst.w : inst.width) || 0;
        const h = (inst.h !== undefined ? inst.h : inst.height) || 0;
        c.fillRect(inst.x, inst.y, w, h);
      }
      else if (inst.type === 'circle') { c.beginPath(); c.arc(inst.x, inst.y, (inst.r !== undefined ? inst.r : inst.radius) || 0, 0, Math.PI*2); c.fill(); }
      else if (inst.type === 'line') { c.beginPath(); c.moveTo(inst.x1, inst.y1); c.lineTo(inst.x2, inst.y2); c.stroke(); }
      else if (inst.type === 'text') {
        if (!inst.font) c.font = '16px sans-serif';  // 旧代码用 canvas 默认 10px，太小
        // [FIX] 文字未指定颜色时默认黑 — 否则继承白底色画成"白字白底"不可见
        if (!fill) c.fillStyle = '#000000';
        c.fillText(inst.text, inst.x, inst.y);
      }
    }
    const blob = await new Promise(res => canvas.toBlob(res));
    if (!blob) return { success: false, error: 'Canvas encode failed (toBlob null). Retry; if persists, use inline SVG instead.' };
    const filename = `image_${Date.now()}.png`;
    await this._saveToVS(ctx, filename, blob);
    // [FIX] 自动通过 WS 发送给用户
    await this._autoSendFile(ctx, filename, blob);
    return { success: true, output: `Image created: ${filename} (${canvas.width}x${canvas.height}) and sent to user.`, files: [filename] };
  },

  // ── send-email ──
  async send_email(args, ctx) {
    // 通过 aicq 服务器代理发送（用户需要在设置里配 SMTP API）
    const config = ctx.agentConfig;
    if (!config.smtp_api_url) return { success: false, error: 'SMTP API not configured. Set it in agent settings.' };
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ url: config.smtp_api_url, mode: 'raw', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': config.smtp_api_key || '' },
        body: JSON.stringify({ to: args.to, subject: args.subject, body: args.body }) })
    });
    return { success: resp.ok, output: resp.ok ? 'Email sent.' : `Failed: ${resp.status}` };
  },

  // ── send-message ──
  // Supports text messages AND file sending from virtual FS
  async send_message(args, ctx) {
    if (!ctx.ws || ctx.ws.readyState !== 1) return { success: false, error: 'WS not connected' };
    
    // If file_path is specified, send a file message
    if (args.file_path) {
      const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
      const file = await AgentStorage.readFile(ctx.agentId, args.file_path);
      if (!file) return { success: false, error: 'File not found: ' + args.file_path };
      
      // Convert to base64
      const bytes = new Uint8Array(file.content);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      
      // Determine MIME type from filename
      const ext = args.file_path.split('.').pop().toLowerCase();
      const mimeTypes = {
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'pdf': 'application/pdf',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
        'txt': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
        'mp3': 'audio/mpeg', 'mp4': 'video/mp4', 'wav': 'audio/wav',
      };
      const mimeType = mimeTypes[ext] || 'application/octet-stream';
      const filename = args.filename || args.file_path.split('/').pop();
      
      // Send as file message via WS
      // Server expects media_data (base64 data URI) + file_info for file messages
      const fileInfo = JSON.stringify({ filename: filename, size: bytes.length, type: ext });
      ctx.ws.send(JSON.stringify({
        type: 'message',
        to: args.target_id,
        content: args.content || '',
        media_data: `data:${mimeType};base64,${base64}`,
        file_info: fileInfo,
      }));
      return { success: true, output: `File ${filename} (${bytes.length} bytes) sent to ${args.target_id}.` };
    }
    
    // Regular text message
    ctx.ws.send(JSON.stringify({ type: 'message', to: args.target_id, content: args.content, content_type: 'text' }));
    return { success: true, output: 'Message sent.' };
  },

  // ── check-messages ──
  async check_messages(args, ctx) {
    // 通过 WS 拉取，或者查 IndexedDB 里缓存的未读
    return { success: true, output: 'Use WS events to receive messages. No pending messages in buffer.' };
  },

  // ── task-plan ──
  async task_plan(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const planKey = `task_plan_${ctx.agentId}_${ctx.sessionId}`;
    if (args.action === 'create') {
      await AgentStorage.saveToKV(planKey, { plan: args.plan, created: Date.now(), tasks: args.plan.split('\n').filter(l => l.trim()).map((t, i) => ({ text: t, done: false })) });
      return { success: true, output: 'Task plan created.' };
    }
    if (args.action === 'update') {
      const plan = await AgentStorage.getFromKV(planKey);
      if (!plan) return { success: false, error: 'No task plan found' };
      if (plan.tasks[args.task_index]) { plan.tasks[args.task_index].done = args.completed; }
      await AgentStorage.saveToKV(planKey, plan);
      return { success: true, output: `Task ${args.task_index} updated.` };
    }
    if (args.action === 'get') {
      const plan = await AgentStorage.getFromKV(planKey);
      if (!plan) return { success: true, output: 'No current task plan.' };
      const text = plan.tasks.map((t, i) => `${t.done ? '[x]' : '[ ]'} ${i}. ${t.text}`).join('\n');
      return { success: true, output: text };
    }
    return { success: false, error: 'Unknown action' };
  },

  // ── alarm ──
  async alarm(args, ctx) {
    const ms = (args.minutes || 1) * 60 * 1000;
    setTimeout(() => {
      if (ctx.ws && ctx.ws.readyState === 1) {
        ctx.ws.send(JSON.stringify({ type: 'message', to: ctx.sessionId, content: `⏰ Reminder: ${args.reason}`, content_type: 'text' }));
      }
    }, ms);
    return { success: true, output: `Reminder set for ${args.minutes} minutes.` };
  },

  // ── system-info ──
  async system_info(args, ctx) {
    const info = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      cookies: navigator.cookieEnabled,
      online: navigator.onLine,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    return { success: true, output: JSON.stringify(info, null, 2), info };
  },

  // ── screenshot ──
  async screenshot(args, ctx) {
    await this._loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    const canvas = await html2canvas(document.body);
    const blob = await new Promise(res => canvas.toBlob(res));
    const filename = `screenshot_${Date.now()}.png`;
    await this._saveToVS(ctx, filename, blob);
    return { success: true, output: `Screenshot saved: ${filename}`, files: [filename] };
  },

  // ── translate ──
  async translate(args, ctx) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${args.from||'auto'}&tl=${args.to}&dt=t&q=${encodeURIComponent(args.text)}`;
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ url, mode: 'raw' })
    });
    if (!resp.ok) return { success: false, error: 'Translate failed' };
    const data = await resp.json();
    const translated = JSON.parse(data.body)[0].map(s => s[0]).join('');
    return { success: true, output: translated };
  },

  // ── qr-code ──
  // [FIX] 使用 api.qrserver.com API 生成二维码 — 不依赖外部 JS 库
  async qr_code(args, ctx) {
    const size = args.size || 256;
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(args.data)}`;
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ url, mode: 'raw' })
    });
    if (!resp.ok) return { success: false, error: 'QR code API failed: ' + resp.status };
    const data = await resp.json();
    if (!data.body) return { success: false, error: 'QR code API returned empty' };
    // web-proxy returns binary data as a string — convert via charCode
    // (atob fails because binary contains chars outside Latin1 range)
    const str = data.body;
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    const blob = new Blob([bytes], { type: 'image/png' });
    const filename = `qr_${Date.now()}.png`;
    await this._saveToVS(ctx, filename, blob);
    await this._autoSendFile(ctx, filename, blob);
    return { success: true, output: `QR code created: ${filename} and sent to user.`, files: [filename] };
  },

  // ── read-clipboard ──
  async read_clipboard(args, ctx) {
    const text = await navigator.clipboard.readText();
    return { success: true, output: text };
  },

  // ── write-clipboard ──
  async write_clipboard(args, ctx) {
    await navigator.clipboard.writeText(args.text);
    return { success: true, output: 'Clipboard updated.' };
  },

  // ── download-file ──
  // Downloads a file from virtual FS to the user's device
  // In headless/PWA mode, triggers browser download
  async download_file(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const file = await AgentStorage.readFile(ctx.agentId, args.path);
    if (!file) return { success: false, error: 'File not found' };
    const blob = new Blob([file.content]);
    const filename = args.filename || args.path.split('/').pop();
    
    // Try browser download
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch(e) { console.warn('[download-file] Browser download failed:', e); }
    
    return { success: true, output: `Downloaded: ${filename} (${blob.size} bytes). The file has been saved to the virtual FS at ${args.path} and downloaded to the user device.` };
  },

  // ── upload-file ──
  // [FIX 2026-09-06] 原实现在无头环境/用户取消时会永久挂起（promise 永不 resolve，
  // 卡死整个 agent 循环 45s+）。补 oncancel 监听 + 90s 兑底超时。
  async upload_file(args, ctx) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => done({ success: false, error: 'Upload timed out: no file selected within 60s (file dialog dismissed or not supported in this environment).' }), 60000);
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) { done({ success: false, error: 'No file selected' }); return; }
        try {
          const buf = await file.arrayBuffer();
          const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
          await AgentStorage.saveFile(ctx.agentId, args.dest_path, buf);
          done({ success: true, output: `File uploaded to ${args.dest_path} (${file.size} bytes)` });
        } catch (err) { done({ success: false, error: 'Upload failed: ' + err.message }); }
      };
      if (typeof input.oncancel !== 'undefined') input.oncancel = () => done({ success: false, error: 'Upload cancelled by user (no file selected).' });
      input.click();
    });
  },

  // ── weather ──
  // [FIX 2026-09-06] 原实现拉 wttr.in 的 j1 大 JSON（>40KB），被 web-proxy 的
  // 20000 字符截断后 JSON.parse 必炸（"Unterminated string at position 20000"）。
  // 改用紧凑文本格式（单行、无 JSON），另保留 j1 兜底 + 容错解析。
  async weather(args, ctx) {
    const loc = String(args.location || '').trim();
    // [FIX 2026-09-06] 三级策略（wttr.in 无 CORS 头、open-meteo 有每 IP 日限额，
    // 单一源都会翻车）：
    //   ① 本地/容器形态：wttr.in 经 web-proxy（curl UA 才能拿紧凑文本）
    //   ② 静态形态：nominatim(OSM) 地理编码 + met.no compact（均免 key + CORS 全开）
    //   ③ 互为兜底，全失败才报错
    // ① wttr.in via proxy
    try {
      const locEnc = encodeURIComponent(loc);
      const body = await this._proxyBody(`https://wttr.in/${locEnc}?format=%C,+%t,+humidity+%h,+wind+%w&m`, ctx, { 'User-Agent': 'curl/8.0' });
      if (body && !body.trim().startsWith('<') && !/Unknown|ERROR|blocked/i.test(body.slice(0, 60))) {
        return { success: true, output: `${loc}: ${body.trim().slice(0, 300)}` };
      }
    } catch (e) { /* static mode has no proxy — try met.no below */ }
    // ② met.no (browser-reachable, CORS-open)
    try {
      let lat = null, lon = null, place = loc;
      const nom = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(loc), { headers: { 'Accept': 'application/json' } });
      const nj = await nom.json();
      if (nj && nj[0]) {
        lat = parseFloat(nj[0].lat); lon = parseFloat(nj[0].lon);
        place = (nj[0].display_name || loc).split(',').slice(0, 2).join(',');
      }
      if (lat !== null) {
        const mr = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`);
        if (mr.ok) {
          const mj = await mr.json();
          const ts = mj.properties?.timeseries?.[0];
          const d = ts?.data?.instant?.details || {};
          const sym = ts?.data?.next_1_hours?.summary?.symbol_code || '';
          const desc = this._metnoText(sym);
          if (d.air_temperature !== undefined) {
            return { success: true, output: `${place}: ${desc}, ${Math.round(d.air_temperature)}°C, Humidity ${Math.round(d.relative_humidity?.humidity ?? d.relative_humidity ?? 0)}%, Wind ${Math.round(d.wind_speed ?? 0)}km/h` };
          }
        }
      }
    } catch (e) { /* fall through */ }
    // ③ open-meteo 最后尝试（每日限额可能已耗尽，尽力而为）
    try {
      const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(loc));
      const g = await geo.json();
      const hit = g.results && g.results[0];
      if (hit) {
        const wResp = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + hit.latitude + '&longitude=' + hit.longitude + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m');
        const w = await wResp.json();
        if (w.current && w.current.temperature_2m !== undefined) {
          const c = w.current;
          return { success: true, output: `${hit.name}${hit.country ? ', ' + hit.country : ''}: ${this._wmoText(c.weather_code)}, ${c.temperature_2m}°C, Humidity ${c.relative_humidity_2m}%, Wind ${c.wind_speed_10m}km/h` };
        }
      }
    } catch (e) { /* final fall through */ }
    return { success: false, error: `Weather data unavailable for ${loc} (all three sources failed)` };
  },

  // met.no symbol_code → 文本（按前缀归并）
  _metnoText(sym) {
    if (!sym) return 'Unknown';
    const s = sym.split('_')[0];
    const map = { clearsky: 'Clear sky', fair: 'Fair', partlycloudy: 'Partly cloudy', cloudy: 'Cloudy', rain: 'Rain', lightrain: 'Light rain', heavyrain: 'Heavy rain', rainshowers: 'Rain showers', snow: 'Snow', lightsnow: 'Light snow', heavysnow: 'Heavy snow', snowshowers: 'Snow showers', sleet: 'Sleet', fog: 'Fog', thunder: 'Thunderstorm' };
    return map[s] || sym;
  },

  // WMO weather code → 文本（open-meteo 标准）
  _wmoText(code) {
    const map = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 56: 'Light freezing drizzle', 57: 'Dense freezing drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 66: 'Light freezing rain', 67: 'Heavy freezing rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail' };
    return map[code] !== undefined ? map[code] + ' (code ' + code + ')' : 'Unknown (code ' + code + ')';
  },

  // web-proxy POST 的公共小封装（返回 body 文本；可覆盖请求头）
  async _proxyBody(url, ctx, extraHeaders) {
    const resp = await fetch('/api/v1/agent/web-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this._authToken(ctx) },
      body: JSON.stringify({ url, mode: 'raw', headers: extraHeaders || {} })
    });
    if (!resp.ok) throw new Error('proxy ' + resp.status);
    const data = await resp.json();
    return data.body || '';
  },

  // ── export-data ──
  async export_data(args, ctx) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const data = await AgentStorage.exportAgent(ctx.agentId);
    if (!data) return { success: false, error: 'No agent data found' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agent_${ctx.agentId}_export.json`;
    a.click();
    return { success: true, output: 'Agent database exported.' };
  },

  // ── selfaicq: manage agent's own AICQ account ──
  async selfaicq(args, ctx) {
    const result = await this._aicqAction(args, ctx, 'self');
    // [FIX] 不管 selfaicq 成功或失败，只要 action 是 list_friends，就尝试追加 owner 的好友列表
    // 因为用户口中的"发给某人"几乎总是 owner 的好友，不是 agent 自己的
    // 这样 AI 在一次调用里就能看到两个列表，避免"找不到 Leo"
    if (args.action === 'list_friends') {
      try {
        const ownerToken = (typeof S !== 'undefined' && S.accessToken) || localStorage.getItem('aicq_at');
        if (ownerToken) {
          const ownerHeaders = { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
          const r = await fetch('/api/v1/friends/', { headers: ownerHeaders });
          if (r.ok) {
            const data = await r.json();
            const ownerFriends = (data.friends || []).map(f => {
              const name = f.remark_name || f.display_name || f.agent_name || '?';
              const online = f.is_online ? 'online' : 'offline';
              return `${f.id} (${f.type||'human'}) ${name} [${online}]`;
            }).join('\n');
            if (ownerFriends) {
              const agentList = result.success ? (result.output || '(empty)') : '(failed to load)';
              result.output = `=== Agent's own friends ===\n${agentList}\n\n=== Owner's friends (use owneraicq to operate on these) ===\n${ownerFriends}`;
              result.success = true;  // 整体成功（至少 owner 列表拿到了）
              result.results = [...(result.results || []), ...(data.friends || [])];
            }
          }
        }
      } catch(e) { /* fallback 失败不影响主流程 */ }
    }
    return result;
  },

  // ── owneraicq: manage owner's AICQ account ──
  async owneraicq(args, ctx) {
    return this._aicqAction(args, ctx, 'owner');
  },

  // ─── AICQ action core (shared by selfaicq and owneraicq) ───
  async _aicqAction(args, ctx, scope) {
    // scope: 'self' = agent's own token, 'owner' = owner's token
    let token;
    if (scope === 'self') {
      token = ctx.agentConfig?.access_token;
      if (!token) return { success: false, error: 'Agent access_token not configured' };
    } else {
      // Owner's token from browser state
      token = (typeof S !== 'undefined' && S.accessToken) || localStorage.getItem('aicq_at');
      if (!token) return { success: false, error: 'Owner not logged in. Please login to AICQ first.' };
    }

    const action = args.action || 'list_friends';
    const limit = args.limit || 20;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
      switch (action) {
        // ── Friends ──
        case 'list_friends': {
          const r = await fetch('/api/v1/friends/', { headers });
          const data = await r.json();
          // [FIX] 检查 HTTP 状态码，401/403 等错误时返回 success=false
          if (!r.ok) {
            return { success: false, error: data?.error?.message || `HTTP ${r.status}` };
          }
          const friends = (data.friends || data || []).map(f => {
            // 优先级: remark_name > display_name > agent_name > '?'
            // （AI 类型好友可能 display_name 为空，需要 fallback 到 agent_name）
            const name = f.remark_name || f.display_name || f.agent_name || '?';
            const online = f.is_online ? 'online' : 'offline';
            return `${f.id} (${f.type||'human'}) ${name} [${online}]`;
          }).join('\n');
          return { success: true, output: friends || 'No friends', results: data.friends || data };
        }
        case 'list_requests': {
          const r = await fetch('/api/v1/friends/requests', { headers });
          const data = await r.json();
          const reqs = (data.requests || data || []).map(rq =>
            `${rq.id}: from ${rq.from_id||rq.account_id} "${rq.message||''}" [${rq.status||'pending'}]`
          ).join('\n');
          return { success: true, output: reqs || 'No friend requests', results: data.requests || data };
        }
        case 'accept_request': {
          if (!args.request_id) return { success: false, error: 'request_id required' };
          const r = await fetch(`/api/v1/friends/requests/${args.request_id}/accept`, { method: 'POST', headers });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Friend request accepted' };
        }
        case 'reject_request': {
          if (!args.request_id) return { success: false, error: 'request_id required' };
          const r = await fetch(`/api/v1/friends/requests/${args.request_id}/reject`, { method: 'POST', headers });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Friend request rejected' };
        }
        case 'send_request': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };
          const r = await fetch('/api/v1/friends/request', {
            method: 'POST', headers,
            body: JSON.stringify({ to_id: args.friend_id, message: args.content || 'Hi, I want to add you as a friend' })
          });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Friend request sent' };
        }
        case 'remove_friend': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };
          const r = await fetch(`/api/v1/friends/${args.friend_id}`, { method: 'DELETE', headers });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Friend removed' };
        }

        // ── Chat ──
        case 'chat_history': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };
          const r = await fetch(`/api/v1/chat/conversation/${args.friend_id}?limit=${limit}`, { headers });
          const data = await r.json();
          const msgs = (data.messages || []).map(m =>
            `[${m.created_at?.slice(0,19)||''}] ${m.from_id===ctx.agentId?'Me':'Them'}: ${m.content?.slice(0,200)||''}`
          ).join('\n');
          return { success: true, output: msgs || 'No messages', results: data.messages };
        }
        case 'send_message': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };
          // 兼容纯文本 + 带 media_url/file_info 的混合消息
          const payload = { to_id: args.friend_id, type: args.type || 'text' };
          if (args.content) payload.content = args.content;
          if (args.media_url) payload.media_url = args.media_url;
          if (args.file_info) payload.file_info = typeof args.file_info === 'string' ? args.file_info : JSON.stringify(args.file_info);
          if (args.metadata) payload.metadata = typeof args.metadata === 'string' ? args.metadata : JSON.stringify(args.metadata);
          if (!payload.content && !payload.media_url) {
            return { success: false, error: 'content or media_url required' };
          }
          const r = await fetch('/api/v1/chat/messages', {
            method: 'POST', headers,
            body: JSON.stringify(payload)
          });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Message sent' };
        }
        // ── Send a file to a friend ──
        // 支持三种来源（按优先级）：
        //   1) args.file_path  → 从智能体虚拟文件系统读取
        //   2) args.url        → 直接用外部 URL（如 https://...）
        //   3) args.content_base64 + args.filename + args.mime_type → 内联 base64
        // 流程：先把文件上传到 /api/v1/chat/upload（外部 URL 跳过），再用 send_message 发送 file 类型消息
        case 'send_file': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };

          // [FIX 2026-09-05] 按扩展名推断 MIME（args.mime_type 未传时），
          // 否则 HTML 文件 file_info.mimeType 落到 octet-stream，接收端无法识别/预览
          const _EXT_MIME = { html:'text/html', htm:'text/html', css:'text/css', json:'application/json',
            js:'text/javascript', txt:'text/plain', csv:'text/csv', md:'text/markdown',
            png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
            svg:'image/svg+xml', pdf:'application/pdf', mp3:'audio/mpeg', mp4:'video/mp4',
            wav:'audio/wav', webm:'video/webm', zip:'application/zip' };
          const mimeFor = (fn) => args.mime_type || _EXT_MIME[(fn||'').split('.').pop()?.toLowerCase()] || 'application/octet-stream';

          let mediaUrl = args.url || '';
          let fileInfo = null;
          const filename = args.filename || args.file_path?.split('/').pop() || `file_${Date.now()}`;

          // (1) 从 VS 读取
          if (args.file_path) {
            const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
            const f = await AgentStorage.readFile(ctx.agentId, args.file_path);
            if (!f) return { success: false, error: `File not found in agent FS: ${args.file_path}` };
            const blob = new Blob([f.content], { type: mimeFor(filename) });
            const fd = new FormData();
            fd.append('file', blob, filename);
            const up = await fetch('/api/v1/chat/upload', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },  // 不要设 Content-Type，让浏览器自动加 boundary
              body: fd
            });
            const upData = await up.json();
            if (!up.ok || upData.error) return { success: false, error: upData.error?.message || `Upload failed: ${up.status}` };
            mediaUrl = upData.url;
            fileInfo = { filename: upData.original_name || filename, size: upData.file_size || f.size, mimeType: mimeFor(filename) };
          }
          // (2) 内联 base64
          else if (args.content_base64) {
            const bin = atob(args.content_base64);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: mimeFor(filename) });
            const fd = new FormData();
            fd.append('file', blob, filename);
            const up = await fetch('/api/v1/chat/upload', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: fd
            });
            const upData = await up.json();
            if (!up.ok || upData.error) return { success: false, error: upData.error?.message || `Upload failed: ${up.status}` };
            mediaUrl = upData.url;
            fileInfo = { filename: upData.original_name || filename, size: upData.file_size || buf.length, mimeType: mimeFor(filename) };
          }
          // (3) 外部 URL：直接用，不上传
          else if (args.url) {
            fileInfo = { filename: args.filename || args.url.split('/').pop() || 'file', size: 0, mimeType: mimeFor(args.url.split('/').pop()), external: true };
          }
          else {
            return { success: false, error: 'One of file_path / url / content_base64 required' };
          }

          // 推断 type：image/* → image，否则 file
          const mimeType = fileInfo?.mimeType || '';
          const msgType = mimeType.startsWith('image/') ? 'image' : (mimeType.startsWith('audio/') ? 'voice' : 'file');

          const payload = {
            to_id: args.friend_id,
            type: msgType,
            content: args.content || filename,  // 文件消息里 content 通常用作 caption / 文件名
            media_url: mediaUrl,
            file_info: JSON.stringify(fileInfo)
          };
          const r = await fetch('/api/v1/chat/messages', {
            method: 'POST', headers,
            body: JSON.stringify(payload)
          });
          const data = await r.json();
          if (data.error) return { success: false, error: data.error.message };
          return { success: true, output: `File sent: ${filename} (${fileInfo.size} bytes) → ${args.friend_id}`, media_url: mediaUrl };
        }
        // ── List files in agent virtual FS ──
        case 'list_files': {
          const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
          const files = await AgentStorage.listFiles(ctx.agentId, args.dir || '/');
          const list = (files || []).map(f => `${f.path} (${f.size||0} bytes)`).join('\n');
          return { success: true, output: list || 'No files in agent FS', results: files };
        }
        case 'get_unread': {
          const r = await fetch('/api/v1/chat/unread', { headers });
          const data = await r.json();
          return { success: true, output: JSON.stringify(data), results: data };
        }
        case 'mark_read': {
          if (!args.friend_id) return { success: false, error: 'friend_id required' };
          const r = await fetch('/api/v1/chat/mark-read', {
            method: 'POST', headers,
            body: JSON.stringify({ friend_id: args.friend_id })
          });
          return { success: true, output: 'Marked as read' };
        }

        // ── Groups ──
        case 'list_groups': {
          const r = await fetch('/api/v1/groups', { headers });
          const data = await r.json();
          const groups = (data.groups || data || []).map(g =>
            `${g.id}: ${g.name} (${g.member_count||0} members)`
          ).join('\n');
          return { success: true, output: groups || 'No groups', results: data.groups || data };
        }
        case 'create_group': {
          if (!args.group_name) return { success: false, error: 'group_name required' };
          const r = await fetch('/api/v1/groups', {
            method: 'POST', headers,
            body: JSON.stringify({ name: args.group_name })
          });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : `Group created: ${data.id}` };
        }
        case 'group_info': {
          if (!args.group_id) return { success: false, error: 'group_id required' };
          const r = await fetch(`/api/v1/groups/${args.group_id}`, { headers });
          const data = await r.json();
          return { success: true, output: JSON.stringify(data, null, 2), results: data };
        }
        case 'group_messages': {
          if (!args.group_id) return { success: false, error: 'group_id required' };
          const r = await fetch(`/api/v1/groups/${args.group_id}/messages?limit=${limit}`, { headers });
          const data = await r.json();
          const msgs = (data.messages || []).map(m =>
            `[${m.created_at?.slice(0,19)||''}] ${m.from_id}: ${m.content?.slice(0,200)||''}`
          ).join('\n');
          return { success: true, output: msgs || 'No messages', results: data.messages };
        }
        case 'invite_member': {
          if (!args.group_id || !args.member_id) return { success: false, error: 'group_id and member_id required' };
          const r = await fetch(`/api/v1/groups/${args.group_id}/members`, {
            method: 'POST', headers,
            body: JSON.stringify({ account_id: args.member_id })
          });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Member invited' };
        }
        case 'kick_member': {
          if (!args.group_id || !args.member_id) return { success: false, error: 'group_id and member_id required' };
          const r = await fetch(`/api/v1/groups/${args.group_id}/members/${args.member_id}`, { method: 'DELETE', headers });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Member removed' };
        }
        case 'leave_group': {
          if (!args.group_id) return { success: false, error: 'group_id required' };
          const r = await fetch(`/api/v1/groups/${args.group_id}/leave`, { method: 'POST', headers });
          const data = await r.json();
          return { success: !data.error, output: data.error ? data.error.message : 'Left group' };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Supported: list_friends|chat_history|send_message|send_file|list_files|list_requests|accept_request|reject_request|send_request|remove_friend|list_groups|create_group|group_info|group_messages|invite_member|kick_member|leave_group|get_unread|mark_read` };
      }
    } catch(e) {
      return { success: false, error: 'AICQ API error: ' + e.message };
    }
  },

  // ── workflow ──
  async workflow(args, ctx) {
    const { AgentWorkflow } = await import('/static/agent/agent-workflow.js');
    const action = args.action || 'list';
    const agentId = ctx.agentId;

    if (action === 'list') {
      const workflows = await AgentWorkflow.list(agentId);
      const text = workflows.map(w => `${w.id}: ${w.name} (${w.steps.length} steps, ${w.enabled?'enabled':'disabled'}, runs: ${w.run_count||0})`).join('\n');
      return { success: true, output: text || 'No workflows found.', results: workflows };
    }
    if (action === 'create') {
      let steps = [];
      try { steps = JSON.parse(args.steps || '[]'); } catch(e) {}
      const wf = await AgentWorkflow.create(agentId, { name: args.name || 'Untitled', description: args.description || '', steps });
      return { success: true, output: `Workflow created: ${wf.id} (${wf.name})`, workflow: wf };
    }
    if (action === 'get') {
      const wf = await AgentWorkflow.get(agentId, args.workflow_id);
      return { success: !!wf, output: wf ? JSON.stringify(wf, null, 2) : 'Workflow not found', workflow: wf };
    }
    if (action === 'run') {
      const result = await AgentWorkflow.run(agentId, args.workflow_id);
      return { success: result.success, output: result.success ? `Workflow completed. ${result.run.steps.length} steps executed.` : `Workflow failed: ${result.run?.error}`, run: result.run };
    }
    if (action === 'update') {
      let updates = {};
      if (args.name) updates.name = args.name;
      if (args.description) updates.description = args.description;
      if (args.steps) { try { updates.steps = JSON.parse(args.steps); } catch(e) {} }
      const wf = await AgentWorkflow.update(agentId, args.workflow_id, updates);
      return { success: !!wf, output: wf ? 'Workflow updated.' : 'Workflow not found' };
    }
    if (action === 'delete') {
      await AgentWorkflow.delete(agentId, args.workflow_id);
      return { success: true, output: 'Workflow deleted.' };
    }
    if (action === 'runs') {
      const runs = await AgentWorkflow.listRuns(agentId, args.workflow_id, 10);
      const text = runs.map(r => `${r.started_at?.slice(0,19)}: ${r.status} (${r.steps.length} steps)`).join('\n');
      return { success: true, output: text || 'No runs found.', results: runs };
    }
    return { success: false, error: 'Unknown action: ' + action };
  },

  // ─── 辅助方法 ───
  async _loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  },

  async _saveToVS(ctx, filename, blob) {
    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const buf = await blob.arrayBuffer();
    await AgentStorage.saveFile(ctx.agentId, '/' + filename, buf);
  },

  // [ADD 2026-09-07 v0.4.8] 独立壳文件投递通道 — aicq.me 全量前端靠 _autoSendFile 发出的
  // message 帧渲染文件卡（chat-messaging.js msgType==='file' 分支 + HTML「预览」按钮），
  // 但独立壳（pip 本地 / HF / MS 静态壳）的 LocalBus 只处理 stream_chunk/stream_end，
  // message 帧被静默丢弃 → 用户在聊天里看不到智能体产出的任何文件。
  // 这里补发一条 chunkType='file' 的 stream_chunk，由 app.js UI.onChunk 渲染
  // （图片内联 / HTML 预览卡 / 通用下载卡）。严格限定独立壳：ctx.ws === window.__localBus
  // （app.js 注入的本地总线）；aicq.me 真实 WS 下不发送，避免污染服务端流缓冲与全量前端。
  _emitFileChunk(ctx, filename, mime, dataURI, size) {
    try {
      if (!ctx || !ctx.ws || ctx.ws.readyState !== 1) return;
      if (typeof window === 'undefined' || !window.__localBus || ctx.ws !== window.__localBus) return;
      ctx.ws.send(JSON.stringify({
        type: 'stream_chunk',
        to: ctx.replyTarget || ctx.sessionId,
        from: ctx.agentId,
        stream_id: 'file_' + Date.now(),
        chunkType: 'file',
        chat_session_id: (String(ctx.sessionId || '').startsWith('cs_')) ? ctx.sessionId : '',
        data: {
          filename: String(filename || 'file'),
          mime: mime || 'application/octet-stream',
          size: size || 0,
          data: dataURI,
        },
      }));
    } catch (e) { console.warn('[emitFileChunk] failed:', e); }
  },

  // [FIX] 自动通过 WS 把文件发送给 owner (sessionId)
  async _autoSendFile(ctx, filename, blob) {
    // [FIX] Guard against undefined filename — LLM sometimes omits filename
    if (!filename) {
      console.warn('[autoSendFile] No filename provided, skipping WS send');
      return;
    }
    if (!ctx.ws || ctx.ws.readyState !== 1) {
      console.warn('[autoSendFile] WS not connected, file saved to VS only:', filename);
      return;
    }
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'pdf': 'application/pdf',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
      'txt': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const fileInfo = JSON.stringify({ filename: filename, size: bytes.length, type: ext });
    // [FIX] Wrap in data object with type='file' and media_url='p2p:local'
    // The server's handleMessage extracts msgType from data.type, and the frontend
    // renders file messages only when msgType==='file'. Without this, the message
    // is saved as type='text' with empty content, showing as an empty bubble.
    // media_url='p2p:local' tells the frontend to use media_data (base64) for download.
    try {
      // [FIX 2026-08-29] Stamp chat_session_id so the server persists the file
      // message under the SAME chat session it belongs to. Without it the
      // direct_messages row has no csid in metadata and the session-scoped
      // history query (?session_id=cs_xxx) drops the row — the file card
      // disappears after navigating away and reopening the conversation.
      // Only stamp genuine cs_ values: stamping an account-id fallback would
      // make the row mismatch EVERY session filter and hide it everywhere.
      const _isGrpTarget = String(ctx.replyTarget || '').startsWith('grp_');
      const _csid = (!_isGrpTarget && String(ctx.sessionId || '').startsWith('cs_')) ? ctx.sessionId : '';
      ctx.ws.send(JSON.stringify({
        type: 'message',
        to: ctx.replyTarget || ctx.sessionId, // [FIX 2026-08-29] must be a real account_id — cs_xxx is not routable
        data: {
          type: 'file',
          content: '',
          media_url: 'p2p:local',
          media_data: `data:${mimeType};base64,${base64}`,
          file_info: fileInfo,
          transfer_mode: 'p2p',
          chat_session_id: _csid,
        },
      }));
      // Also save P2P media to local IndexedDB so recipient can download later
      if (typeof LocalDB !== 'undefined' && LocalDB.saveP2PMedia) {
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        LocalDB.saveP2PMedia(msgId, `data:${mimeType};base64,${base64}`, mimeType, filename);
      }
      console.log('[autoSendFile] Sent:', filename, '(' + bytes.length + ' bytes) to', ctx.replyTarget || ctx.sessionId);
    } catch(e) {
      console.error('[autoSendFile] Failed:', e);
    }
    // [ADD 2026-09-07 v0.4.8] 独立壳渲染通道（见 _emitFileChunk 注释）—
    // 同一份 base64 复用，aicq.me 不受影响（独立壳判定在 _emitFileChunk 内部）
    this._emitFileChunk(ctx, filename, mimeType, `data:${mimeType};base64,${base64}`, bytes.length);
  },

  // [FIX] 扩展 sheet 的 !ref 范围以包含新加的单元格
  // XLSX.write 会丢弃 !ref 范围外的单元格，导致 set_cell/set_formula 后内容丢失
  _extendRange(ws, cellAddr) {
    if (!ws['!ref']) {
      ws['!ref'] = cellAddr + ':' + cellAddr;
      return;
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cell = XLSX.utils.decode_cell(cellAddr);
    if (cell.r < range.s.r) range.s.r = cell.r;
    if (cell.r > range.e.r) range.e.r = cell.r;
    if (cell.c < range.s.c) range.s.c = cell.c;
    if (cell.c > range.e.c) range.e.c = cell.c;
    ws['!ref'] = XLSX.utils.encode_range(range);
  },

  // ══ analyze-image [2026-09-03] ═══════════════════════════════════
  // 图片识别工具：agent 主模型多数不带视觉（免费模型带图直接 400），
  // 收图时引擎把图片存入 _lastImages 槽位，主模型只收文字占位符；
  // 模型需要看图时调用本工具 → 经 llm-proxy 调用带视觉的免费模型。
  // 视觉模型实测（2026-09-03，OpenCode Zen 全部 8 个 free 模型）：
  //   mimo-v2.5-free ✅ 唯一能看图且答对；其余 chat 端 free 带图 400；
  //   muse-spark 走 /responses 且区域受限。故链路以 mimo 为默认，
  //   后接 nemotron/deepseek/laguna 作地域差异兜底；成功模型写 localStorage 缓存。
  _lastImages: {},   // sessionId → { dataUrl, ts }

  rememberImage(sessionId, dataUrl) {
    try {
      this._lastImages[sessionId] = { dataUrl: String(dataUrl || ''), ts: Date.now() };
      // 防膨胀：只保留最近 8 个会话的图片
      const keys = Object.keys(this._lastImages);
      if (keys.length > 8) {
        keys.sort((a, b) => this._lastImages[a].ts - this._lastImages[b].ts);
        for (const k of keys.slice(0, keys.length - 8)) delete this._lastImages[k];
      }
    } catch (e) {}
  },

  // ── search-session-history ──
  // [2026-09-04] 上下文压缩机制的配套回查工具：当历史被压缩成交接日志后，
  // 智能体可用它按关键字检索当前会话的【全部】历史（含被压缩出上下文的早期记录）。
  async search_session_history(args, ctx) {
    const keyword = String((args && args.keyword) || '').trim();
    if (!keyword) {
      return { success: false, error: 'keyword is required (e.g. keyword="deploy flow" or keyword="api key")' };
    }
    const sessionId = String((args && args.session_id) || (ctx && ctx.sessionId) || '').trim();
    if (!sessionId) {
      return { success: false, error: 'session_id is required (no current session in context — pass session_id explicitly)' };
    }
    let topN = parseInt(args && args.top_n, 10);
    if (!Number.isFinite(topN) || topN <= 0) topN = 10;
    topN = Math.min(50, topN);

    const AgentStorage = (await import('/static/agent/agent-storage.js')).default;
    const matches = await AgentStorage.searchSessionHistory(ctx.agentId, sessionId, keyword, topN);
    if (!matches || matches.length === 0) {
      return { success: true, output: `No history records matching "${keyword}" in session ${sessionId}. Try a different keyword (shorter, or in the other language).`, count: 0 };
    }
    const ROLE_CN = { user: 'user', assistant: 'agent', tool: 'tool result' };
    const lines = matches.map((m, i) => {
      const role = ROLE_CN[m.role] || m.role;
      const tcNote = (m.tool_calls && m.tool_calls.length) ? ` [tool calls: ${m.tool_calls.join(', ')}]` : '';
      return `${i + 1}. [${m.created_at}] ${role}${tcNote}: ${m.content}`;
    });
    return {
      success: true,
      count: matches.length,
      output: `History in session ${sessionId} matching "${keyword}" (newest ${matches.length}, newest first):\n\n` + lines.join('\n\n')
    };
  },

  async analyze_image(args, ctx) {
    // [2026-09-03 服务器实测] muse-spark-1.3 经 /responses + input_image 从 samai.cc 区域可用且答对；
    // mimo-v2.5-free 直测可看图但从服务器 IP 常退 429 FreeUsageLimitError；
    // 其余 chat 端 free 模型带图直接 400。链路顺序即实测优先级。
    const VISION_CHAIN = ['muse-spark-1.3-contributor-free', 'mimo-v2.5-free', 'muse-spark-1.2-contributor-free', 'nemotron-3-ultra-free', 'deepseek-v4-flash-free'];
    const CACHE_KEY = 'aicq_agent_vision_model_v1';
    const MAX_AGE_MS = 30 * 60 * 1000;   // "最新图片"有效期 30 分钟

    // 1. 解析图片来源 → dataURI
    let dataUrl = '';
    const src = String((args && args.image) || 'latest').trim();
    if (src === 'latest' || src === '') {
      const best = this._lastImages[ctx.sessionId] || null;
      if (!best || !best.dataUrl || Date.now() - best.ts > MAX_AGE_MS) {
        return { success: false, error: 'No recent image in this chat (received images expire after 30 min). Ask the user to re-send the image, or pass an image URL / data URI.' };
      }
      dataUrl = best.dataUrl;
    } else if (/^data:image\//i.test(src)) {
      dataUrl = src;
    } else if (/^https?:\/\//i.test(src)) {
      dataUrl = await this._analyzeFetchImage(src, ctx);
      if (!dataUrl) return { success: false, error: 'Could not download image from URL (not an image, or fetch blocked): ' + src.slice(0, 120) };
    } else {
      return { success: false, error: 'Unsupported image source. Use "latest" (omit), an http(s) URL, or a data:image/... data URI. Got: ' + src.slice(0, 60) };
    }

    // 2. 大图降采样（>2MB base64 → 最长边 1600px JPEG，避免请求体过大）
    if (dataUrl.length > 2 * 1024 * 1024) {
      dataUrl = await this._analyzeDownscale(dataUrl, 1600);
    }

    // 3. 提问
    const question = String((args && args.question) || '').trim() ||
      '请详细描述这张图片：主要物体/场景、所有可见文字（原样给出）、颜色、品牌或标识，以及值得注意的细节。';

    // 4. 视觉模型链：缓存优先 → 实测可用链
    let cached = '';
    try { cached = localStorage.getItem(CACHE_KEY) || ''; } catch (e) {}
    const chain = [];
    for (const m of [cached].concat(VISION_CHAIN)) {
      if (m && chain.indexOf(m) === -1) chain.push(m);
    }
    const errors = [];
    for (const model of chain) {
      const r = await this._visionDescribe(model, dataUrl, question, ctx);
      if (r.success) {
        try { localStorage.setItem(CACHE_KEY, model); } catch (e) {}
        return { success: true, output: r.output, model: model };
      }
      errors.push(model + ': ' + String(r.error || '').slice(0, 140));
      if (model === cached) { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }
    }
    return { success: false, error: 'All vision models failed — ' + errors.join(' | ') };
  },

  // 经 llm-proxy 下载图片（解决 CORS + aicq 内部文件的鉴权），返回 dataURI
  async _analyzeFetchImage(url, ctx) {
    const tok = this._authToken(ctx);
    const inner = {};
    const isInternal = url.indexOf(location.origin) === 0 ||
                       (url.indexOf('/api/') !== -1 && url.indexOf('opencode') === -1);
    if (isInternal && tok) inner['Authorization'] = 'Bearer ' + tok;
    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify({ target_url: url, method: 'GET', headers: inner, stream: false })
    });
    if (!resp.ok) return '';
    const blob = await resp.blob();
    if (!(blob.type || '').startsWith('image/')) return '';
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res('');
      fr.readAsDataURL(blob);
    });
  },

  // Canvas 降采样：最长边 ≤ maxDim，输出 JPEG（失败原样返回）
  async _analyzeDownscale(dataUrl, maxDim) {
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('img load'));
        i.src = dataUrl;
      });
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return dataUrl;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.85);
      return (out && out.length < dataUrl.length) ? out : dataUrl;
    } catch (e) { return dataUrl; }
  },

  // 单个视觉模型调用 — 按模型端点协议选格式，经 llm-proxy 中继
  //   muse-spark-* → /responses (input_image, max_output_tokens 要给足：思考即耗 500+)
  //   其他        → /chat/completions (image_url)
  async _visionDescribe(model, dataUrl, question, ctx) {
    const tok = this._authToken(ctx);
    const isResponses = String(model).indexOf('muse-spark') === 0;
    const target = 'https://opencode.ai/zen/v1/' + (isResponses ? 'responses' : 'chat/completions');
    let innerBody;
    if (isResponses) {
      innerBody = { model: model, stream: false, max_output_tokens: 4096,
        input: [{ role: 'user', content: [
          { type: 'input_text', text: question },
          { type: 'input_image', image_url: dataUrl, detail: 'auto' }
        ] }] };
    } else {
      innerBody = { model: model, stream: false, max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }] };
    }
    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify({
        target_url: target,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },   // 免费模型匿名可用，无需 key
        stream: false,
        body: JSON.stringify(innerBody)
      })
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { success: false, error: 'HTTP ' + resp.status + ' (non-JSON response)' }; }
    if (data && data.type === 'error') {
      const em = (data.error && (data.error.message || data.error.type)) || 'unknown error';
      return { success: false, error: em };
    }
    let out = '';
    if (isResponses) {
      out = data.output_text || '';
      for (const item of (data.output || [])) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text' && c.text) out += c.text;
          }
        }
      }
      if (!String(out).trim() && data.status === 'incomplete') {
        return { success: false, error: 'incomplete: reasoning exhausted max_output_tokens' };
      }
    } else {
      try { out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''; } catch (e) {}
    }
    if (!String(out).trim()) {
      return { success: false, error: 'empty answer (model may not support vision)' };
    }
    return { success: true, output: String(out).trim() };
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = AgentToolsNative;

export { AgentToolsNative };
export default AgentToolsNative;
