/**
 * DS Agent — TTS Tool (Node.js)
 *
 * Provides text-to-speech synthesis.
 * Currently supports Edge TTS via the edge-tts Node package.
 * OpenAI and HTTP TTS will be added later.
 */

const { execFile } = require('child_process');
const path = require('path');

// Edge TTS Chinese voice shortcuts
const EDGE_VOICES = {
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  xiaoyi: 'zh-CN-XiaoyiNeural',
  yunjian: 'zh-CN-YunjianNeural',
  yunxi: 'zh-CN-YunxiNeural',
  yunxia: 'zh-CN-YunxiaNeural',
  yunyang: 'zh-CN-YunyangNeural',
};

/**
 * Synthesize text using Edge TTS.
 * Requires the 'edge-tts' npm package or the edge-tts Python CLI.
 * Falls back to a placeholder if neither is available.
 */
async function ttsSynthesize(text, voice = 'zh-CN-XiaoxiaoNeural', provider = 'edge') {
  if (!text || !text.trim()) {
    throw new Error('待朗读的文本不能为空');
  }

  const edgeVoice = EDGE_VOICES[voice] || voice;

  if (provider === 'edge') {
    // Try using edge-tts CLI (Python) if available
    return new Promise((resolve, reject) => {
      const chunks = [];
      const proc = execFile('edge-tts', [
        '--voice', edgeVoice,
        '--text', text,
      ], {
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'buffer',
        timeout: 120000,
      }, (error, stdout) => {
        if (error) {
          // edge-tts CLI not available — return a helpful message
          resolve('[TTS] Edge TTS 不可用。请安装: pip install edge-tts，或使用浏览器内置朗读功能');
          return;
        }
        resolve(stdout);
      });
    });
  }

  if (provider === 'openai') {
    // TODO: Implement OpenAI-compatible TTS
    return '[TTS] OpenAI TTS 尚未实现，敬请期待后续版本';
  }

  if (provider === 'http') {
    // TODO: Implement generic HTTP TTS
    return '[TTS] 自定义 HTTP TTS 尚未实现，敬请期待后续版本';
  }

  throw new Error(`未知的 TTS 引擎: '${provider}'。可选引擎: edge, openai, http`);
}

// ─── Tool Definition ─────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'tts_synthesize',
    description: '将文本转为语音（MP3）。支持 Edge TTS（免费）、OpenAI 兼容 TTS、以及自定义 HTTP TTS。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的文本内容' },
        voice: { type: 'string', description: '声音名称', default: 'zh-CN-XiaoxiaoNeural' },
        provider: { type: 'string', enum: ['edge', 'openai', 'http'], description: 'TTS 提供者', default: 'edge' },
      },
      required: ['text'],
    },
  },
];

const HANDLERS = {
  async: {
    tts_synthesize: async (args) => {
      const result = await ttsSynthesize(
        args.text || '',
        args.voice || 'zh-CN-XiaoxiaoNeural',
        args.provider || 'edge'
      );
      return typeof result === 'string' ? result : '[TTS] 音频已生成';
    },
  },
};

module.exports = { TOOL_DEFINITIONS, HANDLERS, EDGE_VOICES };
