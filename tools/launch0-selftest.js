// launch0.js（PC側のLaunch-0画面）を、画面（DOM）を模擬した環境で動かす自己テスト：node tools/launch0-selftest.js
// Launch-passの設定欄・「QRを表示」が押せる条件・状態表示（短く）・注意の帯（カウントダウン）を確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let ts;
try { ts = require("typescript"); } catch (e) { ts = require("/opt/npm-tools/node_modules/typescript"); }

const l0src = fs.readFileSync(path.join(__dirname, "..", "launch0.js"), "utf-8");
const rsrc = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf-8");
// renderer.js から、escapeHtml だけを借りる（本物と同じ動き）
const rsf = ts.createSourceFile("renderer.js", rsrc, ts.ScriptTarget.ES2022, true);
let escapeSrc = "";
rsf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name && n.name.text === "escapeHtml") escapeSrc = rsrc.slice(n.getStart(rsf), n.end); });

let now = 1700000000000;
class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this._text = ""; this.className = ""; this.value = ""; this.style = {}; this.dataset = {}; this.listeners = {}; }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  setAttribute() {} getAttribute() { return null; } focus() {} blur() {} querySelector() { return new El("q"); } querySelectorAll() { return []; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}
const els = {};
const getEl = (id) => els[id] || (els[id] = new El(id));
const apiLog = [];
let passApi = { set: false };
const api = new Proxy({}, { get: (t, p) => {
  if (p === "l0PassStatus") return async () => passApi;
  if (p === "l0SetPass") return async (v) => { apiLog.push(["setPass", v]); if (/^[0-9]{4}$/.test(v)) { passApi = { set: true }; return { ok: true }; } return { ok: false, error: "format" }; };
  if (p === "l0TsStatus") return async () => ({ ok: true, state: "ok", selfIp: "100.64.0.1", selfName: "pc", login: "a@b" });
  if (p === "l0Init") return async () => ({ locked: false });
  if (p === "onRemoteEvent" || p === "onMicChanged" || p === "onLaunch0Ended") return () => {};
  return async () => null;
} });
const ctx = {
  console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  document: { getElementById: getEl, createElement: (t) => new El(t), querySelector: () => new El("q"), querySelectorAll: () => [], addEventListener() {}, activeElement: null, body: new El("body") },
  window: { api },
  Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
  CSS_ICONS: {}, settings: { pageCount: 1 }, tiles: [{ id: "a", name: "A", type: "link", url: "https://a", pageIndex: 0, subActions: [], icon: { kind: "default", value: "" } }],
  THEME_PRESETS: {}, PANEL_OPACITY_DEFAULT: 0.5, MAX_PAGE_COUNT: 6, IS_LAUNCH0: true, timerOpen: true, tileOpensTimer: (t) => !!t && (t.type === "timer" || (t.type === "multi" && (t.subActions || []).some((x) => x && x.type === "timer"))), audioMuteState: {}, lastMuteReadAt: 0, muteSlow: false,
  colorWithAlpha: (c) => c, showToast() {}, safeColor: (c) => c, resolveCssIconKey: (t) => "x", refreshMuteStates: async () => {}, luminance: () => 0, luminanceOfAny: () => 0,
  isMicTile: () => false, tileHasToggle: () => false, svgWithSlash: (s) => s, offColorFor: () => "#f00", micState: () => "on", isSoundPlaying: () => false, handleTileClick() {},
  deriveThemeFromColor: () => ({}), applyTheme() {},
};
vm.createContext(ctx);
vm.runInContext(escapeSrc + "\n" + l0src, ctx);
const run = (c) => vm.runInContext(c, ctx);
const html = () => getEl("l0Root").innerHTML;
const text = () => html().replace(/<[^>]+>/g, " ");

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }

(async () => {
  console.log("[Launch-passの設定（接続の前）]");
  run('l0.phase = "select"; l0.ts = { ok: true, state: "ok" }; l0.pass = { set: false }; l0.passEditing = false; l0.passMsg = ""; l0.startPage = 0;');
  run("l0Render()");
  ok(/id="l0PassInput"/.test(html()) && /4桁の数字を決めてください。延長中の操作と再接続に使います。/.test(html()), "未設定なら、入力欄と、1〜2行の説明が出る");
  ok(/id="l0QrBtn"[^>]*disabled/.test(html()), "未設定の間は、「QRを表示」が押せない");
  getEl("l0PassInput").value = "12";
  await run("l0SavePass()");
  ok(/4桁の数字で入力してください/.test(html()) && !apiLog.length, "4桁でないと、保存せず、お知らせが出る");
  getEl("l0PassInput").value = "4826";
  await run("l0SavePass()");
  ok(apiLog.length === 1 && apiLog[0][1] === "4826", "4桁の数字を、保存の窓口に渡す");
  ok(/設定済み/.test(html()) && !/id="l0PassInput"/.test(html()) && !/id="l0QrBtn"[^>]*disabled/.test(html()), "保存すると、「設定済み」になり、「QRを表示」が押せる");
  ok(/id="l0PassChange"/.test(html()), "接続の前なら、いつでも「変更」で決め直せる");
  run("l0.passEditing = true; l0Render()");
  ok(/id="l0PassInput"/.test(html()) && /id="l0PassCancel"/.test(html()) && /id="l0QrBtn"[^>]*disabled/.test(html()), "決め直している間は、「QRを表示」が押せない（やめるボタンがある）");

  console.log("[接続中の状態表示（短く）]");
  run('l0OnEvent({ type: "connected", since: Date.now(), mode: "tailscale", peer: { name: "localhost", login: "a@b", path: { kind: "direct" } } })');
  ok(run("l0StatusText()") === "接続中", "ふつうは「接続中」");
  now += 1000;
  run('l0OnEvent({ type: "stalled", since: Date.now() - 206000, dropAt: Date.now() + 1594000 })');
  let st = run("l0StatusText()");
  ok(/^通信が途切れています（経過 3分26秒）$/.test(st) && !/あと/.test(st), "途切れ：「通信が途切れています（経過 3分26秒）」だけ（切断までの残りは出さない）");
  run('l0OnEvent({ type: "hidden", since: Date.now() - 206000, dropAt: Date.now() + 1594000 })');
  st = run("l0StatusText()");
  ok(/^スマホから応答がありません（経過 /.test(st) && !/あと/.test(st), "裏に回って、通信も途切れたときは、「スマホから応答がありません（経過…）」");
  run('l0OnEvent({ type: "resumed" })');
  st = run("l0StatusText()");
  ok(/^スマホの画面が裏に回っています（経過 /.test(st), "裏に回っているだけのとき");
  ok(!/あと/.test(st), "「あと◯分で切断」は、状態の行には出ない");
  ok(/class="l0-who"/.test(html()) && !/localhost[^<]*<b id="l0StatusText"/.test(html()), "端末名（アカウント）は、別の行（l0-who）に出る");
  run('l0OnEvent({ type: "hidden-end" })');
  run('l0OnEvent({ type: "locked", why: "idle" })');
  ok(run("l0StatusText()") === "スマホはLaunch-passの入力待ちです", "無操作でロックされたとき：残り時間なしの短い表示");
  run('l0OnEvent({ type: "unlocked" })');
  run('l0OnEvent({ type: "pcaway", kind: "sleep", since: Date.now(), dropAt: Date.now() + 1800000 })');
  ok(run("l0StatusText()") === "PCがスリープ・休止中です", "PCがスリープ・休止：短い表示");
  run('l0OnEvent({ type: "pcback", locked: false })');

  console.log("[注意の帯（カウントダウン）]");
  ok(!/l0CautionLeft/.test(html()), "ふだんは、注意の帯はない");
  run('l0OnEvent({ type: "caution", kind: "hidden", dropAt: Date.now() + 1500000 })');
  ok(/注意：スマホの画面が裏に回ったままです。あと <b id="l0CautionLeft">/.test(html()), "裏に回ったまま5分：注意の帯（あと…で自動的に切断）");
  now += 1000; run("l0UpdateLive()");
  ok(/^24:5\d$/.test(getEl("l0CautionLeft").textContent), "残り時間が数えられる（" + getEl("l0CautionLeft").textContent + "）");
  ok(/15分を超えると、戻ったときにLaunch-passが必要です/.test(getEl("l0CautionNote").textContent), "15分前の注釈");
  now += 16 * 60 * 1000; run("l0UpdateLive()");
  ok(/戻ったときに、Launch-passが必要です/.test(getEl("l0CautionNote").textContent), "15分を超えたら、注釈が変わる");
  run('l0OnEvent({ type: "caution", kind: "stalled", dropAt: Date.now() + 1500000 })');
  ok(/通信が途切れています。あと/.test(html()), "通信の途切れ：注意の帯");
  run('l0OnEvent({ type: "caution-end" })');
  ok(!/l0CautionLeft/.test(html()), "つながりが戻ると、注意の帯が消える");
  run('l0OnEvent({ type: "idle-caution", phase: "pass", at: Date.now() + 900000 })');
  ok(/しばらく操作がありません。あと/.test(html()) && /Launch-passが必要になります/.test(html()) && /id="l0Extend"/.test(html()), "無操作15分：注意（あと何分でLaunch-passが必要か）と「このまま続ける」");
  run('l0OnEvent({ type: "locked", why: "idle" }); l0OnEvent({ type: "idle-caution", phase: "cut", at: Date.now() + 1800000 })');
  ok(/Launch-passの入力待ちです。あと/.test(html()) && /自動的に切断します/.test(html()), "無操作30分以降：注意（あと何分で自動切断か）");
  console.log("[スマホから押せるボタン]");
ok(run('l0IsBlocked({ id: "t1", type: "timer", subActions: [] })') === false, "タイマーのボタンは、スマホから押せる（PCでタイマー画面が開く）");
ok(run('l0IsBlocked({ id: "t2", type: "multi", subActions: [{ type: "timer" }, { type: "link" }] })') === false, "タイマーを含むマルチ操作も、押せる");
ok(run('l0IsBlocked({ id: "t3", type: "power", subActions: [] })') === true && run('l0IsBlocked({ id: "t4", type: "pageswitch", subActions: [] })') === true && run('l0IsBlocked({ id: "t5", type: "qr", subActions: [] })') === true, "画面切替・電源・QRは、これまでどおり押せない");
ok(run('l0IsBlocked({ id: "t6", type: "app", needsConfirm: true, subActions: [] })') === true, "バックアップ由来で、PCでの確認がまだのボタンは、押せない");
ok(run("l0States().timer") === true, "PCでタイマー画面が開いている間は、スマホにそう伝える（ボタンを暗くするため）");
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
