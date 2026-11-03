/* 斗罗大陆 · 文字冒险 —— 零依赖前端
 * 设计要点：
 *  1. 所有游戏规则仍然在 SYSTEM_PROMPT 里（原样保留），前端只做解析与呈现
 *  2. 状态栏解析同时保留「宽松兜底」：半角冒号/漏字段都不会让数值静默丢失
 *  3. 存档仅存本机 localStorage，可导出/导入 JSON 迁移
 */
(function () {
  "use strict";

  var D = window.GAME_DATA || {};
  var LS_CFG = "dl_cfg_v1";
  var LS_SAVE = "dl_save_v1";
  var LS_SLOTS = "dl_slots_v1";
  var LS_THEME = "dl_theme_v1";
  var THEMES = [
    { id: "jin", name: "赤金" },
    { id: "mo", name: "墨" },
    { id: "ye", name: "夜" }
  ];

  function applyTheme(id) {
    var t = THEMES.some(function (x) { return x.id === id; }) ? id : "jin";
    S.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    store(LS_THEME, t);
  }
  function themeName(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0];
    return t ? t.name : id;
  }
  function themeBarHtml() {
    return '<div class="themebar">' + THEMES.map(function (t) {
      return '<button data-theme-id="' + t.id + '" aria-pressed="' + (S.theme === t.id) + '">' + t.name + "</button>";
    }).join("") + "</div>";
  }
  function wireTheme(scope) {
    (scope || document).querySelectorAll("[data-theme-id]").forEach(function (b) {
      b.onclick = function () {
        applyTheme(b.dataset.themeId);
        (scope || document).querySelectorAll("[data-theme-id]").forEach(function (o) {
          o.setAttribute("aria-pressed", o.dataset.themeId === S.theme);
        });
      };
    });
  }

  var S = {
    view: "boot",
    cfg: { key: "", base: "https://api.deepseek.com", model: "deepseek-chat" },
    char: null,
    status: {},
    npcs: {},
    entries: [],
    choices: [],
    loading: false,
    error: null,
    stream: "",
    theme: "jin",
    saveLoaded: false
  };

  /* ---------------- 工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function store(key, val) {
    try {
      if (val === undefined) { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(val));
      return val;
    } catch (e) { return null; }
  }
  function hueOf(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function avatarHtml(name) {
    if (!name) return "";
    var h = hueOf(name);
    var initial = name.slice(0, 1);
    var bg = "linear-gradient(135deg,hsl(" + h + " 65% 46%),hsl(" + ((h + 42) % 360) + " 70% 32%))";
    return '<span class="avatar" style="background:' + bg + '">' + esc(initial) + "</span>";
  }

  /* ---------------- 解析：状态栏 / 选项 ---------------- */
  // 宽松匹配：全角/半角冒号、中英混排的键名都吃
  var KV_RE = /^\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{1,14})\s*[:：]\s*(.+?)\s*$/;

  function parseKvBlock(block) {
    var out = {};
    block.split(/\r?\n/).forEach(function (line) {
      var m = KV_RE.exec(line);
      if (!m) return;
      var k = m[1].trim(), v = m[2].trim();
      if (!v) return;
      out[k] = v;
    });
    return out;
  }

  function parseRelation(str) {
    // "唐三好感+5，小舞好感-2" / "唐三 +5"
    var out = [];
    if (!str) return out;
    str.split(/[，,、;；]/).forEach(function (seg) {
      var m = /([^\s+\-0-9]+?)\s*好感度?\s*([+-]?\d+)/.exec(seg);
      if (m) { out.push({ name: m[1].trim(), delta: parseInt(m[2], 10) }); return; }
      var m2 = /([^\s+\-0-9]+?)\s*([+-]\d+)/.exec(seg);
      if (m2) out.push({ name: m2[1].trim(), delta: parseInt(m2[2], 10) });
    });
    return out;
  }

  // 返回 { body, status, options }
  function parseReply(raw) {
    var text = String(raw || "");
    var status = null;

    var idx = text.indexOf("[状态栏]");
    if (idx < 0) idx = text.indexOf("【状态栏】");
    if (idx >= 0) {
      var tail = text.slice(idx + 4);
      var optCut = tail.search(/\n\s*选项\s*[1１]\s*[:：]/);
      var block = optCut >= 0 ? tail.slice(0, optCut) : tail;
      var kv = parseKvBlock(block);
      if (Object.keys(kv).length) status = kv;
      text = text.slice(0, idx);
    }

    // 选项：允许 "选项1: xxx" / "选项 1：xxx" / "1. xxx"
    var options = [];
    var re = /选项\s*([1-4１-４])\s*[:：]\s*(.+)$/gm;
    var m;
    while ((m = re.exec(raw))) options.push(m[2].trim());
    if (!options.length) {
      re = /^\s*([1-4])\s*[.、)]\s*(.{6,})$/gm;
      while ((m = re.exec(raw))) options.push(m[2].trim());
      if (options.length < 2) options = [];
    }

    text = text.replace(/^\s*选项\s*[1-4１-４]\s*[:：].*$/gm, "");
    text = text.replace(/^\s*\[状态栏\][\s\S]*$/m, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return { body: text, status: status, options: options.slice(0, 4) };
  }

  /* ---------------- 状态合并 ---------------- */
  var STATUS_KEYS = {
    "年龄": "age", "魂力": "power", "魂力等级": "power", "武魂": "soul",
    "魂环": "rings", "当前时间": "time", "地点": "place", "当前位置": "place",
    "当前章节目标": "goal", "章节目标": "goal", "状态": "state",
    "关系变化": "relation", "获得魂骨": "bone", "婚恋状态": "romance"
  };

  function applyStatus(kv) {
    if (!kv) return {};
    var applied = {};
    Object.keys(kv).forEach(function (k) {
      var key = STATUS_KEYS[k] || (/^获得第.?魂技$/.test(k) ? "skill" : null);
      if (!key) { S.status[k] = kv[k]; return; }
      S.status[key] = kv[k];
      applied[key] = kv[k];
    });

    if (S.status.power) {
      var n = parseInt(String(S.status.power).replace(/[^\d]/g, ""), 10);
      if (!isNaN(n)) { S.char.power = n; applied.power = n; }
    }
    if (S.status.age) {
      var a = parseInt(String(S.status.age).replace(/[^\d]/g, ""), 10);
      if (!isNaN(a)) { S.char.age = a; }
    }
    if (S.status.rings) {
      var rings = [];
      var chars = String(S.status.rings).match(/[白黄紫黑红金]/g) || [];
      chars.forEach(function (c) { rings.push(c); });
      if (rings.length) { S.char.rings = rings; }
    }
    if (S.status.relation) {
      parseRelation(S.status.relation).forEach(function (r) {
        var name = normalizeNpc(r.name);
        if (!name) return;
        var cur = S.npcs[name] || { fav: 0 };
        cur.fav = clamp(cur.fav + r.delta, -100, 100);
        S.npcs[name] = cur;
      });
    }
    if (S.status.state && /死亡|身死|陨落/.test(S.status.state)) S.char.dead = true;
    return applied;
  }

  function normalizeNpc(name) {
    if (!name) return "";
    var map = D.NPC_ALIAS_MAP || {};
    var n = String(name).replace(/好感.*$/, "").trim();
    return map[n] || n;
  }

  /* ---------------- 提示词 ---------------- */
  function eraName(id) {
    var e = (D.ERA_LIST || []).filter(function (x) { return x.id === id; })[0];
    return e ? e.name : id;
  }

  function buildSystem() {
    var c = S.char || {};
    var base = D.SYSTEM_PROMPT || "";
    var lines = [];
    lines.push("【当前玩家状态·本轮提醒】");
    lines.push("- 时代：" + eraName(c.era));
    lines.push("- 姓名：" + c.name + "（" + (c.sex === "female" ? "女" : "男") + "，" + c.age + "岁）");
    lines.push("- 武魂：" + c.soul.name + "（" + c.soul.type + "）");
    lines.push("- 魂力：" + c.power + "级");
    lines.push("- 已有魂环：" + (c.rings.length ? c.rings.join("") : "无"));
    if (S.status.place) lines.push("- 当前地点：" + S.status.place);
    if (S.status.time) lines.push("- 当前时间：" + S.status.time);
    if (S.status.goal) lines.push("- 当前章节目标：" + S.status.goal);
    var nextRing = (c.rings.length + 1) * 10;
    if (c.power < nextRing) {
      lines.push("- ⚠️ 距离下一个魂环需要 " + nextRing + " 级，当前等级不足，绝不能让玩家吸收第 " + (c.rings.length + 1) + " 魂环。");
    } else {
      lines.push("- 玩家已可吸收第 " + (c.rings.length + 1) + " 魂环。");
    }
    if (Object.keys(S.npcs).length) {
      lines.push("- 已有关系：" + Object.keys(S.npcs).map(function (n) {
        return n + "(" + S.npcs[n].fav + ")";
      }).join("、"));
    }
    lines.push("");
    lines.push("【输出格式强制要求】每轮回复正文之后，必须输出完整的状态栏：");
    lines.push("[状态栏]");
    lines.push("年龄：X岁");
    lines.push("魂力：X级");
    lines.push("武魂：XXX");
    lines.push("魂环：X色X色");
    lines.push("当前时间：X年X月");
    lines.push("当前章节目标：XXX");
    lines.push("状态：存活");
    lines.push("关系变化：XXX好感+X");
    return base + "\n\n" + lines.join("\n");
  }

  function openingPrompt() {
    var c = S.char;
    return [
      "【角色创建完成】",
      "姓名：" + c.name,
      "性别：" + (c.sex === "female" ? "女" : "男"),
      "年龄：6岁",
      "时代：" + eraName(c.era),
      "武魂：" + c.soul.name + "（" + c.soul.type + "，" + (c.soul.rarity || "common") + "）",
      "先天魂力：" + c.power + "级",
      "出身：" + c.origin,
      "",
      "请开启第一章：",
      "1. 以第二人称描写开场场景，第一段交代地点、时间、在场人物；",
      "2. 给出 3-4 个具体选项，格式严格为「选项1: ……」，每个必须具体到做什么、去哪里、找谁；",
      "3. 结尾输出[状态栏]，字段齐全；",
      "4. 本章目标要贴合该时代原著的首个重要事件。"
    ].join("\n");
  }

  /* ---------------- API ---------------- */
  function apiUrl() {
    return (S.cfg.base || "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions";
  }

  function historyMessages() {
    return S.entries
      .filter(function (e) { return e.role === "user" || e.role === "assistant"; })
      .map(function (e) { return { role: e.role, content: e.raw || e.text }; });
  }

  function trimHistory(msgs) {
    var MAX = 24;
    if (msgs.length <= MAX) return msgs;
    var head = msgs.slice(0, 2);          // 保留开局，维持身份连续性
    var tail = msgs.slice(msgs.length - (MAX - 2));
    return head.concat([{ role: "user", content: "（前情提要已略，请依据当前状态继续推进剧情。）" }], tail);
  }

  function chat(onDelta) {
    var msgs = [{ role: "system", content: buildSystem() }].concat(trimHistory(historyMessages()));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 90000);

    return fetch(apiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + S.cfg.key
      },
      body: JSON.stringify({
        model: S.cfg.model || "deepseek-chat",
        messages: msgs,
        stream: true,
        temperature: 0.9,
        max_tokens: 1600
      }),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("API " + res.status + "：" + t.slice(0, 200));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "";
      var full = "";

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { clearTimeout(timer); return full; }
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split("\n\n");
          buf = parts.pop();
          parts.forEach(function (chunk) {
            chunk.split("\n").forEach(function (line) {
              if (line.indexOf("data:") !== 0) return;
              var data = line.slice(5).trim();
              if (!data || data === "[DONE]") return;
              try {
                var json = JSON.parse(data);
                var d = json.choices && json.choices[0] && json.choices[0].delta;
                if (d && d.content) { full += d.content; onDelta(full); }
              } catch (e) {}
            });
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("请求超时（90秒）。可能是网络慢，或 API 地址不正确。");
      throw e;
    });
  }

  /* ---------------- 渲染 ---------------- */
  var root;

  function render() {
    root = $("#app");
    if (S.view === "boot") { root.innerHTML = '<div class="boot">正在唤醒魂力……</div>'; return; }
    if (S.view === "setup") return renderSetup();
    if (S.view === "create") return renderCreate();
    if (S.view === "game") return renderGame();
  }

  function renderSetup() {
    root.innerHTML =
      '<div class="screen center">' +
        '<div class="brand">' +
          '<div class="kicker">斗 罗 大 陆</div>' +
          '<h1>魂力接续</h1>' +
          '<p>填写一次即可，之后存在本机</p>' +
        '</div>' +
        '<div class="card">' +
          '<div class="field"><label>API Key</label>' +
            '<input id="key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">' +
          '</div>' +
          '<div class="field"><label>接口地址</label>' +
            '<input id="base" type="text" value="' + esc(S.cfg.base) + '" spellcheck="false">' +
          '</div>' +
          '<div class="field"><label>模型</label>' +
            '<input id="model" type="text" value="' + esc(S.cfg.model) + '" spellcheck="false">' +
          '</div>' +
          '<div class="field"><label>界面主题</label>' + themeBarHtml() + "</div>" +
          '<div class="hint" style="margin-bottom:16px">Key 只保存在本机浏览器，不会上传到任何第三方。建议单独申请一个低额度 Key 专门用于此游戏。</div>' +
          '<div id="err" class="err" style="margin-bottom:12px"></div>' +
          '<button class="btn" id="go" style="width:100%">保存并继续</button>' +
        '</div>' +
      '</div>';

    $("#go").onclick = function () {
      var k = $("#key").value.trim();
      if (!k) { $("#err").textContent = "请填写 API Key"; return; }
      S.cfg = {
        key: k,
        base: $("#base").value.trim() || "https://api.deepseek.com",
        model: $("#model").value.trim() || "deepseek-chat"
      };
      store(LS_CFG, S.cfg);
      var saved = store(LS_SAVE);
      if (saved && saved.char) { restore(saved); S.view = "game"; render(); }
      else { S.view = "create"; render(); }
    };
    wireTheme(document);
  }

  function soulPool(era) { return (D.MARTIAL_SOULS_BY_ERA || {})[era] || []; }
  function rollSoul(era) {
    var pool = soulPool(era);
    if (!pool.length) return { name: "蓝银草", type: "器武魂", rarity: "common" };
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function rollPower() {
    if (Math.random() < 0.05) return 10;
    return 3 + Math.floor(Math.random() * 7);
  }
  var RARITY = { common: ["普通", "#94a3b8"], rare: ["稀有", "#60a5fa"], epic: ["极品", "#a855f7"], top: ["顶级", "#fb923c"], god: ["神级", "#facc15"] };

  var draft = null;

  function renderCreate() {
    if (!draft) {
      draft = {
        era: "douluo1", name: "", sex: "male",
        soul: rollSoul("douluo1"), power: rollPower(), origin: "平民"
      };
    }
    var eras = (D.ERA_LIST || []).map(function (e) {
      return '<button class="era" data-era="' + e.id + '" aria-pressed="' + (draft.era === e.id) + '">' +
        '<div class="t">' + esc(e.name) + '</div><div class="s">' + esc(e.subtitle || "") + "</div></button>";
    }).join("");
    var bgs = (D.BACKGROUNDS || []).map(function (b) {
      return '<button class="era" data-bg="' + esc(b.name) + '" aria-pressed="' + (draft.origin === b.name) + '">' +
        '<div class="t">' + esc(b.name) + "</div><div class=\"s\">" + esc(b.bonus || b.desc || "") + "</div></button>";
    }).join("");
    var r = RARITY[draft.soul.rarity] || RARITY.common;

    root.innerHTML =
      '<div class="screen">' +
        '<div class="brand" style="margin-bottom:22px"><h1 style="font-size:22px">武魂觉醒</h1>' +
          '<p>选择时代，然后让命运决定你的武魂</p></div>' +
        '<div class="field"><label>时代</label><div class="eras">' + eras + "</div></div>" +
        '<div class="field"><label>姓名</label><input id="name" maxlength="12" placeholder="输入你的名字" value="' + esc(draft.name) + '"></div>' +
        '<div class="field"><label>性别</label><div class="seg" id="sex">' +
          '<button data-sex="male" aria-pressed="' + (draft.sex === "male") + '">男</button>' +
          '<button data-sex="female" aria-pressed="' + (draft.sex === "female") + '">女</button>' +
        "</div></div>" +
        '<div class="field"><label>武魂</label>' +
          '<div class="soulbox">' +
            '<div style="flex:1"><div class="name">' + esc(draft.soul.name) +
              '<span class="rarity" style="color:' + r[1] + ";border-color:" + r[1] + '">' + r[0] + "</span></div>" +
              '<div class="meta">' + esc(draft.soul.type || "") + "　先天魂力 " + draft.power + " 级</div></div>" +
            '<button class="roll" id="roll">重抽</button>' +
          "</div></div>" +
        '<div class="field"><label>出身</label><div class="eras">' + bgs + "</div></div>" +
        '<div id="err" class="err" style="margin:8px 0 14px"></div>' +
        '<button class="btn" id="start" style="width:100%">开始这一世</button>' +
      "</div>";

    root.querySelectorAll("[data-era]").forEach(function (b) {
      b.onclick = function () {
        draft.era = b.dataset.era;
        draft.soul = rollSoul(draft.era);
        draft.power = rollPower();
        render();
      };
    });
    root.querySelectorAll("[data-bg]").forEach(function (b) {
      b.onclick = function () { draft.origin = b.dataset.bg; render(); };
    });
    root.querySelectorAll("[data-sex]").forEach(function (b) {
      b.onclick = function () { draft.sex = b.dataset.sex; render(); };
    });
    $("#roll").onclick = function () {
      draft.soul = rollSoul(draft.era);
      draft.power = rollPower();
      render();
    };
    $("#start").onclick = function () {
      var n = $("#name").value.trim();
      if (!n) { $("#err").textContent = "先给自己取个名字。"; return; }
      draft.name = n;
      S.char = {
        name: n, sex: draft.sex, age: 6, era: draft.era,
        soul: draft.soul, power: draft.power, origin: draft.origin,
        rings: [], dead: false
      };
      S.status = {};
      S.npcs = {};
      S.entries = [{ role: "user", text: "（开始）", raw: openingPrompt(), hidden: true }];
      S.choices = [];
      S.view = "game";
      saveGame();
      render();
      ask();
    };
  }

  function renderGame() {
    var c = S.char;
    var nextRing = (c.rings.length + 1) * 10;
    var pct = clamp((c.power % 10) / 10 * 100, 0, 100);

    root.innerHTML =
      '<div class="topbar">' +
        '<div class="ch"><div class="t" id="chTitle">' + esc(S.status.goal || "第一章") + "</div>" +
          '<div class="s" id="chTime">' + esc(S.status.time || eraName(c.era)) + "　·　" + esc(c.name) + "</div></div>" +
        '<button class="iconbtn" id="btnUndo" title="退回上一步">↺</button>' +
        '<button class="iconbtn" id="btnStatus">状态</button>' +
        '<button class="iconbtn" id="btnTheme">◐</button>' +
        '<button class="iconbtn" id="btnSave">存档</button>' +
      "</div>" +
      '<div class="desk"><div class="maincol">' +
        '<div class="story" id="story"></div>' +
        '<div class="choices" id="choices"></div>' +
      "</div>" +
      '<div class="side" id="side"></div></div>';

    renderSide();
    renderStory();
    renderChoices();

    $("#btnStatus").onclick = function () { openSheet("status"); };
    $("#btnUndo").onclick = rewind;
    $("#btnTheme").onclick = function () {
      var ids = THEMES.map(function (t) { return t.id; });
      var next = ids[(ids.indexOf(S.theme) + 1) % ids.length];
      applyTheme(next);
      toast("主题：" + themeName(next));
    };
    $("#btnSave").onclick = function () { openSheet("save"); };
  }

  function renderSide() {
    var side = $("#side");
    if (!side) return;
    var c = S.char;
    var ringHtml = c.rings.length
      ? c.rings.map(function (r) {
          var map = { 白: "--r1", 黄: "--r2", 紫: "--r3", 黑: "--r4", 红: "--r5", 金: "--r6" };
          return '<span class="ring" style="background:var(' + (map[r] || "--r1") + ')"></span>';
        }).join("")
      : '<span class="hint">无</span>';

    var rels = Object.keys(S.npcs).sort(function (a, b) { return S.npcs[b].fav - S.npcs[a].fav; }).slice(0, 8);
    var relHtml = rels.length ? rels.map(function (n) {
      return '<div class="rel">' + avatarHtml(n) +
        '<span class="nm">' + esc(n) + '</span>' +
        '<span class="val">' + S.npcs[n].fav + "</span></div>";
    }).join("") : '<div class="hint">还没有结识任何人。</div>';

    side.innerHTML =
      '<div class="sheet">' +
        '<h3>状态</h3>' +
        '<div class="kv"><span class="k">姓名</span><span class="v">' + esc(c.name) + "</span></div>" +
        '<div class="kv"><span class="k">年龄</span><span class="v">' + c.age + " 岁</span></div>" +
        '<div class="kv"><span class="k">武魂</span><span class="v">' + esc(c.soul.name) + "（" + esc(c.soul.type) + "）</span></div>" +
        '<div class="kv"><span class="k">魂力</span><span class="v">' + c.power + " 级" +
          '<div class="bar"><i style="width:' + pct + '%"></i></div></span></div>' +
        '<div class="kv"><span class="k">魂环</span><span class="v"><span class="rings">' + ringHtml + "</span></span></div>" +
        '<div class="kv"><span class="k">地点</span><span class="v">' + esc(S.status.place || "—") + "</span></div>" +
        '<div class="kv"><span class="k">目标</span><span class="v">' + esc(S.status.goal || "—") + "</span></div>" +
        '<div style="margin-top:18px"><div class="hint" style="margin-bottom:8px">关系</div>' + relHtml + "</div>" +
      "</div>";
  }

  function renderStory() {
    var box = $("#story");
    if (!box) return;
    box.innerHTML = S.entries.filter(function (e) { return !e.hidden; }).map(entryHtml).join("") + streamHtml();
    box.scrollTop = box.scrollHeight;
  }

  function entryHtml(e) {
    if (e.role === "user") return '<div class="entry player"><span>' + esc(e.text) + "</span></div>";
    if (e.role === "system") return '<div class="entry sys">' + esc(e.text) + "</div>";
    var paras = String(e.text || "").split(/\n+/).filter(Boolean).map(function (p) {
      var dlg = /^[「“"]/.test(p.trim());
      return '<p class="' + (dlg ? "dlg" : "") + '">' + esc(p) + "</p>";
    }).join("");
    return '<div class="entry narr">' + paras + "</div>";
  }

  function streamHtml() {
    if (!S.loading) return "";
    if (!S.stream) return '<div class="loader"><span class="dots"><i></i><i></i><i></i></span>魂力凝聚中…</div>';
    var body = parseReply(S.stream).body;
    return '<div class="entry narr">' + String(body).split(/\n+/).filter(Boolean).map(function (p) {
      return "<p>" + esc(p) + "</p>";
    }).join("") + "</div>";
  }

  function renderChoices() {
    var box = $("#choices");
    if (!box) return;
    if (S.loading) { box.innerHTML = ""; return; }

    if (S.error) {
      box.innerHTML =
        '<div class="errbox">' + esc(S.error) + "</div>" +
        '<button class="choice" id="retry"><span class="n">›</span>重试这一步</button>' +
        '<button class="choice" id="skip"><span class="n">›</span>跳过这条报错，继续</button>';
      $("#retry").onclick = retryStep;
      $("#skip").onclick = function () {
        S.error = null; S.choices = ["继续"];
        renderStory(); renderChoices();
      };
      return;
    }

    if (S.char && S.char.dead) {
      box.innerHTML =
        '<button class="choice" id="rollback"><span class="n">↺</span>回到死亡之前</button>' +
        '<button class="choice" id="again"><span class="n">✦</span>这一世结束了 · 重新开始</button>';
      $("#rollback").onclick = rewind;
      $("#again").onclick = function () {
        store(LS_SAVE, null); S.char = null; draft = null; S.view = "create"; render();
      };
      return;
    }
    if (!S.choices.length) {
      box.innerHTML = '<button class="choice" id="cont"><span class="n">›</span>继续</button>';
      $("#cont").onclick = function () { ask(); };
      return;
    }
    box.innerHTML = S.choices.map(function (t, i) {
      return '<button class="choice" data-i="' + i + '"><span class="n">' + (i + 1) + "</span>" + esc(t) + "</button>";
    }).join("");
    box.querySelectorAll("[data-i]").forEach(function (b) {
      b.onclick = function () {
        var t = S.choices[parseInt(b.dataset.i, 10)];
        S.choices = [];
        S.entries.push({ role: "user", text: t, raw: "玩家选择：" + t });
        renderStory(); renderChoices(); saveGame();
        ask();
      };
    });
  }

  /* ---------------- 请求流程 ---------------- */
  function ask() {
    if (S.loading) return;
    S.loading = true; S.stream = ""; S.error = null;
    // 存档点：失败或结果不满意时，可以退回这一步之前
    S.undo = JSON.parse(JSON.stringify({
      entries: S.entries, choices: S.choices, status: S.status, npcs: S.npcs, char: S.char
    }));
    renderStory(); renderChoices();

    chat(function (full) {
      S.stream = full;
      renderStory();
    }).then(function (full) {
      S.loading = false; S.stream = "";
      var parsed = parseReply(full);
      S.entries.push({ role: "assistant", text: parsed.body, raw: full, meta: parsed.status ? true : false });
      if (parsed.status) applyStatus(parsed.status);
      S.choices = parsed.options;
      if (!S.choices.length) S.choices = ["继续"];
      saveGame();
      renderStory(); renderChoices(); renderSide(); updateTop();
    }).catch(function (e) {
      S.loading = false; S.stream = "";
      S.error = (e && e.message) || String(e);
      renderStory(); renderChoices();
    });
  }

  // 退回上一个存档点（丢弃这一段回复与它带来的所有数值变化）
  function rewind() {
    if (S.loading) return;
    if (!S.undo) { toast("没有可退回的步骤"); return; }
    var u = JSON.parse(JSON.stringify(S.undo));
    S.entries = u.entries; S.choices = u.choices;
    S.status = u.status; S.npcs = u.npcs; S.char = u.char;
    S.error = null; S.stream = "";
    renderStory(); renderChoices(); renderSide(); updateTop();
    toast("已退回上一步");
  }

  function retryStep() {
    S.error = null;
    renderStory(); renderChoices();
    ask();
  }

  function updateTop() {
    var t = $("#chTitle"), tm = $("#chTime");
    if (t) t.textContent = S.status.goal || "第一章";
    if (tm) tm.textContent = (S.status.time || eraName(S.char.era)) + "　·　" + S.char.name;
  }

  function toast(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom,0px));" +
      "background:#3b1f2b;border:1px solid #7f1d1d;color:#fecaca;padding:10px 16px;border-radius:10px;" +
      "font-size:13px;z-index:60;max-width:86vw;text-align:center;line-height:1.5";
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 4200);
  }

  /* ---------------- 弹层 ---------------- */
  function openSheet(kind) {
    closeSheet();
    var mask = document.createElement("div");
    mask.className = "sheet-mask";
    mask.onclick = closeSheet;
    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = '<div class="grab"></div>';

    if (kind === "status") {
      var side = $("#side");
      sheet.innerHTML += side ? side.innerHTML : "";
    } else {
      sheet.innerHTML +=
        "<h3>存档</h3>" +
        '<div class="field"><label>界面主题</label>' + themeBarHtml() + "</div>" +
        '<div class="hint" style="margin-bottom:14px">进度自动保存在本机。换设备时可导出文本，在另一台导入。</div>' +
        '<button class="btn" id="exp" style="width:100%;margin-bottom:9px">导出进度</button>' +
        '<button class="btn ghost" id="imp" style="width:100%;margin-bottom:9px">导入进度</button>' +
        '<button class="btn ghost" id="reset" style="width:100%;color:#fca5a5;border-color:#7f1d1d">删档重开</button>';
    }

    document.body.appendChild(mask);
    document.body.appendChild(sheet);
    wireTheme(sheet);

    if (kind === "save") {
      $("#exp").onclick = function () {
        var txt = JSON.stringify(snapshot());
        sheet.innerHTML = '<div class="grab"></div><h3>复制下面这段</h3>' +
          '<textarea id="impBox" rows="8" style="font-size:12px">' + esc(txt) + "</textarea>" +
          '<div class="hint" style="margin-top:8px">全选复制，保存到备忘录或发给自己。</div>';
        $("#impBox").select && $("#impBox").select();
      };
      $("#imp").onclick = function () {
        sheet.innerHTML = '<div class="grab"></div><h3>粘贴进度文本</h3>' +
          '<textarea id="impBox" rows="8" placeholder="粘贴之前导出的内容"></textarea>' +
          '<button class="btn" id="doImp" style="width:100%;margin-top:12px">导入</button>';
        $("#doImp").onclick = function () {
          try {
            var obj = JSON.parse($("#impBox").value.trim());
            if (!obj || !obj.char) throw new Error("格式不正确");
            restore(obj); saveGame(); closeSheet(); render();
            toast("已导入");
          } catch (e) { toast("导入失败：" + e.message); }
        };
      };
      $("#reset").onclick = function () {
        if (!confirm("确定清空当前进度？")) return;
        store(LS_SAVE, null);
        S.char = null; S.entries = []; S.choices = []; S.status = {}; S.npcs = {};
        draft = null; closeSheet(); S.view = "create"; render();
      };
    }
  }
  function closeSheet() {
    var m = $(".sheet-mask"), s = $(".sheet");
    if (m) m.remove();
    if (s && s.parentNode === document.body) s.remove();
  }

  /* ---------------- 存读档 ---------------- */
  function snapshot() {
    return {
      v: 1, char: S.char, status: S.status, npcs: S.npcs,
      entries: S.entries, choices: S.choices, ts: Date.now()
    };
  }
  function saveGame() {
    if (!S.char) return;
    var snap = snapshot();
    store(LS_SAVE, snap);
    // 同时留一份最近存档，便于回滚被写坏的状态
    var slots = store(LS_SLOTS) || [];
    if (!slots.length || Date.now() - slots[0].ts > 60000) {
      slots.unshift(snap);
      store(LS_SLOTS, slots.slice(0, 3));
    }
  }
  function restore(snap) {
    S.char = snap.char;
    S.status = snap.status || {};
    S.npcs = snap.npcs || {};
    S.entries = snap.entries || [];
    S.choices = snap.choices || [];
    S.loading = false;
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    applyTheme(store(LS_THEME) || "jin");
    var cfg = store(LS_CFG);
    if (cfg && cfg.key) S.cfg = cfg;
    var saved = store(LS_SAVE);

    render();
    if (!cfg || !cfg.key) { S.view = "setup"; render(); return; }
    if (saved && saved.char) { restore(saved); S.view = "game"; render(); }
    else { S.view = "create"; render(); }
  }

  // 测试钩子（生产环境无副作用）
  window.__DL_TEST__ = {
    parseReply: parseReply, parseKvBlock: parseKvBlock, parseRelation: parseRelation,
    buildSystem: buildSystem, applyStatus: applyStatus, snapshot: snapshot, restore: restore,
    chat: chat, normalizeNpc: normalizeNpc,
    state: S, setChar: function (c) { S.char = c; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
