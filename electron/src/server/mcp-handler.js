/**
 * DS Agent — MCP Tool Handler Registry
 *
 * Central registry for all MCP tools.
 * Aggregates tool definitions and handlers from tool modules.
 * Reads service config from mcp.json and injects config into tool calls.
 */

const path = require('path');
const fs = require('fs');
const { TOOL_DEFINITIONS: SHELL_TOOLS, HANDLERS: SHELL_HANDLERS } = require('./tools/shell');
const { TOOL_DEFINITIONS: SEARCH_TOOLS, HANDLERS: SEARCH_HANDLERS } = require('./tools/search');
const { TOOL_DEFINITIONS: TTS_TOOLS, HANDLERS: TTS_HANDLERS } = require('./tools/tts');
const { TOOL_DEFINITIONS: FILE_TOOLS, HANDLERS: FILE_HANDLERS } = require('./tools/file-processor');

// ─── Load Service Config ─────────────────────────────────────
// Try to load mcp.json from the project root (for config like API keys)
const _configSearchPaths = [
  path.join(__dirname, '..', '..', '..', 'server', 'mcp.json'),  // project root server/mcp.json
  path.join(process.cwd(), 'server', 'mcp.json'),                // cwd/server/mcp.json
];

let serviceConfig = {};
for (const p of _configSearchPaths) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    serviceConfig = raw.services || {};
    console.log(`[MCP Handler] Config loaded from ${p}`);
    break;
  } catch {
    // try next path
  }
}

if (Object.keys(serviceConfig).length === 0) {
  console.log('[MCP Handler] No mcp.json found, using defaults');
}

// ─── Map: toolName → serviceName ─────────────────────────────
const TOOL_TO_SERVICE = {};
for (const [svcName, svc] of Object.entries(serviceConfig)) {
  if (svc.type === 'builtin' && Array.isArray(svc.tools)) {
    for (const toolName of svc.tools) {
      TOOL_TO_SERVICE[toolName] = svcName;
    }
  }
}

// ─── Aggregate Tool Definitions ───────────────────────────────
const ALL_TOOLS = {};

// Tool filtering: if config specifies tools, only enable those; otherwise enable all
const enabledTools = new Set();
for (const svc of Object.values(serviceConfig)) {
  if (svc.type === 'builtin' && Array.isArray(svc.tools)) {
    for (const tool of svc.tools) {
      enabledTools.add(tool);
    }
  }
}
const filterEnabled = enabledTools.size > 0;

for (const toolDef of [...SHELL_TOOLS, ...SEARCH_TOOLS, ...TTS_TOOLS, ...FILE_TOOLS]) {
  if (!filterEnabled || enabledTools.has(toolDef.name)) {
    ALL_TOOLS[toolDef.name] = toolDef;
  }
}

console.log(`[MCP Handler] Enabled tools: ${Object.keys(ALL_TOOLS).sort().join(', ')}`);

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
 * Get list of all enabled tool definitions.
 * @returns {Array<object>}
 */
function getToolList() {
  return Object.values(ALL_TOOLS);
}

/**
 * Call a tool by name.
 * Merges service config (e.g., API keys) into tool args before calling.
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments from the caller
 * @returns {Promise<string>} Tool execution result
 */
async function handleToolCall(toolName, args) {
  // Merge service config into args (e.g., bing_api_key for bing_search)
  const mergedArgs = { ...args };
  const svcName = TOOL_TO_SERVICE[toolName];
  if (svcName && serviceConfig[svcName]?.config) {
    for (const [key, val] of Object.entries(serviceConfig[svcName].config)) {
      // Only inject if the caller didn't provide the value
      if (mergedArgs[key] === undefined) {
        mergedArgs[key] = val;
      }
    }
  }

  if (ASYNC_HANDLERS[toolName]) {
    return await ASYNC_HANDLERS[toolName](mergedArgs);
  }
  if (SYNC_HANDLERS[toolName]) {
    return SYNC_HANDLERS[toolName](mergedArgs);
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
