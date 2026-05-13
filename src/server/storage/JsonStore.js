/**
 * JsonStore — 会话持久化存储（JSON 文件实现）
 *
 * 接口契约（后续可替换为 SqliteStore）：
 *   list()              → Promise<Array<{id, title, messageCount, createdAt, updatedAt}>>
 *   get(id)             → Promise<{id, title, messages, createdAt, updatedAt} | null>
 *   save(conversation)  → Promise<void>
 *   delete(id)          → Promise<void>
 *
 * 存储结构：
 *   {baseDir}/
 *     index.json          ← 轻量索引（map 结构，O(1) 查找/更新）
 *     {id}.json           ← 完整会话数据
 *
 * 索引格式：
 *   {
 *     "version": 1,
 *     "conversations": {
 *       "conv_xxx": { "id": "conv_xxx", "title": "...", "messageCount": 5, "createdAt": ..., "updatedAt": ... }
 *     }
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

class JsonStore {
  /**
   * @param {string} baseDir - 存储目录绝对路径
   */
  constructor(baseDir) {
    this._baseDir = baseDir;
    this._ensureDir();
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * 列出全部会话摘要（按 updatedAt 降序）。
   * @returns {Promise<Array<{id, title, messageCount, createdAt, updatedAt}>>}
   */
  async list() {
    const index = this._readIndex();
    const map = index.conversations || {};
    const list = Object.values(map);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }

  /**
   * 读取单个会话完整数据。
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async get(id) {
    const filePath = this._dataPath(id);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`[JsonStore] get(${id}) ERROR:`, e.message);
      return null;
    }
  }

  /**
   * 保存会话（创建或更新）。
   * 同时写入数据文件 + 更新索引。
   * @param {{id, title, messages, createdAt, updatedAt}} conv
   * @returns {Promise<void>}
   */
  async save(conv) {
    if (!conv.id) throw new Error('缺少会话 ID');

    // 1. 写入数据文件（原子：先写临时文件再重命名）
    const data = {
      id: conv.id,
      title: conv.title || '未命名会话',
      messages: conv.messages || [],
      createdAt: conv.createdAt || Date.now(),
      updatedAt: conv.updatedAt || Date.now(),
    };
    this._writeAtomic(this._dataPath(conv.id), JSON.stringify(data, null, 2));

    // 2. 更新索引
    const index = this._readIndex();
    index.conversations[conv.id] = {
      id: conv.id,
      title: data.title,
      messageCount: data.messages.length,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    this._writeIndex(index);
  }

  /**
   * 删除会话（数据文件 + 索引条目）。
   * @param {string} id
   * @returns {Promise<void>}
   */
  async delete(id) {
    // 1. 删除数据文件
    const filePath = this._dataPath(id);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error(`[JsonStore] delete(${id}) unlink ERROR:`, e.message);
    }

    // 2. 从索引移除
    const index = this._readIndex();
    delete index.conversations[id];
    this._writeIndex(index);
  }

  // ─── Internal ──────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(this._baseDir)) {
      fs.mkdirSync(this._baseDir, { recursive: true });
    }
  }

  _dataPath(id) {
    return path.join(this._baseDir, id + '.json');
  }

  _indexPath() {
    return path.join(this._baseDir, INDEX_FILE);
  }

  /**
   * 读取索引文件，不存在则返回空结构。
   */
  _readIndex() {
    const p = this._indexPath();
    try {
      if (!fs.existsSync(p)) {
        return { version: INDEX_VERSION, conversations: {} };
      }
      const raw = fs.readFileSync(p, 'utf-8');
      const index = JSON.parse(raw);
      // 兼容旧格式（数组 → map）
      if (Array.isArray(index.conversations)) {
        const map = {};
        for (const c of index.conversations) {
          map[c.id] = c;
        }
        index.conversations = map;
        index.version = INDEX_VERSION;
      }
      if (!index.conversations) index.conversations = {};
      return index;
    } catch (e) {
      console.error(`[JsonStore] _readIndex ERROR:`, e.message);
      return { version: INDEX_VERSION, conversations: {} };
    }
  }

  /**
   * 写入索引文件（原子：先写临时文件再重命名）。
   */
  _writeIndex(index) {
    const p = this._indexPath();
    const tmp = p + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error(`[JsonStore] _writeIndex ERROR:`, e.message);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  /**
   * 原子写入：先写 .tmp 再 rename。
   */
  _writeAtomic(filePath, content) {
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error(`[JsonStore] _writeAtomic ERROR:`, e.message);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  }
}

module.exports = { JsonStore };