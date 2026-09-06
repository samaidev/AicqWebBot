/* ═══════════════ agent/agent-storage.js ═══════════════
   IndexedDB 存储层 — agent 配置、记忆、文件、对话
   + 导出/导入智能体数据库
   ═══════════════════════════════════════════════════════ */

const AgentStorage = {
  DB_NAME: 'aicq_agents',
  // [2026-09-04] v2: 新增 agent_sessions 会话表（含 cuttime 上下文压缩游标）。
  // onupgradeneeded 只增不改，对存量数据无影响。
  DB_VERSION: 2,
  _db: null,

  async init() {
    if (this._db) return this._db;
    return new Promise((resolve) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('agent_config')) {
          db.createObjectStore('agent_config', { keyPath: 'agent_id' });
        }
        if (!db.objectStoreNames.contains('agent_memory')) {
          const store = db.createObjectStore('agent_memory', { keyPath: 'id' });
          store.createIndex('agent_id', 'agent_id', { unique: false });
          store.createIndex('agent_session', ['agent_id','session_id'], { unique: false });
        }
        if (!db.objectStoreNames.contains('agent_files')) {
          const store = db.createObjectStore('agent_files', { keyPath: 'path' });
          store.createIndex('agent_id', 'agent_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('agent_conversations')) {
          const store = db.createObjectStore('agent_conversations', { keyPath: 'id' });
          store.createIndex('agent_session', ['agent_id','session_id'], { unique: false });
        }
        if (!db.objectStoreNames.contains('agent_skills')) {
          const store = db.createObjectStore('agent_skills', { keyPath: 'slug' });
          store.createIndex('agent_id', 'agent_id', { unique: false });
        }
        // [2026-09-04] 会话表：每个 agent+session 一行，cuttime 为上下文压缩游标。
        // 历史加载一律按时间索引从 cuttime 开始抓取（见 getConversationsSince）。
        if (!db.objectStoreNames.contains('agent_sessions')) {
          db.createObjectStore('agent_sessions', { keyPath: 'session_key' });
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = () => { resolve(null); };
    });
  },

  // ═══ 配置存取 ═══
  async saveConfig(agentId, config) {
    await this.init();
    if (!this._db) return;
    config.agent_id = agentId;
    config.updated_at = Date.now();
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_config', 'readwrite');
      tx.objectStore('agent_config').put(config);
      tx.oncomplete = async () => {
        // [OPTIMIZE 2026-07-06] Sync config to server for persistence across browser data clears.
        if (config?.access_token) {
          try {
            const metadata = {
              agent_id: config.agent_id,
              name: config.name,
              system_prompt: config.system_prompt,
              llm_config: config.llm_config,
              tools: config.tools,
              sandbox_type: config.sandbox_type,
              key_pair: config.key_pair,
              owner_id: config.owner_id,
              _synced_at: new Date().toISOString()
            };
            await fetch('/api/v1/accounts/me/metadata', {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.access_token
              },
              body: JSON.stringify({ metadata })
            });
            console.log('[AgentStorage] Config synced to server');
          } catch(e) {
            console.warn('[AgentStorage] Server sync failed:', e);
          }
        }
        resolve(true);
      };
      tx.onerror = () => resolve(false);
    });
  },

  async getConfig(agentId) {
    await this.init();
    if (!this._db) return null;
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_config', 'readonly');
      const req = tx.objectStore('agent_config').get(agentId);
      req.onsuccess = async () => {
        if (req.result) {
          resolve(req.result);
          return;
        }
        // [OPTIMIZE 2026-07-06] Config not in IndexedDB — try restoring from server.
        const restored = await this._restoreConfigFromServer(agentId);
        resolve(restored);
      };
      req.onerror = () => resolve(null);
    });
  },

  // [OPTIMIZE 2026-07-06] Restore agent config from server metadata.
  async _restoreConfigFromServer(agentId) {
    try {
      const ownerToken = (typeof S !== 'undefined' && S.accessToken) || '';
      if (!ownerToken) return null;
      const resp = await fetch('/api/v1/accounts/me/metadata', {
        headers: { 'Authorization': 'Bearer ' + ownerToken }
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const metadata = data.metadata;
      if (!metadata) return null;
      if (metadata.agent_id === agentId) {
        console.log('[AgentStorage] Config restored from server metadata');
        const restored = { ...metadata };
        delete restored._synced_at;
        await this.saveConfig(agentId, restored);
        return restored;
      }
      if (metadata.agents && metadata.agents[agentId]) {
        console.log('[AgentStorage] Config restored from server (multi-agent)');
        const restored = { ...metadata.agents[agentId] };
        delete restored._synced_at;
        await this.saveConfig(agentId, restored);
        return restored;
      }
      return null;
    } catch(e) {
      console.warn('[AgentStorage] Restore from server failed:', e);
      return null;
    }
  },

  // 通过 kv_store 存（兼容 aicq 的 LocalDB）
  async saveToKV(key, value) {
    if (typeof LocalDB !== 'undefined' && LocalDB.db) {
      await LocalDB.setKV(key, value);
    }
  },

  async getFromKV(key) {
    if (typeof LocalDB !== 'undefined' && LocalDB.db) {
      return await LocalDB.getKV(key);
    }
    return null;
  },

  // ═══ 对话历史 ═══
  async addConversation(agentId, sessionId, role, content, toolCalls, toolCallId) {
    await this.init();
    if (!this._db) return;
    const msg = {
      id: `${agentId}_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      agent_id: agentId,
      session_id: sessionId,
      role, content, tool_calls: toolCalls || null,
      created_at: new Date().toISOString()
    };
    // [2026-09-04] 工具结果行记录 tool_call_id — 重建 messages 时才能还原完整
    // 的工具调用链（assistant.tool_calls + tool.tool_call_id），满足喂给 LLM 的
    // “全量信息”要求（用户输入/智能体回复/工具调用命令/工具调用结果）。
    if (toolCallId) msg.tool_call_id = toolCallId;
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readwrite');
      tx.objectStore('agent_conversations').put(msg);
      tx.oncomplete = () => resolve(msg);
      tx.onerror = () => resolve(null);
    });
  },

  async getConversations(agentId, sessionId, limit = 50) {
    await this.init();
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readonly');
      const idx = tx.objectStore('agent_conversations').index('agent_session');
      const req = idx.getAll([agentId, sessionId]);
      req.onsuccess = () => {
        let results = req.result || [];
        results.sort((a,b) => (a.created_at||'').localeCompare(b.created_at||''));
        if (limit > 0) results = results.slice(-limit);
        resolve(results);
      };
      req.onerror = () => resolve([]);
    });
  },

  // ═══ [2026-09-04] 会话表（cuttime 游标）+ 时间索引历史加载 ═══
  // 上下文压缩机制的核心：每轮喂给 LLM 的历史 = 从 cuttime 开始的全量记录
  // （用户输入/智能体回复/工具调用命令和结果），压缩后 cuttime 前移，
  // 压缩摘要插入 newcuttime+1s —— 因按时间索引加载，下一轮自然加载
  // “压缩摘要 + 最近历史”。
  _sessionKey(agentId, sessionId) { return agentId + '|' + sessionId; },

  // 取会话行（懒创建）。默认 cuttime：
  //   - 新会话（无历史）= 当前时间（即会话起点）
  //   - 存量会话迁移   = 最早一条消息的时间（保证旧历史不丢失，
  //                      否则按“字段创建时间”会把已有历史全部跳过）
  async ensureSession(agentId, sessionId) {
    await this.init();
    if (!this._db) return null;
    const key = this._sessionKey(agentId, sessionId);
    const row = await new Promise((resolve) => {
      const tx = this._db.transaction('agent_sessions', 'readonly');
      const req = tx.objectStore('agent_sessions').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (row) return row;
    // 懒创建：查最早一条消息时间作为 cuttime（无历史则当前时间）。
    // 减 1ms：历史加载用严格大于（排除压缩边界消息本身），不减会永久漏掉最早一条。
    const all = await this.getConversations(agentId, sessionId, 0);
    let cuttime = new Date().toISOString();
    if (all && all.length > 0) {
      const firstMs = Date.parse(all[0].created_at || '');
      cuttime = Number.isFinite(firstMs)
        ? new Date(firstMs - 1).toISOString()
        : all[0].created_at;
    }
    const newRow = {
      session_key: key,
      agent_id: agentId,
      session_id: sessionId,
      cuttime,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await new Promise((resolve) => {
      const tx = this._db.transaction('agent_sessions', 'readwrite');
      tx.objectStore('agent_sessions').put(newRow);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
    return newRow;
  },

  // cuttime 前移（压缩完成后调用）
  async setCuttime(agentId, sessionId, cuttimeIso) {
    const row = await this.ensureSession(agentId, sessionId);
    if (!row) return false;
    row.cuttime = cuttimeIso;
    row.updated_at = new Date().toISOString();
    await this.init();
    if (!this._db) return false;
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_sessions', 'readwrite');
      tx.objectStore('agent_sessions').put(row);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  // 按时间索引抓取 cuttime 之后的历史（全量，无条数限制）。
  // inclusive=false 时严格大于（用于加载：排除 cuttime 边界消息本身，
  // 因为它已进入压缩摘要）；ISO 字符串比较即时序比较。
  async getConversationsSince(agentId, sessionId, sinceIso, inclusive = false) {
    await this.init();
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readonly');
      const idx = tx.objectStore('agent_conversations').index('agent_session');
      const req = idx.getAll([agentId, sessionId]);
      req.onsuccess = () => {
        const all = (req.result || []).filter(m => m.created_at);
        all.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || (a.id || '').localeCompare(b.id || ''));
        const results = inclusive
          ? all.filter(m => m.created_at >= sinceIso)
          : all.filter(m => m.created_at > sinceIso);
        resolve(results);
      };
      req.onerror = () => resolve([]);
    });
  },

  // search-session-history 工具的存储层实现：在指定会话的【全部】历史
  // （含已被压缩出上下文的早期记录）里按关键字查找，返回最新 N 条匹配。
  async searchSessionHistory(agentId, sessionId, keyword, topN = 10) {
    await this.init();
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readonly');
      const idx = tx.objectStore('agent_conversations').index('agent_session');
      const req = idx.getAll([agentId, sessionId]);
      req.onsuccess = () => {
        const q = String(keyword || '').toLowerCase().trim();
        if (!q) { resolve([]); return; }
        const matches = (req.result || [])
          .filter(m => {
            let text = (m.content || '') + ' ';
            if (m.tool_calls && m.tool_calls.length) {
              text += m.tool_calls.map(tc => (tc.function && (tc.function.name + ' ' + (tc.function.arguments || ''))) || '').join(' ');
            }
            return text.toLowerCase().includes(q);
          })
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, Math.max(1, Math.min(50, topN | 0 || 10)));
        resolve(matches.map(m => ({
          created_at: m.created_at,
          role: m.role,
          content: (m.content || '').slice(0, 800),
          tool_calls: (m.tool_calls || []).map(tc => (tc.function && tc.function.name) || '?')
        })));
      };
      req.onerror = () => resolve([]);
    });
  },

  // [2026-09-04] 在指定时间点插入一条历史记录（上下文压缩摘要专用）。
  // fixedId 幂等：压缩重试时同 id put 覆盖，不会产生重复摘要行。
  async insertConversationAt(agentId, sessionId, role, content, createdAtIso, fixedId) {
    await this.init();
    if (!this._db) return null;
    const msg = {
      id: fixedId || `${agentId}_${sessionId}_ins_${Date.parse(createdAtIso)}`,
      agent_id: agentId,
      session_id: sessionId,
      role, content, tool_calls: null,
      created_at: createdAtIso
    };
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readwrite');
      tx.objectStore('agent_conversations').put(msg);
      tx.oncomplete = () => resolve(msg);
      tx.onerror = () => resolve(null);
    });
  },

  // ═══ 记忆 ═══
  async saveMemory(agentId, key, content, summary, importance = 0.5, sessionId = '') {
    await this.init();
    if (!this._db) return;
    const mem = {
      id: `mem_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      agent_id: agentId, key, content, summary,
      importance, session_id: sessionId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_memory', 'readwrite');
      tx.objectStore('agent_memory').put(mem);
      tx.oncomplete = () => resolve(mem);
      tx.onerror = () => resolve(null);
    });
  },

  async searchMemory(agentId, query, limit = 10) {
    await this.init();
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_memory', 'readonly');
      const idx = tx.objectStore('agent_memory').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => {
        const all = req.result || [];
        // 简单关键词搜索
        const q = (query || '').toLowerCase();
        const scored = all.map(m => {
          const text = ((m.content||'') + ' ' + (m.summary||'')).toLowerCase();
          let score = 0;
          q.split(/\s+/).forEach(kw => {
            if (kw && text.includes(kw)) score++;
          });
          return { ...m, _score: score };
        }).filter(m => m._score > 0);
        scored.sort((a,b) => b._score - a._score || (b.importance||0) - (a.importance||0));
        resolve(scored.slice(0, limit));
      };
      req.onerror = () => resolve([]);
    });
  },

  // ═══ WASM 虚拟文件系统 ═══
  // 路径规范化：确保以 / 开头，去除重复 /，去掉末尾 /（根目录除外）
  _normalizePath(path) {
    if (!path || typeof path !== 'string') return '/';
    let p = path.trim();
    if (!p.startsWith('/')) p = '/' + p;
    // 折叠重复 /
    p = p.replace(/\/+/g, '/');
    // 去掉末尾 /（根目录除外）
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  },

  async saveFile(agentId, path, content, persistent = false) {
    await this.init();
    if (!this._db) return;
    // 路径规范化：避免 'output/x.txt' 与 '/output/x.txt' 视为不同文件
    path = this._normalizePath(path);
    // 容量检查
    const size = await this.getFSSize(agentId);
    const MAX_FS = 800 * 1024 * 1024; // 800MB
    if (size + (content.byteLength || content.length) > MAX_FS) {
      await this._cleanFS(agentId, (content.byteLength || content.length));
    }
    const file = {
      path, agent_id: agentId,
      content: content instanceof ArrayBuffer ? content : new TextEncoder().encode(content).buffer,
      size: content.byteLength || content.length,
      last_accessed: Date.now(),
      persistent
    };
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readwrite');
      tx.objectStore('agent_files').put(file);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  async readFile(agentId, path) {
    await this.init();
    if (!this._db) return null;
    path = this._normalizePath(path);
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readwrite');
      const req = tx.objectStore('agent_files').get(path);
      req.onsuccess = () => {
        const file = req.result;
        // 防御：可能存在不同 agent 共享同 path 的旧数据，校验 agent_id
        if (file && file.agent_id !== agentId) {
          // 同 path 不同 agent：扫描所有同 path 记录无法（keyPath=path 单值），返回 null 让上层处理
          resolve(null);
          return;
        }
        if (file) {
          file.last_accessed = Date.now();
          tx.objectStore('agent_files').put(file);
        }
        resolve(file || null);
      };
      req.onerror = () => resolve(null);
    });
  },

  async listFiles(agentId, dir = '/') {
    await this.init();
    if (!this._db) return [];
    dir = this._normalizePath(dir);
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readonly');
      const idx = tx.objectStore('agent_files').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => {
        const all = req.result || [];
        // 精确匹配目录前缀：dir='/' → 所有；dir='/output' → 仅 /output 和 /output/...
        const filtered = all.filter(f => {
          if (!f.path) return false;
          if (dir === '/') return true;  // 根目录列全部
          return f.path === dir || f.path.startsWith(dir + '/');
        });
        resolve(filtered.map(f => ({
          path: f.path, size: f.size, last_accessed: f.last_accessed, persistent: f.persistent
        })));
      };
      req.onerror = () => resolve([]);
    });
  },

  async deleteFile(agentId, path) {
    await this.init();
    if (!this._db) return;
    path = this._normalizePath(path);
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readwrite');
      tx.objectStore('agent_files').delete(path);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  async getFSSize(agentId) {
    await this.init();
    if (!this._db) return 0;
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readonly');
      const idx = tx.objectStore('agent_files').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.reduce((sum, f) => sum + (f.size || 0), 0));
      };
      req.onerror = () => resolve(0);
    });
  },

  // 滑动清理：按 last_accessed 淘汰非持久文件
  async _cleanFS(agentId, neededBytes) {
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readwrite');
      const idx = tx.objectStore('agent_files').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => {
        const all = req.result || [];
        // 排序：非持久的按 last_accessed 升序（最旧先删）
        const candidates = all.filter(f => !f.persistent)
          .sort((a,b) => (a.last_accessed||0) - (b.last_accessed||0));
        let freed = 0;
        for (const f of candidates) {
          if (freed >= neededBytes) break;
          tx.objectStore('agent_files').delete(f.path);
          freed += f.size || 0;
        }
        resolve(freed);
      };
      req.onerror = () => resolve(0);
    });
  },

  // ═══ ClawHub Skills ═══
  async saveSkill(agentId, skill) {
    await this.init();
    if (!this._db) return;
    skill.agent_id = agentId;
    skill.installed_at = Date.now();
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_skills', 'readwrite');
      tx.objectStore('agent_skills').put(skill);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  async getSkills(agentId) {
    await this.init();
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_skills', 'readonly');
      const idx = tx.objectStore('agent_skills').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  },

  async removeSkill(agentId, slug) {
    await this.init();
    if (!this._db) return;
    return new Promise((resolve) => {
      const tx = this._db.transaction('agent_skills', 'readwrite');
      tx.objectStore('agent_skills').delete(slug);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  // ═══ 导出/导入 ═══
  async exportAgent(agentId) {
    await this.init();
    const config = await this.getConfig(agentId);
    if (!config) return null;

    // 导出记忆
    const memories = await new Promise((resolve) => {
      const tx = this._db.transaction('agent_memory', 'readonly');
      const idx = tx.objectStore('agent_memory').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    // 导出文件 (base64)
    const files = await new Promise((resolve) => {
      const tx = this._db.transaction('agent_files', 'readonly');
      const idx = tx.objectStore('agent_files').index('agent_id');
      const req = idx.getAll(agentId);
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.map(f => ({
          path: f.path,
          content_base64: btoa(String.fromCharCode(...new Uint8Array(f.content))),
          size: f.size,
          persistent: f.persistent
        })));
      };
      req.onerror = () => resolve([]);
    });

    // 导出对话
    const conversations = await new Promise((resolve) => {
      const tx = this._db.transaction('agent_conversations', 'readonly');
      // agent_conversations 没有 agent_id 独立索引，只有复合索引 agent_session
      // 使用全表扫描 + 过滤
      const req = tx.objectStore('agent_conversations').getAll();
      req.onsuccess = () => resolve((req.result||[]).filter(c => c.agent_id === agentId));
      req.onerror = () => resolve([]);
    });

    // 导出 skills
    const skills = await this.getSkills(agentId);

    return {
      version: '1.0',
      exported_at: new Date().toISOString(),
      agent: config,
      memories,
      files,
      conversations,
      skills
    };
  },

  async importAgent(data) {
    await this.init();
    if (!data || !data.agent) return false;

    const config = data.agent;
    await this.saveConfig(config.agent_id, config);

    // 导入记忆
    if (data.memories) {
      for (const mem of data.memories) {
        await new Promise((resolve) => {
          const tx = this._db.transaction('agent_memory', 'readwrite');
          tx.objectStore('agent_memory').put(mem);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      }
    }

    // 导入文件
    if (data.files) {
      for (const f of data.files) {
        const binary = Uint8Array.from(atob(f.content_base64), c => c.charCodeAt(0)).buffer;
        await this.saveFile(config.agent_id, f.path, binary, f.persistent);
      }
    }

    // 导入对话
    if (data.conversations) {
      for (const conv of data.conversations) {
        await new Promise((resolve) => {
          const tx = this._db.transaction('agent_conversations', 'readwrite');
          tx.objectStore('agent_conversations').put(conv);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      }
    }

    // 导入 skills
    if (data.skills) {
      for (const skill of data.skills) {
        await this.saveSkill(config.agent_id, skill);
      }
    }

    return true;
  },

  async deleteAgent(agentId) {
    await this.init();
    if (!this._db) return;
    // 删除所有相关数据
    // 注意: agent_config 用 keyPath=agent_id, 可直接 delete(agentId)
    //       agent_conversations 没有 agent_id 独立索引, 需全表扫描
    //       其他 store 有 agent_id 索引, 可用 index
    // 1. agent_config - 直接按键删除
    await new Promise((resolve) => {
      const tx = this._db.transaction('agent_config', 'readwrite');
      tx.objectStore('agent_config').delete(agentId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    // 2. 其他 store - 逐个处理
    for (const storeName of ['agent_memory', 'agent_files', 'agent_conversations', 'agent_skills']) {
      await new Promise((resolve) => {
        const tx = this._db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        // 使用全表 cursor, 按 agent_id 过滤删除 (兼容所有 store, 不依赖索引)
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (cursor.value && cursor.value.agent_id === agentId) cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
    // 也从 kv_store 彻底删除 key (不是设 null)
    if (typeof LocalDB !== 'undefined' && LocalDB.db) {
      await new Promise(resolve => {
        const tx = LocalDB.db.transaction('kv_store', 'readwrite');
        tx.objectStore('kv_store').delete('local_agent_' + agentId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  }
};

// 导出供 ES module import 使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentStorage;
}

export default AgentStorage;
