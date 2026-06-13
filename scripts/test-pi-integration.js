'use strict';

/**
 * End-to-end integration: spawn the real pi CLI in --print mode, point it
 * at our HTTP shim (with a FakeBridge), and verify pi accepts the
 * OpenAI-style stream we produce and prints the final assistant content.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { createHttpServer } = require('../src/main/http-server');

class FakeBridge {
  isReady() { return true; }
  request({ body, onChunk, signal }) {
    return new Promise((resolve, reject) => {
      const created = Math.floor(Date.now() / 1000);
      const id = 'fake-' + Date.now().toString(36);
      const model = body.model || 'deepseek-via-web';

      const emit = (delta, finishReason) => onChunk({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finishReason == null ? null : finishReason }],
      });

      // tiny scripted response: a few content chunks and stop
      let i = 0;
      const tokens = ['Hello', ', ', 'from', ' DeepSeek', '!'];
      const tick = () => {
        if (signal && signal.aborted) return reject(new Error('aborted'));
        if (i === 0) { emit({ role: 'assistant', content: '' }); }
        if (i < tokens.length) {
          emit({ content: tokens[i] });
          i++;
          setTimeout(tick, 5);
          return;
        }
        emit({}, 'stop');
        resolve();
      };
      tick();
    });
  }
}

function piCliPath() {
  const p = path.join(__dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  if (!fs.existsSync(p)) throw new Error('pi cli not found at ' + p);
  return p;
}

function makeAgentDir(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-pi-'));
  const config = {
    providers: {
      'ds-agent': {
        name: 'DS Agent', baseUrl: 'http://127.0.0.1:' + port + '/v1',
        apiKey: 'sk-not-required', api: 'openai-completions', authHeader: true,
        compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' },
        models: [{
          id: 'deepseek-via-web', name: 'DeepSeek (via web)',
          input: ['text'], contextWindow: 65536, maxTokens: 8192, reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, 'settings.json'),
    JSON.stringify({ defaultModel: 'ds-agent/deepseek-via-web' }, null, 2));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

function runPi(piHome, cliPath) {
  return new Promise((resolve, reject) => {
    const args = [
      cliPath,
      '--print',
      '--model', 'ds-agent/deepseek-via-web',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-session',
      '--offline',
      'just say hi',
    ];
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: piHome,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    };
    const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (c) => out += c.toString('utf-8'));
    proc.stderr.on('data', (c) => err += c.toString('utf-8'));
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('pi --print timed out\n--- stdout ---\n' + out + '\n--- stderr ---\n' + err));
    }, 30000);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  const server = createHttpServer({ bridge: new FakeBridge() });
  const port = await server.listen();
  console.log('http shim listening on', port);

  const agentDir = makeAgentDir(port);
  console.log('pi agent dir:', agentDir);

  try {
    const result = await runPi(agentDir, piCliPath());
    console.log('pi exited code=' + result.code + ' signal=' + result.signal);
    console.log('--- pi stdout (trimmed) ---');
    console.log(result.out.split('\n').slice(0, 40).join('\n'));
    if (result.err) {
      console.log('--- pi stderr (trimmed) ---');
      console.log(result.err.split('\n').slice(0, 20).join('\n'));
    }

    const stdout = result.out;
    let pass = 0, fail = 0;
    function check(name, cond) {
      if (cond) { pass++; console.log('  PASS  ' + name); }
      else { fail++; console.log('  FAIL  ' + name); }
    }
    check('pi exits cleanly', result.code === 0);
    check('pi stdout contains scripted response', stdout.indexOf('Hello, from DeepSeek!') !== -1
                                              || stdout.indexOf('DeepSeek') !== -1);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    await server.close();
    fs.rmSync(agentDir, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('integration test crashed:', err);
    await server.close();
    fs.rmSync(agentDir, { recursive: true, force: true });
    process.exit(1);
  }
})();
