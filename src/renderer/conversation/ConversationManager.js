/**
 * ConversationManager — 会话状态管理 & 本地持久化
 *
 * Injected into the MAIN WORLD by preload.
 * Manages conversation messages locally and persists via IPC to main process.
 *
 * Data model:
 *   Conversation {
 *     id: string,
 *     title: string,
 *     messages: [{ role: "system"|"user"|"assistant"|"tool", content: string, timestamp: number }],
 *     createdAt: number,
 *     updatedAt: number
 *   }
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
          t: Date.now(),
          tag: 'ConvMgr',
          level: level,
          msg: msg
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
          t: Date.now(),
          tag: 'ConvMgr',
          level: 'ERROR',
          msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (e) {}
  }

  // ─── Constructor ────────────────────────────────────────────

  /**
   * @constructor
   */
  function ConversationManager() {
    this._currentId = null;
    this._messages = [];
    this._title = '';
    this._createdAt = 0;
    this._dirty = false;
    this._saveTimer = null;
  }

  // ─── Initialization ─────────────────────────────────────────

  /**
   * Initialize the manager. Call once after construction.
   */
  ConversationManager.prototype.init = async function () {
    _log('INFO', 'ConversationManager initializing...');
    _log('INFO', 'ConversationManager initialized');
  };

  // ─── Conversation Lifecycle ─────────────────────────────────

  /**
   * Create a new conversation.
   * @param {string} [title] - Optional title
   * @returns {string} The new conversation ID
   */
  ConversationManager.prototype.newConversation = function (title) {
    this._flushPendingSave();

    var id = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    this._currentId = id;
    this._messages = [];
    this._title = title || '新会话';
    this._createdAt = Date.now();
    this._dirty = true;

    _log('INFO', 'newConversation id=' + id + ' title="' + this._title + '"');
    this._scheduleSave();
    return id;
  };

  /**
   * Load an existing conversation by ID.
   * @param {string} id
   * @returns {Promise<boolean>} true if loaded successfully
   */
  ConversationManager.prototype.load = async function (id) {
    this._flushPendingSave();
    _log('INFO', 'load start id=' + id);

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
        var elapsed = Date.now() - t0;
        _log('INFO', 'load done id=' + id + ' msgs=' + this._messages.length + ' elapsed=' + elapsed + 'ms');
        return true;
      }
      _log('WARN', 'load failed id=' + id + ' reason=' + (result.error || 'not found'));
    } catch (e) {
      _logError('load exception id=' + id, e);
    }
    return false;
  };

  /**
   * Delete a conversation by ID.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  ConversationManager.prototype.deleteConversation = async function (id) {
    _log('INFO', 'deleteConversation id=' + id);
    try {
      var result = await window.dsAgent.deleteConversation(id);
      if (result.success) {
        if (this._currentId === id) {
          this._currentId = null;
          this._messages = [];
          this._title = '';
          this._dirty = false;
        }
        _log('INFO', 'deleteConversation done id=' + id);
        return true;
      }
      _log('WARN', 'deleteConversation failed id=' + id + ' reason=' + (result.error || 'unknown'));
    } catch (e) {
      _logError('deleteConversation exception id=' + id, e);
    }
    return false;
  };

  /**
   * List all saved conversations (summary only, no messages).
   * @returns {Promise<Array<{id, title, createdAt, updatedAt, messageCount}>>}
   */
  ConversationManager.prototype.listConversations = async function () {
    try {
      var result = await window.dsAgent.listConversations();
      if (result.success) {
        var list = result.data || [];
        _log('INFO', 'listConversations count=' + list.length);
        return list;
      }
      _log('WARN', 'listConversations failed');
    } catch (e) {
      _logError('listConversations exception', e);
    }
    return [];
  };

  // ─── Message Management ─────────────────────────────────────

  /**
   * Add a message to the current conversation.
   * @param {string} role - "user" | "assistant" | "tool" | "system"
   * @param {string} content
   * @returns {object} The added message
   */
  ConversationManager.prototype.addMessage = function (role, content) {
    if (!this._currentId) {
      this.newConversation();
    }

    var msg = {
      role: role,
      content: content,
      timestamp: Date.now()
    };
    this._messages.push(msg);
    this._dirty = true;

    // Auto-title: use first user message as title
    if (role === 'user' && this._title === '新会话') {
      this._title = content.substring(0, 50).replace(/\n/g, ' ');
    }

    _log('INFO', 'addMessage role=' + role + ' len=' + content.length + ' totalMsgs=' + this._messages.length + ' convId=' + this._currentId);
    this._scheduleSave();
    return msg;
  };

  /**
   * Get all messages in the current conversation.
   * @returns {Array<{role, content, timestamp}>}
   */
  ConversationManager.prototype.getMessages = function () {
    return this._messages.slice();
  };

  /**
   * Get the last N messages.
   * @param {number} n
   * @returns {Array<{role, content, timestamp}>}
   */
  ConversationManager.prototype.getLastMessages = function (n) {
    return this._messages.slice(-n);
  };

  /**
   * Get the total character count of all messages (for token estimation).
   * @returns {number}
   */
  ConversationManager.prototype.getTotalChars = function () {
    var total = 0;
    for (var i = 0; i < this._messages.length; i++) {
      total += this._messages[i].content.length;
    }
    return total;
  };

  /**
   * Remove the last N messages (for undo / error recovery).
   * @param {number} n
   */
  ConversationManager.prototype.removeLastMessages = function (n) {
    if (n <= 0) return;
    this._messages.splice(-n, n);
    this._dirty = true;
    _log('INFO', 'removeLastMessages n=' + n + ' remaining=' + this._messages.length);
    this._scheduleSave();
  };

  /**
   * Clear all messages in the current conversation.
   */
  ConversationManager.prototype.clearMessages = function () {
    var wasCount = this._messages.length;
    this._messages = [];
    this._dirty = true;
    _log('INFO', 'clearMessages was=' + wasCount + ' now=0');
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
   * Save the current conversation immediately.
   * @returns {Promise<void>}
   */
  ConversationManager.prototype.save = async function () {
    if (!this._currentId) {
      _log('DEBUG', 'save skipped: no currentId');
      return;
    }
    if (!this._dirty) {
      _log('DEBUG', 'save skipped: not dirty');
      return;
    }

    this._flushPendingSave();

    var t0 = Date.now();
    var msgCount = this._messages.length;
    var totalChars = this.getTotalChars();
    _log('INFO', 'save start id=' + this._currentId + ' msgs=' + msgCount + ' chars=' + totalChars);

    try {
      await window.dsAgent.saveConversation({
        id: this._currentId,
        title: this._title,
        messages: this._messages,
        createdAt: this._createdAt,
        updatedAt: Date.now()
      });
      this._dirty = false;
      var elapsed = Date.now() - t0;
      _log('INFO', 'save done id=' + this._currentId + ' elapsed=' + elapsed + 'ms');
    } catch (e) {
      _logError('save failed id=' + this._currentId, e);
    }
  };

  /**
   * Schedule a debounced save (500ms after last change).
   */
  ConversationManager.prototype._scheduleSave = function () {
    var self = this;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(function () {
      self.save();
    }, 500);
  };

  /**
   * Flush any pending scheduled save immediately.
   */
  ConversationManager.prototype._flushPendingSave = function () {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  };

  // ─── Export ─────────────────────────────────────────────────

  window.ConversationManager = ConversationManager;
  _log('INFO', 'ConversationManager registered');
})();
