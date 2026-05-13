/**
 * ConversationManager — 会话状态管理 & 本地持久化
 *
 * Injected into the MAIN WORLD by preload.
 *
 * 架构：
 *   内存层（本文件）         磁盘层（JsonStore，通过 IPC）
 *   ┌──────────────────┐    ┌──────────────────────────────┐
 *   │ _currentId        │    │ index.json  ← 全部会话摘要   │
 *   │ _messages[]       │    │ {id}.json   ← 完整会话数据   │
 *   │ _title            │    └──────────────────────────────┘
 *   │ _listCache[]      │
 *   │ _dirty            │
 *   └──────────────────┘
 *
 * 原则：
 *   - 磁盘是真相源，内存是工作区
 *   - 所有状态变更前先 await 保存当前会话
 *   - 侧边栏读 _listCache（零 IPC），切换/新建/删除后刷新
 */

(function () {
  'use strict';

  var PREFIX = '[DS Agent]';
  var LOG_TAG = '[ConvMgr]';

  // ─── File Logger ────────────────────────────────────────────

  function _log(level, msg) {
    var line = LOG_TAG + ' [' + level + '] ' + msg;
    console.log(line);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'ConvMgr', level: level, msg: msg
        }));
      }
    } catch (e) { /* dsAgent not ready yet */ }
  }

  function _logError(msg, err) {
    var line = LOG_TAG + ' [ERROR] ' + msg + (err ? ' ' + (err.message || err) : '');
    console.error(line);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'ConvMgr', level: 'ERROR', msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (e) {}
  }

  // ─── Constructor ────────────────────────────────────────────

  function ConversationManager() {
    /** @type {string|null} 当前活跃会话 ID */
    this._currentId = null;
    /** @type {Array<{role, content, timestamp}>} 当前会话消息 */
    this._messages = [];
    /** @type {string} 当前会话标题 */
    this._title = '';
    /** @type {number} 当前会话创建时间 */
    this._createdAt = 0;
    /** @type {boolean} 当前会话是否有未保存变更 */
    this._dirty = false;
    /** @type {number|null} 防抖保存定时器 */
    this._saveTimer = null;
    /** @type {Array<{id,title,messageCount,createdAt,updatedAt}>} 全部会话摘要缓存 */
    this._listCache = [];
  }

  // ─── Initialization ─────────────────────────────────────────

  /**
   * 初始化：加载会话列表缓存。
   */
  ConversationManager.prototype.init = async function () {
    _log('INFO', 'ConversationManager initializing...');
    await this.refreshListCache();
    _log('INFO', 'ConversationManager initialized, ' + this._listCache.length + ' conversations in cache');
  };

  // ─── List Cache ─────────────────────────────────────────────

  /**
   * 获取缓存的会话列表（零 IPC，直接读内存）。
   * @returns {Array<{id, title, messageCount, createdAt, updatedAt}>}
   */
  ConversationManager.prototype.getListCache = function () {
    return this._listCache;
  };

  /**
   * 从磁盘刷新会话列表缓存。
   */
  ConversationManager.prototype.refreshListCache = async function () {
    try {
      var result = await window.dsAgent.listConversations();
      if (result.success) {
        this._listCache = result.data || [];
        _log('INFO', 'refreshListCache count=' + this._listCache.length);
      }
    } catch (e) {
      _logError('refreshListCache failed', e);
    }
  };

  // ─── Conversation Lifecycle ─────────────────────────────────

  /**
   * 创建新会话。先保存当前会话，再创建新的。
   * @param {string} [title]
   * @returns {Promise<string>} 新会话 ID
   */
  ConversationManager.prototype.newConversation = async function (title) {
    // 1. 先保存当前会话
    await this._saveCurrentNow();

    // 2. 创建新会话
    var id = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    this._currentId = id;
    this._messages = [];
    this._title = title || '新会话';
    this._createdAt = Date.now();
    this._dirty = true;

    _log('INFO', 'newConversation id=' + id + ' title="' + this._title + '"');

    // 3. 立即写入磁盘（空会话也入库，确保出现在列表中）
    await this._saveNow();
    await this.refreshListCache();

    return id;
  };

  /**
   * 切换到已有会话。先保存当前会话，再从磁盘加载目标会话。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  ConversationManager.prototype.switchTo = async function (id) {
    // 1. 先保存当前会话
    await this._saveCurrentNow();

    // 2. 从磁盘加载目标会话
    _log('INFO', 'switchTo start id=' + id);
    try {
      var t0 = Date.now();
      var result = await window.dsAgent.getConversation(id);
      if (result.success && result.data) {
        var conv = result.data;
        this._currentId = conv.id;
        this._messages = conv.messages || [];
        this._title = conv.title || '';
        this._createdAt = conv.createdAt || Date.now();
        this._dirty = false;
        _log('INFO', 'switchTo done id=' + id + ' msgs=' + this._messages.length + ' elapsed=' + (Date.now() - t0) + 'ms');

        // 3. 刷新列表缓存
        await this.refreshListCache();
        return true;
      }
      _log('WARN', 'switchTo failed id=' + id + ' reason=' + (result.error || 'not found'));
    } catch (e) {
      _logError('switchTo exception id=' + id, e);
    }
    return false;
  };

  /**
   * 删除会话。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  ConversationManager.prototype.deleteConversation = async function (id) {
    _log('INFO', 'deleteConversation id=' + id);
    try {
      var result = await window.dsAgent.deleteConversation(id);
      if (result.success) {
        // 如果删除的是当前会话，重置状态
        if (this._currentId === id) {
          this._currentId = null;
          this._messages = [];
          this._title = '';
          this._dirty = false;
        }
        await this.refreshListCache();
        _log('INFO', 'deleteConversation done id=' + id);
        return true;
      }
      _log('WARN', 'deleteConversation failed id=' + id);
    } catch (e) {
      _logError('deleteConversation exception id=' + id, e);
    }
    return false;
  };

  // ─── Message Management ─────────────────────────────────────

  /**
   * 向当前会话添加一条消息。
   */
  ConversationManager.prototype.addMessage = function (role, content) {
    if (!this._currentId) {
      // 延迟创建：首次 addMessage 时自动创建会话
      this._currentId = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      this._messages = [];
      this._title = '新会话';
      this._createdAt = Date.now();
    }

    var msg = { role: role, content: content, timestamp: Date.now() };
    this._messages.push(msg);
    this._dirty = true;

    // 自动标题：用第一条用户消息
    if (role === 'user' && this._title === '新会话') {
      this._title = content.substring(0, 50).replace(/\n/g, ' ');
    }

    _log('INFO', 'addMessage role=' + role + ' len=' + content.length + ' totalMsgs=' + this._messages.length);
    this._scheduleSave();
    return msg;
  };

  /**
   * 获取当前会话全部消息（副本）。
   */
  ConversationManager.prototype.getMessages = function () {
    return this._messages.slice();
  };

  /**
   * 获取最后 N 条消息。
   */
  ConversationManager.prototype.getLastMessages = function (n) {
    return this._messages.slice(-n);
  };

  /**
   * 获取总字符数（用于 token 估算）。
   */
  ConversationManager.prototype.getTotalChars = function () {
    var total = 0;
    for (var i = 0; i < this._messages.length; i++) {
      total += this._messages[i].content.length;
    }
    return total;
  };

  /**
   * 移除最后 N 条消息。
   */
  ConversationManager.prototype.removeLastMessages = function (n) {
    if (n <= 0) return;
    this._messages.splice(-n, n);
    this._dirty = true;
    _log('INFO', 'removeLastMessages n=' + n + ' remaining=' + this._messages.length);
    this._scheduleSave();
  };

  // ─── Getters ────────────────────────────────────────────────

  ConversationManager.prototype.getCurrentId = function () {
    return this._currentId;
  };

  ConversationManager.prototype.getTitle = function () {
    return this._title;
  };

  ConversationManager.prototype.getMessageCount = function () {
    return this._messages.length;
  };

  // ─── Persistence ────────────────────────────────────────────

  /**
   * 公开的保存方法：立即保存当前会话到磁盘。
   */
  ConversationManager.prototype.save = async function () {
    await this._saveNow();
  };

  /**
   * 立即保存当前会话到磁盘（内部方法）。
   */
  ConversationManager.prototype._saveNow = async function () {
    if (!this._currentId) return;
    if (!this._dirty) return;

    this._cancelSaveTimer();

    var t0 = Date.now();
    _log('INFO', '_saveNow id=' + this._currentId + ' msgs=' + this._messages.length);

    try {
      await window.dsAgent.saveConversation({
        id: this._currentId,
        title: this._title,
        messages: this._messages,
        createdAt: this._createdAt,
        updatedAt: Date.now()
      });
      this._dirty = false;
      _log('INFO', '_saveNow done id=' + this._currentId + ' elapsed=' + (Date.now() - t0) + 'ms');
    } catch (e) {
      _logError('_saveNow failed id=' + this._currentId, e);
    }
  };

  /**
   * 保存当前会话（如果 dirty），用于切换/新建前。
   */
  ConversationManager.prototype._saveCurrentNow = async function () {
    if (this._dirty && this._currentId) {
      await this._saveNow();
    }
  };

  /**
   * 防抖保存（500ms 后自动保存）。
   */
  ConversationManager.prototype._scheduleSave = function () {
    var self = this;
    this._cancelSaveTimer();
    this._saveTimer = setTimeout(function () {
      self._saveTimer = null;
      self._saveNow().catch(function (e) {
        _logError('_scheduleSave failed', e);
      });
    }, 500);
  };

  /**
   * 取消防抖定时器。
   */
  ConversationManager.prototype._cancelSaveTimer = function () {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  };

  // ─── Export ─────────────────────────────────────────────────

  window.ConversationManager = ConversationManager;
  _log('INFO', 'ConversationManager registered');
})();