/* ═══════════════ agent/agent-engine.js ═══════════════
   核心引擎 — agent loop + LLM 调用 + WS 流式回复
   ═════════════════════════════════════════════════════ */

// Cache-buster version for dynamic imports — bump when agent modules change
const _AGENT_VER = '20260904b';
function _agUrl(name) { return `/static/agent/${name}?v=${_AGENT_VER}`; }

const AgentEngine = {

  // ══ [2026-09-04] LLM 调用日志埋点 ══
  // 写入 agent-llm-log.js（环形 100 条 + localStorage），设置页可查看。
  // fire-and-forget：绝不阻塞 LLM 响应链路。
  _logLLM(entry) {
    // [2026-09-04] 上下文压缩等内部调用的日志标记（设置页可区分 phase=compress）
    if (!entry.phase && this._llmLogPhase) entry.phase = this._llmLogPhase;
    import(_agUrl('agent-llm-log.js')).then(m => {
      const L = m.default;
      if (entry._messages) { entry.input = L.serializeMessages(entry._messages); delete entry._messages; }
      if (entry._rawInput) {
        entry.input = String(entry._rawInput).replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
          (mm) => '[image ' + Math.round(mm.length * 3 / 4 / 1024) + 'KB]');
        delete entry._rawInput;
      }
      L.record(entry);
    }).catch(e => console.warn('[LLMLog] record failed:', e));
  },

  // 从 messages 数组粗估输入 token（无 usage 时兑底）
  _estTokensIn(messages) {
    try {
      const LLMLog = null; // 惰性：直接用序列化长度估算
      let total = 0;
      for (const m of messages || []) {
        if (typeof m.content === 'string') total += m.content.length;
        else if (Array.isArray(m.content)) for (const c of m.content) total += (c.text || '').length;
      }
      return Math.ceil(total / 4) + 8;
    } catch (e) { return null; }
  },

  // [2026-09-04] generic 路径日志收口（成功 + 200 内业务错误统一记一条）
  // usage 兼容两种协议：chat completions(prompt/completion_tokens) 与 responses(input/output_tokens)
  _logLLMGeneric(parsed, data, llmConfig, messages, t0, config) {
    try {
      const u = (data && data.usage) || null;
      const tin = u ? (u.prompt_tokens ?? u.input_tokens ?? null) : this._estTokensIn(messages);
      const tout = u ? (u.completion_tokens ?? u.output_tokens ?? null) : Math.ceil((parsed.content || '').length / 4);
      const toolNames = (parsed.tool_calls || []).map(tc => tc.function?.name || '?').join(',');
      this._logLLM({
        provider: llmConfig.provider, model: llmConfig.model, status: 200,
        latency_ms: Date.now() - t0, tokens_in: tin, tokens_out: tout,
        tokens_est: !u, msg_count: messages.length, _messages: messages,
        output: (parsed.content || '') + (toolNames ? '\n[tool_calls] ' + toolNames : ''),
        error: parsed.success ? '' : String(parsed.error || '').slice(0, 500),
        agent_id: config.agent_id
      });
    } catch (e) { console.warn('[LLMLog] generic log failed:', e); }
  },
  _agentWS: {},  // agentId → WebSocket
  _running: {},  // agentId+sessionId → boolean (防重入)
  // [FIX 2026-08-29] agentId → 当前回复的流上下文
  //   { streamId, isGroup, textSegments, contentOrder, toolCalls }
  // 修复聊天记录不持久化 bug 的关键：每次回复复用同一个 stream_id，
  // 让服务端把全部 chunk 聚合进同一个 StreamBuffer 并在 stream_end 时落库。
  _activeStreams: {},

  // 连接 agent WS (用 agent 的 access_token)
  async connectAgent(config) {
    const agentId = config.agent_id;
    if (this._agentWS[agentId]) {
      try { this._agentWS[agentId].close(); } catch(e) {}
    }
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${config.access_token}`;
    const ws = new WebSocket(wsUrl);
    this._agentWS[agentId] = ws;

    ws.onopen = () => {
      console.log(`[AgentEngine] Agent ${agentId} WS connected`);
      // 发送认证 + 上线消息 (服务器要求 {type:"online", nodeId, token})
      ws.send(JSON.stringify({ type: 'online', nodeId: agentId, token: config.access_token }));
      // 心跳: 每25秒发ping, 防止服务器断开
      if (ws._pingInterval) clearInterval(ws._pingInterval);
      ws._pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        // DEBUG: log all messages received by agent WS
        if (!['pong', 'online_ack', 'presence', 'presence_update', 'friends_online'].includes(msg.type)) {
          console.log(`[AgentEngine WS recv] type=${msg.type} from=${msg.from || msg.from_id || msg.data?.from_id} to=${msg.to || msg.to_id || msg.data?.to_id} content=${(msg.content || msg.data?.content || '').slice(0, 50)}`);
        }
        // 忽略系统消息 (online_ack, friends_online, pong, presence 等)
        if (['online_ack', 'friends_online', 'pong', 'presence_update', 'presence'].includes(msg.type)) {
          // [FIX 2026-08-30] online_ack = 连接完全建立 → 重置该 agent 的重连退避计数。
          if (msg.type === 'online_ack') {
            this._wsFailCount = this._wsFailCount || {};
            if (this._wsFailCount[agentId]) delete this._wsFailCount[agentId];
            this._wsAuthFailed = this._wsAuthFailed || {};
            this._wsAuthFailed[agentId] = false;
          }
          return;
        }
        // [FIX 2026-08-30] 认证类错误：token 过期/无效。服务器 handleOnline 会回
        // {type:'error', code:'TOKEN_INVALID'|'AUTH_REQUIRED'|...} 然后关连接。
        // 标记该 agent 需要先刷新 token 再重连（用 IndexedDB 里的 refresh_token
        // 调 /api/v1/auth/refresh），否则拿旧 token 重试永远失败 → 无限风暴。
        if (msg.type === 'error' && ['TOKEN_INVALID', 'AUTH_REQUIRED', 'AGENT_SCOPE_DENIED'].includes(msg.code)) {
          console.warn(`[AgentEngine] Agent ${agentId} auth error: ${msg.code} — will refresh token before reconnect`);
          this._wsAuthFailed = this._wsAuthFailed || {};
          this._wsAuthFailed[agentId] = true;
          return; // 连接即将被服务器关闭，等 onclose 的退避重连
        }
        // 处理私聊消息
        // 服务器发送格式: { type: "message", from: "1000008", data: { from_id, to_id, content, ... } }
        // 或: { type: "direct_message", to: "ai_xxx", content: "..." }
        // [FIX 2026-07-06] Also handle group_message so JS agents can participate in group chats.
        if (msg.type === 'message' || msg.type === 'direct_message' || msg.type === 'group_message') {
          const data = msg.data || msg;
          const toId = data.to_id || data.to || msg.to || msg.to_id || '';
          const fromId = data.from_id || msg.from || msg.from_id || '';
          // [FIX 2026-07-06] For group_message, extract groupId and sender info
          const isGroupMsg = (msg.type === 'group_message');
          let groupId = '';
          let senderName = '';
          if (isGroupMsg) {
            groupId = msg.groupId || msg.group_id || data.groupId || data.group_id || '';
            senderName = msg.senderName || msg.sender_name || data.senderName || data.sender_name || fromId;
            // Skip messages from self (other agents in the group, or this agent itself)
            if (fromId === agentId) {
              // our own message echoed back — skip
            } else if (fromId.startsWith('ai_')) {
              // Message from another AI agent — skip to prevent loops
              console.log(`[AgentEngine] Skipping group message from another agent: ${fromId}`);
              return;
            }
            // For group messages, "to" is the group, not the agent.
            // We process it if the agent is a member of the group (server already filtered).
          }
          // 确保消息是发给这个 agent 的 (for PMs); group messages always pass
          if (isGroupMsg || toId === agentId || (msg.type === 'message' && fromId !== agentId)) {
            // 提取消息内容
            const messageContent = data.content || msg.content || '';
            // [OPTIMIZE 2026-07-06] Extract media fields for multimodal image handling.
            // Server relays: media_url (server path), media_data (base64 data URI),
            // file_info (JSON with filename/size/url), msgType (image/file/text).
            const _mediaUrl = data.media_url || msg.media_url || '';
            const _mediaData = data.media_data || msg.media_data || '';
            const _fileInfo = data.file_info || msg.file_info || '';
            const _msgType = data.msgType || data.type || msg.msgType || 'text';
            // 去重：60秒内同 from+content+media 的消息只处理一次
            // 服务器在消息未被 ACK 时会反复重发
            // [FIX 2026-07-06] Include media_url and msg_id in dedup key.
            // Without this, multiple images (all with content="[Image]") get
            // falsely deduped, and only the first image is processed.
            // [FIX 2026-08-28] Removed duplicate `const _mediaUrl` declaration here —
            // it was a SyntaxError (already declared at line 80) that broke the
            // ENTIRE agent-engine.js module (agents could not load at all).
            const _msgId = data.id || msg.id || '';
            const dedupKey = agentId + '_' + fromId + '_' + messageContent.trim() + '_' + _mediaUrl + '_' + _msgId;
            if (!window._agentMsgDedup) window._agentMsgDedup = new Map();
            const lastSeen = window._agentMsgDedup.get(dedupKey);
            if (lastSeen && (Date.now() - lastSeen) < 60000) {
              console.log(`[AgentEngine WS] Dedup: skipping resend from ${fromId}: ${messageContent.slice(0, 30)}`);
              // 不处理，但也不 return — 让后续逻辑继续（虽然这里没有后续）
            } else {
              window._agentMsgDedup.set(dedupKey, Date.now());
              // 清理
              if (window._agentMsgDedup.size > 200) {
                const cutoff = Date.now() - 5*60*1000;
                for (const [k, t] of window._agentMsgDedup) {
                  if (t < cutoff) window._agentMsgDedup.delete(k);
                }
              }

              const messageData = {
                type: msg.type,
                from: fromId,
                to: toId,
                content: messageContent,
                content_type: _msgType,
                msg_id: data.id || msg.id || '',
                // [OPTIMIZE 2026-07-06] Media fields for multimodal handling
                media_url: _mediaUrl,
                media_data: _mediaData,
                file_info: _fileInfo,
                msg_type: _msgType,
                // [FIX 2026-07-06] Pass chat_session_id from server relay so each
                // "+" new chat gets its own isolated conversation history.
                // Server (chat.go line 125, ws.go line 513) puts it in data.chat_session_id.
                chat_session_id: data.chat_session_id || msg.chat_session_id || '',
                // [FIX 2026-07-06] Group message metadata
                is_group: isGroupMsg,
                group_id: groupId,
                sender_name: senderName,
                // For group messages, check if this agent is @mentioned
                mentioned: isGroupMsg ? this._isMentioned(messageContent, config) : false
              };
              // [FIX 2026-07-06] For group messages, only respond if @mentioned or if LLM decides it's relevant
              if (isGroupMsg && !messageData.mentioned) {
                console.log(`[AgentEngine] Group message in ${groupId} not @mentioning me, doing LLM relevance check...`);
                // [OPTIMIZE 2026-07-06] LLM-based relevance check:
                // Ask the LLM if this message is relevant to this agent.
                // This is a lightweight call (no tools, short system prompt).
                const isRelevant = await this._checkGroupMessageRelevance(messageData, config);
                if (!isRelevant) {
                  console.log(`[AgentEngine] Group message in ${groupId} not relevant to me, skipping`);
                  return;
                }
                console.log(`[AgentEngine] Group message in ${groupId} is relevant, responding`);
                messageData.mentioned = true;  // mark as relevant so handleAgentMessage processes it
              }
              await this.handleAgentMessage(messageData, config);
            }
          }
        }
      } catch(e) {
        console.error('[AgentEngine] WS message error:', e);
      }
    };

    ws.onclose = () => {
      if (ws._pingInterval) clearInterval(ws._pingInterval);
      // [FIX 2026-08-30] 指数退避重连（风暴根因修复）：此前固定 3s 重试，token
      // 过期(TOKEN_INVALID)后永远失败 → 每 3-5s 一次的永久重连风暴。单 IP 每分
      // 钟 10 次的 auth 限流配额被打满，同 IP 上外部 SDK 机器人（teambot 等）的
      // 挑战-应答重登被 429 饿死，无法重新上线。退避序列 3s→6s→12s→…→5min 封顶；
      // 认证失败时先刷新 token；online_ack 成功后计数清零。
      this._wsFailCount = this._wsFailCount || {};
      const n = (this._wsFailCount[agentId] || 0) + 1;
      this._wsFailCount[agentId] = n;
      const delay = Math.min(3000 * Math.pow(2, Math.min(n - 1, 6)), 300000);
      console.log(`[AgentEngine] Agent ${agentId} WS closed, reconnecting in ${Math.round(delay / 1000)}s (attempt ${n})...`);
      setTimeout(async () => {
        this._wsAuthFailed = this._wsAuthFailed || {};
        if (this._wsAuthFailed[agentId]) {
          this._wsAuthFailed[agentId] = false;
          const refreshed = await this._refreshAgentToken(agentId);
          if (!refreshed) {
            // 刷新失败（refresh_token 也过期）：退避到下一轮再试，不阻塞其它 agent
            console.warn(`[AgentEngine] Agent ${agentId} token refresh failed — will retry with backoff`);
          }
        }
        this._reconnectAgent(agentId);
      }, delay);
    };

    ws.onerror = (e) => console.error('[AgentEngine] WS error:', e);
  },

  // [FIX 2026-08-30] 用 IndexedDB 里保存的 refresh_token 换新 access_token。
  // 内建智能体创建时保存了 access_token+refresh_token（agent-create.js），但
  // 引擎此前从不刷新 —— token 24h 过期后连接永远失败，重连风暴由此而来。
  async _refreshAgentToken(agentId) {
    try {
      const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
      const config = await AgentStorage.getConfig(agentId);
      if (!config || !config.refresh_token) return false;
      const resp = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: config.refresh_token })
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data && (data.access_token || data.accessToken)) {
        config.access_token = data.access_token || data.accessToken;
        if (data.refresh_token || data.refreshToken) config.refresh_token = data.refresh_token || data.refreshToken;
        await AgentStorage.saveConfig(agentId, config);
        console.log(`[AgentEngine] Agent ${agentId} access_token refreshed`);
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[AgentEngine] token refresh error:', e && e.message);
      return false;
    }
  },

  async _reconnectAgent(agentId) {
    const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
    const config = await AgentStorage.getConfig(agentId);
    if (config) await this.connectAgent(config);
  },

  // 处理收到的消息（从 WS 或主页面 hook）
  async handleAgentMessage(msg, config) {
    // 处理私聊和群聊消息
    // [FIX 2026-07-06] Also accept group_message (was previously rejected here even after
    // the WS handler passed it through)
    if (msg.type !== 'direct_message' && msg.type !== 'message' && msg.type !== 'group_message') return;

    const agentId = config.agent_id;
    const sessionId = msg.chat_session_id || msg.from || msg.from_id || msg.sender_id || '';  // [FIX 2026-07-06] Prefer chat_session_id for context isolation (aicq.me '+' new chat)
    const userMessage = msg.content || msg.text || msg.data?.content || '';
    // [FIX 2026-07-06] For group messages, route replies to the group_id
    // and use group_id as the conversation session key (each group = isolated context)
    // [FIX 2026-07-06] For PMs, reply to the USER's account ID (msg.from), not sessionId.
    // sessionId may be a chat_session_id (cs_xxx) which is not a valid WS node.
    // stream_chunk's "to" field must be a real account_id for the server to relay it.
    // For group messages, reply to the group_id (handled via _sendGroupMessage).
    const replyTarget = msg.is_group ? (msg.group_id || sessionId) : (msg.from || sessionId);
    const convSessionId = msg.is_group ? ('group:' + (msg.group_id || sessionId)) : sessionId;
    if (!userMessage.trim()) return;

    // 忽略 agent 自己发的消息 — 否则 agent 发的 "(LLM 返回了空回复)" 等错误提示
    // 会通过 WS 发回 agent 自己，触发无限循环
    if (sessionId === agentId) {
      console.log('[AgentEngine] Ignoring own message');
      return;
    }

    // 消息去重 — 用 content 作为 key (服务器重发同一消息时 content 相同)
    // 防止 WS 重连后服务器重发同一消息导致重复处理
    // [FIX 2026-07-06] Include msg.msg_id in dedup key for image/file messages.
    // Image messages all have content "[Image]", so without msg_id they'd be
    // falsely deduped within the same session.
    const _msgIdForDedup = msg.msg_id || '';
    const msgKey = agentId + '_' + convSessionId + '_' + userMessage.trim() + '_' + _msgIdForDedup;
    if (!AgentEngine._processedMsgs) AgentEngine._processedMsgs = new Map();
    const lastProcessed = AgentEngine._processedMsgs.get(msgKey);
    if (lastProcessed && (Date.now() - lastProcessed) < 60000) {
      // 60 秒内处理过同一条消息，跳过
      console.log(`[AgentEngine] Duplicate within 60s, skipping: ${userMessage.trim().slice(0, 30)}`);
      return;
    }
    AgentEngine._processedMsgs.set(msgKey, Date.now());
    // 清理超过 5 分钟的去重记录
    if (AgentEngine._processedMsgs.size > 100) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, t] of AgentEngine._processedMsgs) {
        if (t < cutoff) AgentEngine._processedMsgs.delete(k);
      }
    }

    // 防重入：同一 agent+session 同时只跑一个 loop
    const lockKey = `${agentId}_${convSessionId}`;
    if (this._running[lockKey]) {
      console.log(`[AgentEngine] ${lockKey} already running, skip`);
      return;
    }
    this._running[lockKey] = true;

    // [FIX 2026-08-29] 为本次回复注册稳定 stream_id —— 聊天记录持久化修复的核心。
    // 之前 _sendStreamChunk/_sendStreamEnd 每次调用都新生成 stream_id（Date.now()），
    // 服务端按 stream_id 聚合 StreamBuffer，导致每个 chunk 各自落入独立的 1-chunk
    // 缓冲区；stream_end 的 stream_id 也匹配不到任何缓冲区 → fallback 又拿不到
    // text_segments → 消息从未写入 direct_messages 表。
    // 客户端刷新/重连后 _syncRecentMessages 与服务端 reconcile，这些"服务端不存在"
    // 的本地消息被判定为"已在其他设备删除"而清空 —— 这就是切换页面/刷新后
    // 智能体聊天记录消失的根因。修复后：同一回复的所有 chunk 共用一个 stream_id，
    // 服务端聚合后于 stream_end 整体落库，reconcile 时本地/服务端 ID 一致，不再丢失。
    const _isGroupReply = !!(msg.is_group || (replyTarget || '').startsWith('grp_'));
    this._activeStreams[agentId] = {
      streamId: `st_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      isGroup: _isGroupReply,
      // [FIX 2026-08-29] Bind the request's chat_session_id to THIS reply's
      // stream. _sendStreamChunk/_sendStreamEnd stamp outgoing payloads with it
      // so the server persists the reply under the SAME session it answers —
      // without this, a late reply (long LLM call / context compression) lands
      // with no csid and the frontend timestamp fallback leaks it into whatever
      // session the user has opened by then ("replies leaking across sessions").
      csid: (msg.is_group ? '' : (msg.chat_session_id || '')),
      textSegments: [],
      contentOrder: [],
      toolCalls: []
    };

    // [FIX 2026-08-29] Ensure the agent's WS is up BEFORE running the LLM loop.
    // _sendStreamChunk/_sendStreamEnd silently drop output when the agent WS is
    // down — after the page had been closed for a long time the reconnect loop
    // may still be in progress, and the user sees "agent never replied".
    // connectAgent() replaces the socket; give the handshake a short grace wait.
    {
      const ws0 = this._agentWS ? this._agentWS[agentId] : null;
      if (!ws0 || ws0.readyState !== 1) {
        try {
          console.log('[AgentEngine] agent WS down, reconnecting before handling:', agentId);
          await this.connectAgent(config);
          for (let i = 0; i < 10; i++) {
            const w = this._agentWS[agentId];
            if (w && w.readyState === 1) break;
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (e) { console.warn('[AgentEngine] reconnect before handle failed:', e && e.message); }
      }
    }

    // [UX 2026-08-29] Immediate feedback: emit the thinking status BEFORE the
    // slow context build (history load + LLM compression can take tens of
    // seconds). The frontend pre-buffer (sent path) or this chunk — whichever
    // lands first — shows "Calling LLM..." with the stop button right away.
    this._sendStreamChunk(agentId, replyTarget, config, 'Calling LLM...', 'thinking');

    try {
      // 重新从 storage 读取最新 config — 用户可能在创建 agent 后改过设置
      // (connectAgent 时闭包捕获的 config 可能是旧的)
      const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
      const latestConfig = await AgentStorage.getConfig(agentId);
      const effectiveConfig = latestConfig || config;
      // [FIX 2026-07-06] Pass replyTarget and convSessionId for group message routing
      // [OPTIMIZE 2026-07-06] Pass msg object so _agentLoop can access media fields
      await this._agentLoop(userMessage, convSessionId, effectiveConfig, replyTarget, msg);
    } catch(e) {
      console.error('[AgentEngine] Agent loop error:', e);
      this._sendStreamEnd(agentId, replyTarget || sessionId, config);
    } finally {
      this._running[lockKey] = false;
      delete this._activeStreams[agentId];
    }
  },

  // 核心循环
  async _agentLoop(userMessage, sessionId, config, replyTarget, msg) {
    const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
    const AgentTools = (await import(_agUrl('agent-tools.js'))).default;

    // [FIX 2026-07-06] replyTarget defaults to sessionId for backwards compat (PMs)
    // For group messages, replyTarget = group_id so replies go to the group
    if (!replyTarget) replyTarget = sessionId;

    // [OPTIMIZE 2026-07-06] Build multimodal user message for image messages.
    // If the message contains an image (media_data or media_url), build OpenAI
    // vision API format: [{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]
    // This lets vision-capable LLMs (GPT-4V, Qwen-VL, etc.) actually see the image
    // instead of just receiving "[Image]" as text.
    let userMessageContent = userMessage;
    const _isImageMsg = msg && (msg.msg_type === 'image' || (msg.media_data && msg.msg_type !== 'file'));
    if (_isImageMsg) {
      let imageUrl = '';
      // Prefer media_data (base64 data URI) — works without additional HTTP fetch
      if (msg.media_data && msg.media_data.startsWith('data:')) {
        imageUrl = msg.media_data;
      }
      // Fall back to media_url — convert relative path to absolute
      else if (msg.media_url) {
        imageUrl = msg.media_url.startsWith('http') ? msg.media_url :
                   (location.origin + (msg.media_url.startsWith('/') ? '' : '/') + msg.media_url);
      }
      if (imageUrl) {
        console.log('[AgentEngine] Image message, urlLen=' + imageUrl.length);
        // ══ [2026-09-03 analyze-image] ══
        // 1) 先把图片固化为 dataURI 存入"最新图片"槽位（analyze-image 工具的数据源）。
        //    只有 media_url 时先经 llm-proxy 下载（aicq 内部文件需内层 Bearer），
        //    确保删除服务器副本之前本地已留存。
        let _imgDataUrl = imageUrl.startsWith('data:') ? imageUrl : '';
        if (!_imgDataUrl) {
          try {
            const _tok = config.access_token || (typeof S !== 'undefined' && S.accessToken) || '';
            const _inner = {};
            const _isInternal = imageUrl.indexOf(location.origin) === 0 || imageUrl.indexOf('/api/') === 0;
            if (_isInternal && _tok) _inner['Authorization'] = 'Bearer ' + _tok;
            const _resp = await fetch('/api/v1/agent/llm-proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _tok },
              body: JSON.stringify({ target_url: imageUrl, method: 'GET', headers: _inner, stream: false })
            });
            if (_resp.ok) {
              const _blob = await _resp.blob();
              if ((_blob.type || '').startsWith('image/')) {
                _imgDataUrl = await new Promise((res) => {
                  const fr = new FileReader();
                  fr.onload = () => res(String(fr.result));
                  fr.onerror = () => res('');
                  fr.readAsDataURL(_blob);
                });
              }
            }
          } catch (e) { console.warn('[AgentEngine] Image download for analyze-image failed:', e); }
        }
        if (_imgDataUrl) {
          try {
            const { AgentToolsNative: _ATN } = await import(_agUrl('agent-tools-native.js'));
            _ATN.rememberImage(sessionId, _imgDataUrl);
            console.log('[AgentEngine] Image stored for analyze-image, len=' + _imgDataUrl.length);
          } catch (e) { console.warn('[AgentEngine] rememberImage failed:', e); }
        }
        // 2) 主模型 payload：BYOK 模型是否支持视觉由用户自选（vision 模型内联）。
        //    不支持视觉的模型会报错 → 用户可在设置里换模型，或让 agent 调 analyze-image 工具。
        if (_imgDataUrl) {
          userMessageContent = [
            { type: 'text', text: userMessage || 'What do you see in this image?' },
            { type: 'image_url', image_url: { url: _imgDataUrl } }
          ];
        }
        if (!userMessage || !userMessage.trim()) userMessage = '[Image]';
        // 3) 本地已留存（media_data 或已下载 dataURI）才删服务器副本；否则留给 24h GC 兜底
        if (_imgDataUrl && msg.media_url && msg.media_url.indexOf('/api/v1/chat/files/') !== -1) {
          const _fileId = msg.media_url.split('/api/v1/chat/files/')[1].split(/[?&#/]/)[0];
          const _delToken = config.access_token || (typeof S !== 'undefined' && S.accessToken) || '';
          if (_fileId && _delToken) {
            fetch('/api/v1/chat/files/' + encodeURIComponent(_fileId), {
              method: 'DELETE',
              headers: { 'Authorization': 'Bearer ' + _delToken }
            }).then(r => {
              if (r.ok || r.status === 404) console.log('[AgentEngine] Server image copy deleted after ingest (HTTP ' + r.status + ')');
              else console.warn('[AgentEngine] Image copy delete unexpected status:', r.status);
            }).catch(e => console.warn('[AgentEngine] Image copy delete failed (24h GC will cover):', e));
          }
        }
      }
    }

    // [OPTIMIZE 2026-07-06] File handling: auto-save received files to virtual FS
    // and notify the agent about the file. The agent can then use read-pdf/read-doc/
    // read-xlsx tools to extract and read the file content.
    const _isFileMsg = msg && msg.msg_type === 'file' && (msg.file_info || msg.media_url);
    if (_isFileMsg) {
      try {
        let fileInfo = msg.file_info;
        if (typeof fileInfo === 'string') {
          try { fileInfo = JSON.parse(fileInfo); } catch(e) { fileInfo = { filename: fileInfo }; }
        }
        const filename = fileInfo?.filename || fileInfo?.name || `file_${Date.now()}`;
        const fileSize = fileInfo?.size || 0;
        const mimeType = fileInfo?.mimeType || fileInfo?.mime_type || '';

        // Save file to virtual FS
        const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
        let fileSaved = false;

        if (msg.media_data && msg.media_data.startsWith('data:')) {
          // Base64 data URI — decode and save
          const base64Match = msg.media_data.match(/^data:([^;]+);base64,(.+)$/);
          if (base64Match) {
            const byteString = atob(base64Match[2]);
            const bytes = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
            await AgentStorage.saveFile(config.agent_id, filename, bytes.buffer);
            fileSaved = true;
          }
        } else if (msg.media_url) {
          // Fetch from URL
          try {
            const fileUrl = msg.media_url.startsWith('http') ? msg.media_url :
                            (location.origin + (msg.media_url.startsWith('/') ? '' : '/') + msg.media_url);
            const fetchResp = await fetch(fileUrl);
            if (fetchResp.ok) {
              const arrayBuffer = await fetchResp.arrayBuffer();
              await AgentStorage.saveFile(config.agent_id, filename, arrayBuffer);
              fileSaved = true;
            }
          } catch(e) { console.warn('[AgentEngine] File fetch failed:', e); }
        }

        // Determine the appropriate read tool based on file extension
        const ext = filename.toLowerCase().split('.').pop();
        let readTool = '';
        if (ext === 'pdf') readTool = 'read-pdf';
        else if (ext === 'docx' || ext === 'doc') readTool = 'read-doc';
        else if (ext === 'xlsx' || ext === 'xls') readTool = 'read-xlsx';
        else if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'json') readTool = 'read-file';

        if (fileSaved) {
          const fileNote = `[File received: ${filename} (${fileSize} bytes${mimeType ? ', ' + mimeType : ''}).` +
            (readTool ? ` Use the ${readTool} tool with filename="${filename}" to read its content.` : '') + `]`;
          userMessageContent = (userMessage || 'A file was uploaded.') + '\n' + fileNote;
          console.log(`[AgentEngine] File saved to VS: ${filename}, readTool=${readTool}`);
        } else {
          console.warn('[AgentEngine] File could not be saved to VS');
        }
      } catch(e) {
        console.error('[AgentEngine] File handling error:', e);
      }
    }

    // 1. 加载对话历史 — [2026-09-04 重构] 按会话表 cuttime 时间索引抓取【全量】历史
    //    （不再用固定 20/10 条截断；用户输入/智能体回复/工具调用命令与结果全量入上下文）。
    //    cuttime 是上下文压缩游标：压缩发生后 cuttime 前移到 newcuttime，压缩交接日志
    //    插入在 newcuttime+1s —— 下一轮加载自然得到 "压缩交接日志 + 最近约10%历史"。
    //    仍保持懒加载：只有消息到达时才读，启动不预载。
    // 会话表（agent_sessions）：懒创建。存量会话 cuttime=最早消息时间-1ms（不丢历史），
    // 新会话 = 当前时间（即会话起点，与规格一致）。IndexedDB 不可用时兜底空游标。
    const sessionRow = (await AgentStorage.ensureSession(config.agent_id, sessionId)) ||
                       { cuttime: new Date().toISOString() };
    let history = await AgentStorage.getConversationsSince(config.agent_id, sessionId, sessionRow.cuttime);

    // 2. 构建 tools — [2026-09-04] 提前构建：上下文占比计算要把工具注册算进去；
    //    喂给 LLM 的顺序为 系统提示词→工具注册→历史，全部静态前缀，可变内容只在最新部分（缓存命中）
    const tools = AgentTools.toOpenAIFormat(config.tools);
    // [2026-09-03] analyze-image 内置强制注册 — 图片识别是基础能力，
    // 不受 per-agent 工具勾选影响（存量 agent 无需重新配置即可用）
    if (!tools.some(t => t.function && t.function.name === 'analyze-image')) {
      tools.push(...AgentTools.toOpenAIFormat(['analyze-image']));
    }
    // [2026-09-04] search-session-history 内置强制注册 — 上下文压缩的配套回查工具，
    // 压缩提醒文本会让模型调用它，必须始终可用
    if (!tools.some(t => t.function && t.function.name === 'search-session-history')) {
      tools.push(...AgentTools.toOpenAIFormat(['search-session-history']));
    }
    const toolsNL = this._toolsToNaturalLanguage(tools);

    // 3. 系统提示词 — [2026-09-04] 不再注入 [当前时间]（每轮变化会打断静态前缀、
    //    破坏 prompt cache）。时间注入移到本轮用户消息末尾（可变内容只在最新部分）。
    const userSysPrompt = config.system_prompt || 'You are a helpful assistant.';
    const sysContent = userSysPrompt +
      '\n[提醒] 涉及信息资讯的任务，请尽量提供最新时间节点信息，让用户知道数据的时效性。' +
      '\n[输出格式] 需要给用户演示/展示页面、组件、小工具、效果时，一律生成完整可运行的单文件 HTML（内联 CSS/JS）保存为 .html 文件发给用户，而不是贴大段代码让用户自己运行；需要画图（示意图/流程图/图表/图形）时，一律用 SVG 绘制（可内联在 HTML 中或保存为 .svg 文件发送），不要用 ASCII 字符画、不要发截图。';

    // 4. 上下文压缩：计算 maxcontextrate =（系统提示词+工具注册+cuttime 后全量历史+本轮消息）
    //    占模型最大上下文的百分比；> 80% 启动 cutAndSumHistory 压缩
    history = await this._cutAndSumHistoryIfNeeded({
      config, sessionId, sessionRow, history, sysContent, tools, userMessageContent
    });

    // 5. 构建 messages（系统提示词 → 历史 → 本轮用户消息）
    let messages = [
      { role: 'system', content: sysContent }
    ];
    for (const h of history) {
      // [2026-09-04] 还原完整工具调用链：assistant.tool_calls + tool.tool_call_id
      // （旧实现重建历史时丢弃 tool_calls，喂给 LLM 的不是全量信息）
      if (h.role === 'assistant' && h.tool_calls && h.tool_calls.length) {
        messages.push({ role: 'assistant', content: h.content || null, tool_calls: h.tool_calls });
      } else if (h.role === 'tool') {
        const tm = { role: 'tool', content: h.content || '' };
        if (h.tool_call_id) tm.tool_call_id = h.tool_call_id;
        messages.push(tm);
      } else {
        messages.push({ role: h.role, content: h.content });
      }
    }
    // [2026-09-04] 当前时间注入到本轮用户消息末尾 — 之前的信息保持静态（缓存友好）
    const now = new Date();
    const timeStr = now.getFullYear() + '-' +
      String(now.getMonth()+1).padStart(2,'0') + '-' +
      String(now.getDate()).padStart(2,'0') + ' ' +
      String(now.getHours()).padStart(2,'0') + ':' +
      String(now.getMinutes()).padStart(2,'0') + ':' +
      String(now.getSeconds()).padStart(2,'0');
    if (Array.isArray(userMessageContent)) {
      userMessageContent = userMessageContent.concat([{ type: 'text', text: '[当前时间] ' + timeStr }]);
    } else {
      userMessageContent = userMessageContent + '\n\n[当前时间] ' + timeStr;
    }
    messages.push({ role: 'user', content: userMessageContent });

    // 保存用户消息
    await AgentStorage.addConversation(config.agent_id, sessionId, 'user', userMessage);

    // 4. 发送"正在思考"状态
    this._sendStreamChunk(config.agent_id, replyTarget, config, 'Calling LLM...', 'thinking');

    // 5. Agent loop (最多 50 轮)
    const maxIterations = 50;
    // [FIX 2026-08-30] 免费模型 (nemotron/hy3 类) 常见 HTTP 200 但 content 为空
    // (仅 reasoning 无正文, 或上游偶发空 completion)。原逻辑直接退出循环要求
    // 人工"请重试", 长任务极易中断 → 自动重试最多 3 次 (退避 1.5/3/4.5s)。
    let emptyRetries = 0;
    for (let i = 0; i < maxIterations; i++) {
      // 调 LLM
      // [2026-08-28] 传入 replyTarget — 流式路径需要知道往哪个会话发 stream_chunk
      // [FIX 2026-08-30] const → let: 空回复降级重试路径需要重新赋值 llmResp
      // [2026-09-06] 经 _callLLMRetry 包装：429 限流 30s 起算指数退避，最多重试 5 次
      let llmResp = await this._callLLMRetry(messages, tools, toolsNL, config, sessionId, replyTarget);

      if (!llmResp.success) {
        this._sendStreamChunk(config.agent_id, replyTarget, config, `[Error: ${llmResp.error}]`, 'text');
        break;
      }

      // DEBUG: log LLM response
      console.log('[AgentEngine._agentLoop] LLM response:', JSON.stringify({
        content_preview: (llmResp.content || '').slice(0, 100),
        tool_calls_count: llmResp.tool_calls?.length || 0,
        success: llmResp.success,
        iteration: i,
        messages_count: messages.length,
        last_msg_preview: messages[messages.length-1]?.content?.slice(0, 80)
      }));

      // 如果有 tool_calls
      if (llmResp.tool_calls && llmResp.tool_calls.length > 0) {
        // 保存 assistant 消息（含 tool_calls）
        await AgentStorage.addConversation(config.agent_id, sessionId, 'assistant', llmResp.content, llmResp.tool_calls);
        // [FIX] content 为空字符串时改用 null — 部分 LLM API (如 Anthropic 兼容层)
        // 在 assistant 消息有 tool_calls 时会拒绝 content="" ，要求 content=null
        const assistantContent = (llmResp.content && llmResp.content.trim()) ? llmResp.content : null;
        messages.push({ role: 'assistant', content: assistantContent, tool_calls: llmResp.tool_calls });

        // 执行每个工具，并发送 tool_call / tool_result 流式事件
        for (const tc of llmResp.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch(e) {}
          const ctx = { agentId: config.agent_id, sessionId, ws: this._agentWS[config.agent_id], agentConfig: config, // [FIX 2026-08-29] replyTarget = the real account_id for WS sends — sessionId may be a
      // chat_session_id (cs_xxx) which is NOT a routable WS node; _autoSendFile must use this
      replyTarget: replyTarget || sessionId };

          const toolName = tc.function.name;

          // 发送 tool_call chunk — chat-streaming.js 会渲染成可折叠的工具卡片
          // data 格式: { name, input, id }
          this._sendStreamChunk(config.agent_id, replyTarget, config, {
            name: toolName,
            input: args,
            id: tc.id
          }, 'tool_call');

          let result;
          const isWasmTool = AgentTools._getCategory(toolName) === 'wasm';

          if (isWasmTool && toolName !== 'exec-code' && toolName !== 'exec-js' && toolName !== 'export-data') {
            // WASM 文件系统工具
            const { AgentToolsWasm } = await import(_agUrl('agent-tools-wasm.js'));
            result = await AgentToolsWasm.execute(toolName, args, ctx);
          } else if (toolName === 'exec-code' || toolName === 'exec-js') {
            // 代码执行沙箱
            const sandboxType = config.sandbox_type || 'javascript';
            if (sandboxType === 'python') {
              const { AgentSandboxPython } = await import(_agUrl('agent-sandbox-python.js'));
              result = await AgentSandboxPython.execute(args, ctx);
            } else if (sandboxType === 'javascript') {
              const { AgentSandboxJS } = await import(_agUrl('agent-sandbox-js.js'));
              result = await AgentSandboxJS.execute(args, ctx);
            } else {
              result = { success: false, error: 'No sandbox configured' };
            }
          } else {
            // 浏览器原生工具
            const { AgentToolsNative } = await import(_agUrl('agent-tools-native.js'));
            result = await AgentToolsNative.execute(toolName, args, ctx);
          }

          // 工具结果加入 messages
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          messages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id });
          // [2026-09-04] 落库时带上 tool_call_id — 历史重建时才能还原完整工具调用链
          await AgentStorage.addConversation(config.agent_id, sessionId, 'tool', resultStr, null, tc.id);

          // 发送 tool_result chunk — chat-streaming.js 会更新工具卡片的 ✓/✗ 状态和结果
          // data 格式: { output, success, error, id }
          const outputText = (result.output || resultStr).slice(0, 4000);
          this._sendStreamChunk(config.agent_id, replyTarget, config, {
            output: outputText,
            success: result.success !== false && !result.error,
            error: result.error,
            id: tc.id
          }, 'tool_result');
        }

        // 继续下一轮（让 LLM 看到工具结果后继续）
        // 发送 "thinking" 状态表示下一轮 LLM 调用
        this._sendStreamChunk(config.agent_id, replyTarget, config, 'Calling LLM...', 'thinking');
        continue;
      }

      // 没有 tool_calls → 最终回复
      const replyText = (llmResp.content || '').trim();
      // [FIX 2026-08-30] 空回复自动重试: 重试不占用正常轮次 (i-- 抵消 for 的 i++)。
      if (!replyText) {
        emptyRetries++;
        if (emptyRetries <= 5) {
          const delay = 1500 * emptyRetries;
          // [FIX 2026-08-30] 第 3 次起降级非流式: 免费档过载时流式路径返回 200 空流,
          // 非流式能拿到真实错误(502/503 可见)或完整 content
          const forceNonStream = emptyRetries >= 3;
          console.warn(`[AgentEngine._agentLoop] LLM empty content, auto-retry ${emptyRetries}/5 in ${delay}ms (nonStream=${forceNonStream})`);
          this._sendStreamChunk(config.agent_id, replyTarget, config, `(LLM empty reply — auto-retry ${emptyRetries}/5${forceNonStream ? ' · non-stream' : ''}...)`, 'thinking');
          await new Promise(r => setTimeout(r, delay));
          // [2026-09-06] 同样经 _callLLMRetry 包装（429 指数退避）
          llmResp = await this._callLLMRetry(messages, tools, toolsNL, config, sessionId, replyTarget, forceNonStream);
          if (llmResp && llmResp.success && (llmResp.content || '').trim()) {
            emptyRetries = 0;
            // 拿到非流式结果, 落到下方正常处理 (可能含 tool_calls → 继续循环)
          } else {
            i--;
            continue;
          }
        } else {
          console.warn('[AgentEngine._agentLoop] LLM empty content after 5 auto-retries, stopping loop');
          this._sendStreamChunk(config.agent_id, replyTarget, config, '(LLM returned empty replies repeatedly — the free model is overloaded. Try again later or switch models in Settings)', 'text');
          break;
        }
      }
      emptyRetries = 0; // 收到有效回复, 重置计数
      await AgentStorage.addConversation(config.agent_id, sessionId, 'assistant', replyText);

      // [FIX 2026-07-06] For group messages, send the reply via group_message WS
      // (stream_chunk only works for 1-to-1 PMs, not groups)
      if (replyTarget && replyTarget.startsWith('grp_')) {
        this._sendGroupMessage(config.agent_id, replyTarget, replyText, config);
      }
      messages.push({ role: 'assistant', content: replyText });

      // 流式输出最终回复
      // [2026-08-28] 流式路径已在 _callLLM 里逐段发送文本增量，
      // 这里不能再发完整文本，否则 UI 会出现两遍
      if (!llmResp.streamed) {
        this._sendStreamChunk(config.agent_id, replyTarget, config, replyText, 'text');
      }
      break;
    }

    // 6. 发送 stream_end
    this._sendStreamEnd(config.agent_id, replyTarget, config);
  },

  // [2026-09-06] 429 限流专用包装：指数退避重试，30s 起算（30/60/120/240/480s），最多 5 次。
  // 判定依据：底层调用返回 http_status === 429（各 provider 失败路径统一携带该字段）。
  // 每次等待前向聊天流发 thinking 提示，让长等待对用户可见。
  async _callLLMRetry(messages, tools, toolsNL, config, sessionId, replyTarget, forceNonStream) {
    const MAX_429_RETRIES = 5;       // 最多重试 5 次
    const BASE_429_MS = 30 * 1000;   // 30 秒起算
    let attempt = 0;
    while (true) {
      const r = await this._callLLM(messages, tools, toolsNL, config, sessionId, replyTarget, forceNonStream);
      if (r && r.success === false && r.http_status === 429 && attempt < MAX_429_RETRIES) {
        const delay = BASE_429_MS * Math.pow(2, attempt);   // 30/60/120/240/480s
        attempt++;
        console.warn(`[AgentEngine._callLLMRetry] HTTP 429 rate-limited — exponential backoff retry ${attempt}/${MAX_429_RETRIES} in ${Math.round(delay / 1000)}s`);
        this._sendStreamChunk(config.agent_id, replyTarget, config,
          `(Model rate-limited (HTTP 429) — auto-retry ${attempt}/${MAX_429_RETRIES} in ${Math.round(delay / 1000)}s...)`, 'thinking');
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      return r;
    }
  },

  // 调 LLM API（通过 aicq 服务器代理）
  async _callLLM(messages, tools, toolsNL, config, sessionId, replyTarget, forceNonStream) {
    const llmConfig = config.llm_config;
    const provider = llmConfig.provider;
    // [C4] Store agent's access_token for authenticated proxy calls
    llmConfig.__authToken = config.access_token || (typeof S !== 'undefined' && S.accessToken) || '';
    llmConfig.__agentId = config.agent_id || '';   // [2026-09-04] LLM 日志用

    // 兼容模式：不使用 function calling，改用文本方式让 LLM 调工具
    const compatMode = llmConfig.compat_mode === true;
    // scnet、chat-accumulation 始终用兼容模式（它们不支持 tools 参数）
    const useCompatMode = compatMode || provider === 'scnet' || provider === 'chat-accumulation';

    // DEBUG
    console.log('[AgentEngine._callLLM] provider=', provider, 'useCompatMode=', useCompatMode, 'tools_count=', tools.length);

    // ── chat-accumulation 模式：三段式发送，不发历史消息 ──
    // 1. 第一次调用：发 system prompt（初始化会话）
    // 2. 第二次调用：发 tools 列表（如果有的话）
    // 3. 第三次调用：发用户消息
    // 之后的每轮只发用户消息（服务端已累积历史）
    if (provider === 'chat-accumulation') {
      // 确保 session_id 存在
      if (!llmConfig.session_id) {
        llmConfig.session_id = 'sess_' + Date.now();
        // 持久化到 storage
        try {
          const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
          const cfg = await AgentStorage.getConfig(config.agent_id);
          if (cfg) {
            cfg.llm_config.session_id = llmConfig.session_id;
            await AgentStorage.saveConfig(config.agent_id, cfg);
            await AgentStorage.saveToKV('local_agent_' + config.agent_id, cfg);
          }
        } catch(e) { console.warn('[AgentEngine] Failed to persist session_id:', e); }
      }

      // 检查是否需要初始化会话（第一次发 system prompt + tools）
      // 标记存在 AgentEngine 实例上，不会被 config 重新加载覆盖
      if (!AgentEngine._caInit) AgentEngine._caInit = {};
      if (!AgentEngine._caInit[config.agent_id]) {
        // 第一次：发 system prompt
        const sysMsg = messages.find(m => m.role === 'system')?.content || 'You are a helpful assistant.';
        const initResp = await this._callChatAccumulation(llmConfig, sysMsg);
        if (!initResp.success) return initResp;

        // 第二次：发 tools 列表（如果有）
        if (toolsNL) {
          const toolsResp = await this._callChatAccumulation(llmConfig, toolsNL);
          if (!toolsResp.success) return toolsResp;
        }

        // 标记会话已初始化
        AgentEngine._caInit[config.agent_id] = true;
      }

      // 第三次（及之后每轮）：发用户消息 OR 工具结果
      // [FIX] 如果刚执行完工具，必须把 tool_result 发给 LLM，否则 LLM 看不到工具返回
      // （原代码只发 lastUser，导致 LLM 误以为工具没返回有效结果）
      const contentToSend = this._getAccumulationContent(messages);
      return await this._callChatAccumulation(llmConfig, contentToSend);
    }

    // ── scnet 模式：三段式发送，避免超字数限制 ──
    // scnet 服务端用 conversationId 自动累积对话历史
    // 所以客户端只需要发最新消息，不需要发历史
    // 三段式初始化：① system prompt → ② tools → ③ 用户消息
    // 每段如果超过 SCNET_MAX_CHUNK 字符，自动分批发送
    // 中间批次加"请勿回复"提示，最后一批加"请回复"提示
    if (provider === 'scnet') {
      const SCNET_MAX_CHUNK = 45000; // scnet 限制 50000，留 5000 余量
      // [注意] scnet 的 50000 限制是针对 content 字段的字节数。
      // JSON.stringify 嵌套时 < > { } " 等字符会被转义，导致字节数膨胀。
      // 实测 11295 字符的 toolsNL 在浏览器中会触发限制，
      // 所以分段阈值设为 10000 以确保安全。

      // 用唯一的 conversationId（每次创建 agent 用新的时间戳）
      // 避免不同 agent 的 hash 碰撞导致 scnet 上下文累积
      if (!AgentEngine._scnetCid) AgentEngine._scnetCid = {};
      if (!AgentEngine._scnetCid[config.agent_id]) {
        AgentEngine._scnetCid[config.agent_id] = Date.now() % 9007199254740991;
      }
      const cid = AgentEngine._scnetCid[config.agent_id];

      // 跟踪已发送的累积长度（scnet 服务端会累积所有历史）
      let _scnetAccumulatedLen = 0;

      // 分段发送辅助函数
      // scnet 限制：单次请求的 content + 服务端累积的历史 ≤ 50000
      // 所以每段的可用长度 = 50000 - 已累积长度 - 前缀提示长度 - 安全余量
      const sendChunked = async (text, label) => {
        const SCNET_LIMIT = 10000; // scnet 限制 50000 字节，但 JSON 转义会膨胀，安全阈值 10000
        const SAFETY_MARGIN = 2000; // 前缀提示 + 响应预留空间
        const PREFIX_MAX_LEN = 200; // 前缀提示最大长度

        // 计算当前可用的单段最大长度
        const availableChunk = SCNET_LIMIT - _scnetAccumulatedLen - SAFETY_MARGIN - PREFIX_MAX_LEN;
        
        if (availableChunk <= 0) {
          // 累积上下文已经超过限制 — 不能重置会话（会丢失 system prompt + tools）
          // 直接发送剩余文本（scnet 可能会截断，但不会丢失之前的上下文）
          console.log('[scnet] Accumulated context full, sending remaining text directly...');
          _scnetAccumulatedLen = 0; // 重置计数器但不重置会话
          return await this._callScnet(llmConfig, cid, text);
        }

        if (text.length <= availableChunk) {
          // 不需要分段，直接发
          _scnetAccumulatedLen += text.length + 500; // 500 = 估计的 scnet 响应长度
          return await this._callScnet(llmConfig, cid, text);
        }

        // 按段落边界切分
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
          // 动态计算当前段的可用长度
          const currentAvail = SCNET_LIMIT - _scnetAccumulatedLen - SAFETY_MARGIN - PREFIX_MAX_LEN;
          if (currentAvail <= 0) {
            // 累积超限，把剩余部分作为新段（会触发下面的重置逻辑）
            chunks.push(remaining);
            break;
          }
          if (remaining.length <= currentAvail) {
            chunks.push(remaining);
            break;
          }
          let cutPos = remaining.lastIndexOf('\n\n', currentAvail);
          if (cutPos < currentAvail * 0.5) cutPos = remaining.lastIndexOf('\n', currentAvail);
          if (cutPos < currentAvail * 0.5) cutPos = remaining.lastIndexOf(' ', currentAvail);
          if (cutPos < currentAvail * 0.5) cutPos = currentAvail;
          chunks.push(remaining.slice(0, cutPos));
          remaining = remaining.slice(cutPos).trimStart();
        }

        console.log(`[scnet] ${label} split into ${chunks.length} chunks (total ${text.length} chars, accumulated ${_scnetAccumulatedLen})`);

        // 逐段发送
        let lastResult = null;
        for (let i = 0; i < chunks.length; i++) {
          const isLast = (i === chunks.length - 1);
          let chunkContent = chunks[i];

          if (chunks.length > 1) {
            if (i === 0) {
              chunkContent = `[注意：以下${label}因长度限制将分${chunks.length}次发送，请在全部发完后再回复。这是第1段/共${chunks.length}段，请暂勿回复。]\n\n` + chunkContent;
            } else if (!isLast) {
              chunkContent = `[续上：第${i + 1}段/共${chunks.length}段，请暂勿回复。]\n\n` + chunkContent;
            } else {
              chunkContent = `[续上：第${i + 1}段/共${chunks.length}段。以上为全部${label}内容，请现在开始回复。]\n\n` + chunkContent;
            }
          }

          // 检查加上前缀后是否超限
          if (chunkContent.length > SCNET_LIMIT - _scnetAccumulatedLen - 500) {
            // 这段太长了，需要重置会话再发
            // [关键修复] 重置会话后，之前发的 system prompt 和 tools 都丢失了！
            // 必须标记 _scnetInit 为 false，让下次 _callLLM 重新初始化
            // 但当前 sendChunked 还在执行中，不能中断。
            // 解决方案：不用 session reset，而是减小 chunk 大小重试
            console.log(`[scnet] Chunk ${i + 1} too long (${chunkContent.length}), splitting further...`);
            // 把当前 chunk 进一步切分
            const subChunks = [];
            let subRemaining = chunks[i];
            while (subRemaining.length > 0) {
              const subAvail = SCNET_LIMIT - _scnetAccumulatedLen - SAFETY_MARGIN - PREFIX_MAX_LEN;
              if (subAvail <= 0) {
                // 累积已满，无法继续 — 直接发剩余部分（scnet 会截断或报错）
                subChunks.push(subRemaining);
                break;
              }
              if (subRemaining.length <= subAvail) {
                subChunks.push(subRemaining);
                break;
              }
              let subCut = subRemaining.lastIndexOf('\n', subAvail);
              if (subCut < subAvail * 0.5) subCut = subRemaining.lastIndexOf(' ', subAvail);
              if (subCut < subAvail * 0.5) subCut = subAvail;
              subChunks.push(subRemaining.slice(0, subCut));
              subRemaining = subRemaining.slice(subCut).trimStart();
            }
            // 替换当前 chunk 为子 chunks
            chunks.splice(i, 1, ...subChunks);
            // 重新计算 isLast
            continue; // 重新处理当前 index（现在是新的更小的 chunk）
          }

          console.log(`[scnet] Sending ${label} chunk ${i + 1}/${chunks.length} (${chunkContent.length} chars, accumulated ${_scnetAccumulatedLen})`);
          const resp = await this._callScnet(llmConfig, cid, chunkContent);
          if (!resp.success) return resp;

          // 更新累积长度（当前消息 + 估计的响应长度）
          _scnetAccumulatedLen += chunkContent.length + Math.min((resp.content || '').length + 500, 5000);

          if (!isLast) {
            console.log(`[scnet] Chunk ${i + 1} response (ignored): ${resp.content?.slice(0, 50) || '(empty)'}`);
            lastResult = resp;
          } else {
            return resp;
          }
        }
        // 如果所有段都发送了但没有返回（边界情况），返回最后一个结果
        return lastResult || { success: true, content: '', tool_calls: [] };
      };

      // 检查是否需要初始化会话
      if (!AgentEngine._scnetInit) AgentEngine._scnetInit = {};
      if (!AgentEngine._scnetInit[config.agent_id]) {
        // Phase 1: 发 system prompt（可能分段）
        const sysMsg = messages.find(m => m.role === 'system')?.content || 'You are a helpful assistant.';
        const initResp = await sendChunked(sysMsg, 'system prompt');
        if (!initResp.success) return initResp;

        // Phase 2: 发 tools 列表（如果有，可能分段）
        if (toolsNL) {
          const toolsResp = await sendChunked(toolsNL, 'tools');
          if (!toolsResp.success) return toolsResp;
        }

        AgentEngine._scnetInit[config.agent_id] = true;
      }

      // Phase 3: 只发用户消息（scnet 服务端已累积历史，可能分段）
      // [关键修复] 每隔一定消息数，重发工具列表防止模型遗忘
      if (!AgentEngine._scnetMsgCount) AgentEngine._scnetMsgCount = {};
      AgentEngine._scnetMsgCount[config.agent_id] = (AgentEngine._scnetMsgCount[config.agent_id] || 0) + 1;
      
      // 每 5 条消息重发一次工具列表
      // [FIX] 不在工具结果迭代中重发工具列表 — 工具列表很长会被分段发送，
      // 分段前缀会污染 LLM 历史，导致 LLM 把后续的工具结果误认为「第1段」
      const _hasToolResult = messages.length > 0 && messages[messages.length - 1].role === 'tool';
      if (toolsNL && AgentEngine._scnetMsgCount[config.agent_id] % 5 === 0 && !_hasToolResult) {
        console.log('[scnet] Re-sending tools list to prevent model from forgetting...');
        const refreshResp = await sendChunked(toolsNL, 'tools reminder');
        if (!refreshResp.success) return refreshResp;
      }
      
      // [FIX] 如果刚执行完工具，把 tool_result 发给 LLM，否则 LLM 看不到工具返回
      // （原代码只发 lastUser，导致 scnet 模式下 LLM 误以为工具没返回有效结果）
      let contentToSendScnet = this._getAccumulationContent(messages);
      
      // [FIX] 每次都附加精简版工具提醒，防止 LLM 遗忘工具
      // scnet 服务端累积历史，完整工具列表只在初始化时发一次（且被分段），
      // 后续轮次 LLM 容易遗忘 create-doc/weather/qr-code 等不常用工具。
      // 精简版提醒只有工具名+一句话描述（约2KB），不会被分段发送。
      if (toolsNL) {
        const compactReminder = this._toolsToCompactReminder(tools);
        contentToSendScnet = compactReminder + '\n\n---\n\n' + contentToSendScnet;
      }
      
      return await sendChunked(contentToSendScnet, 'user message');
    }

    // ── [2026-09-06] openai-response（OpenAI Responses API，POST /responses）──
    // BYOK 供应商（openai / custom）可选 Responses 协议：gpt-5.x 等新模型推荐。
    // 复用 _messagesToResponsesInput / _toolsToResponsesFormat / _parseResponsesOutput；
    // 通用路径本就非流式（stream:false），无需处理 SSE。
    if (llmConfig.api_type === 'openai-response') {
      const _base = (llmConfig.base_url || '').replace(/\/+$/, '');
      const _conv = this._messagesToResponsesInput(messages);
      const _rbody = { model: llmConfig.model, input: _conv.input, stream: false, store: false };
      if (_conv.instructions) _rbody.instructions = _conv.instructions;
      if (tools.length > 0) _rbody.tools = this._toolsToResponsesFormat(tools);
      const _proxyBody = {
        target_url: _base + '/responses',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.api_key}`
        },
        body: JSON.stringify(_rbody),
        stream: false
      };
      console.log('[AgentEngine._callLLM] openai-response →', _proxyBody.target_url, 'model=', llmConfig.model, 'tools=', tools.length);
      const _t0 = Date.now();
      const _resp = await fetch('/api/v1/agent/llm-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llmConfig.__authToken || '') },
        body: JSON.stringify(_proxyBody)
      });
      if (!_resp.ok) {
        let _errDetail = '';
        try { _errDetail = await _resp.text(); } catch (e) {}
        this._logLLM({ provider, model: llmConfig.model, status: _resp.status,
          latency_ms: Date.now() - _t0, msg_count: messages.length, _messages: messages,
          error: ('HTTP ' + _resp.status + ' — ' + _errDetail).slice(0, 500), agent_id: config.agent_id });
        return { success: false, http_status: _resp.status,
          error: `Responses API error: ${_resp.status} — ${String(_errDetail).slice(0, 400)}` };
      }
      const _text = await _resp.text();
      let _data;
      try { _data = JSON.parse(_text); }
      catch (e) {
        this._logLLM({ provider, model: llmConfig.model, status: 'ERR',
          latency_ms: Date.now() - _t0, msg_count: messages.length, _messages: messages,
          error: 'response not valid JSON: ' + _text.slice(0, 300), agent_id: config.agent_id });
        return { success: false, error: 'Responses API response is not valid JSON: ' + _text.slice(0, 200) };
      }
      const _parsed = this._parseResponsesOutput(_data);
      this._logLLMGeneric(_parsed, _data, llmConfig, messages, _t0, config);
      return _parsed;
    }

// 构建 prompt（兼容模式需要把 toolsNL 拼到 messages 里）
    let prompt = null;
    if (useCompatMode) {
      // 兼容模式：把 toolsNL 加到 system message 里，不发 tools 参数
      const sysMsg = messages.find(m => m.role === 'system');
      if (sysMsg && toolsNL) {
        sysMsg.content = sysMsg.content + '\n\n' + toolsNL;
      } else if (toolsNL) {
        messages.unshift({ role: 'system', content: toolsNL });
      }
      prompt = null;
    } else {
      prompt = null;
    }

    // 通过 aicq 服务器代理调 LLM（非 scnet 路径）
    const proxyBody = {
      target_url: llmConfig.base_url + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.api_key}`
      },
      body: JSON.stringify(useCompatMode ? {
        // 兼容模式：请求体尽可能精简，避免触发不支持参数的代理报错
        // 不发 tools, temperature, max_tokens — 只发最基本字段
        // [FIX] 兼容模式 LLM 不理解 OpenAI 的 role:'tool' 和 tool_calls 字段，
        // 必须净化消息：把 tool 结果转成 user 消息（<tool_result> 标签），
        // 把 assistant.tool_calls 转成 <tool_call> 标签放回 content。
        // 否则兼容模式 LLM 看不到工具结果，会回答"工具没返回有效结果"
        model: llmConfig.model,
        messages: this._sanitizeMessagesForCompat(messages),
        stream: false
      } : {
        // 标准 OpenAI function calling 模式
        model: llmConfig.model,
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: false,
        temperature: 0.8,
        // [FIX 2026-08-30] 4096 → 16384: nemotron 等 reasoning 模型的思考 token
        // 计入 max_tokens, 长对话+多工具轮次下 4096 被思考耗尽 → 正文为空
        max_tokens: 16384
      }),
      stream: false
    };

    // [2026-09-04] LLM 日志计时起点（fetch 之前）
    const _llmT0 = Date.now();
    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llmConfig.__authToken || '') },
      body: JSON.stringify(proxyBody)
    });

    // DEBUG: log what we sent to LLM (truncated)
    try {
      const sentBody = JSON.parse(proxyBody.body);
      console.log('[AgentEngine._callLLM] Sent to LLM:', JSON.stringify({
        model: sentBody.model,
        messages_count: sentBody.messages?.length,
        system_preview: sentBody.messages?.[0]?.content?.slice(0, 200),
        last_user_preview: sentBody.messages?.[sentBody.messages.length-1]?.content?.slice(0, 100),
        has_tools: !!sentBody.tools,
        useCompatMode
      }));
    } catch(e) {}

    if (!resp.ok) {
      // 读取错误详情 — 代理会在 body 里返回实际原因（如 DNS 失败、TLS 错误等）
      let errDetail = '';
      try {
        const errText = await resp.text();
        try {
          const errJson = JSON.parse(errText);
          // errJson.error 可能是 string 或 object，统一转成字符串
          const raw = errJson.error || errJson.message || errText;
          errDetail = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {
          errDetail = errText;
        }
      } catch {}
      // 提供常见原因提示
      let hint = '';
      if (resp.status === 502) {
        hint = ' (502 = the relay cannot reach the LLM API. Common causes: network down, DNS failure, wrong API URL, TLS handshake failure)';
      } else if (resp.status === 401 || resp.status === 403) {
        hint = ' (Authentication failed — check your API Key / Cookie)';
      } else if (resp.status === 404) {
        hint = ' (404 — check base_url; for deepseek it should be https://api.deepseek.com/v1)';
      } else if (resp.status === 503) {
        // 503 通常是上游 API 拒绝请求 — 可能是不支持 function calling
        hint = ' (503 = upstream model unavailable. If the test button works but chat returns 503, the API relay likely does not support function calling — enable "Compat Mode" in the LLM settings)';
      } else if (resp.status === 400) {
        hint = ' (400 = bad request — the API relay may not support the tools parameter; enable "Compat Mode" in the LLM settings)';
      }
      // [2026-09-04] LLM 日志：HTTP 失败
      this._logLLM({ provider, model: llmConfig.model, status: resp.status,
        latency_ms: Date.now() - _llmT0, msg_count: messages.length, _messages: messages,
        error: ('HTTP ' + resp.status + ' — ' + errDetail).slice(0, 500), agent_id: config.agent_id });
      // [2026-09-06] http_status 供 _callLLMRetry 识别 429 限流（30s 指数退避重试）
      return { success: false, http_status: resp.status, error: `LLM proxy error: ${resp.status} — ${errDetail}${hint}` };
    }

    // 解析响应（scnet 已在上面的三段式分支处理，这里只处理 OpenAI 兼容）
    if (useCompatMode) {
      // 兼容模式：解析 OpenAI JSON 响应，但从文本中提取 <tool_call> 标签
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        const parsed = this._parseOpenAICompatResponse(data);
        this._logLLMGeneric(parsed, data, llmConfig, messages, _llmT0, config);
        return parsed;
      } catch(e) {
        console.error('[AgentEngine] LLM response parse error:', e, 'text:', text.slice(0, 500));
        this._logLLM({ provider: llmConfig.provider, model: llmConfig.model, status: 'ERR',
          latency_ms: Date.now() - _llmT0, msg_count: messages.length, _messages: messages,
          error: 'response not valid JSON: ' + text.slice(0, 300), agent_id: config.agent_id });
        return { success: false, error: 'LLM response is not valid JSON: ' + text.slice(0, 200) };
      }
    } else {
      // 标准 OpenAI function calling 响应
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        const parsed = this._parseOpenAIResponse(data);
        this._logLLMGeneric(parsed, data, llmConfig, messages, _llmT0, config);
        return parsed;
      } catch(e) {
        console.error('[AgentEngine] LLM response parse error:', e, 'text:', text.slice(0, 500));
        this._logLLM({ provider: llmConfig.provider, model: llmConfig.model, status: 'ERR',
          latency_ms: Date.now() - _llmT0, msg_count: messages.length, _messages: messages,
          error: 'response not valid JSON: ' + text.slice(0, 300), agent_id: config.agent_id });
        return { success: false, error: 'LLM response is not valid JSON: ' + text.slice(0, 200) };
      }
    }
  },

  // ── scnet 单次调用（三段式发送的每一段）──
  // 用固定的 conversationId，发单条 content，scnet 服务端自动累积历史
  async _callScnet(llmConfig, cid, content) {
    const proxyBody = {
      target_url: 'https://www.scnet.cn/acx/chatbot/v1/chat/completion',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': llmConfig.cookie,
        'Accept': 'text/event-stream',
        'Origin': 'https://www.scnet.cn',
        'Referer': `https://www.scnet.cn/ui/chatbot/${cid}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0'
      },
      body: JSON.stringify({
        conversationId: cid,
        content: content,
        thinkingEnable: false, onlineEnable: false,
        modelId: llmConfig.model_id || 520,
        textFile: [], imageFile: [], autoRun: 0, clusterId: ''
      }),
      stream: true
    };

    console.log('[AgentEngine._callScnet] cid=', cid, 'content_len=', content.length);

    // [2026-09-04] LLM 日志计时起点（fetch 之前）
    const _llmT0 = Date.now();
    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llmConfig.__authToken || '') },
      body: JSON.stringify(proxyBody)
    });

    if (!resp.ok) {
      let errDetail = '';
      try {
        const errText = await resp.text();
        try {
          const errJson = JSON.parse(errText);
          const raw = errJson.error || errJson.message || errText;
          errDetail = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch { errDetail = errText; }
      } catch {}
      // [2026-09-04] LLM 日志：HTTP 失败
      this._logLLM({ provider: 'scnet', model: 'scnet:' + (llmConfig.model_id || 520), status: resp.status,
        latency_ms: Date.now() - _llmT0, _rawInput: content,
        error: ('HTTP ' + resp.status + ' — ' + errDetail).slice(0, 500), agent_id: llmConfig.__agentId || '', phase: 'chunk' });
      return { success: false, http_status: resp.status, error: `scnet error: ${resp.status} — ${errDetail}` };
    }

    // 解析 scnet SSE 响应
    const _r = await this._parseScnetResponse(resp, []);
    // [2026-09-04] LLM 日志：分段调用（scnet 三段式每段一条）
    this._logLLM({ provider: 'scnet', model: 'scnet:' + (llmConfig.model_id || 520), status: 200,
      latency_ms: Date.now() - _llmT0, tokens_in: Math.ceil(content.length / 4),
      tokens_out: Math.ceil((_r.content || '').length / 4), tokens_est: true,
      _rawInput: content, output: _r.content || '',
      error: _r.success ? '' : String(_r.error || '').slice(0, 500),
      agent_id: llmConfig.__agentId || '', phase: 'chunk' });
    return _r;
  },


  // ── chat-accumulation 单次调用 ──
  // 发送单条消息到 OpenAI 兼容端点，带 session_id 作为自定义字段
  // 服务端会根据 session_id 累积对话历史
  async _callChatAccumulation(llmConfig, content) {
    const proxyBody = {
      target_url: llmConfig.base_url + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.api_key}`
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: 'user', content: content }],
        stream: false,
        // session_id 作为自定义字段传给服务端
        // 服务端（如 one-api/new-api）可以用它来累积对话历史
        session_id: llmConfig.session_id
      }),
      stream: false
    };

    console.log('[AgentEngine._callChatAccumulation] session_id=', llmConfig.session_id, 'content_len=', content.length);

    // [2026-09-04] LLM 日志计时起点（fetch 之前）
    const _llmT0 = Date.now();
    const resp = await fetch('/api/v1/agent/llm-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (llmConfig.__authToken || '') },
      body: JSON.stringify(proxyBody)
    });

    if (!resp.ok) {
      let errDetail = '';
      try {
        const errText = await resp.text();
        try {
          const errJson = JSON.parse(errText);
          const raw = errJson.error || errJson.message || errText;
          errDetail = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch { errDetail = errText; }
      } catch {}
      // [2026-09-04] LLM 日志：HTTP 失败
      this._logLLM({ provider: 'chat-accumulation', model: llmConfig.model || '', status: resp.status,
        latency_ms: Date.now() - _llmT0, _rawInput: content,
        error: ('HTTP ' + resp.status + ' — ' + errDetail).slice(0, 500), agent_id: llmConfig.__agentId || '', phase: 'step' });
      return { success: false, http_status: resp.status, error: `Chat-Accumulation error: ${resp.status} — ${errDetail}` };
    }

    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      // 用兼容模式解析（提取 <tool_call> 标签）
      const _parsed = this._parseOpenAICompatResponse(data);
      // [2026-09-04] LLM 日志
      this._logLLM({ provider: 'chat-accumulation', model: llmConfig.model || '', status: 200,
        latency_ms: Date.now() - _llmT0, tokens_in: Math.ceil(content.length / 4),
        tokens_out: Math.ceil((_parsed.content || '').length / 4), tokens_est: !data?.usage,
        _rawInput: content, output: _parsed.content || '',
        error: _parsed.success ? '' : String(_parsed.error || '').slice(0, 500),
        agent_id: llmConfig.__agentId || '', phase: 'step' });
      return _parsed;
    } catch(e) {
      console.error('[AgentEngine] Chat-Accumulation parse error:', e, 'text:', text.slice(0, 500));
      // [2026-09-04] LLM 日志：非 JSON 响应
      this._logLLM({ provider: 'chat-accumulation', model: llmConfig.model || '', status: 'ERR',
        latency_ms: Date.now() - _llmT0, _rawInput: content,
        error: 'Invalid JSON response: ' + text.slice(0, 300), agent_id: llmConfig.__agentId || '', phase: 'step' });
      return { success: false, error: 'Invalid JSON response: ' + text.slice(0, 200) };
    }
  },

  // OpenAI chat messages → Responses API {instructions, input}
  // system→instructions / 多模态 image_url→input_image / tool_calls→function_call /
  // tool 结果→function_call_output
  _messagesToResponsesInput(messages) {
    let instructions = '';
    const input = [];
    for (const m of messages || []) {
      if (m.role === 'system') {
        instructions += (instructions ? '\n\n' : '') + this._textFromContentParts(m.content);
        continue;
      }
      if (m.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: m.tool_call_id || '',
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        });
        continue;
      }
      if (Array.isArray(m.content)) {
        // 多模态消息（图片分析）：text→input_text / image_url→input_image
        const parts = [];
        for (const c of m.content) {
          if (c.type === 'text') {
            parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: c.text || '' });
          } else if (c.type === 'image_url') {
            const u = (typeof c.image_url === 'string') ? c.image_url : (c.image_url && c.image_url.url) || '';
            if (u) parts.push({ type: 'input_image', image_url: u, detail: 'auto' });
          }
        }
        input.push({ role: m.role, content: parts });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // 上一轮的函数调用 — 还原成 function_call 项（call_id 必须与 function_call_output 对应）
        if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] });
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '{}'
          });
        }
        continue;
      }
      input.push({
        role: m.role,
        content: m.role === 'assistant'
          ? [{ type: 'output_text', text: String(m.content ?? '') }]
          : [{ type: 'input_text', text: String(m.content ?? '') }]
      });
    }
    return { instructions, input };
  },

  _textFromContentParts(content) {
    if (!Array.isArray(content)) return String(content ?? '');
    return content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  },

  // OpenAI chat tools (嵌套 function) → Responses API function tools (扁平)
  _toolsToResponsesFormat(tools) {
    return (tools || []).map(t => ({
      type: 'function',
      name: t.function?.name || '',
      description: t.function?.description || '',
      parameters: t.function?.parameters || { type: 'object', properties: {} }
    }));
  },

  // Responses API 非流式输出解析 → OpenAI 风格 {content, tool_calls}
  _parseResponsesOutput(data) {
    // [2026-08-28] HTTP 200 + {"error":{...}} 包裹错误
    if (data.error && !data.output) {
      const e = data.error;
      const msg = (typeof e === 'string') ? e : (e.message || e.type || JSON.stringify(e).slice(0, 200));
      return { success: false, error: 'Responses API error: ' + msg };
    }
    if (data.status === 'failed') {
      const err = data.error || {};
      return { success: false, error: 'Responses API failed: ' + (err.message || JSON.stringify(err).slice(0, 200)) };
    }
    let content = data.output_text || '';
    const toolCalls = [];
    for (const item of (data.output || [])) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) content += c.text;
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id || ('call_' + (toolCalls.length + 1)),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' }
        });
      }
    }
    return { success: true, content, tool_calls: toolCalls };
  },

  // [FIX] 从文本中提取 tool_call — 平衡括号匹配，支持多种标签名
  // 解决问题：
  //   1. LLM 幻觉闭合标签名（</tool_action> 而非 </tool_call>）
  //   2. 深层嵌套 JSON 导致非贪婪正则回溯失败
  //   3. LLM 忘记写闭合标签
  _extractToolCallsFromText(text) {
    if (!text) return { toolCalls: [], text: '' };
    const toolCalls = [];
    const cleanedParts = [];
    let lastEnd = 0;

    // 匹配多种开始标签：<tool_call>、<tool_action>、<function_call>
    const openPattern = /<(tool_call|tool_action|function_call)>\s*/gi;
    let match;
    while ((match = openPattern.exec(text)) !== null) {
      const tagStart = match.index;
      const jsonStart = openPattern.lastIndex;

      // 把标签前的文本加入清理后的输出
      cleanedParts.push(text.slice(lastEnd, tagStart));

      if (text[jsonStart] !== '{') {
        // 标签后不是 JSON 对象 — 跳过
        lastEnd = openPattern.lastIndex;
        continue;
      }

      // 平衡括号匹配 — 逐字符扫描，正确处理字符串内的括号和转义
      let depth = 0, inString = false, escape = false, jsonEnd = -1;
      for (let i = jsonStart; i < text.length; i++) {
        const c = text[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { jsonEnd = i; break; }
        }
      }

      if (jsonEnd === -1) {
        // JSON 没有正确闭合 — 跳过
        lastEnd = jsonStart;
        continue;
      }

      const jsonStr = text.slice(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        toolCalls.push({
          id: `call_${toolCalls.length + 1}`, type: 'function',
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) }
        });
      } catch(e) {
        console.warn('[AgentEngine] Failed to parse tool_call JSON:', e.message, 'json:', jsonStr.slice(0, 200));
      }

      // 跳过闭合标签（如果有）— 支持多种标签名
      let afterJson = jsonEnd + 1;
      const restText = text.slice(afterJson);
      const closeMatch = restText.match(/^\s*<\/(?:tool_call|tool_action|function_call)>/i);
      if (closeMatch) {
        afterJson += closeMatch[0].length;
      }
      lastEnd = afterJson;
    }

    cleanedParts.push(text.slice(lastEnd));
    const cleanedText = cleanedParts.join('').trim();

    return { toolCalls, text: cleanedText };
  },

  // 解析 OpenAI 兼容模式响应 — 从文本中提取 <tool_call> 标签
  _parseOpenAICompatResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) return { success: false, error: 'No choices in response' };
    let content = choice.message?.content || '';
    let toolCalls = [];

    // [FIX] 使用平衡括号匹配提取 tool_call，替代脆弱的正则
    // 旧正则 /<tool_call>\s*(\{.*?\})\s*<\/tool_call>/gs 有三个问题：
    // 1. 严格要求 </tool_call> 闭合标签 — LLM 可能幻觉成 </tool_action> 等
    // 2. 非贪婪 .*? 遇到深层嵌套 JSON（如 create-doc 的 content 参数）会回溯失败
    // 3. 无闭合标签时（LLM 忘记关闭）完全失败
    const extracted = this._extractToolCallsFromText(content);
    return { success: true, content: extracted.text, tool_calls: extracted.toolCalls };
  },

  // 解析 scnet SSE 响应
  async _parseScnetResponse(resp, tools) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullContent = '';
    let toolCalls = [];

    while (true) {
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
            if (obj.contentType === '1001' && obj.content) {
              fullContent += obj.content;
            } else if (obj.contentType && obj.contentType !== '1002' && obj.content) {
              // 错误事件
              return { success: false, error: obj.content };
            }
          } catch(e) {}
        }
      }
    }

    // [FIX] 使用平衡括号匹配提取 tool_call，替代脆弱的正则
    const extracted = this._extractToolCallsFromText(fullContent);
    return { success: true, content: extracted.text, tool_calls: extracted.toolCalls };
  },

  // 解析 OpenAI 标准响应
  // [2026-08-28] 增强识别 HTTP 200 + {"error":{...}} 包裹错误（部分网关上游过载时
  // 会返回 200 + error JSON，而非 HTTP 5xx）
  _parseOpenAIResponse(data) {
    if (data.error) {
      const e = data.error;
      const msg = (typeof e === 'string') ? e : (e.message || e.type || JSON.stringify(e).slice(0, 200));
      const etype = (typeof e === 'object' && e.type) ? e.type + ': ' : '';
      return { success: false, error: 'LLM error: ' + etype + msg };
    }
    const choice = data.choices?.[0];
    if (!choice) return { success: false, error: 'No choices in response' };
    return {
      success: true,
      content: choice.message?.content || '',
      tool_calls: choice.message?.tool_calls || []
    };
  },

  // [2026-08-28] 判断是否为瞬态上游错误（值得自动重试一次）：5xx/超时/overloaded 类错误自动重试一次
  _isTransientUpstreamError(status, bodyText) {
    if (status === 502 || status === 503 || status === 529 || status === 408) return true;
    try {
      const j = JSON.parse(bodyText);
      const et = j.error?.type || '';
      const em = (j.error?.message || j.error || '').toString().toLowerCase();
      return et === 'server_error' || /overloaded|temporarily|timeout|try again/.test(em);
    } catch(e) {
      return /overloaded|temporarily|try again/i.test(bodyText || '');
    }
  },

  // [FIX] 累积式 provider (scnet / chat-accumulation) 每次只发一条消息，
  // 服务端累积历史。原代码只发 lastUser，导致工具结果永远送不到 LLM。
  // 此函数检测 messages 末尾的 tool 结果，若有则包成 user 消息发出去。
  _getAccumulationContent(messages) {
    if (!messages || messages.length === 0) return '';
    // 从末尾收集连续的 tool 结果
    const toolResults = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') {
        toolResults.unshift(messages[i]);
      } else {
        break;
      }
    }
    if (toolResults.length === 0) {
      // 没有工具结果 — 正常发最后一条 user 消息
      return [...messages].reverse().find(m => m.role === 'user')?.content || '';
    }
    // 有工具结果 — 包成 user 消息发给 LLM
    // [FIX] scnet 分段发送的前缀（如「请暂勿回复，等待第N段」）会污染 LLM 的对话历史，
    // 导致 LLM 看到工具结果时模式匹配成「第1段」并回复「好的，我已收到第1段」就停下。
    // 这里加一个强提示，明确告诉 LLM 这是一条完整消息，不是分段消息，必须立即回复。
    const userQuestion = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let content = '[IMPORTANT: the following is ONE complete tool-execution result, not a segmented message. Read all of it now and reply to the user based on it — do not wait for further segments and do not say "received part 1".]\n\n<tool_results>\n';
    // [FIX] 截断过长的工具结果，避免触发 scnet 分段发送导致 LLM 混淆
    // scnet 单段安全阈值约 8000 字符，每个工具结果最多保留 4000 字符
    const MAX_TOOL_RESULT_LEN = 4000;
    for (const tr of toolResults) {
      let tc = tr.content || '';
      if (tc.length > MAX_TOOL_RESULT_LEN) {
        tc = tc.substring(0, MAX_TOOL_RESULT_LEN) + '\n... [truncated, original length ' + tc.length + ' chars]';
      }
      content += `<tool_result tool_call_id="${tr.tool_call_id || ''}">\n${tc}\n</tool_result>\n\n`;
    }
    content += `</tool_results>\n\n[User's original question] ${userQuestion}\n\nContinue answering the user based on the tool results above. If they are sufficient, give the final answer directly (reply in the same language as the user's message); if more tool calls are needed, continue calling tools. Never say "the tool returned no valid result" — the results are inside the <tool_result> tags above.`;
    return content;
  },

  // [FIX] 兼容模式消息净化 — 把 OpenAI function calling 格式转成纯文本
  // 1. role:'tool' → role:'user'，内容用 <tool_result> 包裹
  // 2. assistant.tool_calls → 转成 <tool_call> 标签放回 content
  // 3. assistant.content 为空但有 tool_calls 时，至少保留 <tool_call> 标签
  _sanitizeMessagesForCompat(messages) {
    if (!messages) return [];
    return messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: `<tool_result tool_call_id="${m.tool_call_id || ''}">\n${m.content || ''}\n</tool_result>`
        };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        let content = m.content || '';
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch(e) { args = {}; }
          content += `\n<tool_call>\n${JSON.stringify({ name: tc.function?.name, arguments: args })}\n</tool_call>`;
        }
        return { role: 'assistant', content: content.trim() };
      }
      // 兼容模式 LLM 可能也不理解 assistant.content=null
      if (m.role === 'assistant' && (m.content === null || m.content === undefined)) {
        return { role: 'assistant', content: '' };
      }
      // [OPTIMIZE 2026-07-06] Compat mode LLMs don't support array content (multimodal).
      // Extract text from array content, ignore image_url parts.
      if (Array.isArray(m.content)) {
        const textParts = m.content.filter(c => c.type === 'text').map(c => c.text || '');
        const hasImage = m.content.some(c => c.type === 'image_url');
        let textContent = textParts.join('\n');
        if (hasImage) textContent += '\n[Image attached — compat mode LLM cannot view images]';
        return { role: m.role, content: textContent };
      }
      return m;
    });
  },

  // [FIX] 精简版工具提醒 — 只有工具名和一句话描述，不会被 scnet 分段发送
  // 每次发用户消息时附加这个提醒，确保 LLM 始终知道所有可用工具
  // 解决问题：scnet 初始化时发了完整工具列表（很长，被分段），
  // 但后续轮次只发用户消息，LLM 遗忘了 create-doc/weather/qr-code 等工具
  _toolsToCompactReminder(tools) {
    if (!tools || tools.length === 0) return '';
    const lines = ['[可用工具提醒] 你有以下工具可用。要调用工具，输出 <tool_call>{"name":"工具名","arguments":{...}}</tool_call>'];
    for (const t of tools) {
      const f = t.function;
      // 只取描述的第一句话（到第一个句号或换行）
      const shortDesc = (f.description || '').split(/[.。\n]/)[0].slice(0, 60);
      lines.push(`- ${f.name}: ${shortDesc}`);
    }
    return lines.join('\n');
  },

  // 工具列表转自然语言（给 scnet 用）
  _toolsToNaturalLanguage(tools) {
    if (!tools || tools.length === 0) return '';
    let lines = ['<available_tools>', 'To call a tool, output: <tool_call>{"name":"tool_name","arguments":{...}}</tool_call>', ''];
    for (const t of tools) {
      const f = t.function;
      lines.push(`## ${f.name}\n${f.description}`);
      if (f.parameters?.properties) {
        lines.push('Parameters:');
        for (const [pname, pinfo] of Object.entries(f.parameters.properties)) {
          const req = f.parameters.required?.includes(pname) ? 'required' : 'optional';
          lines.push(`  - ${pname} (${pinfo.type}, ${req}): ${pinfo.description || ''}`);
        }
      }
      lines.push('');
    }
    lines.push('</available_tools>\n');
    return lines.join('\n');
  },

  // WS 发送流式 chunk
  // chunkType: 'text' | 'thinking' | 'reasoning' | 'reasoning_end' | 'tool_call' | 'tool_result' | 'clear_text'
  // text/data 可以是 string (text/thinking) 或 object (tool_call/tool_result)
  // [FIX 2026-08-29] 使用本次回复注册的稳定 stream_id（见 handleAgentMessage），
  // 服务端把所有 chunk 聚合进同一个 StreamBuffer，stream_end 时整体落库持久化。
  // 同时本地镜像追踪 text/tool 片段，供 stream_end 的 fallback 覆盖字段使用
  // （服务端缓冲区丢失时——如服务重启——仍可完整落库）。
  _sendStreamChunk(agentId, sessionId, config, data, chunkType) {
    const ws = this._agentWS[agentId];
    if (!ws || ws.readyState !== 1) {
      // [FIX 2026-08-29] Silent drops here looked like "agent never replies".
      // Log loudly so the condition is diagnosable from the browser console.
      console.warn('[AgentEngine] WS down, DROP stream_chunk for', sessionId, '- agent may appear silent');
      return;
    }
    const st = this._activeStreams && this._activeStreams[agentId];
    // 群聊回复不走 stream_chunk：服务器 SendToNode 无法投递到 grp_* 账号，
    // 纯浪费流量且会在服务端留下孤立缓冲区。群回复由 _sendGroupMessage 发送。
    if (st && st.isGroup) return;
    const streamId = (st && st.streamId) || `${agentId}_${Date.now()}`;
    // 本地镜像追踪（text / tool_call / tool_result）
    if (st) {
      if ((chunkType || 'text') === 'text' && typeof data === 'string') {
        if (st.contentOrder[st.contentOrder.length - 1] === 'text') {
          st.textSegments[st.textSegments.length - 1] += data;
        } else {
          st.contentOrder.push('text');
          st.textSegments.push(data);
        }
      } else if (chunkType === 'tool_call' && data && typeof data === 'object') {
        st.contentOrder.push('tool');
        st.toolCalls.push({ name: data.name || '', input: data.input, id: data.id || '', result: '', success: null });
      } else if (chunkType === 'tool_result' && data && typeof data === 'object') {
        const rid = data.id || '';
        for (let i = st.toolCalls.length - 1; i >= 0; i--) {
          const tc = st.toolCalls[i];
          if ((rid && tc.id === rid) || (!rid && tc.result === '')) {
            tc.result = String(data.output || data.error || '').slice(0, 4000);
            tc.success = data.success !== false && !data.error;
            break;
          }
        }
      }
    }
    ws.send(JSON.stringify({
      type: 'stream_chunk',
      to: sessionId,
      from: agentId,
      stream_id: streamId,
      chunkType: chunkType || 'text',  // camelCase — 服务器只认 chunkType / msg_type
      // [FIX 2026-08-29] session stamp — relayed to the recipient's frontend so
      // live chunks from a PREVIOUS session are not rendered into the current view
      chat_session_id: (st && st.csid) || '',
      data: data
    }));
  },

  // WS 发送 stream_end
  // [FIX 2026-08-29] 1) 复用稳定 stream_id，服务端 EndStream 找到聚合缓冲区并落库；
  // 2) 附带 text_segments / tool_calls / content_order 覆盖字段 —— 即使服务端
  //    缓冲区丢失（如服务重启），fallback 路径也能把完整消息写入 direct_messages。
  _sendStreamEnd(agentId, sessionId, config) {
    const ws = this._agentWS[agentId];
    const st = this._activeStreams && this._activeStreams[agentId];
    if (st && st.isGroup) return;  // 群回复不走流式通道（见 _sendStreamChunk）
    if (!ws || ws.readyState !== 1) {
      // [FIX 2026-08-29] Dropping stream_end silently = the whole reply is
      // never persisted — the visible symptom of "agent never replied".
      console.warn('[AgentEngine] WS down, DROP stream_end for', sessionId, '- reply lost unless retried');
      return;
    }
    const payload = {
      type: 'stream_end',
      to: sessionId,
      from: agentId,
      stream_id: (st && st.streamId) || `${agentId}_${Date.now()}`,
      // [FIX 2026-08-29] Server stamps this csid into the persisted metadata so
      // the reply strictly belongs to the session it answers (anti cross-session leak)
      chat_session_id: (st && st.csid) || ''
    };
    if (st) {
      if (st.textSegments.length > 0) payload.text_segments = st.textSegments;
      if (st.toolCalls.length > 0) {
        payload.tool_calls = st.toolCalls.map(tc => ({
          name: tc.name, input: tc.input, result: tc.result || '', success: tc.success, id: tc.id || ''
        }));
      }
      if (st.contentOrder.length > 1) payload.content_order = st.contentOrder;
    }
    ws.send(JSON.stringify(payload));
  },

  // [FIX 2026-07-06] Send a group_message via WS (for group chat replies)
  // The server's handleGroupMessage saves to DB and broadcasts to all group members.
  // This is the correct way for agents to reply in group chats — stream_chunk
  // only works for 1-to-1 PMs (SendToNode expects an account_id, not a group_id).
  _sendGroupMessage(agentId, groupId, content, config) {
    const ws = this._agentWS[agentId];
    if (!ws || ws.readyState !== 1) {
      console.warn('[AgentEngine] Cannot send group_message: WS not connected');
      return;
    }
    ws.send(JSON.stringify({
      type: 'group_message',
      groupId: groupId,
      from: agentId,
      content: content,
      msgType: 'text'
    }));
    console.log(`[AgentEngine] Sent group_message to ${groupId}: ${content.slice(0, 80)}`);
  },

  // ═══ [2026-09-04] 上下文压缩机制（cutAndSumHistory）═══
  // 规格实现（替换旧实现：固定4000 token 阈值 + 60/40 按条数分割 + 英文500token摘要
  // + 输入 slice(0,8000) 截断 + 摘要仅存 KV 不落历史表 —— 用户在 LLM 日志里看到
  // 压缩调用输入"根本没有按要求进压缩"即由此而来）。
  //
  // 规格流程：
  //   1. 会话表（agent_sessions）含 cuttime 字段，默认=创建时间（存量会话迁移时取
  //      最早消息时间防丢历史）；历史加载一律按时间索引从 cuttime 抓全量；
  //   2. 每轮计算 maxcontextrate = 当前上下文 / 模型最大上下文；> 80% 触发本函数；
  //   3. 从最新往回取约 10% 最大上下文的最近历史保留，newcuttime = 剩余被压缩区间的
  //      最后一个时间点；
  //   4. [cuttime..newcuttime] 全量信息（用户输入/智能体回复/工具调用命令与结果，
  //      不截断）交给 LLM 整理成 ≤2000字 结构化交接工作日志（五个固定栏目）；
  //   5. llm_output + search-session-history 提醒 插入历史表，时间 = newcuttime+1s
  //      （时间索引上紧跟 newcuttime 之后）；cuttime = newcuttime；
  //   6. 下一轮加载自然 = 压缩交接日志 + 最近约10%历史。
  //   兜底：压缩 LLM 失败 → 本轮不压缩不丢数据，下轮重试。

  // CJK 感知 token 估算：中文≈1字1token（保守宁高勿低），非CJK≈4字符1token
  _estCtxTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++;
    }
    const other = s.length - cjk;
    return cjk + Math.ceil(other / 4);
  },

  _estCtxTokensMsgs(msgs) {
    let t = 0;
    for (const m of (msgs || [])) {
      const c = m.content;
      t += this._estCtxTokens(typeof c === 'string' ? c : JSON.stringify(c ?? ''));
      if (m.tool_calls && m.tool_calls.length) t += this._estCtxTokens(JSON.stringify(m.tool_calls));
      t += 8;  // 每条消息角色/结构开销
    }
    return t;
  },

  // 模型最大上下文 tokens：llm_config.max_context_tokens 显式配置优先 →
  // 模型家族启发式 → 兜底 32768（免费模型常见窗口，偏保守=早压缩更安全）
  _modelMaxContextTokens(llmConfig) {
    const c = llmConfig && (llmConfig.max_context_tokens || llmConfig.context_window);
    if (c && Number(c) > 0) return Number(c);
    const model = String((llmConfig && llmConfig.model) || '').toLowerCase();
    const table = [
      [/claude/, 200000],
      [/gpt-5|gpt-4\.|gpt-4o/, 128000],
      [/gemini/, 128000],
      [/deepseek/, 64000],
      [/glm|chatglm/, 128000],
      [/kimi|moonshot/, 128000],
      [/grok/, 131072],
      [/qwen/, 32768],
      [/llama/, 32000],
      [/nemotron/, 32768],
      [/mimo|muse-spark/, 32768],
    ];
    for (const [re, n] of table) if (re.test(model)) return n;
    return 32768;
  },

  async _cutAndSumHistoryIfNeeded({ config, sessionId, sessionRow, history, sysContent, tools, userMessageContent }) {
    try {
      if (!history || history.length === 0) return history;
      // 独立函数作用域：自行导入存储层（_agentLoop 的局部导入在此不可见）
      const AgentStorage = (await import(_agUrl('agent-storage.js'))).default;
      const maxCtx = this._modelMaxContextTokens(config.llm_config);
      // 当前上下文 = 系统提示词 + 工具注册 + cuttime 后全量历史 + 本轮用户消息
      const estSystem = this._estCtxTokens(sysContent);
      const estTools = this._estCtxTokens(JSON.stringify(tools || []));
      const estHistory = this._estCtxTokensMsgs(history);
      const estCurrent = this._estCtxTokens(typeof userMessageContent === 'string'
        ? userMessageContent : JSON.stringify(userMessageContent || ''));
      const estTotal = estSystem + estTools + estHistory + estCurrent;
      const rate = estTotal / maxCtx;
      console.log(`[ContextCompress] est=${estTotal} tok (sys=${estSystem} tools=${estTools} hist=${estHistory} cur=${estCurrent}) / maxCtx=${maxCtx} → maxcontextrate=${(rate * 100).toFixed(1)}%`);

      if (rate <= 0.8) return history;  // 未达 80% 阈值，不压缩
      console.log(`[ContextCompress] maxcontextrate=${(rate * 100).toFixed(1)}% > 80% → 启动压缩 cutAndSumHistory`);

      // a) 从最新往回取约 10% 最大上下文的最近历史（至少保留 1 条）
      const recentBudget = Math.floor(maxCtx * 0.10);
      let acc = 0, recentStartIdx = history.length - 1;
      for (let i = history.length - 1; i >= 0; i--) {
        acc += this._estCtxTokensMsgs([history[i]]);
        recentStartIdx = i;
        if (acc >= recentBudget) break;
      }
      if (recentStartIdx <= 0) {
        console.warn('[ContextCompress] 最近10%已覆盖全部历史，无可压缩区间，跳过');
        return history;
      }
      const toCompress = history.slice(0, recentStartIdx);
      const toKeep = history.slice(recentStartIdx);
      // newcuttime = 被压缩区间 [cuttime..newcuttime] 的最后一个时间点
      const newcuttime = toCompress[toCompress.length - 1].created_at;

      // b) 组装压缩输入 — 全量信息不截断（旧实现的 slice(0,8000) 会把后半段历史
      //    整体丢掉，是"没有按要求进压缩"的直接原因）
      const ROLE_CN = { user: '用户输入', assistant: '智能体回复', tool: '工具调用结果' };
      const convText = toCompress.map(m => {
        const role = ROLE_CN[m.role] || m.role;
        let line = `[${m.created_at}] ${role}: ${m.content || ''}`;
        if (m.tool_calls && m.tool_calls.length) {
          line += '\n[工具调用命令] ' + m.tool_calls.map(tc =>
            `${(tc.function && tc.function.name) || '?'}(${(tc.function && tc.function.arguments) || ''})`
          ).join('; ');
        }
        return line;
      }).join('\n\n');

      const compressMessages = [
        {
          role: 'system',
          content: '你是会话历史压缩器。请把下面这段历史会话记录（包含用户输入、智能体文本回复、工具调用命令和工具调用结果）整理成2000字以内的结构化交接工作日志：\n一、用户原始诉求和意图；\n二、规划完成步骤；\n三、已完成工作；\n四、下一步计划；\n五、交接备忘录，含用户提供的密钥、登录方法、使用方法步骤、操作要求规范等。\n注意关键信息细节要保留（密钥、ID、参数、路径、结论数字等原样保留）。直接输出交接日志正文，不要额外解释。'
        },
        {
          role: 'user',
          content: `以下是会话 ${sessionId} 从 ${sessionRow.cuttime} 到 ${newcuttime} 的全部历史记录（共 ${toCompress.length} 条），请整理成交接工作日志：\n\n${convText}`
        }
      ];

      // LLM 日志标记 phase=compress（设置页"LLM日志"可见该压缩调用，输入即全量历史）
      this._llmLogPhase = 'compress';
      let llmResp;
      try {
        llmResp = await this._callLLM(compressMessages, [], '', config, 'compress_' + sessionId);
      } finally {
        this._llmLogPhase = '';
      }

      if (!llmResp || !llmResp.success || !llmResp.content || !llmResp.content.trim()) {
        console.warn('[ContextCompress] 压缩 LLM 调用失败，本轮不压缩（历史保持不变，下轮重试）:',
          llmResp && llmResp.error);
        return history;  // 兜底：不丢数据
      }
      const llm_output = llmResp.content.trim();
      const prevCuttime = sessionRow.cuttime;  // setCuttime 前快照，日志用

      // c) llm_output + 提醒 插入历史表，时间 = newcuttime+1s（时间索引上紧跟
      //    newcuttime 之后、最近10%保留区间之前）；间隔不足 1s 时前移避让
      const REMINDER = '（注意：因上下文过多，已启用压缩，以上历史记录为压缩内容，如需查找更多会话历史，请使用search-session-history工具（直接关键字查找当前会话历史：search-session-history，输入：当前会话的id，关键字,top N。输出：把该对应id的会话里面匹配前N个历史聊天记录搜索出来））';
      const summaryContent = '[历史压缩·交接工作日志]\n' + llm_output + '\n\n' + REMINDER;
      const boundaryMs = Date.parse(newcuttime);
      let insertMs = boundaryMs + 1000;
      const firstKeepMs = Date.parse(toKeep[0].created_at);
      if (Number.isFinite(firstKeepMs) && Number.isFinite(boundaryMs) && insertMs >= firstKeepMs) {
        insertMs = firstKeepMs - 1;
      }
      if (Number.isFinite(boundaryMs) && insertMs <= boundaryMs) insertMs = boundaryMs + 1;
      const insertIso = Number.isFinite(insertMs) ? new Date(insertMs).toISOString() : new Date().toISOString();
      const summaryId = `sum_${config.agent_id}_${sessionId}_${Date.parse(newcuttime)}`;
      await AgentStorage.insertConversationAt(config.agent_id, sessionId, 'user', summaryContent, insertIso, summaryId);

      // d) cuttime = newcuttime —— 下一轮按时间索引自然加载 压缩摘要+最近历史
      await AgentStorage.setCuttime(config.agent_id, sessionId, newcuttime);
      console.log(`[ContextCompress] 压缩完成: ${toCompress.length} 条(${prevCuttime}..${newcuttime}) → 交接日志 ${llm_output.length} 字, 摘要行插入于 ${insertIso}, cuttime=${newcuttime}, 保留 ${toKeep.length} 条`);

      // 重载：cuttime 之后 = 压缩摘要 + 最近约10%历史（本轮 LLM 调用即刻生效）
      return await AgentStorage.getConversationsSince(config.agent_id, sessionId, newcuttime);
    } catch (e) {
      console.warn('[ContextCompress] 压缩流程异常，本轮按原历史继续:', e);
      return history;
    }
  },

  // [OPTIMIZE 2026-07-06] LLM-based relevance check for group messages.
  // When a group message doesn't @mention this agent, ask the LLM if the message
  // is relevant to this agent's capabilities/role. This enables "smart listening"
  // where agents respond to relevant questions even without being explicitly @mentioned.
  //
  // Returns: true if relevant (should respond), false if not (should skip)
  async _checkGroupMessageRelevance(msg, config) {
    try {
      const agentName = config.name || 'AicqWebbot';
      const systemPrompt = (config.system_prompt || '').slice(0, 500);  // truncate for token efficiency
      const messageContent = (msg.content || '').slice(0, 1000);  // truncate long messages
      const senderName = msg.sender_name || msg.from || 'someone';

      // Build a lightweight relevance check prompt
      const relevanceMessages = [
        {
          role: 'system',
          content: `You are a relevance classifier for an AI agent named "${agentName}" in a group chat.
The agent's role/purpose: ${systemPrompt}

Your job: determine if the following group chat message is relevant to this agent.
- If the message is a direct question that the agent could answer, reply RELEVANT
- If the message mentions topics related to the agent's purpose, reply RELEVANT
- If the message is general chatter, greetings to everyone, or clearly directed at another agent, reply NOT_RELEVANT
- If unsure, reply NOT_RELEVANT (conservative — avoid unnecessary responses)

Reply with ONLY one word: RELEVANT or NOT_RELEVANT`
        },
        {
          role: 'user',
          content: `Group: ${msg.group_id}\nFrom: ${senderName}\nMessage: ${messageContent}\n\nIs this relevant to agent "${agentName}"?`
        }
      ];

      // Make a lightweight LLM call (no tools, no history)
      const llmResp = await this._callLLM(relevanceMessages, [], '', config, 'relevance_check_' + msg.group_id);

      if (!llmResp.success) {
        console.warn('[AgentEngine] Relevance check LLM failed, defaulting to NOT_RELEVANT:', llmResp.error);
        return false;
      }

      const answer = (llmResp.content || '').trim().toUpperCase();
      const isRelevant = answer.includes('RELEVANT') && !answer.includes('NOT_RELEVANT');
      console.log(`[AgentEngine] Relevance check: "${answer.slice(0, 50)}" -> ${isRelevant}`);
      return isRelevant;
    } catch(e) {
      console.error('[AgentEngine] Relevance check error:', e);
      return false;  // on error, don't respond (conservative)
    }
  },

  // [FIX 2026-07-06] Check if this agent is @mentioned in a group message.
  // Matches patterns:
  //   - "@JS Test Agent" (full name, case-insensitive)
  //   - "@JS Test Agent(ai_6d1)" (aicq.me UI format: @Name(short_id))
  //   - "@ai_6d19e7b0" (full agent_id)
  //   - "(ai_6d1)" (short_id in parentheses, used by aicq.me mention insert)
  _isMentioned(text, config) {
    if (!text || !config) return false;
    const name = (config.name || '').toLowerCase().replace(/\s+/g, '[_\s-]*');
    const id = config.agent_id || '';
    const textLower = text.toLowerCase();
    // 1. Check for @Name (case-insensitive, whitespace-flexible)
    //    Matches "@JS Test Agent" and the name part of "@JS Test Agent(ai_6d1)"
    if (name) {
      const namePattern = new RegExp('@' + name, 'i');
      if (namePattern.test(text)) return true;
    }
    // 2. Check for @agent_id (full)
    if (id && textLower.includes('@' + id.toLowerCase())) return true;
    // 3. Check for short_id in parentheses: (ai_6d1) or (ai_6d19e)
    //    aicq.me UI inserts mentions as "@Name(first_6_chars_of_agent_id)"
    if (id) {
      const short6 = id.slice(0, 6).toLowerCase();  // e.g. "ai_6d1"
      const short7 = id.slice(0, 7).toLowerCase();  // e.g. "ai_6d19"
      if (textLower.includes('(' + short6 + ')') || textLower.includes('(' + short7 + ')')) {
        return true;
      }
    }
    return false;
  }
};

// 导出
if (typeof window !== 'undefined') window.AgentEngine = AgentEngine;

export default AgentEngine;
