// timer.html のスクリプトを、画面（DOM）を模擬した環境で動かす自己テスト：node tools/timer-selftest.js
// Enterキー（開始／一時停止、メニューの中での決定）と、追加したボタンのつなぎを確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "timer.html"), "utf-8");
const script = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];

class FakeEl {
  constructor(id) {
    this.id = id; this._text = ""; this.innerHTML = ""; this.className = ""; this.value = ""; this.disabled = false; this.checked = false; this.type = ""; this.tagName = "DIV";
    this.listeners = {}; this.childNodes = []; this.dataset = {}; this.clicks = 0;
    this.style = new Proxy({ setProperty() {}, removeProperty() {} }, { get: (t, p) => (p in t ? t[p] : ""), set: (t, p, v) => { t[p] = v; return true; } });
    this.classList = { add: (c) => { if (!this.className.split(" ").includes(c)) this.className = (this.className + " " + c).trim(); }, remove: (c) => { this.className = this.className.split(" ").filter((x) => x && x !== c).join(" "); }, toggle: (c, f) => { const has = this.className.split(" ").includes(c); if (f === undefined ? !has : f) this.classList.add(c); else this.classList.remove(c); }, contains: (c) => this.className.split(" ").includes(c) };
    return new Proxy(this, { get: (t, p) => (p in t || typeof p === "symbol" ? t[p] : (() => undefined)), set: (t, p, v) => { t[p] = v; return true; } });
  }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  get children() { return this.childNodes; } get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { this.childNodes.push(c); return c; } append(...c) { this.childNodes.push(...c); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } removeEventListener() {}
  setAttribute() {} getAttribute() { return null; } removeAttribute() {} querySelector() { return new FakeEl("q"); } querySelectorAll() { return []; }
  closest() { return this; } focus() {} blur() { this.blurred = true; } select() {}
  click() { this.clicks++; (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {}, stopPropagation() {} })); }
  getBoundingClientRect() { return { width: 300, height: 400, top: 0, left: 0 }; }
  get offsetWidth() { return 300; } get offsetHeight() { return 400; } remove() {} scrollIntoView() {}
}
const els = {};
const getEl = (id) => els[id] || (els[id] = new FakeEl(id));
const docListeners = [];
const store = new Map();
const calls = [];
const ctx = {
  console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  document: { getElementById: getEl, createElement: (t) => new FakeEl(t), querySelector: () => new FakeEl("q"), querySelectorAll: () => [], body: new FakeEl("body"), documentElement: new FakeEl("html"), activeElement: null, hidden: false,
    addEventListener: (t, f, cap) => docListeners.push({ t, f, cap }), removeEventListener() {} },
  window: null, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  AudioContext: undefined, webkitAudioContext: undefined, Notification: undefined,
  requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ getPropertyValue: () => "" }),
  performance: { now: () => Date.now() }, Intl, JSON, Math, Date, Number, String, Array, Object, parseInt, parseFloat, isNaN, Promise, RegExp, Error, Set, Map,
};
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
ctx.timerApi = new Proxy({}, { get: (t, p) => (...a) => { calls.push([String(p), ...a]); return undefined; } });
vm.createContext(ctx);

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }
const enter = (extra) => {
  const ev = { key: "Enter", isComposing: false, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...(extra || {}) };
  docListeners.filter((l) => l.t === "keydown").forEach((l) => l.f(ev));
  return ev;
};
let err = null;
try { vm.runInContext(script, ctx); } catch (e) { err = e; }
ok(!err, "スクリプトがエラーなく読み込める" + (err ? "（" + err.message + "）" : ""));
if (err) { console.log(err.stack.split("\n").slice(0, 4).join("\n")); process.exit(1); }

console.log("[Enterキー]");
getEl("startBtn").clicks = 0;
ctx.document.activeElement = null;
let ev = enter();
ok(getEl("startBtn").clicks === 1 && ev.defaultPrevented, "タイマー画面：Enterで「開始／一時停止」");
ctx.document.activeElement = { tagName: "BUTTON", id: "resetBtn" };
getEl("startBtn").clicks = 0; getEl("resetBtn").clicks = 0;
enter();
ok(getEl("startBtn").clicks === 1 && getEl("resetBtn").clicks === 0, "どのボタンにフォーカスがあっても、Enterは開始／一時停止（停止ボタンは押されない）");
ctx.document.activeElement = null; getEl("startBtn").clicks = 0;
enter({ isComposing: true }); enter({ repeat: true }); enter({ ctrlKey: true }); enter({ shiftKey: true });
ok(getEl("startBtn").clicks === 0, "日本語入力の確定・押しっぱなし・修飾キー付きでは、動かない");

console.log("[メニューの中]");
getEl("menuOverlay").classList.add("show");
getEl("startBtn").clicks = 0; getEl("applyEditBtn").clicks = 0;
ctx.document.activeElement = { tagName: "INPUT", type: "number", id: "editM", blur() {} };
ev = enter();
ok(getEl("applyEditBtn").clicks === 1 && getEl("startBtn").clicks === 0 && ev.defaultPrevented, "時間の入力欄でEnter：「この時間に変更」を押す（開始はしない）");
let blurred = false;
ctx.document.activeElement = { tagName: "INPUT", type: "text", id: "someName", blur() { blurred = true; } };
enter();
ok(blurred && getEl("startBtn").clicks === 0, "名前などの入力欄でEnter：入力を確定する（欄を離れる）");
ctx.document.activeElement = { tagName: "BUTTON", id: "x" };
ev = enter();
ok(!ev.defaultPrevented && getEl("startBtn").clicks === 0, "メニューの中のボタンは、標準のEnterで押せる（開始は動かない）");
getEl("menuOverlay").classList.remove("show");

console.log("[上書きの確認]");
getEl("overwriteOverlay").classList.add("show");
getEl("overwriteYes").clicks = 0; getEl("startBtn").clicks = 0;
ctx.document.activeElement = null;
enter();
ok(getEl("overwriteYes").clicks === 1 && getEl("startBtn").clicks === 0, "確認が出ているときの Enter は「上書きして開始」");

console.log("[追加したボタン]");
getEl("overwriteOverlay").classList.remove("show");
getEl("minBtn").click();
ok(calls.some((c) => c[0] === "minimize"), "最小化ボタンは、最小化の窓口につながる");
ok(!/quickAmount|quickUnit|adjustMinus|adjustPlus/.test(script), "±ボタン・クイック調整の単位の記述は残っていない");
ok(!/鳴ったら音でお知らせ|ロック（常に最前面）が既定/.test(html), "「ロックが既定でオン、鳴ったら音で…」の説明文は残っていない");
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
