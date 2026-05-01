/**
 * DS Agent — Shell & File Operation Tools (Node.js)
 *
 * Ported from Python tools/shell.py
 * Provides: execute_command, get_cwd, list_directory, read_file, write_file, edit_file
 *           set_workspace, get_workspace
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Workspace Root ──────────────────────────────────────────
// Priority: 1. DS_WORKSPACE env  2. Default ~/DS-Agent
const DEFAULT_WORKSPACE_NAME = 'DS-Agent';

function getDefaultWorkspace() {
  return path.join(os.homedir(), DEFAULT_WORKSPACE_NAME);
}

let WORKSPACE_ROOT = process.env.DS_WORKSPACE
  ? path.resolve(process.env.DS_WORKSPACE)
  : getDefaultWorkspace();

// Ensure default workspace directory exists
if (!process.env.DS_WORKSPACE && !fs.existsSync(WORKSPACE_ROOT)) {
  try {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    console.log(`[DS Agent] Default workspace created: ${WORKSPACE_ROOT}`);
  } catch (err) {
    console.error(`[DS Agent] Failed to create default workspace: ${err.message}`);
  }
}

const IS_WINDOWS = process.platform === 'win32';
const PLATFORM_NAME = IS_WINDOWS ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

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

function setWorkspace(newPath) {
  if (!newPath || typeof newPath !== 'string') {
    return `错误：无效的工作目录路径`;
  }
  const resolved = path.resolve(newPath.startsWith('~')
    ? newPath.replace('~', os.homedir())
    : newPath);

  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return `错误：'${resolved}' 不是一个目录`;
    }
    WORKSPACE_ROOT = resolved;
    _updateToolDescriptions();
    console.log(`[DS Agent] Workspace changed to: ${WORKSPACE_ROOT}`);
    return `工作目录已切换到: ${WORKSPACE_ROOT}`;
  } catch (err) {
    return `切换工作目录失败: ${err.message}`;
  }
}

function getWorkspace() {
  return WORKSPACE_ROOT;
}

function listDirectory(dirPath) {
  try {
    // Require absolute path (after tilde expansion)
    const expanded = dirPath.startsWith('~') ? dirPath.replace('~', os.homedir()) : dirPath;
    if (!path.isAbsolute(expanded)) {
      return `错误：需要提供绝对路径，当前传入的是相对路径 "${dirPath}"。请使用以 / 开头的绝对路径（如 /home/user/projects）`;
    }
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

function readFile(filePath, encoding = 'utf-8', maxBytes = 1048576, startLine = 1, lineCount = 200) {
  try {
    const resolved = validatePath(filePath);
    if (!fs.existsSync(resolved)) return `错误：文件不存在 — ${resolved}`;
    if (!fs.statSync(resolved).isFile()) return `错误：这不是一个文件 — ${resolved}`;

    const size = fs.statSync(resolved).size;
    if (size > maxBytes) {
      return `错误：文件过大（${size.toLocaleString()} 字节，限制 ${maxBytes.toLocaleString()} 字节）。请增大 max_bytes 参数或使用 start_line/line_count 分段读取`;
    }

    const raw = fs.readFileSync(resolved, { encoding });
    const lines = raw.split('\n');
    const totalLines = lines.length;

    // startLine is 1-based
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(totalLines, startIdx + lineCount);
    const selected = lines.slice(startIdx, endIdx);
    let content = selected.join('\n');

    // Add truncation notice
    if (endIdx < totalLines) {
      content += `\n\n[文件共 ${totalLines.toLocaleString()} 行，以上为第 ${startLine}-${endIdx} 行。使用 start_line=${endIdx + 1} 继续读取后续内容]`;
    } else if (startLine > 1) {
      content += `\n\n[文件共 ${totalLines.toLocaleString()} 行，以上为第 ${startLine}-${endIdx} 行（文件末尾）]`;
    }

    return content;
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

function _updateToolDescriptions() {
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.name === 'execute_command') {
      tool.description = `执行 shell 命令。工作区: ${WORKSPACE_ROOT}（平台: ${PLATFORM_NAME}，${IS_WINDOWS ? '请使用 cmd.exe 语法' : '请使用 bash 语法'}）。可用 set_workspace 切换工作目录`;
    } else if (tool.name === 'get_cwd') {
      tool.description = `获取当前工作区目录路径（${WORKSPACE_ROOT}）`;
    }
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'execute_command',
    description: `执行 shell 命令。工作区: ${WORKSPACE_ROOT}（平台: ${PLATFORM_NAME}，${IS_WINDOWS ? '请使用 cmd.exe 语法' : '请使用 bash 语法'}）。可用 set_workspace 切换工作目录`,
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
    name: 'set_workspace',
    description: '设置工作目录。切换后所有文件操作和命令执行都将在新目录下进行',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '新的工作目录路径（支持 ~ 表示用户主目录）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: '列出工作区内指定目录的文件和子目录。path 必须是绝对路径（如 /home/user/projects）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（必填）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取工作区内指定文件的内容。大文件会自动分段，默认读取前 200 行。使用 start_line 和 line_count 参数可以读取文件的任意部分。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件路径' },
        encoding: { type: 'string', description: '文件编码（默认: utf-8）' },
        start_line: { type: 'integer', description: '从第几行开始读取，1 表示第一行（默认: 1）' },
        line_count: { type: 'integer', description: '读取多少行（默认: 200）' },
        max_bytes: { type: 'integer', description: '文件大小上限，超过此大小的文件拒绝读取（默认 1048576 = 1MB）' },
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
    set_workspace: (args) => setWorkspace(args.path || ''),
    list_directory: (args) => {
      const rawPath = (args.path || '').toString().trim();
      return listDirectory(rawPath || WORKSPACE_ROOT);
    },
    read_file: (args) => readFile(args.path || '', args.encoding || 'utf-8', args.max_bytes || 1048576, args.start_line || 1, args.line_count || 200),
    write_file: (args) => writeFile(args.path || '', args.content || '', args.encoding || 'utf-8'),
    edit_file: (args) => editFile(args.path || '', args.old_string || '', args.new_string || '', args.replace_all || false),
    search_in_files: (args) => searchInFiles(args.pattern || '', args.directory || '.', args.file_pattern || '*', args.max_results || 50),
  },
  async: {
    execute_command: async (args) => await executeCommand(args.command || '', args.timeout || 30),
  },
};

module.exports = { TOOL_DEFINITIONS, HANDLERS, getWorkspace, setWorkspace };
