/**
 * DS Agent — File Processor Tool (Node.js)
 *
 * Ported from Python tools/file_processor.py
 * Extracts structured text from uploaded files.
 */

const fs = require('fs');
const path = require('path');

const MAX_TEXT_LENGTH = 100_000;
const MAX_PREVIEW_LINES = 500;

// ─── Helpers ─────────────────────────────────────────────────

function truncate(text, maxLen = MAX_TEXT_LENGTH) {
  if (text.length <= maxLen) return { text, truncated: false };
  return {
    text: text.slice(0, maxLen) + `\n\n... [截断: 原文 ${text.length} 字符，已截断至 ${maxLen}]`,
    truncated: true,
  };
}

// ─── Process Text Files ──────────────────────────────────────

function processText(fileBuffer, filename, mimeType) {
  let text;
  try {
    text = fileBuffer.toString('utf-8');
  } catch {
    text = fileBuffer.toString('latin1');
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (ext === 'json' || mimeType === 'application/json') {
    try {
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      const result = truncate(formatted);
      return {
        filename,
        mime_type: mimeType,
        file_size: fileBuffer.length,
        content_type: 'text',
        text: result.text,
        truncated: result.truncated,
        metadata: {
          json_keys: typeof parsed === 'object' && parsed !== null
            ? Array.isArray(parsed) ? `array[${parsed.length}]` : Object.keys(parsed)
            : typeof parsed,
          char_count: result.text.length,
        },
      };
    } catch {
      // Not valid JSON, treat as plain text
    }
  }

  if (ext === 'csv' || mimeType === 'text/csv') {
    const lines = text.split('\n');
    const rows = lines.map(line => line.split(','));
    const preview = rows.slice(0, MAX_PREVIEW_LINES);
    const previewText = preview.map(row => row.join(',')).join('\n');
    const result = rows.length > MAX_PREVIEW_LINES
      ? truncate(previewText + `\n\n... [截断: 共 ${rows.length} 行，显示前 ${MAX_PREVIEW_LINES} 行]`)
      : truncate(previewText);

    return {
      filename,
      mime_type: mimeType,
      file_size: fileBuffer.length,
      content_type: 'text',
      text: result.text,
      truncated: result.truncated,
      metadata: {
        rows: rows.length,
        columns: rows[0]?.length || 0,
        headers: rows[0] || [],
        char_count: result.text.length,
      },
    };
  }

  const result = truncate(text);
  return {
    filename,
    mime_type: mimeType,
    file_size: fileBuffer.length,
    content_type: 'text',
    text: result.text,
    truncated: result.truncated,
    metadata: { char_count: result.text.length },
  };
}

// ─── Process Image Files ─────────────────────────────────────

function processImage(fileBuffer, filename, mimeType) {
  const sizeKB = Math.round(fileBuffer.length / 1024 * 10) / 10;
  return {
    filename,
    mime_type: mimeType,
    file_size: fileBuffer.length,
    content_type: 'image',
    text: `[图片文件] ${filename} (${sizeKB} KB)`,
    truncated: false,
    metadata: { file_size_kb: sizeKB },
  };
}

// ─── Main Entry Point ────────────────────────────────────────

function processFile(fileBuffer, filename, mimeType = '') {
  if (!fileBuffer || fileBuffer.length === 0) {
    return {
      filename,
      mime_type: mimeType,
      file_size: 0,
      content_type: 'unknown',
      text: '[错误] 文件为空',
      truncated: false,
      metadata: {},
    };
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const textExtensions = new Set([
    'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'py', 'js', 'ts',
    'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'yaml',
    'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash', 'zsh', 'fish',
    'bat', 'cmd', 'ps1', 'sql', 'r', 'rb', 'go', 'rs', 'java', 'kt',
    'swift', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'lua', 'dart',
    'vue', 'svelte', 'astro', 'log', 'env', 'gitignore', 'dockerfile',
  ]);
  const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);

  if (ext in textExtensions || mimeType.startsWith('text/')) {
    return processText(fileBuffer, filename, mimeType);
  }
  if (ext in imageExtensions || mimeType.startsWith('image/')) {
    return processImage(fileBuffer, filename, mimeType);
  }

  // Default: try as text
  return processText(fileBuffer, filename, mimeType);
}

// ─── Tool Definition ─────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'process_file',
    description: '处理上传的文件并提取结构化文本内容。支持 TXT、MD、JSON、CSV 和图片。',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '文件名' },
        file_size: { type: 'integer', description: '文件大小（字节）' },
        content_type: { type: 'string', description: '文件内容类型提示' },
      },
      required: ['filename'],
    },
  },
];

const HANDLERS = {
  sync: {
    process_file: (args) => {
      // In Electron context, this would need file path access
      // For now, return metadata
      return JSON.stringify({
        filename: args.filename,
        status: 'File processing in Electron requires file dialog integration',
      });
    },
  },
};

module.exports = { TOOL_DEFINITIONS, HANDLERS, processFile };
