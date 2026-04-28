/**
 * DS Agent — Shell & File Operation Tools (Node.js)
 *
 * Ported from Python tools/shell.py
 * Provides: execute_command, get_cwd, list_directory, read_file, write_file, edit_file
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ───────────────────────────────────────────────
const WORKSPACE_ROOT = process.env.DS_WORKSPACE
  ? path.resolve(process.env.DS_WORKSPACE)
  : process.cwd();

const IS_WINDOWS = process.platform === 'win32';
const PLATFORM_NAME = IS_WINDOWS ? 'Windows' : 'Linux';

// Dangerous command patterns — same as Python version
const DANGEROUS_PATTERNS = [
  /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\//,       // rm -rf /
  /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+\//,       // rm -fr /
  /:\(\)\s*\{\s*:\|:\&\s*\}\s*;:/,          // fork bomb
  /\bmkfs\b/,                                // mkfs
  /\bdd\s+if=/,                              // dd if=...
  />\s*\/dev\/sd/,                           // overwrite disk
  /chmod\s+777\s+\//,                        // chmod 777 /
  /chown\s+root\s+\//,                       // chown root /
  /\bkill\b/,                                // kill
  /\bpkill\b/,                               // pkill
  /\bkillall\b/,                             // killall
  /\btaskkill(\.exe)?\b/,                    // taskkill (Windows)
  /\bdel\s+(\/[fFsSqQ]\s+){2,}\/[fFsSqQ]/, // del /f /s /q (Windows)
  /\brmdir\s+(\/[sSqQ]\s+){1,}\/[sSqQ]/,   // rmdir /s /q (Windows)
  /\brd\s+(\/[sSqQ]\s+){1,}\/[sSqQ]/,      // rd /s /q (Windows)
  /\bformat(\.com)?\b/,                      // format (Windows)
  /\bdiskpart\b/,                            // diskpart (Windows)
];

// ─── Helpers ─────────────────────────────────────────────────

function validatePath(inputPath) {
  const resolved = path.resolve(inputPath.startsWith('~')
    ? inputPath.replace('~', os.homedir())
    : inputPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`路径 '${resolved}' 超出工作区范围，仅允许访问 '${WORKSPACE_ROOT}' 内的文件`);
  }
  return resolved;
}

function executeCommand(command, timeout = 30) {
  // Safety check
  const cmdLower = command.toLowerCase().trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    const match = cmdLower.match(pattern);
    if (match) {
      return `安全拦截：命令中包含危险操作 '${match[0]}'，已阻止执行以保护系统安全`;
    }
  }

  return new Promise((resolve) => {
    exec(command, {
      cwd: WORKSPACE_ROOT,
      timeout: timeout * 1000,
      maxBuffer: 5 * 1024 * 1024, // 5MB
      encoding: 'utf-8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      let output = stdout || '';
      if (stderr) {
        output += (output ? '\n--- stderr ---\n' : '') + stderr;
      }
      if (error) {
        if (error.killed) {
          resolve(`命令执行超时（限制 ${timeout} 秒）。如需更长时间，请增大 timeout 参数`);
          return;
        }
        output += `\n(退出码: ${error.code || 'unknown'})`;
        if (IS_WINDOWS && error.code === 1 && stderr?.includes('is not recognized')) {
          output += '\n提示：当前运行在 Windows 上，请使用 cmd.exe 语法';
        } else if (!IS_WINDOWS && error.code === 127) {
          output += '\n提示：命令未找到（退出码 127），请检查命令名称是否正确';
        }
      }
      resolve(output || '(命令执行完毕，无输出)');
    });
  });
}

function getCwd() {
  return WORKSPACE_ROOT;
}

function listDirectory(dirPath = '.') {
  try {
    const resolved = validatePath(dirPath);
    if (!fs.existsSync(resolved)) return `错误：路径不存在 — ${resolved}`;
    if (!fs.statSync(resolved).isDirectory()) return `错误：这不是一个目录 — ${resolved}`;

    const entries = fs.readdirSync(resolved)
      .sort()
      .map(name => {
        const fullPath = path.join(resolved, name);
        try {
          const isDir = fs.statSync(fullPath).isDirectory();
          if (isDir) return `d ${name}`;
          const size = fs.statSync(fullPath).size;
          return `f ${name} (${size.toLocaleString()} bytes)`;
        } catch {
          return `? ${name}`;
        }
      });

    return entries.length ? entries.join('\n') : '(空目录)';
  } catch (err) {
    return err.message;
  }
}

function readFile(filePath, encoding = 'utf-8', maxBytes = 1048576) {
  try {
    const resolved = validatePath(filePath);
    if (!fs.existsSync(resolved)) return `错误：文件不存在 — ${resolved}`;
    if (!fs.statSync(resolved).isFile()) return `错误：这不是一个文件 — ${resolved}`;

    const size = fs.statSync(resolved).size;
    if (size > maxBytes) {
      return `错误：文件过大（${size.toLocaleString()} 字节，限制 ${maxBytes.toLocaleString()} 字节）。请增大 max_bytes 参数或读取部分内容`;
    }

    return fs.readFileSync(resolved, { encoding });
  } catch (err) {
    if (err.code === 'ENOENT') return `错误：文件不存在 — ${filePath}`;
    return `读取文件失败: ${err.message}`;
  }
}

function writeFile(filePath, content, encoding = 'utf-8') {
  try {
    const resolved = validatePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, { encoding });
    return `已写入 ${content.length.toLocaleString()} 个字符到 ${resolved}`;
  } catch (err) {
    return `写入文件失败: ${err.message}`;
  }
}

/**
 * NEW: Edit file — replace exact string matches in a file.
 * This is essential for Agent coding tasks.
 */
function editFile(filePath, oldString, newString, replaceAll = false) {
  try {
    const resolved = validatePath(filePath);
    if (!fs.existsSync(resolved)) return `错误：文件不存在 — ${resolved}`;

    let content = fs.readFileSync(resolved, 'utf-8');

    if (!content.includes(oldString)) {
      return `错误：在文件中未找到要替换的内容。请确保 old_string 与文件中的内容完全匹配（包括缩进和空格）`;
    }

    if (!replaceAll && content.split(oldString).length > 2) {
      return `错误：要替换的内容在文件中出现了多次。请提供更多上下文以唯一匹配，或设置 replace_all 为 true`;
    }

    if (replaceAll) {
      content = content.split(oldString).join(newString);
    } else {
      content = content.replace(oldString, newString);
    }

    fs.writeFileSync(resolved, content, 'utf-8');
    const count = replaceAll
      ? (content.split(newString).length - 1)
      : 1;
    return `已替换 ${count} 处，文件已保存: ${resolved}`;
  } catch (err) {
    return `编辑文件失败: ${err.message}`;
  }
}

/**
 * NEW: Search in files — like grep, finds patterns across files.
 */
function searchInFiles(pattern, directory = '.', filePattern = '*', maxResults = 50) {
  try {
    const resolved = validatePath(directory);
    if (!fs.existsSync(resolved)) return `错误：目录不存在 — ${resolved}`;

    const regex = new RegExp(pattern, 'gi');
    const results = [];

    function walk(dir) {
      if (results.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);

        // Skip common non-useful directories
        if (entry.isDirectory()) {
          if (['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build'].includes(entry.name)) continue;
          walk(fullPath);
          continue;
        }

        // Simple file pattern matching
        if (filePattern !== '*' && !entry.name.match(new RegExp(filePattern.replace(/\*/g, '.*')))) continue;

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${path.relative(resolved, fullPath)}:${i + 1}: ${lines[i].trim()}`);
              if (results.length >= maxResults) break;
            }
            regex.lastIndex = 0; // Reset regex state
          }
        } catch {
          // Skip binary/unreadable files
        }
      }
    }

    walk(resolved);

    if (results.length === 0) {
      return `未找到匹配 '${pattern}' 的内容。请尝试调整搜索模式`;
    }

    let output = results.join('\n');
    if (results.length >= maxResults) {
      output += `\n\n... (结果已截断，最多显示 ${maxResults} 条)`;
    }
    return output;
  } catch (err) {
    return `搜索失败: ${err.message}`;
  }
}

// ─── Tool Definitions (MCP Schema) ──────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'execute_command',
    description: `执行 shell 命令。工作区: ${WORKSPACE_ROOT}（平台: ${PLATFORM_NAME}，${IS_WINDOWS ? '请使用 cmd.exe 语法' : '请使用 bash 语法'}）`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'integer', description: '超时时间（秒，默认 30）' },
      },
      required: ['command'],
    },
  },
  {
    name: 'get_cwd',
    description: `获取当前工作区目录路径（${WORKSPACE_ROOT}）`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_directory',
    description: '列出工作区内指定目录的文件和子目录',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（默认为当前目录）' },
      },
    },
  },
  {
    name: 'read_file',
    description: '读取工作区内指定文件的内容',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件路径' },
        encoding: { type: 'string', description: '文件编码（默认: utf-8）' },
        max_bytes: { type: 'integer', description: '最大读取字节数（默认 1048576）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '将内容写入工作区内的指定文件',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要写入的文件路径' },
        content: { type: 'string', description: '要写入的内容' },
        encoding: { type: 'string', description: '文件编码（默认: utf-8）' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '编辑工作区内的文件——精确替换文件中的指定字符串。适用于代码修改、配置更新等场景',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的文件路径' },
        old_string: { type: 'string', description: '要替换的原始文本（必须完全匹配）' },
        new_string: { type: 'string', description: '替换后的新文本' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配项（默认 false，仅替换第一处）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'search_in_files',
    description: '在工作区内搜索文件内容（类似 grep）。支持正则表达式，可按文件名模式过滤',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（支持正则表达式）' },
        directory: { type: 'string', description: '搜索目录（默认为工作区根目录）' },
        file_pattern: { type: 'string', description: '文件名过滤模式（如 "*.js", "*.py"，默认 "*"）' },
        max_results: { type: 'integer', description: '最大返回结果数（默认 50）' },
      },
      required: ['pattern'],
    },
  },
];

// ─── Handler Maps ────────────────────────────────────────────

const HANDLERS = {
  sync: {
    get_cwd: (args) => getCwd(),
    list_directory: (args) => listDirectory(args.path || '.'),
    read_file: (args) => readFile(args.path || '', args.encoding || 'utf-8', args.max_bytes || 1048576),
    write_file: (args) => writeFile(args.path || '', args.content || '', args.encoding || 'utf-8'),
    edit_file: (args) => editFile(args.path || '', args.old_string || '', args.new_string || '', args.replace_all || false),
    search_in_files: (args) => searchInFiles(args.pattern || '', args.directory || '.', args.file_pattern || '*', args.max_results || 50),
  },
  async: {
    execute_command: async (args) => await executeCommand(args.command || '', args.timeout || 30),
  },
};

module.exports = { TOOL_DEFINITIONS, HANDLERS };
