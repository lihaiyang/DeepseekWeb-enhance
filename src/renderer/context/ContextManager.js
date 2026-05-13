/**
 * ContextManager — Agent 上下文管理
 *
 * Injected into the MAIN WORLD by preload.
 *
 * 问题：每次 send() 都开启新会话，如果把全部历史消息都发过去，
 * 随着对话增长会超出 token 限制，且大量中间工具结果浪费 token。
 *
 * 方案：分层保留 + Token 预算控制
 *   Layer 1: 系统提示词（必留，不计入预算）
 *   Layer 2: 原始任务（第一条 user 消息，必留）
 *   Layer 3: 最近 N 轮对话（从最新往前取，直到预算用完）
 *   Layer 4: 更早的工具结果（超过阈值则截断）
 *
 * 参考：pi-agent、opencode 等开源项目的上下文管理策略
 */

(function () {
  'use strict';

  var LOG_TAG = '[CtxMgr]';

  // ─── Default Config ─────────────────────────────────────────

  var DEFAULT_CONFIG = {
    maxTokens: 200000,            // 上下文 token 总预算（不含系统提示词），DeepSeek 支持 1M
    minRecentExchanges: 5,       // 最少保留最近几轮完整对话
    maxToolResultLength: 8000,   // 单个工具结果最大字符数（超过则截断）
    keepFirstUserMessage: true,  // 是否始终保留第一条用户消息
    charsPerToken: 2,            // 字符/token 估算比例（混合中英文取保守值）
  };

  // ─── File Logger ────────────────────────────────────────────

  function _log(level, msg) {
    console.log(LOG_TAG + ' [' + level + '] ' + msg);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(),
          tag: 'CtxMgr',
          level: level,
          msg: msg
        }));
      }
    } catch (e) { /* dsAgent not ready yet */ }
  }

  function _logError(msg, err) {
    console.error(LOG_TAG + ' [ERROR] ' + msg + (err ? ' ' + (err.message || err) : ''));
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(),
          tag: 'CtxMgr',
          level: 'ERROR',
          msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (e) {}
  }

  // ─── Token Estimation ───────────────────────────────────────

  /**
   * 简单 token 估算。
   * 中文约 1.5 字符/token，英文约 4 字符/token，
   * 混合场景取保守值 2 字符/token。
   */
  function estimateTokens(text, charsPerToken) {
    if (!text) return 0;
    return Math.ceil(text.length / (charsPerToken || 2));
  }

  // ─── Tool Result Truncation ─────────────────────────────────

  /**
   * 截断过长的工具结果，保留头尾。
   * @param {string} text - 原始工具结果
   * @param {number} maxLen - 最大字符数
   * @returns {string}
   */
  function truncateToolResult(text, maxLen) {
    if (!text || text.length <= maxLen) return text;

    var headLen = Math.floor(maxLen * 0.6);
    var tailLen = maxLen - headLen - 50; // 50 给截断提示

    var head = text.substring(0, headLen);
    var tail = text.substring(text.length - tailLen);

    return head + '\n\n... [中间省略 ' + (text.length - headLen - tailLen) + ' 字符] ...\n\n' + tail;
  }

  // ─── Constructor ────────────────────────────────────────────

  function ContextManager() {
    this._config = {};
    var keys = Object.keys(DEFAULT_CONFIG);
    for (var i = 0; i < keys.length; i++) {
      this._config[keys[i]] = DEFAULT_CONFIG[keys[i]];
    }
    this._initialized = false;
  }

  // ─── Init ───────────────────────────────────────────────────

  ContextManager.prototype.init = async function () {
    var self = this;
    try {
      if (window.dsAgent && window.dsAgent.getConfig) {
        var saved = await window.dsAgent.getConfig('context_config');
        if (saved && typeof saved === 'object') {
          var keys = Object.keys(DEFAULT_CONFIG);
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (saved.hasOwnProperty(k) && typeof saved[k] === 'number') {
              self._config[k] = saved[k];
            }
          }
          _log('INFO', 'loaded custom config: maxTokens=' + self._config.maxTokens +
            ' minRecent=' + self._config.minRecentExchanges +
            ' maxToolLen=' + self._config.maxToolResultLength);
        }
      }
    } catch (e) {
      _logError('init: failed to load config', e);
    }
    this._initialized = true;
    _log('INFO', 'ContextManager initialized');
  };

  // ─── Config ─────────────────────────────────────────────────

  ContextManager.prototype.getConfig = function (key) {
    if (key) return this._config[key];
    // Return a copy
    var copy = {};
    var keys = Object.keys(this._config);
    for (var i = 0; i < keys.length; i++) {
      copy[keys[i]] = this._config[keys[i]];
    }
    return copy;
  };

  ContextManager.prototype.setConfig = function (key, value) {
    if (!DEFAULT_CONFIG.hasOwnProperty(key)) {
      _log('WARN', 'setConfig: unknown key "' + key + '"');
      return;
    }
    this._config[key] = value;
    this._saveConfig();
    _log('INFO', 'config "' + key + '" = ' + value);
  };

  ContextManager.prototype._saveConfig = function () {
    if (!window.dsAgent || !window.dsAgent.setConfig) return;
    window.dsAgent.setConfig('context_config', this._config).catch(function (e) {
      _logError('_saveConfig failed', e);
    });
  };

  // ─── Build Context ──────────────────────────────────────────

  /**
   * 从全量消息中筛选出最优上下文子集。
   *
   * @param {Array<{role:string, content:string}>} allMessages - 全量消息历史
   * @param {string} systemPrompt - 系统提示词（不计入 token 预算）
   * @returns {{ messages: Array, stats: Object }}
   *   messages: 筛选后的消息数组
   *   stats: { totalMessages, selectedMessages, estimatedTokens, truncatedTools }
   */
  ContextManager.prototype.buildContext = function (allMessages, systemPrompt) {
    if (!allMessages || !allMessages.length) {
      return { messages: [], stats: { totalMessages: 0, selectedMessages: 0, estimatedTokens: 0, truncatedTools: 0 } };
    }

    var cfg = this._config;
    var maxTokens = cfg.maxTokens;
    var minRecent = cfg.minRecentExchanges;
    var maxToolLen = cfg.maxToolResultLength;
    var keepFirst = cfg.keepFirstUserMessage;
    var cpt = cfg.charsPerToken;

    // ── Step 1: 找到第一条 user 消息的索引 ──
    var firstUserIdx = -1;
    for (var i = 0; i < allMessages.length; i++) {
      if (allMessages[i].role === 'user') {
        firstUserIdx = i;
        break;
      }
    }

    // ── Step 2: 从后往前收集消息，按轮次分组 ──
    // 一轮 = user 消息 + 后续的 assistant/tool 消息（直到下一个 user）
    var exchanges = []; // [{ userIdx, messages: [...] }]
    var currentExchange = null;

    for (var ei = allMessages.length - 1; ei >= 0; ei--) {
      var msg = allMessages[ei];
      if (msg.role === 'user') {
        // 开始新的一轮（从后往前，所以是更早的轮次）
        currentExchange = { userIdx: ei, messages: [msg] };
        exchanges.unshift(currentExchange);
      } else if (currentExchange) {
        currentExchange.messages.unshift(msg);
      } else {
        // 尾部没有 user 消息开头的 assistant/tool（不应该出现，但兜底）
        currentExchange = { userIdx: -1, messages: [msg] };
        exchanges.unshift(currentExchange);
      }
    }

    // ── Step 3: 分层筛选 ──
    var selected = [];
    var truncatedTools = 0;
    var usedTokens = 0;

    // Layer 1: 系统提示词（不计入预算，由调用方单独处理）

    // Layer 2: 第一条 user 消息（原始任务，必留）
    if (keepFirst && firstUserIdx >= 0) {
      var firstMsg = allMessages[firstUserIdx];
      selected.push(firstMsg);
      usedTokens += estimateTokens(firstMsg.content, cpt);
    }

    // Layer 3: 最近 N 轮完整对话（从最新往前取）
    var recentStart = Math.max(0, exchanges.length - minRecent);
    for (var ri = recentStart; ri < exchanges.length; ri++) {
      var ex = exchanges[ri];
      for (var mj = 0; mj < ex.messages.length; mj++) {
        var em = ex.messages[mj];
        // 跳过已经在 Layer 2 中加入的第一条 user 消息
        if (keepFirst && em === allMessages[firstUserIdx]) continue;

        var content = em.content;
        // 对 tool 消息做截断
        if (em.role === 'tool' && content.length > maxToolLen) {
          content = truncateToolResult(content, maxToolLen);
          truncatedTools++;
        }
        usedTokens += estimateTokens(content, cpt);
        selected.push({ role: em.role, content: content });
      }
    }

    // Layer 4: 更早的轮次（如果预算还有剩余）
    if (recentStart > 0 && usedTokens < maxTokens) {
      for (var oi = recentStart - 1; oi >= 0; oi--) {
        var oldEx = exchanges[oi];
        var exchangeTokens = 0;
        var exchangeMsgs = [];

        for (var ok = 0; ok < oldEx.messages.length; ok++) {
          var om = oldEx.messages[ok];
          if (keepFirst && om === allMessages[firstUserIdx]) continue;

          var oc = om.content;
          if (om.role === 'tool' && oc.length > maxToolLen) {
            oc = truncateToolResult(oc, maxToolLen);
            truncatedTools++;
          }
          var t = estimateTokens(oc, cpt);
          exchangeTokens += t;
          exchangeMsgs.push({ role: om.role, content: oc });
        }

        if (usedTokens + exchangeTokens <= maxTokens) {
          // 整轮加入
          usedTokens += exchangeTokens;
          // 插入到 selected 前面（保持时间顺序）
          for (var ik = 0; ik < exchangeMsgs.length; ik++) {
            selected.splice(ik, 0, exchangeMsgs[ik]);
          }
        } else {
          // 预算不够，停止
          break;
        }
      }
    }

    // ── Step 4: 确保消息按时间排序 ──
    // selected 可能因为 Layer 4 的 splice 而乱序，需要重新排序
    // 简单做法：按原始 allMessages 中的顺序过滤
    var selectedSet = new Set();
    for (var si = 0; si < selected.length; si++) {
      // 用 role+content 前 100 字符做 key（不够精确但够用）
      selectedSet.add(selected[si].role + ':' + selected[si].content.substring(0, 100));
    }

    var ordered = [];
    for (var ai = 0; ai < allMessages.length; ai++) {
      var am = allMessages[ai];
      var key = am.role + ':' + (am.content || '').substring(0, 100);
      if (selectedSet.has(key)) {
        ordered.push(am);
        selectedSet.delete(key);
      }
    }
    // 追加任何没匹配上的（截断过的 tool 消息等）
    if (selectedSet.size > 0) {
      for (var si2 = 0; si2 < selected.length; si2++) {
        var sk = selected[si2].role + ':' + selected[si2].content.substring(0, 100);
        if (selectedSet.has(sk)) {
          ordered.push(selected[si2]);
          selectedSet.delete(sk);
        }
      }
    }

    var stats = {
      totalMessages: allMessages.length,
      selectedMessages: ordered.length,
      estimatedTokens: usedTokens,
      truncatedTools: truncatedTools,
      totalExchanges: exchanges.length,
      keptExchanges: exchanges.length - recentStart,
    };

    _log('INFO', 'buildContext: total=' + allMessages.length + ' selected=' + ordered.length +
      ' tokens=' + usedTokens + '/' + maxTokens + ' truncated=' + truncatedTools +
      ' exchanges=' + exchanges.length + ' kept=' + stats.keptExchanges);

    return { messages: ordered, stats: stats };
  };

  // ─── Export ─────────────────────────────────────────────────

  window.ContextManager = ContextManager;
  _log('INFO', 'ContextManager registered');
})();
