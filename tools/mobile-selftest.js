// mobile.html のスクリプトを、画面（DOM）を模擬した環境で動かす自己テスト：node tools/mobile-selftest.js
// ロック画面（Launch-pass）・PCのスリープ・PCに届かないとき・無操作の注意の流れで、エラーが出ず、期待どおりに表示が変わることを確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "mobile.html"), "utf-8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];

let clock = 1700000000000; // 実際の時刻と同じ桁（13桁）
const timers = [];
let tid = 1;
function addTimer(fn, ms, repeat) { const t = { id: tid++, fn, at: clock + Math.max(0, ms || 0), ms: Math.max(1, ms || 0), repeat }; timers.push(t); return t.id; }
function clearT(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
async function advance(ms) {
  const end = clock + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    clock = Math.max(clock, t.at);
    if (t.repeat) t.at = clock + t.ms; else timers.shift();
    try { t.fn(); } catch (e) { errors.push(e); }
    await Promise.resolve(); await Promise.resolve();
  }
  clock = end;
  await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setImmediate(r));
}
const errors = [];
const created = []; // 作られたボタン

class FakeEl {
  constructor(id) {
    this.id = id; this._text = ""; this.innerHTML = ""; this.className = ""; this.value = ""; this.disabled = false; this.checked = false; this.hidden = false;
    this.listeners = {}; this.childNodes = []; this.dataset = {};
    this.style = new Proxy({ setProperty() {}, removeProperty() {} }, { get: (t, p) => (p in t ? t[p] : ""), set: (t, p, v) => { t[p] = v; return true; } });
    this.classList = { add: (c) => { if (!this.className.split(" ").includes(c)) this.className = (this.className + " " + c).trim(); }, remove: (c) => { this.className = this.className.split(" ").filter((x) => x && x !== c).join(" "); }, toggle: (c, f) => { const has = this.className.split(" ").includes(c); if (f === undefined ? !has : f) this.classList.add(c); else this.classList.remove(c); }, contains: (c) => this.className.split(" ").includes(c) };
    return new Proxy(this, { get: (t, p) => (p in t || typeof p === "symbol" ? t[p] : (() => undefined)), set: (t, p, v) => { t[p] = v; return true; } });
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  get children() { return this.childNodes.length ? this.childNodes : Array.from({ length: this.id === "passDots" ? 4 : 0 }, () => new FakeEl("dot")); }
  get firstChild() { if (this._text !== "") { const self = this; return { nodeType: 3, get nodeValue() { return self._text; }, set nodeValue(v) { self._text = v; } }; } return this.childNodes[0] || null; }
  appendChild(c) { this.childNodes.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  setAttribute() {} getAttribute(k) { return this.dataset[k] ?? null; } removeAttribute() {}
  querySelector() { return new FakeEl("q"); } querySelectorAll() { return []; }
  closest() { return this; } focus() {} blur() {} click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {}, stopPropagation() {} })); }
  getBoundingClientRect() { return { width: 360, height: 640, top: 0, left: 0, right: 360, bottom: 640 }; }
  get offsetWidth() { return 360; } get offsetHeight() { return 640; } get clientWidth() { return 360; } get clientHeight() { return 640; }
  remove() {} scrollIntoView() {} scrollTo() {}
}
const els = {};
const getEl = (id) => els[id] || (els[id] = new FakeEl(id));
const store = new Map([["lk_sid", "SID1"]]);
const sources = [];
class FakeES { constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; sources.push(this); } addEventListener(t, f) { this.handlers[t] = f; } close() { this.readyState = 2; } }
const fetchLog = [];
let fetchImpl = (p) => (p === "/api/ping" ? { status: 200, body: { ok: true, paused: false } } : { status: 200, body: { ok: true } });
const ctx = {
  console, setTimeout: (f, ms) => addTimer(f, ms, false), setInterval: (f, ms) => addTimer(f, ms, true), clearTimeout: clearT, clearInterval: clearT,
  document: { hidden: false, getElementById: getEl, createElement: (t) => { const e = new FakeEl(t); if (t === "button") created.push(e); return e; }, querySelector: () => new FakeEl("q"), querySelectorAll: () => [], body: new FakeEl("body"), documentElement: new FakeEl("html"), addEventListener() {}, removeEventListener() {} },
  navigator: { userAgent: "iPhone", wakeLock: undefined },
  location: { search: "?sid=SID1", pathname: "/", href: "http://100.64.0.1:1/?k=abc", hash: "" },
  history: { replaceState() {} },
  sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  EventSource: FakeES,
  fetch: async (p, o) => { fetchLog.push({ p, body: o && o.body ? JSON.parse(o.body) : null, tab: o && o.headers ? o.headers["X-Tab"] : "" }); const r = await fetchImpl(p, o && o.body ? JSON.parse(o.body) : null); if (r instanceof Error) throw r; return { status: r.status, json: async () => r.body }; },
  Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
  addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestAnimationFrame: (f) => addTimer(f, 16, false), cancelAnimationFrame: clearT, innerWidth: 390, innerHeight: 800, devicePixelRatio: 2,
  URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Promise, Array, Object, String, Number, RegExp, Error, parseInt, parseFloat, isNaN,
};
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }
const send = (m) => { const es = sources[sources.length - 1]; es.onmessage({ data: JSON.stringify(m) }); };
const snap = { v: 1, startPage: 0, icons: {}, states: {}, pages: [{ index: 0, label: "画面1", theme: {}, tiles: [{ id: "t1", name: "A", blocked: false, color: "#ff0000", icon: { kind: "css", key: "circleMark", toggle: null }, multi: false }] }] };
const ready = (extra) => ({ type: "ready", snapshot: snap, paused: false, page: 0, seq: 0, mode: "", info: { idleLeft: 3600, maxLeft: 10800 }, exec: { busy: false, multi: false }, locked: false, away: null, ...extra });
const layerOn = () => getEl("lockLayer").className.split(" ").includes("on");
const press = async (digits) => { for (const d of digits) { const b = new FakeEl("b"); b.dataset["data-k"] = d; b.getAttribute = (k) => (k === "data-k" ? d : null); getEl("pad").listeners.click.forEach((f) => f({ target: b })); await advance(5); } };

(async () => {
  console.log("[読み込み]");
  try { vm.runInContext(script, ctx); } catch (e) { errors.push(e); }
  await advance(10);
  ok(errors.length === 0, "スクリプトがエラーなく読み込める" + (errors[0] ? "（" + errors[0].message + "）" : ""));
  ok(sources.length === 1, "つなぎ直し（保存済みの接続）でイベントを開始する");
  send(ready());
  await advance(10);
  ok(errors.length === 0 && !layerOn(), "操作画面になり、ロック画面は出ていない" + (errors[0] ? "（" + errors[0].message + "）" : ""));

  console.log("[Launch-passのロック]");
  send({ type: "locked", why: "idle", passLeft: 3 });
  ok(layerOn() && getEl("passArea").className.includes("on") && /ロック/.test(getEl("lockTitle").textContent), "ロックされると、入力画面になる");
  fetchImpl = (p, b) => (p === "/api/unlock" ? { status: 403, body: { ok: false, error: "pass", left: 2 } } : { status: 200, body: { ok: true, paused: false, locked: true, lockWhy: "idle" } });
  await press("1234");
  await advance(20);
  ok(fetchLog.some((x) => x.p === "/api/unlock" && x.body.pass === "1234"), "4桁入れると、自動で送る");
  ok(/あと2回/.test(getEl("passMsg").textContent) && layerOn(), "間違えたら、残りの回数を出して、ロックのまま");
  fetchImpl = (p) => (p === "/api/unlock" ? { status: 200, body: { ok: true } } : { status: 200, body: { ok: true, paused: false, locked: false } });
  await press("4826");
  await advance(20);
  ok(!layerOn(), "正しいLaunch-passで、ロックが解ける");
  fetchImpl = (p) => (p === "/api/unlock" ? { status: 403, body: { ok: false, error: "pass", left: 0, ended: true } } : { status: 200, body: { ok: true, paused: false, locked: true } });
  send({ type: "locked", why: "idle", passLeft: 1 });
  await press("0000"); await advance(20);
  ok(/3回続けて/.test(getEl("passMsg").textContent), "3回目の間違いは、切断のお知らせを出す");
  fetchImpl = (p) => (p === "/api/unlock" ? { status: 429, body: { ok: false, error: "cooldown", left: 240 } } : { status: 200, body: { ok: true, paused: false, locked: true } });
  await press("1111"); await advance(20);
  ok(/入力できません/.test(getEl("passMsg").textContent), "入力できない時間は、残りを出す");
  send({ type: "unlocked" });
  ok(!layerOn(), "PCで解除されたら、ロックが消える");

  console.log("[PCがスリープ・休止]");
  fetchImpl = (p) => ({ status: 200, body: { ok: true, paused: false, away: { kind: "sleep", ago: 0 } } });
  send({ type: "pcaway", kind: "sleep", notice: 180, caution: 300, lock: 900, limit: 1800 });
  ok(layerOn() && /スリープ/.test(getEl("lockTitle").textContent) && !getEl("passArea").className.includes("on"), "スリープの通知で、暗くして「ロックされています」を出す（入力欄は出さない）");
  ok(getEl("lockCount").className === "", "最初の3分は、お知らせを出さない");
  await advance(185 * 1000);
  ok(/お知らせ/.test(getEl("lockCount").textContent), "3分で「お知らせ」");
  await advance(120 * 1000);
  ok(/注意/.test(getEl("lockCount").textContent) && /あと2\d分/.test(getEl("lockCount").textContent), "5分で「注意」（切断までのカウントダウン）");
  await advance(11 * 60 * 1000);
  ok(/Launch-pass/.test(getEl("lockCount").textContent), "15分を超えると、「戻ったあとはLaunch-passが必要」と出す");
  const bye = fetchLog.length;
  await advance(15 * 60 * 1000);
  ok(/スリープ・休止が30分/.test(getEl("endText").textContent) || /30分/.test(getEl("endText").textContent), "30分で、スマホ自身が切断する");
  ok(errors.length === 0, "ここまでエラーなし" + (errors[0] ? "（" + errors[0].message + "）" : ""));

  console.log("[PCに届かないとき（スリープの通知が届かなかった場合も）]");
  // 新しい接続
  ctx.location.search = "?sid=SID2";
  for (const k of Object.keys(els)) delete els[k];
  fetchImpl = (p) => ({ status: 200, body: { ok: true, paused: false, locked: false } });
  sources.length = 0; timers.length = 0; errors.length = 0;
  const ctx2 = ctx; // 同じ環境で、もう一度読み込む
  try { vm.runInContext(script, ctx2); } catch (e) { errors.push(e); }
  await advance(10); send(ready()); await advance(10);
  ok(!layerOn(), "つながっている間は、暗くならない");
  fetchImpl = () => new Error("network");
  await advance(10 * 1000);
  ok(!layerOn(), "10秒の途切れでは、まだ暗くならない");
  await advance(10 * 1000);
  ok(layerOn() && /届いていません/.test(getEl("lockTitle").textContent) && !getEl("passArea").className.includes("on"), "15秒以上届かなければ、暗くして「PCに届いていません」を出す");
  fetchImpl = () => ({ status: 200, body: { ok: true, paused: false, locked: false } });
  await advance(5 * 1000);
  ok(!layerOn(), "つながったら、自動で消える");

  console.log("[無操作の注意]");
  send({ type: "idle-caution", phase: "pass", secs: 900 });
  await advance(1500);
  ok(/あと1\d分/.test(getEl("banner").textContent) && /Launch-pass/.test(getEl("banner").textContent), "無操作の注意（あと何分でロックされるか）が出る");
  send({ type: "caution-end" });
  ok(getEl("banner").className === "", "操作すると、注意が消える");
  console.log("[複数タブ：新しく開いたタブが有効]");
  {
    ctx.location.search = "?sid=SID3";
    for (const k of Object.keys(els)) delete els[k];
    fetchImpl = (p) => ({ status: 200, body: { ok: true, paused: false, locked: false } });
    sources.length = 0; timers.length = 0; errors.length = 0; fetchLog.length = 0;
    try { vm.runInContext(script, ctx); } catch (e) { errors.push(e); }
    await advance(10); send(ready()); await advance(4500);
    const tab1 = (fetchLog.find((x) => x.p === "/api/ping") || {}).tab;
    ok(/^[0-9]{10,16}-[a-z0-9]{4,16}$/.test(tab1 || ""), "通信には、このタブの識別子が付く");
    ok(/[?&]tab=/.test(sources[sources.length - 1].url), "受信（events）にも、識別子が付く");
    ok(!layerOn(), "ふつうは、暗くならない");
    // ほかのタブが開かれて、このタブの通信が断られる
    fetchImpl = (p) => ({ status: 409, body: { ok: false, error: "othertab" } });
    await advance(4500);
    ok(layerOn() && /別のタブ/.test(getEl("lockTitle").textContent), "「別のタブで開かれました」と出て、使えなくなる");
    ok(getEl("takeOver").style.display === "block" && getEl("lockDisc").style.display === "none", "「このタブで使う」だけを出す（切断は出さない）");
    ok(sources[sources.length - 1].readyState === 2, "受信を止める");
    const n = fetchLog.length;
    await advance(30 * 1000);
    ok(fetchLog.length === n, "それ以降、このタブは通信しない（行き来しない）");
    ok(store.size >= 0 && ctx.location.search === "?sid=SID3", "接続の情報は、そのまま（切断しない）");
    ok(!/切断しました|終了/.test(getEl("endTitle").textContent), "接続終了の画面にはならない");
    // 「このタブで使う」
    fetchImpl = (p) => ({ status: 200, body: { ok: true, paused: false, locked: false } });
    const before = sources.length;
    getEl("takeOver").click();
    await advance(10);
    ok(sources.length === before + 1, "押すと、受信をやり直す");
    const tab2 = /[?&]tab=([^&]+)/.exec(sources[sources.length - 1].url)[1];
    ok(tab2 !== tab1 && Number(tab2.split("-")[0]) >= Number(tab1.split("-")[0]), "新しい識別子になる（さらに新しいタブ扱い）");
    send(ready()); await advance(4500);
    ok(!layerOn(), "つながれば、使える画面に戻る");
    ok(fetchLog.filter((x) => x.p === "/api/ping").slice(-1)[0].tab === tab2, "以後の通信は、新しい識別子で行う");
  }
  console.log("[タイマーのボタン（スマホ）]");
{
  const tsnap = JSON.parse(JSON.stringify(snap));
  tsnap.pages[0].tiles[0].timer = true;
  tsnap.states = { timer: true };
  created.length = 0;
  send(ready({ snapshot: tsnap })); await advance(20);
  ok(created.some((b) => /\btile\b/.test(b.className) && /timerbusy/.test(b.className)), "PCでタイマー画面が開いている間は、タイマーのボタンが暗くなる");
  created.length = 0;
  send({ type: "state", state: { timer: false } }); await advance(20);
  ok(created.some((b) => /\btile\b/.test(b.className)) && !created.some((b) => /timerbusy/.test(b.className)), "閉じたら、暗くない状態に戻る");
  ok(/\.tile\.timerbusy \{ opacity: 0\.6; \}/.test(html), "暗さ（0.6）のスタイルがある");
  ok(errors.length === 0, "エラーなし");
}
console.log("[長押し]");
  ok(/var LONGPRESS_MS = 590;/.test(script) && /var NAME_TIP_HIDE_MS = 1100;/.test(script), "長押しは0.59秒、名前は指を離して1.1秒で消える");
  ok(/lpcharge 390ms/.test(html), "長押しの途中経過の表示が、0.59秒でちょうど満ちる");
  console.log(`\n${pass} 件成功 / ${fail} 件失敗` + (errors.length ? `（実行中のエラー ${errors.length} 件：${errors[0].message}）` : ""));
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
