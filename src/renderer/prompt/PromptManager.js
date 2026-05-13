/**
 * PromptManager — 提示词模板化管理
 *
 * Injected into the MAIN WORLD by preload.
 * 将系统提示词拆分为可独立配置的段落，支持自定义和持久化。
 *
 * 提示词由以下段落组成：
 *   - persona:       AI 身份/角色定义
 *   - tool_format:   工具调用格式说明 + 示例
 *   - tools:         可用工具列表（动态生成，不可自定义）
 *   - behavior_rules: 行为规范
 *   - special_instructions: 特殊说明（大文件读取、tool_result 处理等）
 *
 * 每个段落可通过 setSection() 自定义，通过 getSection() 读取。
 * 自定义内容通过 window.dsAgent.setConfig/getConfig 持久化。
 */

(function () {
  'use strict';

  var LOG_TAG = '[PromptMgr]';
  var CONFIG_KEY = 'prompt_sections';

  // ─── File Logger ────────────────────────────────────────────

  function _log(level, msg) {
    console.log(LOG_TAG + ' [' + level + '] ' + msg);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(),
          tag: 'PromptMgr',
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
          tag: 'PromptMgr',
          level: 'ERROR',
          msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (e) {}
  }

  // ─── Default Prompt Sections ────────────────────────────────

  var DEFAULT_SECTIONS = {
    persona: [
      '[系统指令] 你是一个能操作用户电脑的 AI 助手。',
      '你拥有以下 MCP 工具，当用户的需求可以用工具完成时，你必须调用工具。'
    ].join(' '),

    tool_format: [
      '调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。',
      '',
      '示例：',
      '```mcp:execute_command',
      '{"command": "ls -la"}',
      '```'
    ].join('\n'),

    behavior_rules: [
      '## 行为规范',
      '- 如果用户的需求需要多步操作，请逐步调用工具，每次调用一个',
      '- 如果工具返回错误，请分析原因并尝试其他方法',
      '- 执行完所有必要操作后，请给出清晰的总结',
      '- 如果不需要工具就正常回答'
    ].join('\n'),

    special_instructions: [
      '## 读取大文件',
      '- read_file 默认只读取文件的前 200 行',
      '- 如果返回结果末尾有截断提示，说明文件还有更多行',
      '- 使用 start_line 参数从指定行继续读取，例如 start_line=201 读取下一段',
      '- 可以增大 line_count 参数一次读取更多行，但建议不超过 500 行',
      '- 先用默认参数读取文件开头了解结构，再根据需要分段读取后续部分',
      '',
      '当收到 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。',
      '请基于结果继续回答用户的问题，或决定是否需要调用更多工具。'
    ].join('\n')
  };

  // ─── Constructor ────────────────────────────────────────────

  function PromptManager() {
    this._sections = {};
    this._initialized = false;

    // Copy defaults
    var keys = Object.keys(DEFAULT_SECTIONS);
    for (var i = 0; i < keys.length; i++) {
      this._sections[keys[i]] = DEFAULT_SECTIONS[keys[i]];
    }
  }

  // ─── Init: load custom sections from config ─────────────────

  PromptManager.prototype.init = async function () {
    var self = this;
    try {
      if (window.dsAgent && window.dsAgent.getConfig) {
        var saved = await window.dsAgent.getConfig(CONFIG_KEY);
        if (saved && typeof saved === 'object') {
          var keys = Object.keys(saved);
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (DEFAULT_SECTIONS.hasOwnProperty(k) && typeof saved[k] === 'string' && saved[k].trim()) {
              self._sections[k] = saved[k];
            }
          }
          _log('INFO', 'loaded custom sections: ' + keys.join(', '));
        }
      }
    } catch (e) {
      _logError('init: failed to load custom sections', e);
    }
    this._initialized = true;
    _log('INFO', 'PromptManager initialized');
  };

  // ─── Section Getters / Setters ──────────────────────────────

  /**
   * 获取某个段落的当前内容。
   * @param {string} name - 段落名: persona | tool_format | behavior_rules | special_instructions
   * @returns {string}
   */
  PromptManager.prototype.getSection = function (name) {
    if (this._sections.hasOwnProperty(name)) {
      return this._sections[name];
    }
    return '';
  };

  /**
   * 设置某个段落的内容（自定义）。
   * @param {string} name - 段落名
   * @param {string} value - 新内容
   */
  PromptManager.prototype.setSection = function (name, value) {
    if (!DEFAULT_SECTIONS.hasOwnProperty(name)) {
      _log('WARN', 'setSection: unknown section "' + name + '"');
      return;
    }
    this._sections[name] = value;
    this._save();
    _log('INFO', 'section "' + name + '" updated (len=' + value.length + ')');
  };

  /**
   * 重置某个段落为默认值。
   * @param {string} name - 段落名，不传则重置全部
   */
  PromptManager.prototype.resetSection = function (name) {
    if (name) {
      if (DEFAULT_SECTIONS.hasOwnProperty(name)) {
        this._sections[name] = DEFAULT_SECTIONS[name];
        _log('INFO', 'section "' + name + '" reset to default');
      }
    } else {
      var keys = Object.keys(DEFAULT_SECTIONS);
      for (var i = 0; i < keys.length; i++) {
        this._sections[keys[i]] = DEFAULT_SECTIONS[keys[i]];
      }
      _log('INFO', 'all sections reset to defaults');
    }
    this._save();
  };

  /**
   * 获取所有段落名。
   * @returns {string[]}
   */
  PromptManager.prototype.getSectionNames = function () {
    return Object.keys(DEFAULT_SECTIONS);
  };

  /**
   * 获取默认段落内容。
   * @param {string} name
   * @returns {string}
   */
  PromptManager.prototype.getDefault = function (name) {
    return DEFAULT_SECTIONS[name] || '';
  };

  // ─── Build Full Prompt ──────────────────────────────────────

  /**
   * 构建完整的系统提示词。
   * 按顺序拼接：persona → tool_format → tools(动态) → behavior_rules → special_instructions
   *
   * @param {Array} toolRegistry - 工具定义数组 [{name, description, inputSchema}]
   * @returns {string} 完整系统提示词
   */
  PromptManager.prototype.buildPrompt = function (toolRegistry) {
    if (!toolRegistry || !toolRegistry.length) {
      _log('WARN', 'buildPrompt: toolRegistry is empty');
      return '';
    }

    var parts = [];

    // 1. Persona
    if (this._sections.persona) {
      parts.push(this._sections.persona);
    }

    // 2. Tool format
    if (this._sections.tool_format) {
      parts.push('\n' + this._sections.tool_format);
    }

    // 3. Dynamic tool list
    parts.push('\n\n可用工具列表：');
    for (var i = 0; i < toolRegistry.length; i++) {
      var t = toolRegistry[i];
      parts.push('\n### ' + t.name);
      parts.push(t.description || '');
      var schema = t.inputSchema;
      if (schema && schema.properties) {
        var propKeys = Object.keys(schema.properties);
        if (propKeys.length) {
          parts.push('参数:');
          for (var j = 0; j < propKeys.length; j++) {
            var key = propKeys[j];
            var val = schema.properties[key];
            var required = (schema.required && schema.required.indexOf(key) !== -1) ? ' (必填)' : ' (可选)';
            parts.push('  - ' + key + required + ': ' + (val.description || val.type || ''));
          }
        }
      }
    }

    // 4. Behavior rules
    if (this._sections.behavior_rules) {
      parts.push('\n\n' + this._sections.behavior_rules);
    }

    // 5. Special instructions
    if (this._sections.special_instructions) {
      parts.push('\n\n' + this._sections.special_instructions);
    }

    var prompt = parts.join('');
    _log('INFO', 'buildPrompt done: ' + toolRegistry.length + ' tools, promptLen=' + prompt.length);
    return prompt;
  };

  // ─── Persistence ────────────────────────────────────────────

  PromptManager.prototype._save = function () {
    var self = this;
    if (!window.dsAgent || !window.dsAgent.setConfig) return;

    // Only save sections that differ from defaults
    var toSave = {};
    var keys = Object.keys(DEFAULT_SECTIONS);
    var hasCustom = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (self._sections[k] !== DEFAULT_SECTIONS[k]) {
        toSave[k] = self._sections[k];
        hasCustom = true;
      }
    }

    if (hasCustom) {
      window.dsAgent.setConfig(CONFIG_KEY, toSave).catch(function (e) {
        _logError('_save failed', e);
      });
    } else {
      // No custom sections — remove config key to keep it clean
      window.dsAgent.setConfig(CONFIG_KEY, null).catch(function (e) {
        _logError('_save clear failed', e);
      });
    }
  };

  // ─── Export ─────────────────────────────────────────────────

  window.PromptManager = PromptManager;
  _log('INFO', 'PromptManager registered');
})();
