const express = require('express');
const fs = require('fs');
const path = require('path');

// 读取项目根目录 .env（轻量实现，不依赖 dotenv），让 API Key 不写进代码
try {
  const envRaw = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  envRaw.split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
} catch (e) { /* 没有 .env 文件也没关系，走模板兜底 / 环境变量 */ }

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
}));

// 是否使用真实数据库：配置了 DATABASE_URL 走 Postgres，否则回退本地 JSON 文件
const USE_PG = !!process.env.DATABASE_URL;

// 统一抛出带状态码的错误
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 日期格式化为可读字符串（与前端显示兼容）
function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

// ============================================================
// JSON 文件存储（本地开发回退，保持本机 3456 可用）
// ============================================================
const DB_PATH = path.join(__dirname, 'data', 'db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { events: [], registrations: [], topics: [], topic_votes: [], notes: [], ai_history: [] };
}

function saveDb(db) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  } catch (e) { /* 目录已存在则忽略 */ }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function createJsonStorage() {
  return {
    async listEvents() {
      const db = loadDb();
      const events = db.events.map(e => ({
        ...e,
        pro_count: db.registrations.filter(r => r.event_id === e.id && r.side === '正方').length,
        con_count: db.registrations.filter(r => r.event_id === e.id && r.side === '反方').length,
        watch_count: db.registrations.filter(r => r.event_id === e.id && r.side === '观战').length,
      }));
      events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return events;
    },
    async getEvent(id) {
      const db = loadDb();
      const event = db.events.find(e => e.id === id);
      if (!event) return null;
      const registrations = db.registrations.filter(r => r.event_id === event.id);
      return {
        ...event,
        pro_count: registrations.filter(r => r.side === '正方').length,
        con_count: registrations.filter(r => r.side === '反方').length,
        registrations: registrations.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      };
    },
    async createEvent({ topic, debate_time, format, max_per_side }) {
      const db = loadDb();
      const event = {
        id: Date.now(),
        topic, debate_time,
        format: format || 'standard',
        max_per_side: max_per_side || 3,
        status: 'open',
        created_at: fmtDate(new Date()),
      };
      db.events.push(event);
      saveDb(db);
      return { id: event.id };
    },
    async register({ eventId, name, side, role }) {
      const db = loadDb();
      const event = db.events.find(e => e.id === eventId);
      if (!event) throw httpError(404, 'Event not found');
      if (event.status !== 'open') throw httpError(400, '该比赛已关闭报名');
      if (db.registrations.find(r => r.event_id === event.id && r.name === name)) {
        throw httpError(400, '你已报名该比赛');
      }
      if (side === '正方' || side === '反方') {
        const count = db.registrations.filter(r => r.event_id === event.id && r.side === side).length;
        if (count >= event.max_per_side) throw httpError(400, `${side}已满员`);
      }
      db.registrations.push({
        id: Date.now(), event_id: event.id, name, side,
        role: role || '辩手', created_at: fmtDate(new Date()),
      });
      const pro = db.registrations.filter(r => r.event_id === event.id && r.side === '正方').length;
      const con = db.registrations.filter(r => r.event_id === event.id && r.side === '反方').length;
      if (pro >= event.max_per_side && con >= event.max_per_side) event.status = 'ready';
      saveDb(db);
      return { success: true };
    },
    async deleteEvent(id) {
      const db = loadDb();
      db.registrations = db.registrations.filter(r => r.event_id !== id);
      db.events = db.events.filter(e => e.id !== id);
      saveDb(db);
      return { success: true };
    },
    async listTopics() {
      const db = loadDb();
      return db.topics.sort((a, b) => b.votes - a.votes || new Date(b.created_at) - new Date(a.created_at));
    },
    async createTopic({ title, pro_position, con_position, submitter }) {
      const db = loadDb();
      const topic = {
        id: Date.now(), title, pro_position, con_position, submitter,
        votes: 0, created_at: fmtDate(new Date()),
      };
      db.topics.push(topic);
      saveDb(db);
      return { id: topic.id };
    },
    async voteTopic({ topicId, voter }) {
      const db = loadDb();
      const topic = db.topics.find(t => t.id === topicId);
      if (!topic) throw httpError(404, 'Topic not found');
      const existing = db.topic_votes.find(v => v.topic_id === topic.id && v.voter === voter);
      if (existing) {
        db.topic_votes = db.topic_votes.filter(v => !(v.topic_id === topic.id && v.voter === voter));
        topic.votes = Math.max(0, topic.votes - 1);
        saveDb(db);
        return { action: 'unvoted', votes: topic.votes };
      } else {
        db.topic_votes.push({ id: Date.now(), topic_id: topic.id, voter, created_at: new Date().toISOString() });
        topic.votes += 1;
        saveDb(db);
        return { action: 'voted', votes: topic.votes };
      }
    },
    async deleteTopic(id) {
      const db = loadDb();
      db.topic_votes = db.topic_votes.filter(v => v.topic_id !== id);
      db.topics = db.topics.filter(t => t.id !== id);
      saveDb(db);
      return { success: true };
    },
    async listNotes(owner, topic) {
      const db = loadDb();
      let notes = db.notes.filter(n => n.owner === owner);
      if (topic) notes = notes.filter(n => n.topic === topic);
      notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return notes;
    },
    async createNote({ owner, event_id, topic, title, content, side, type }) {
      const db = loadDb();
      const note = {
        id: Date.now(), owner,
        event_id: event_id || null, topic: topic || null, title,
        content: content || '', side: side || null, type: type || 'argument',
        created_at: fmtDate(new Date()), updated_at: fmtDate(new Date()),
      };
      db.notes.push(note);
      saveDb(db);
      return { id: note.id };
    },
    async updateNote({ id, owner, title, content, side, type, topic }) {
      const db = loadDb();
      const note = db.notes.find(n => n.id === id);
      if (!note) throw httpError(404, 'Note not found');
      if (note.owner !== owner) throw httpError(403, '无权操作');
      note.title = title; note.content = content; note.side = side; note.type = type;
      if (topic !== undefined) note.topic = topic;
      note.updated_at = fmtDate(new Date());
      saveDb(db);
      return { success: true };
    },
    async deleteNote({ id, owner }) {
      const db = loadDb();
      const note = db.notes.find(n => n.id === id);
      if (!note) throw httpError(404, 'Note not found');
      if (note.owner !== owner) throw httpError(403, '无权操作');
      db.notes = db.notes.filter(n => n.id !== id);
      saveDb(db);
      return { success: true };
    },
    async getAiHistory(owner) {
      const db = loadDb();
      const h = (db.ai_history || []).find(x => x.owner === owner);
      return h ? { topic: h.topic, side: h.side, messages: h.messages } : { messages: [] };
    },
    async saveAiHistory({ owner, topic, side, messages }) {
      const db = loadDb();
      db.ai_history = db.ai_history || [];
      const h = db.ai_history.find(x => x.owner === owner);
      if (h) { h.topic = topic; h.side = side; h.messages = messages; }
      else db.ai_history.push({ owner, topic, side, messages });
      saveDb(db);
      return { success: true };
    },
    async deleteAiHistory(owner) {
      const db = loadDb();
      db.ai_history = db.ai_history || [];
      db.ai_history = db.ai_history.filter(x => x.owner !== owner);
      saveDb(db);
      return { success: true };
    },
  };
}

// ============================================================
// Postgres 存储（部署到 Railway 等平台，数据真正持久化）
// ============================================================
let pool = null;

async function initPg() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      debate_time TEXT,
      format TEXT DEFAULT 'standard',
      max_per_side INT DEFAULT 3,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      event_id INT REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      side TEXT NOT NULL,
      role TEXT DEFAULT '辩手',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      pro_position TEXT,
      con_position TEXT,
      submitter TEXT,
      votes INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS topic_votes (
      id SERIAL PRIMARY KEY,
      topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
      voter TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(topic_id, voter)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      event_id INT,
      topic TEXT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      side TEXT,
      type TEXT DEFAULT 'argument',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_history (
      owner TEXT PRIMARY KEY,
      topic TEXT,
      side TEXT,
      messages JSONB DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// Postgres 查询时把时间字段格式化为可读字符串（上海时区）
const TS = "to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS created_at";

function createPgStorage() {
  const num = (v) => parseInt(v, 10) || 0;
  return {
    async listEvents() {
      const { rows } = await pool.query(`
        SELECT e.id, e.topic, e.debate_time, e.format, e.max_per_side, e.status,
               ${TS},
               COUNT(r.id) FILTER (WHERE r.side='正方') AS pro_count,
               COUNT(r.id) FILTER (WHERE r.side='反方') AS con_count,
               COUNT(r.id) FILTER (WHERE r.side='观战') AS watch_count
        FROM events e LEFT JOIN registrations r ON r.event_id = e.id
        GROUP BY e.id ORDER BY e.created_at DESC
      `);
      return rows.map(r => ({
        ...r, id: num(r.id), max_per_side: num(r.max_per_side),
        pro_count: num(r.pro_count), con_count: num(r.con_count), watch_count: num(r.watch_count),
      }));
    },
    async getEvent(id) {
      const ev = await pool.query(`
        SELECT id, topic, debate_time, format, max_per_side, status, ${TS}
        FROM events WHERE id=$1
      `, [id]);
      if (ev.rowCount === 0) return null;
      const r = ev.rows[0];
      const regs = await pool.query(`
        SELECT id, event_id, name, side, role, ${TS}
        FROM registrations WHERE event_id=$1 ORDER BY created_at ASC
      `, [id]);
      const pro = regs.rows.filter(x => x.side === '正方').length;
      const con = regs.rows.filter(x => x.side === '反方').length;
      return {
        ...r, id: num(r.id), max_per_side: num(r.max_per_side),
        pro_count: pro, con_count: con,
        registrations: regs.rows.map(x => ({ ...x, id: num(x.id), event_id: num(x.event_id) })),
      };
    },
    async createEvent({ topic, debate_time, format, max_per_side }) {
      const { rows } = await pool.query(`
        INSERT INTO events (topic, debate_time, format, max_per_side)
        VALUES ($1,$2,$3,$4) RETURNING id
      `, [topic, debate_time, format || 'standard', max_per_side || 3]);
      return { id: num(rows[0].id) };
    },
    async register({ eventId, name, side, role }) {
      const ev = await pool.query('SELECT id, max_per_side, status FROM events WHERE id=$1', [eventId]);
      if (ev.rowCount === 0) throw httpError(404, 'Event not found');
      const event = ev.rows[0];
      if (event.status !== 'open') throw httpError(400, '该比赛已关闭报名');
      const dup = await pool.query('SELECT 1 FROM registrations WHERE event_id=$1 AND name=$2', [eventId, name]);
      if (dup.rowCount > 0) throw httpError(400, '你已报名该比赛');
      if (side === '正方' || side === '反方') {
        const c = await pool.query(
          "SELECT COUNT(*) FROM registrations WHERE event_id=$1 AND side=$2", [eventId, side]);
        if (num(c.rows[0].count) >= num(event.max_per_side)) throw httpError(400, `${side}已满员`);
      }
      await pool.query(
        'INSERT INTO registrations (event_id, name, side, role) VALUES ($1,$2,$3,$4)',
        [eventId, name, side, role || '辩手']);
      const counts = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE side='正方') AS pro, COUNT(*) FILTER (WHERE side='反方') AS con FROM registrations WHERE event_id=$1",
        [eventId]);
      const pro = num(counts.rows[0].pro), con = num(counts.rows[0].con);
      if (pro >= num(event.max_per_side) && con >= num(event.max_per_side)) {
        await pool.query("UPDATE events SET status='ready' WHERE id=$1", [eventId]);
      }
      return { success: true };
    },
    async deleteEvent(id) {
      await pool.query('DELETE FROM events WHERE id=$1', [id]);
      return { success: true };
    },
    async listTopics() {
      const { rows } = await pool.query(`
        SELECT id, title, pro_position, con_position, submitter, votes, ${TS}
        FROM topics ORDER BY votes DESC, created_at DESC
      `);
      return rows.map(r => ({ ...r, id: num(r.id), votes: num(r.votes) }));
    },
    async createTopic({ title, pro_position, con_position, submitter }) {
      const { rows } = await pool.query(`
        INSERT INTO topics (title, pro_position, con_position, submitter)
        VALUES ($1,$2,$3,$4) RETURNING id
      `, [title, pro_position, con_position, submitter]);
      return { id: num(rows[0].id) };
    },
    async voteTopic({ topicId, voter }) {
      const tp = await pool.query('SELECT id FROM topics WHERE id=$1', [topicId]);
      if (tp.rowCount === 0) throw httpError(404, 'Topic not found');
      const ex = await pool.query('SELECT 1 FROM topic_votes WHERE topic_id=$1 AND voter=$2', [topicId, voter]);
      let action;
      if (ex.rowCount > 0) {
        await pool.query('DELETE FROM topic_votes WHERE topic_id=$1 AND voter=$2', [topicId, voter]);
        await pool.query('UPDATE topics SET votes = GREATEST(0, votes-1) WHERE id=$1', [topicId]);
        action = 'unvoted';
      } else {
        await pool.query('INSERT INTO topic_votes (topic_id, voter) VALUES ($1,$2)', [topicId, voter]);
        await pool.query('UPDATE topics SET votes = votes+1 WHERE id=$1', [topicId]);
        action = 'voted';
      }
      const v = await pool.query('SELECT votes FROM topics WHERE id=$1', [topicId]);
      return { action, votes: num(v.rows[0].votes) };
    },
    async deleteTopic(id) {
      await pool.query('DELETE FROM topics WHERE id=$1', [id]);
      return { success: true };
    },
    async listNotes(owner, topic) {
      let sql = `SELECT id, owner, event_id, topic, title, content, side, type, ${TS} AS created_at,
                        to_char(updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS updated_at
                 FROM notes WHERE owner=$1`;
      const params = [owner];
      if (topic) { sql += ' AND topic=$2'; params.push(topic); }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await pool.query(sql, params);
      return rows.map(r => ({ ...r, id: num(r.id), event_id: r.event_id == null ? null : num(r.event_id) }));
    },
    async createNote({ owner, event_id, topic, title, content, side, type }) {
      const { rows } = await pool.query(`
        INSERT INTO notes (owner, event_id, topic, title, content, side, type)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [owner, event_id || null, topic || null, title, content || '', side || null, type || 'argument']);
      return { id: num(rows[0].id) };
    },
    async updateNote({ id, owner, title, content, side, type, topic }) {
      const cur = await pool.query('SELECT owner FROM notes WHERE id=$1', [id]);
      if (cur.rowCount === 0) throw httpError(404, 'Note not found');
      if (cur.rows[0].owner !== owner) throw httpError(403, '无权操作');
      await pool.query(`
        UPDATE notes SET title=$1, content=$2, side=$3, type=$4, topic=$5, updated_at=NOW()
        WHERE id=$6
      `, [title, content, side, type, topic, id]);
      return { success: true };
    },
    async deleteNote({ id, owner }) {
      const cur = await pool.query('SELECT owner FROM notes WHERE id=$1', [id]);
      if (cur.rowCount === 0) throw httpError(404, 'Note not found');
      if (cur.rows[0].owner !== owner) throw httpError(403, '无权操作');
      await pool.query('DELETE FROM notes WHERE id=$1', [id]);
      return { success: true };
    },
    async getAiHistory(owner) {
      const { rows } = await pool.query('SELECT topic, side, messages FROM ai_history WHERE owner=$1', [owner]);
      if (rows.length === 0) return { messages: [] };
      return { topic: rows[0].topic, side: rows[0].side, messages: rows[0].messages || [] };
    },
    async saveAiHistory({ owner, topic, side, messages }) {
      await pool.query(`
        INSERT INTO ai_history (owner, topic, side, messages)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (owner) DO UPDATE SET topic=$2, side=$3, messages=$4, updated_at=NOW()
      `, [owner, topic, side, JSON.stringify(messages)]);
      return { success: true };
    },
    async deleteAiHistory(owner) {
      await pool.query('DELETE FROM ai_history WHERE owner=$1', [owner]);
      return { success: true };
    },
  };
}

const storage = USE_PG ? createPgStorage() : createJsonStorage();

// ===== 身份辅助 =====
function getOwner(req) {
  const u = req.headers['x-user'];
  return u ? decodeURIComponent(u) : null;
}

// ===== Events API =====
app.get('/api/events', async (req, res) => {
  try { res.json(await storage.listEvents()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const ev = await storage.getEvent(parseInt(req.params.id));
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    res.json(ev);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', async (req, res) => {
  try {
    const { topic, debate_time, format, max_per_side } = req.body;
    if (!topic || !debate_time) return res.status(400).json({ error: '辩题和时间不能为空' });
    const { id } = await storage.createEvent({ topic, debate_time, format, max_per_side });
    res.json({ id, success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/events/:id/register', async (req, res) => {
  try {
    const { name, side, role } = req.body;
    if (!name || !side) return res.status(400).json({ error: '姓名和立场不能为空' });
    const result = await storage.register({ eventId: parseInt(req.params.id), name, side, role });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/events/:id', async (req, res) => {
  try { res.json(await storage.deleteEvent(parseInt(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Topics API =====
app.get('/api/topics', async (req, res) => {
  try { res.json(await storage.listTopics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/topics', async (req, res) => {
  try {
    const { title, pro_position, con_position, submitter } = req.body;
    if (!title || !pro_position || !con_position || !submitter) {
      return res.status(400).json({ error: '请填写完整信息' });
    }
    const { id } = await storage.createTopic({ title, pro_position, con_position, submitter });
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/topics/:id/vote', async (req, res) => {
  try {
    const { voter } = req.body;
    if (!voter) return res.status(400).json({ error: '请提供投票人名称' });
    res.json(await storage.voteTopic({ topicId: parseInt(req.params.id), voter }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/topics/:id', async (req, res) => {
  try { res.json(await storage.deleteTopic(parseInt(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Prep Notes API =====
app.get('/api/notes', async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  try {
    res.json(await storage.listNotes(owner, req.query.topic));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notes', async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const { event_id, topic, title, content, side, type } = req.body;
  if (!title) return res.status(400).json({ error: '请输入标题' });
  try {
    const { id } = await storage.createNote({ owner, event_id, topic, title, content, side, type });
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notes/:id', async (req, res) => {
  const owner = getOwner(req);
  const { title, content, side, type, topic } = req.body;
  try {
    res.json(await storage.updateNote({ id: parseInt(req.params.id), owner, title, content, side, type, topic }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/notes/:id', async (req, res) => {
  const owner = getOwner(req);
  try {
    res.json(await storage.deleteNote({ id: parseInt(req.params.id), owner }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ===== AI Debate History (Private per user) =====
app.get('/api/ai-history', async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  try { res.json(await storage.getAiHistory(owner)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai-history', async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const { topic, side, messages } = req.body;
  try { res.json(await storage.saveAiHistory({ owner, topic, side, messages })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ai-history', async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  try { res.json(await storage.deleteAiHistory(owner)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== AI Debate (DeepSeek 真实模型 + 模板兜底) =====
const aiResponses = {
  pro: [
    '从正面角度来看，{topic}确实能够带来显著的社会效益。首先，它促进了资源的优化配置；其次，它激发了创新活力；第三，它满足了人民群众的迫切需求。',
    '我方的核心论点是：{topic}是时代发展的必然选择。历史经验表明，类似的变革在初期都会遇到阻力，但最终都证明了其正确性。',
    '对方辩友似乎忽略了一个关键事实——问题的本质不在于是否应该做，而在于如何做得更好。{topic}本身的方向是正确的。',
    '数据表明，在实施{topic}的地区，相关指标提升了30%以上。这充分说明{topic}的积极意义是不可否认的。',
    '从伦理角度看，{topic}体现了对个体权利的尊重。每个人都有选择和发展的自由，这正是现代社会的基本价值。',
  ],
  con: [
    '如果从反面深入分析，{topic}存在几个不可忽视的风险：第一，执行层面的困难被严重低估；第二，潜在的负面效应缺乏充分评估；第三，替代方案没有得到应有的重视。',
    '我方的立场是：{topic}看似美好，实则可能是一场代价高昂的冒险。我们需要冷静下来，认真审视其可行性。',
    '对方辩友刚才的论述存在逻辑漏洞——将相关性等同于因果性。{topic}带来的所谓"好处"，可能根本就是其他因素导致的。',
    '多项独立研究的结论恰恰相反：{topic}的实践案例中，超过60%未能达到预期目标，甚至出现了负面效果。',
    '从成本-收益分析的角度，{topic}的投入产出比并不理想。有限的资源应该优先投入到已被验证有效的方案中。',
  ],
};

function templateResponse(topic, user_side) {
  const ai_side = user_side === '正方' ? '反方' : '正方';
  const responses = ai_side === '反方' ? aiResponses.con : aiResponses.pro;
  const response = responses[Math.floor(Math.random() * responses.length)].replace(/\{topic\}/g, topic);
  const specificRefutations = [
    `针对您刚才提到的观点，我认为存在以下问题：${topic}的复杂性被过度简化了，实际上需要多方位的考量。`,
    `您的论据看似有力，但忽略了一个重要前提——我们讨论的语境和适用范围需要更精确的界定。`,
    `我理解您的关切，但请允许我指出：您方论证的前提假设本身就值得商榷。`,
  ];
  const finalResponse = Math.random() > 0.5
    ? response
    : specificRefutations[Math.floor(Math.random() * specificRefutations.length)];
  return { response: finalResponse, ai_side, model: 'template' };
}

app.get('/api/ai-status', (req, res) => {
  res.json({ configured: !!process.env.DEEPSEEK_API_KEY });
});

app.post('/api/ai-debate', async (req, res) => {
  const { topic, user_message, user_side, history = [], model = 'chat' } = req.body;
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) return res.json(templateResponse(topic, user_side));

  const ai_side = user_side === '正方' ? '反方' : '正方';
  const sysPrompt = `你是一位顶尖辩论赛选手，正在与用户进行一对一模拟辩论。
辩题：${topic}
你的立场：${ai_side}
对方的立场：${user_side}

辩论要求：
1. 始终坚守你的立场，逻辑清晰、论据扎实；
2. 针对对方刚才的具体论点进行有力反驳，不要空泛；
3. 语言简洁有力、适合口头辩论，单次回应控制在 150-260 字；
4. 可结合事实逻辑、常识或价值层面展开，展现论证深度；
5. 保持交锋感，避免重复已说过的内容。`;

  const messages = [{ role: 'system', content: sysPrompt }];
  (history || []).forEach(m => {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'ai') messages.push({ role: 'assistant', content: m.content });
  });

  const useModel = model === 'reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';

  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: useModel, messages, temperature: 0.85, max_tokens: 800 })
    });
    if (!resp.ok) throw new Error('DeepSeek API ' + resp.status);
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '（AI 无可读回复）';
    res.json({ response: content, ai_side, model: useModel });
  } catch (e) {
    console.error('[DeepSeek] 调用失败:', e.message);
    const fb = templateResponse(topic, user_side);
    res.json({ ...fb, notice: '真实模型调用失败，已临时回退到模板模式' });
  }
});

// ===== Debate Format Presets =====
app.get('/api/debate-formats', (req, res) => {
  res.json({
    standard: {
      name: '标准赛制',
      description: '完整流程：立论→驳论→质询→自由辩论→总结，适合正式比赛',
      phases: [
        { name: '正方一辩立论', duration: 180, side: '正方', speaker: '一辩' },
        { name: '反方一辩立论', duration: 180, side: '反方', speaker: '一辩' },
        { name: '正方二辩驳论', duration: 120, side: '正方', speaker: '二辩' },
        { name: '反方二辩驳论', duration: 120, side: '反方', speaker: '二辩' },
        { name: '正方三辩质询', duration: 120, side: '正方', speaker: '三辩' },
        { name: '反方三辩质询', duration: 120, side: '反方', speaker: '三辩' },
        { name: '自由辩论（正方先）', duration: 240, side: '双方', speaker: '全员' },
        { name: '自由辩论（反方后）', duration: 240, side: '双方', speaker: '全员' },
        { name: '反方三辩总结', duration: 180, side: '反方', speaker: '三辩' },
        { name: '正方三辩总结', duration: 180, side: '正方', speaker: '三辩' },
      ]
    },
    classic: {
      name: '经典四辩赛制',
      description: '完整14环节：陈词→质询→对辩→质询小结→自由辩论→总结，每方4人',
      phases: [
        { name: '正方一辩开篇陈词', duration: 180, side: '正方', speaker: '一辩' },
        { name: '反方二辩质询正方一辩', duration: 120, side: '反方', speaker: '二辩' },
        { name: '反方一辩开篇陈词', duration: 180, side: '反方', speaker: '一辩' },
        { name: '正方二辩质询反方一辩', duration: 120, side: '正方', speaker: '二辩' },
        { name: '反方二辩质询小结', duration: 120, side: '反方', speaker: '二辩' },
        { name: '正方二辩质询小结', duration: 120, side: '正方', speaker: '二辩' },
        { name: '正方四辩对辩（正方先）', duration: 90, side: '正方', speaker: '四辩' },
        { name: '反方四辩对辩', duration: 90, side: '反方', speaker: '四辩' },
        { name: '正方三辩质询环节', duration: 120, side: '正方', speaker: '三辩' },
        { name: '反方三辩质询环节', duration: 120, side: '反方', speaker: '三辩' },
        { name: '正方三辩质询小结', duration: 120, side: '正方', speaker: '三辩' },
        { name: '反方三辩质询小结', duration: 120, side: '反方', speaker: '三辩' },
        { name: '正方自由辩论（正方先）', duration: 240, side: '正方', speaker: '全员' },
        { name: '反方自由辩论', duration: 240, side: '反方', speaker: '全员' },
        { name: '反方四辩总结陈词', duration: 210, side: '反方', speaker: '四辩' },
        { name: '正方四辩总结陈词', duration: 210, side: '正方', speaker: '四辩' },
      ]
    },
    quick: {
      name: '快速赛制',
      description: '精简流程：立论→自由辩论→总结，适合轻量快打',
      phases: [
        { name: '正方一辩立论', duration: 150, side: '正方', speaker: '一辩' },
        { name: '反方一辩立论', duration: 150, side: '反方', speaker: '一辩' },
        { name: '自由辩论', duration: 300, side: '双方', speaker: '全员' },
        { name: '反方二辩总结', duration: 120, side: '反方', speaker: '二辩' },
        { name: '正方二辩总结', duration: 120, side: '正方', speaker: '二辩' },
      ]
    },
    bp: {
      name: '英国议会制 (BP)',
      description: '国际通用赛制，多队同场竞技，适合高阶选手',
      phases: [
        { name: '首相（正方一队）', duration: 420, side: '正方', speaker: '首相' },
        { name: '反对党领袖（反方一队）', duration: 420, side: '反方', speaker: '领袖' },
        { name: '副首相（正方一队）', duration: 420, side: '正方', speaker: '副首相' },
        { name: '反对党副领袖（反方一队）', duration: 420, side: '反方', speaker: '副领袖' },
        { name: '正方二队成员', duration: 420, side: '正方', speaker: '二队' },
        { name: '反方二队成员', duration: 420, side: '反方', speaker: '二队' },
        { name: '正方二队总结', duration: 420, side: '正方', speaker: '二队' },
        { name: '反方二队总结', duration: 420, side: '反方', speaker: '二队' },
      ]
    },
    custom: {
      name: '自定义赛制',
      description: '自由设置各个环节和时间',
      phases: [
        { name: '正方立论', duration: 180, side: '正方', speaker: '' },
        { name: '反方立论', duration: 180, side: '反方', speaker: '' },
      ]
    }
  });
});

// Serve main page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 启动 =====
async function start() {
  if (USE_PG) {
    await initPg();
    console.log('🐘 使用 PostgreSQL 数据库（DATABASE_URL 已配置）');
  } else {
    console.log('📄 使用本地 JSON 文件存储（未配置 DATABASE_URL）');
  }
  app.listen(PORT, () => {
    console.log(`🏛️  随地大小辩·网络辩论赛 running at http://localhost:${PORT}`);
  });
}

start().catch(e => {
  console.error('❌ 启动失败:', e.message);
  process.exit(1);
});
