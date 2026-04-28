/**
 * DS Agent — MCP Server (Node.js)
 *
 * HTTP server implementing MCP (Model Context Protocol) over JSON-RPC 2.0.
 * Replaces the Python FastAPI server from the original project.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { ALL_TOOLS, SYNC_HANDLERS, ASYNC_HANDLERS } = require('./mcp-handler');

// ─── Config ──────────────────────────────────────────────────
// Try multiple paths to find mcp.json (prioritize electron's own config)
const _configSearchPaths = [
  path.join(__dirname, '..', '..', 'server', 'mcp.json'),        // electron/server/mcp.json (preferred)
  path.join(__dirname, '..', '..', '..', 'server', 'mcp.json'),  // ../server/mcp.json (original project)
  path.join(process.cwd(), 'server', 'mcp.json'),                // cwd/server/mcp.json
];

let CONFIG_PATH = _configSearchPaths.find(p => fs.existsSync(p)) || _configSearchPaths[0];
const PRESETS_PATH = path.join(path.dirname(CONFIG_PATH), 'presets.json');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch {
  config = { server: { host: '127.0.0.1', port: 8024 }, services: {} };
}

const serverCfg = config.server || {};

// ─── Tool filtering ──────────────────────────────────────────
const enabledTools = new Set();
const services = config.services || {};

for (const svc of Object.values(services)) {
  if (svc.type === 'builtin') {
    for (const tool of (svc.tools || [])) {
      enabledTools.add(tool);
    }
  }
}

// If no config filter, enable all
if (enabledTools.size === 0) {
  for (const name of Object.keys(ALL_TOOLS)) {
    enabledTools.add(name);
  }
}

console.log(`[MCP Server] Enabled tools: ${[...enabledTools].sort().join(', ')}`);

// ─── Sessions ────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_MAX_COUNT = 100;
const sessions = new Map();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sid, data] of sessions) {
    if (data.lastActivity && now - data.lastActivity > SESSION_TIMEOUT_MS) {
      sessions.delete(sid);
    }
  }
  // Evict oldest if over max
  if (sessions.size > SESSION_MAX_COUNT) {
    const entries = [...sessions.entries()]
      .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0));
    const toRemove = entries.slice(0, sessions.size - SESSION_MAX_COUNT);
    for (const [sid] of toRemove) {
      sessions.delete(sid);
    }
  }
}

// ─── JSON-RPC 2.0 Handler ───────────────────────────────────

async function handleJSONRPC(msg) {
  const method = msg.method || '';
  const msgId = msg.id;
  const params = msg.params || {};

  // Notifications (no id) — acknowledge silently
  if (msgId === undefined && method) {
    console.log(`[MCP Server] Notification: ${method}`);
    return null;
  }

  console.log(`[MCP Server] Request: ${method} (id=${msgId})`);

  if (method === 'initialize') {
    cleanupExpiredSessions();
    const sessionId = uuidv4();
    sessions.set(sessionId, {
      client: params.clientInfo || {},
      lastActivity: Date.now(),
    });
    console.log(`[MCP Server] Session created: ${sessionId}`);
    return {
      jsonrpc: '2.0',
      id: msgId,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ds-agent-mcp', version: '1.0.0' },
        sessionId,
      },
    };
  }

  if (method === 'tools/list') {
    const tools = [];
    for (const [name, toolDef] of Object.entries(ALL_TOOLS)) {
      if (enabledTools.has(name)) {
        tools.push(toolDef);
      }
    }
    // TODO: Add external MCP server tools
    return {
      jsonrpc: '2.0',
      id: msgId,
      result: { tools },
    };
  }

  if (method === 'tools/call') {
    const toolName = params.name || '';
    const arguments_ = params.arguments || {};

    if (!enabledTools.has(toolName)) {
      return {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          content: [{ type: 'text', text: `工具 '${toolName}' 未启用。请在 mcp.json 的 services 配置中启用该工具` }],
          isError: true,
        },
      };
    }

    console.log(`[MCP Server] Tool call: ${toolName}(${JSON.stringify(arguments_).slice(0, 200)})`);

    try {
      let resultText;

      if (ASYNC_HANDLERS[toolName]) {
        resultText = await ASYNC_HANDLERS[toolName](arguments_);
      } else if (SYNC_HANDLERS[toolName]) {
        resultText = SYNC_HANDLERS[toolName](arguments_);
      } else {
        resultText = `工具 '${toolName}' 没有对应的处理器`;
      }

      return {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          content: [{ type: 'text', text: String(resultText) }],
          isError: false,
        },
      };
    } catch (err) {
      console.error(`[MCP Server] Tool execution failed: ${err}`);
      return {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          content: [{ type: 'text', text: `工具执行异常: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  // Unknown method
  return {
    jsonrpc: '2.0',
    id: msgId,
    error: { code: -32601, message: `未知的 MCP 方法: '${method}'` },
  };
}

// ─── Express App ─────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    tools: [...enabledTools].length,
    builtin_tools: [...enabledTools].length,
    external_tools: 0,
    sessions: sessions.size,
  });
});

// MCP endpoint (JSON-RPC 2.0)
app.post('/mcp', async (req, res) => {
  const body = req.body;

  // Handle batch
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const result = await handleJSONRPC(msg);
      if (result !== null) results.push(result);
    }
    return res.status(results.length ? 200 : 202).json(results.length ? results : null);
  }

  const result = await handleJSONRPC(body);
  if (result === null) return res.status(202).send(null);
  res.json(result);
});

// TTS endpoint (placeholder — will be implemented in tts.js)
app.post('/api/tts', (_req, res) => {
  res.status(501).json({ error: 'TTS not yet implemented in Node.js version' });
});

app.get('/api/tts/voices', (_req, res) => {
  res.json({ voices: [] });
});

// File upload endpoint (placeholder)
app.post('/api/upload', (_req, res) => {
  res.status(501).json({ error: 'File upload not yet implemented in Node.js version' });
});

// ─── Server Lifecycle ────────────────────────────────────────

let serverInstance = null;

/**
 * Start the MCP server.
 * @param {number} port - Port to listen on
 * @returns {Promise<number>} The actual port used
 */
function startMCPServer(port = 8024) {
  return new Promise((resolve, reject) => {
    serverInstance = app.listen(port, '127.0.0.1', () => {
      const addr = serverInstance.address();
      console.log(`[MCP Server] Listening on http://127.0.0.1:${addr.port}`);
      resolve(addr.port);
    });

    serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[MCP Server] Port ${port} in use, trying ${port + 1}...`);
        serverInstance = app.listen(port + 1, '127.0.0.1', () => {
          const addr = serverInstance.address();
          console.log(`[MCP Server] Listening on http://127.0.0.1:${addr.port}`);
          resolve(addr.port);
        });
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Stop the MCP server.
 * @returns {Promise<void>}
 */
function stopMCPServer() {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('[MCP Server] Stopped');
        serverInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Get the port the MCP server is listening on.
 * @returns {number|null}
 */
function getMCPPort() {
  return serverInstance?.address()?.port || null;
}

module.exports = { startMCPServer, stopMCPServer, getMCPPort };
