/* StudyTrail 原型 v0.1
 * 纯前端实现，数据保存在 localStorage。
 * 卡片生成使用基于规则的本地"AI"（关键词抽取 + 定义句识别），
 * 生产版将替换为 LLM API（见 README 的 Roadmap）。
 */

const STORE_KEY = "studytrail.v1";

const state = load() || {
  topics: {},   // topicName -> [cardIds]
  cards: {},    // id -> card
  reviews: 0,
};

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

/* ---------- 本地“AI”卡片生成 ---------- */

// 简易中文停用词表（原型版；生产版交给 LLM）
const STOPWORDS = new Set([
  ..."的了和是就都而及与著或一个我们你们他们它这那也又被把上下中大小之以为于其但不没很还再只有些什么样如何可以因为所以如果虽然然而因此指种用的于最通过".split(""),
  ..."the a an of to in and is are was for on with that this it as by be or".split(" "),
]);

// 常见定义/要点句式：命中即视为一个知识点候选
const DEF_PATTERNS = [
  /^(.{2,18})(?:是|是指|是指的|指的是|means|is)/,
  /^(?:所谓|什么是)(.{2,18})[?:：]?/,
];

function splitSentences(text) {
  return text.replace(/\r/g, "")
    .split(/(?<=[。！？!?\.；;\n])/)
    .map(s => s.trim())
    .filter(s => s.length > 6);
}

function extractKeywords(sentences) {
  const freq = {};
  for (const s of sentences) {
    // 中文按 2-4 字滑窗粗切分，英文按单词
    const tokens = s.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || [];
    for (const t of tokens) {
      const w = t.toLowerCase();
      if (!STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 2;
    }
    for (let n = 2; n <= 6; n++) {
      const cjk = new RegExp("^[\\u4e00-\\u9fa5]{" + n + "}$"); // {n} 需构造，字面量不插值
      for (let i = 0; i + n <= s.length; i++) {
        const w = s.slice(i, i + n);
        if (cjk.test(w) && !STOPWORDS.has(w)) {
          freq[w] = (freq[w] || 0) + 1;
        }
      }
    }
  }
  const ranked = Object.entries(freq)
    .filter(([w, c]) => c >= 3 && w.length >= 2 && !/[是指的了在把被和与及或最通过而让够需能够]/.test(w))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w);
  return ranked;
}

// 泛词不做考点：太宽泛，做成卡片没有复习价值
const GENERIC = new Set(["数据", "模型", "生成", "任务", "文本", "技术", "学习", "语言", "训练", "算子", "参数"]);

function longestKeyword(sentence, keywords) {
  let best = null;
  for (const k of keywords) {
    if (sentence.toLowerCase().includes(k.toLowerCase()) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

function topicOf(sentence, keywords, fallback) {
  // 优先取句中出现的最长关键词，避免泛词抢走主题
  return longestKeyword(sentence, keywords) || fallback;
}

function makeCard(front, back, topic, source) {
  const id = "c" + Date.now() + Math.random().toString(36).slice(2, 6);
  return {
    id, topic, front, back, source,
    // SM-2 lite 间隔重复字段
    ease: 2.5, interval: 0, reps: 0, streak: 0,
    due: Date.now(),          // 新卡立即到期
    status: "new",            // new | learning | mastered
  };
}

function generateCards(title, text, forcedTopic) {
  const sentences = splitSentences(text);
  const keywords = extractKeywords(sentences);
  const cards = [];
  for (const s of sentences) {
    let front = null, back = s;
    for (const p of DEF_PATTERNS) {
      const m = s.match(p);
      if (m && m[1] && !STOPWORDS.has(m[1])) { front = m[1].trim(); break; }
    }
    if (!front) {
      // 无定义句式：取句子中命中的最长关键词作为考点
      const kw = longestKeyword(s, keywords);
      if (!kw || GENERIC.has(kw)) continue;
      front = kw;
      // 挖空式问题
      back = s;
    }
    if (front.length < 2 || front.length > 18) continue;
    if (cards.some(c => c.front === front)) continue; // 同名考点去重
    const topic = forcedTopic || topicOf(s, keywords, title || "未分类");
    cards.push(makeCard(front, back, topic, title || "未分类"));
    if (cards.length >= 20) break; // 单份材料最多 20 张，防刷屏
  }
  return cards;
}

/* ---------- 状态操作 ---------- */

function addMaterial(title, text, forcedTopic) {
  const cards = generateCards(title, text, forcedTopic);
  for (const c of cards) {
    state.cards[c.id] = c;
    (state.topics[c.topic] = state.topics[c.topic] || []).push(c.id);
  }
  save();
  return cards;
}

function dueCards() {
  const now = Date.now();
  return Object.values(state.cards)
    .filter(c => c.due <= now && c.status !== "suspended")
    .sort((a, b) => a.due - b.due);
}

// SM-2 lite：grade 0=忘了 2=困难 4=想起 5=简单
function reviewCard(card, grade) {
  if (grade < 3) {
    card.interval = 0;           // 10 分钟后重来
    card.due = Date.now() + 10 * 60 * 1000;
    card.streak = 0;
    card.status = "learning";
    if (card.ease > 1.3) card.ease -= 0.2;
  } else {
    card.reps += 1;
    card.streak += 1;
    card.ease = Math.min(2.8, card.ease + (grade === 5 ? 0.1 : 0));
    card.interval = card.interval === 0 ? 1
      : card.interval === 1 ? 3 : Math.round(card.interval * card.ease);
    card.due = Date.now() + card.interval * 24 * 3600 * 1000;
    card.status = card.streak >= 2 ? "mastered" : "learning";
  }
  state.reviews += 1;
  save();
}

function deleteCard(id) {
  const c = state.cards[id];
  if (!c) return;
  state.topics[c.topic] = (state.topics[c.topic] || []).filter(x => x !== id);
  if (!state.topics[c.topic].length) delete state.topics[c.topic];
  delete state.cards[id];
  save();
}

/* ---------- 示例材料（演示用） ---------- */

const SAMPLE_TITLE = "AI 入门知识卡";
const SAMPLE_TEXT = `机器学习是指让计算机从数据中自动学习规律、而无需人工编写具体规则的技术。机器学习的核心思想是用数据代替规则。机器学习分为监督学习、无监督学习和强化学习三大类。
监督学习是指用带标签的数据训练模型的学习方式。监督学习最常用于分类和回归任务。无监督学习是指让模型在没有标签的数据中自己发现结构的学习方式。聚类是无监督学习最典型的应用。
神经网络是一种模拟人脑神经元连接方式的计算模型。神经网络由输入层、隐藏层和输出层组成。深度学习是指使用多层神经网络进行学习的方法。深度学习是机器学习的一个分支。深度学习需要大量数据和算力作为支撑。
大语言模型是指用海量文本训练出来的、能够理解和生成自然语言的模型。大语言模型通过预测下一个词来学习语言规律。上下文窗口是指大语言模型一次能读取的最大文本长度。Token 是大语言模型处理文本的基本单位，一个汉字通常是一到两个 token。
提示工程是指通过设计输入文本来引导大语言模型产生更好输出的技术。提示工程是最经济的模型优化手段。少样本提示是指在提示词中给出几个示例让模型模仿的技术。
检索增强生成是指先从外部知识库检索相关资料、再让模型基于资料回答问题的技术。检索增强生成能有效减少幻觉。幻觉是指大语言模型一本正经地编造错误事实的现象。幻觉是大语言模型落地最大的障碍之一。
微调是指在预训练模型基础上用特定数据继续训练的方法。微调适合让模型掌握特定领域的知识。智能体是指能够自主感知环境、制定计划并调用工具完成任务的 AI 系统。智能体的核心能力是任务分解与工具调用。MCP 是一种把 AI 模型连接到外部工具和数据的标准协议。
参数量是指模型中可学习权重的总数，通常用来衡量模型规模。训练是指用数据调整模型参数的过程。推理是指训练好的模型对输入生成输出的过程。过拟合是指模型把训练数据背得太死、遇到新数据表现变差的现象。
Embedding 是指把文本转换成向量以表示语义的技术。语义相近的文本在向量空间中距离更近。`;

/* ---------- UI 渲染 ---------- */

const $ = (s) => document.querySelector(s);

function switchTab(name) {
  document.querySelectorAll("nav button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.id === "tab-" + name));
  render();
}

function render() { renderMap(); renderReview(); renderStats(); }

const STATUS_TXT = { new: "待学习", learning: "学习中", mastered: "已掌握" };

function renderMap() {
  const box = $("#map-container");
  const topics = Object.keys(state.topics);
  if (!topics.length) {
    box.innerHTML = `<div class="topic-block"><p class="hint">地图还是空的。去「添加材料」粘贴第一份学习材料吧！</p></div>`;
    return;
  }
  box.innerHTML = topics.map(t => {
    const cards = state.topics[t].map(id => state.cards[id]).filter(Boolean);
    const mastered = cards.filter(c => c.status === "mastered").length;
    return `<div class="topic-block">
      <h4>📌 ${esc(t)}
        <span class="topic-meta">${cards.length} 张卡片 · 已掌握 ${mastered}</span></h4>
      ${cards.map(c => `<div class="kcard">
        <span class="status ${c.status}">${STATUS_TXT[c.status]}</span>
        <b>${esc(c.front)}</b> — ${esc(c.back.slice(0, 60))}${c.back.length > 60 ? "…" : ""}
      </div>`).join("")}
    </div>`;
  }).join("");
  // 主题下拉提示
  $("#topic-list").innerHTML = topics.map(t => `<option value="${esc(t)}">`).join("");
}

let currentCard = null;

function renderReview() {
  const due = dueCards();
  const badge = $("#review-badge");
  badge.textContent = due.length;
  badge.classList.toggle("hidden", !due.length);
  $("#review-empty").classList.toggle("hidden", !!due.length);
  $("#review-box").classList.toggle("hidden", !due.length);
  if (!due.length) return;
  currentCard = due[0];
  $("#quiz-topic").textContent = "主题：" + currentCard.topic;
  // 挖空式提问：把考点从答案句中挖掉，更接近真实测验
  const q = currentCard.back.includes(currentCard.front)
    ? currentCard.back.replaceAll(currentCard.front, "＿＿＿")
    : `请解释：${currentCard.front} 是什么？`;
  $("#quiz-question").textContent = q;
  $("#quiz-answer").textContent = currentCard.back;
  $("#quiz-answer").classList.add("hidden");
  $("#quiz-rating").classList.add("hidden");
  $("#btn-reveal").classList.remove("hidden");
  $("#review-progress").textContent = `今日待复习 ${due.length} 张 · 已累计复习 ${state.reviews} 次`;
}

function renderStats() {
  const cards = Object.values(state.cards);
  const mastered = cards.filter(c => c.status === "mastered").length;
  const learning = cards.filter(c => c.status === "learning").length;
  const topics = Object.keys(state.topics);
  $("#stats-grid").innerHTML = [
    [cards.length, "知识卡片总数"],
    [mastered, "已掌握"],
    [learning, "学习中"],
    [state.reviews, "累计复习次数"],
  ].map(([n, l]) => `<div class="stat"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");
  $("#topic-mastery").innerHTML = topics.length ? topics.map(t => {
    const cs = state.topics[t].map(id => state.cards[id]).filter(Boolean);
    const m = cs.filter(c => c.status === "mastered").length;
    const pct = cs.length ? Math.round(100 * m / cs.length) : 0;
    return `<div class="mastery-row">${esc(t)} — ${pct}%（${m}/${cs.length}）
      <div class="mastery-bar"><div class="mastery-fill" style="width:${pct}%"></div></div></div>`;
  }).join("") : `<p class="hint">暂无数据。</p>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* ---------- 事件绑定 ---------- */

document.querySelectorAll("nav button").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));

$("#btn-generate").addEventListener("click", () => {
  const title = $("#material-title").value.trim();
  const topic = $("#material-topic").value.trim();
  const text = $("#material-text").value.trim();
  const box = $("#add-result");
  if (text.length < 20) {
    box.className = "";
    box.innerHTML = `<div class="ok" style="background:#FDECEC">材料太短了，请粘贴至少 20 字的学习内容。</div>`;
    return;
  }
  const cards = addMaterial(title || "未命名材料", text, topic || null);
  box.className = "";
  box.innerHTML = `<div class="ok">✅ 已生成 ${cards.length} 张知识卡片` +
    (cards.length ? `，主题：${[...new Set(cards.map(c => c.topic))].map(esc).join("、")}` : "") +
    `。可在「知识地图」中查看，或到「今日复习」开始测验。</div>`;
  $("#material-text").value = "";
  render();
});

$("#btn-sample").addEventListener("click", () => {
  $("#material-title").value = SAMPLE_TITLE;
  $("#material-text").value = SAMPLE_TEXT;
  $("#material-topic").value = "";
  $("#add-result").className = "";
  $("#add-result").innerHTML = `<div class="ok">已载入示例材料（${SAMPLE_TEXT.length} 字），点击「生成知识卡片」即可看到效果。</div>`;
});

$("#btn-reveal").addEventListener("click", () => {
  $("#quiz-answer").classList.remove("hidden");
  $("#quiz-rating").classList.remove("hidden");
  $("#btn-reveal").classList.add("hidden");
});

document.querySelectorAll(".rate").forEach(b =>
  b.addEventListener("click", () => {
    if (!currentCard) return;
    reviewCard(currentCard, Number(b.dataset.grade));
    renderReview();
  }));

render();
