/**
 * DS Agent — Web Search & Crawl Tools (Node.js)
 *
 * Ported from Python tools/search.py
 * Provides: bing_search, crawl_webpage
 */

const https = require('https');
const http = require('http');

// ─── HTTP Helper ─────────────────────────────────────────────

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': options.userAgent || 'Mozilla/5.0 (compatible; DS-Agent/1.0)',
        ...options.headers,
      },
      timeout: options.timeout || 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location, options).then(resolve).catch(reject);
      }

      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Bing Search ─────────────────────────────────────────────

async function bingSearch(query, count = 10, offset = 0, apiKey = '') {
  if (!apiKey) {
    return '错误：未配置 Bing 搜索 API 密钥。请在 mcp.json 的 services.web_search.config.bing_api_key 中填入 API Key';
  }

  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 50)}&offset=${offset}&mkt=zh-CN`;

  try {
    const data = await fetchURL(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });

    const parsed = JSON.parse(data);
    const results = parsed.webPages?.value || [];

    if (!results.length) {
      return '搜索无结果。请尝试调整关键词后重试';
    }

    return results.map((r, i) =>
      `${offset + i + 1}. ${r.name || ''}\n   URL: ${r.url || ''}\n   ${r.snippet || ''}`
    ).join('\n\n');
  } catch (err) {
    return `搜索请求失败: ${err.message}。请检查网络连接和 API 密钥是否正确`;
  }
}

// ─── Crawl Webpage ───────────────────────────────────────────

async function crawlWebpage(url, maxLength = 10000) {
  try {
    const html = await fetchURL(url);

    // Simple HTML to text extraction (no cheerio dependency needed for basic use)
    let text = html
      // Remove scripts and styles
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      // Remove HTML tags
      .replace(/<[^>]+>/g, '\n')
      // Decode common entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean up whitespace
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + `\n\n... (已截断，原文共 ${text.length.toLocaleString()} 个字符)`;
    }

    return text;
  } catch (err) {
    return `网页抓取失败: ${err.message}。目标页面可能无法访问或响应超时`;
  }
}

// ─── Tool Definitions ────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'bing_search',
    description: '使用 Bing 搜索网页内容',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '返回结果数量（默认 10，最大 50）' },
        offset: { type: 'integer', description: '分页偏移量（默认 0）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'crawl_webpage',
    description: '抓取网页并提取纯文本内容',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        max_length: { type: 'integer', description: '最大返回字符数（默认 10000）' },
      },
      required: ['url'],
    },
  },
];

const HANDLERS = {
  async: {
    bing_search: async (args) => await bingSearch(
      args.query || '',
      args.count || 10,
      args.offset || 0,
      args.api_key || ''
    ),
    crawl_webpage: async (args) => await crawlWebpage(
      args.url || '',
      args.max_length || 10000
    ),
  },
};

module.exports = { TOOL_DEFINITIONS, HANDLERS };
