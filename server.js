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
} catch (e) { /* 没有 .env 文件也没关系，走模板兜底 */ }

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
}));

// ===== Simple JSON File Database =====
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

let nextId = 1;
function genId(db) {
  return nextId++;
}

function getOwner(req) {
  const u = req.headers['x-user'];
  return u ? decodeURIComponent(u) : null;
}

// ===== Events API =====

app.get('/api/events', (req, res) => {
  const db = loadDb();
  const events = db.events.map(e => ({
    ...e,
    pro_count: db.registrations.filter(r => r.event_id === e.id && r.side === '正方').length,
    con_count: db.registrations.filter(r => r.event_id === e.id && r.side === '反方').length,
    watch_count: db.registrations.filter(r => r.event_id === e.id && r.side === '观战').length,
  }));
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(events);
});

app.get('/api/events/:id', (req, res) => {
  const db = loadDb();
  const event = db.events.find(e => e.id === parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const registrations = db.registrations.filter(r => r.event_id === event.id);
  res.json({
    ...event,
    pro_count: registrations.filter(r => r.side === '正方').length,
    con_count: registrations.filter(r => r.side === '反方').length,
    registrations: registrations.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
  });
});

app.post('/api/events', (req, res) => {
  const { topic, debate_time, format, max_per_side } = req.body;
  if (!topic || !debate_time) return res.status(400).json({ error: '辩题和时间不能为空' });

  const db = loadDb();
  const event = {
    id: genId(db),
    topic,
    debate_time,
    format: format || 'standard',
    max_per_side: max_per_side || 3,
    status: 'open',
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
  db.events.push(event);
  saveDb(db);
  res.json({ id: event.id, success: true });
});

app.post('/api/events/:id/register', (req, res) => {
  const { name, side, role } = req.body;
  if (!name || !side) return res.status(400).json({ error: '姓名和立场不能为空' });

  const db = loadDb();
  const event = db.events.find(e => e.id === parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'open') return res.status(400).json({ error: '该比赛已关闭报名' });

  if (db.registrations.find(r => r.event_id === event.id && r.name === name)) {
    return res.status(400).json({ error: '你已报名该比赛' });
  }

  if (side === '正方' || side === '反方') {
    const count = db.registrations.filter(r => r.event_id === event.id && r.side === side).length;
    if (count >= event.max_per_side) return res.status(400).json({ error: `${side}已满员` });
  }

  const reg = {
    id: genId(db),
    event_id: event.id,
    name,
    side,
    role: role || '辩手',
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
  db.registrations.push(reg);

  const proCount = db.registrations.filter(r => r.event_id === event.id && r.side === '正方').length;
  const conCount = db.registrations.filter(r => r.event_id === event.id && r.side === '反方').length;
  if (proCount >= event.max_per_side && conCount >= event.max_per_side) {
    event.status = 'ready';
  }

  saveDb(db);
  res.json({ success: true });
});

app.delete('/api/events/:id', (req, res) => {
  const db = loadDb();
  const eid = parseInt(req.params.id);
  db.registrations = db.registrations.filter(r => r.event_id !== eid);
  db.events = db.events.filter(e => e.id !== eid);
  saveDb(db);
  res.json({ success: true });
});

// ===== Topics API =====

app.get('/api/topics', (req, res) => {
  const db = loadDb();
  const topics = db.topics.sort((a, b) => b.votes - a.votes || new Date(b.created_at) - new Date(a.created_at));
  res.json(topics);
});

app.post('/api/topics', (req, res) => {
  const { title, pro_position, con_position, submitter } = req.body;
  if (!title || !pro_position || !con_position || !submitter) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  const db = loadDb();
  const topic = {
    id: genId(db),
    title,
    pro_position,
    con_position,
    submitter,
    votes: 0,
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
  db.topics.push(topic);
  saveDb(db);
  res.json({ id: topic.id, success: true });
});

app.post('/api/topics/:id/vote', (req, res) => {
  const { voter } = req.body;
  if (!voter) return res.status(400).json({ error: '请提供投票人名称' });

  const db = loadDb();
  const topic = db.topics.find(t => t.id === parseInt(req.params.id));
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const existing = db.topic_votes.find(v => v.topic_id === topic.id && v.voter === voter);
  if (existing) {
    db.topic_votes = db.topic_votes.filter(v => !(v.topic_id === topic.id && v.voter === voter));
    topic.votes = Math.max(0, topic.votes - 1);
    saveDb(db);
    res.json({ action: 'unvoted', votes: topic.votes });
  } else {
    db.topic_votes.push({ id: genId(db), topic_id: topic.id, voter, created_at: new Date().toISOString() });
    topic.votes += 1;
    saveDb(db);
    res.json({ action: 'voted', votes: topic.votes });
  }
});

app.delete('/api/topics/:id', (req, res) => {
  const db = loadDb();
  const tid = parseInt(req.params.id);
  db.topic_votes = db.topic_votes.filter(v => v.topic_id !== tid);
  db.topics = db.topics.filter(t => t.id !== tid);
  saveDb(db);
  res.json({ success: true });
});

// ===== Prep Notes API =====

app.get('/api/notes', (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const db = loadDb();
  let notes = db.notes.filter(n => n.owner === owner);
  if (req.query.topic) {
    notes = notes.filter(n => n.topic === req.query.topic);
  }
  notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const { event_id, topic, title, content, side, type } = req.body;
  if (!title) return res.status(400).json({ error: '请输入标题' });

  const db = loadDb();
  const note = {
    id: genId(db),
    owner,
    event_id: event_id || null,
    topic: topic || null,
    title,
    content: content || '',
    side: side || null,
    type: type || 'argument',
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    updated_at: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
  db.notes.push(note);
  saveDb(db);
  res.json({ id: note.id, success: true });
});

app.put('/api/notes/:id', (req, res) => {
  const owner = getOwner(req);
  const { title, content, side, type, topic } = req.body;
  const db = loadDb();
  const note = db.notes.find(n => n.id === parseInt(req.params.id));
  if (note && note.owner !== owner) return res.status(403).json({ error: '无权操作' });
  if (note) {
    note.title = title;
    note.content = content;
    note.side = side;
    note.type = type;
    if (topic !== undefined) note.topic = topic;
    note.updated_at = new Date().toLocaleString('zh-CN', { hour12: false });
    saveDb(db);
  }
  res.json({ success: true });
});

app.delete('/api/notes/:id', (req, res) => {
  const owner = getOwner(req);
  const db = loadDb();
  const note = db.notes.find(n => n.id === parseInt(req.params.id));
  if (note && note.owner !== owner) return res.status(403).json({ error: '无权操作' });
  db.notes = db.notes.filter(n => n.id !== parseInt(req.params.id));
  saveDb(db);
  res.json({ success: true });
});

// ===== AI Debate History (Private per user) =====
app.get('/api/ai-history', (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const db = loadDb();
  db.ai_history = db.ai_history || [];
  const h = db.ai_history.find(x => x.owner === owner);
  res.json(h ? { topic: h.topic, side: h.side, messages: h.messages } : { messages: [] });
});

app.post('/api/ai-history', (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const { topic, side, messages } = req.body;
  const db = loadDb();
  db.ai_history = db.ai_history || [];
  let h = db.ai_history.find(x => x.owner === owner);
  if (h) { h.topic = topic; h.side = side; h.messages = messages; }
  else db.ai_history.push({ owner, topic, side, messages });
  saveDb(db);
  res.json({ success: true });
});

app.delete('/api/ai-history', (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(401).json({ error: 'NEED_AUTH' });
  const db = loadDb();
  db.ai_history = db.ai_history || [];
  db.ai_history = db.ai_history.filter(x => x.owner !== owner);
  saveDb(db);
  res.json({ success: true });
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

// 模板兜底（未配置 API Key 或调用失败时）
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

// 是否配置了真实模型
app.get('/api/ai-status', (req, res) => {
  res.json({ configured: !!process.env.DEEPSEEK_API_KEY });
});

app.post('/api/ai-debate', async (req, res) => {
  const { topic, user_message, user_side, history = [], model = 'chat' } = req.body;
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // 未配置 Key：直接返回模板，避免报错
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

app.listen(PORT, () => {
  console.log(`🏛️  随地大小辩·网络辩论赛 running at http://localhost:${PORT}`);
});
