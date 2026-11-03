// 迷你 DOM：足够跑真实 app.js 的渲染流程（解析 innerHTML、querySelector、点击）
// 目的：在没有浏览器的环境里做真正的「渲染 + 交互」测试

const VOID = new Set(["br", "img", "input", "meta", "link", "hr", "source"]);

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return attrs;
}

function findTagEnd(html, start) {
  let i = start + 1, q = null;
  while (i < html.length) {
    const c = html[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
    i++;
  }
  return html.length;
}

export function parseHTML(html) {
  const root = new Node("#root");
  const stack = [root];
  let i = 0;
  const text = (t) => { if (t.trim()) stack[stack.length - 1].appendChild(new Node("#text", t)); };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { i = html.indexOf("-->", lt) + 3; continue; }
    const gt = findTagEnd(html, lt);
    const raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const attrs = sp < 0 ? {} : parseAttrs(body.slice(sp));
    const node = new Node(tag, null, attrs);
    stack[stack.length - 1].appendChild(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return root;
}

function matches(node, sel) {
  if (!node || node.tag === "#text") return false;
  sel = sel.trim();
  if (sel.startsWith("#")) return node.attrs.id === sel.slice(1);
  if (sel.startsWith(".")) return (node.attrs.class || "").split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("[")) {
    const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(sel);
    if (!m) return false;
    if (!(m[1] in node.attrs)) return false;
    return m[2] === undefined ? true : node.attrs[m[1]] === m[2];
  }
  return node.tag === sel.toLowerCase();
}

export class Node {
  constructor(tag, textContent = null, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.parent = null;
    this.style = {};
    this._text = textContent;
    this._on = {};
    this.value = attrs.value !== undefined ? attrs.value : "";
  }
  get tagName() { return this.tag.toUpperCase(); }
  get id() { return this.attrs.id || ""; }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  get dataset() {
    const d = {};
    for (const k of Object.keys(this.attrs)) {
      if (k.startsWith("data-")) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    }
    return d;
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  set innerHTML(html) {
    this.children.forEach((c) => (c.parent = null));
    this.children = [];
    this._text = null;
    parseHTML(html).children.forEach((c) => this.appendChild(c));
  }
  get innerHTML() { return this.children.map(serialize).join(""); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    return (this._text || "") + this.children.map((c) => c.textContent).join("");
  }
  set onclick(fn) { this._on.click = fn; }
  get onclick() { return this._on.click; }
  addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); }
  click() { if (this._on.click) this._on.click({ target: this }); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
}

function serialize(n) {
  if (n.tag === "#text") return n._text || "";
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  const inner = n._text ? n._text : n.children.map(serialize).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

export function createDocument(bodyHtml) {
  const root = new Node("#document");
  const html = parseHTML(bodyHtml);
  html.children.forEach((c) => root.appendChild(c));
  const el = root.querySelector("html") || root;
  const body = root.querySelector("body") || root;

  const doc = {
    readyState: "complete",
    documentElement: el,
    body,
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    createElement(tag) { return new Node(tag); },
    createTextNode(t) { return new Node("#text", String(t)); },
    getElementById(id) { return root.querySelector("#" + id); },
    querySelector(sel) { return root.querySelector(sel); },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
  };
  return { doc, root };
}
