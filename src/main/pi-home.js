'use strict';

/**
 * pi-home — bootstraps an isolated PI_CODING_AGENT_DIR pointing at our
 * userData. PI_CODING_AGENT_DIR is the agent dir itself (the one that
 * contains models.json/settings.json/sessions/...), NOT a parent ".pi" dir.
 *
 * Schema is checked against:
 *   node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MODEL_ID = 'deepseek-via-web';
const PROVIDER_KEY = 'ds-agent';

function agentDir() {
  return path.join(app.getPath('userData'), 'pi-home');
}

function ensureDirs() {
  const dirs = [
    agentDir(),
    path.join(agentDir(), 'sessions'),
    path.join(agentDir(), 'themes'),
    path.join(agentDir(), 'tools'),
    path.join(agentDir(), 'prompts'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function writeModelsJson(port) {
  // Schema from ModelsConfigSchema in model-registry.js:
  //   { providers: { <key>: { name, baseUrl, apiKey, api, compat, models[] } } }
  const baseUrl = 'http://127.0.0.1:' + port + '/v1';
  const config = {
    providers: {
      [PROVIDER_KEY]: {
        name: 'DS Agent (DeepSeek Web)',
        baseUrl: baseUrl,
        apiKey: 'sk-not-required',
        api: 'openai-completions',
        authHeader: true,
        compat: {
          thinkingFormat: 'deepseek',
          maxTokensField: 'max_tokens',
          supportsStrictMode: false,
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: MODEL_ID,
            name: 'DeepSeek (via web)',
            input: ['text'],
            contextWindow: 1000000,
            maxTokens: 384000,
            reasoning: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  const target = path.join(agentDir(), 'models.json');
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf-8');
  return target;
}

function writeDefaultSettings() {
  const settingsPath = path.join(agentDir(), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    // Preserve user edits, but make sure defaultModel points at us if missing.
    try {
      const cur = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!cur.defaultModel) {
        cur.defaultModel = `${PROVIDER_KEY}/${MODEL_ID}`;
        fs.writeFileSync(settingsPath, JSON.stringify(cur, null, 2), 'utf-8');
      }
    } catch (_) { /* leave alone if malformed */ }
    return settingsPath;
  }
  const defaults = {
    defaultModel: `${PROVIDER_KEY}/${MODEL_ID}`,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
  return settingsPath;
}

/**
 * Prepare PI_CODING_AGENT_DIR for the current session. Must be called after
 * the HTTP shim has bound its port.
 *
 * @param {number} httpPort
 * @returns {{ piHome: string, modelsPath: string, settingsPath: string, modelId: string, providerKey: string }}
 */
function prepare(httpPort) {
  ensureDirs();
  const modelsPath = writeModelsJson(httpPort);
  const settingsPath = writeDefaultSettings();
  return {
    piHome: agentDir(),
    modelsPath,
    settingsPath,
    modelId: MODEL_ID,
    providerKey: PROVIDER_KEY,
  };
}

module.exports = { prepare, MODEL_ID, PROVIDER_KEY };
