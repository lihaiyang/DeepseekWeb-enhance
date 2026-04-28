/**
 * DS Agent — MCP Tool Handler Registry
 *
 * Central registry for all MCP tools.
 * Aggregates tool definitions and handlers from tool modules.
 */

const { TOOL_DEFINITIONS: SHELL_TOOLS, HANDLERS: SHELL_HANDLERS } = require('./tools/shell');
const { TOOL_DEFINITIONS: SEARCH_TOOLS, HANDLERS: SEARCH_HANDLERS } = require('./tools/search');
const { TOOL_DEFINITIONS: TTS_TOOLS, HANDLERS: TTS_HANDLERS } = require('./tools/tts');
const { TOOL_DEFINITIONS: FILE_TOOLS, HANDLERS: FILE_HANDLERS } = require('./tools/file-processor');

// ─── Aggregate Tool Definitions ───────────────────────────────
const ALL_TOOLS = {};

for (const toolDef of [...SHELL_TOOLS, ...SEARCH_TOOLS, ...TTS_TOOLS, ...FILE_TOOLS]) {
  ALL_TOOLS[toolDef.name] = toolDef;
}

// ─── Aggregate Handlers ──────────────────────────────────────
// Sync handlers return values directly
const SYNC_HANDLERS = {
  ...SHELL_HANDLERS.sync || {},
  ...FILE_HANDLERS.sync || {},
};

// Async handlers return Promises
const ASYNC_HANDLERS = {
  ...SHELL_HANDLERS.async || {},
  ...SEARCH_HANDLERS.async || {},
  ...TTS_HANDLERS.async || {},
};

// ─── Public API ──────────────────────────────────────────────

/**
 * Get list of all tool definitions.
 * @returns {Array<object>}
 */
function getToolList() {
  return Object.values(ALL_TOOLS);
}

/**
 * Call a tool by name.
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments
 * @returns {Promise<string>} Tool execution result
 */
async function handleToolCall(toolName, args) {
  if (ASYNC_HANDLERS[toolName]) {
    return await ASYNC_HANDLERS[toolName](args);
  }
  if (SYNC_HANDLERS[toolName]) {
    return SYNC_HANDLERS[toolName](args);
  }
  throw new Error(`工具 '${toolName}' 没有对应的处理器`);
}

module.exports = {
  ALL_TOOLS,
  SYNC_HANDLERS,
  ASYNC_HANDLERS,
  getToolList,
  handleToolCall,
};
