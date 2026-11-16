// renderer.js のうち、画面（DOM）に依存しない関数だけを取り出して動かす自己テスト：node tools/renderer-selftest.js
// ショートカットの重複判定・Discord/OBSの除去・画面単体バックアップの取り込みを確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let ts;
try { ts = require("typescript"); } catch (e) { ts = require("/opt/npm-tools/node_modules/typescript"); }

const srcPath = path.join(__dirname, "..", "renderer.js");
const src = fs.readFileSync(srcPath, "utf-8");
const sf = ts.createSourceFile("renderer.js", src, ts.ScriptTarget.ES2022, true);
const want = new Set(["hotkeyNorm", "isLaunch0Hotkey", "hotkeyUsesOfTile", "hotkeyUseLabel", "hotkeyOwnerLabel", "findHotkeyClash", "validateTileHotkeys",
  "computeActiveHotkeys", "clearConflictingLaunchHotkeys", "removeObsLeftovers", "removeSoundFromMulti", "buildImportedPageTiles", "tileOpensTimer"]);
const wantConst = new Set(["LAUNCH0_HOTKEY"]);
let code = "";
sf.forEachChild((n) => {
  if (ts.isFunctionDeclaration(n) && n.name && want.has(n.name.text)) code += src.slice(n.getStart(sf), n.end) + "\n";
  if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && wantConst.has(d.name.text)) code += src.slice(n.getStart(sf), n.end) + "\n";
});
const ctx = { tiles: [], settings: {}, DEFAULT_SETTINGS: {}, activePage: 0, MAX_TILES_PER_PAGE: 64, showToast: () => {}, console };
vm.createContext(ctx);
vm.runInContext(code + "\nthis.__f = { hotkeyNorm, findHotkeyClash, validateTileHotkeys, computeActiveHotkeys, clearConflictingLaunchHotkeys, removeObsLeftovers, buildImportedPageTiles, tileOpensTimer, isLaunch0Hotkey };", ctx);
const F = ctx.__f;
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }
const T = (id, hotkey, page = 0, extra = {}) => ({ id, name: id, type: "link", url: "https://a", hotkey, pageIndex: page, subActions: [], ...extra });

console.log("[ショートカットの比較]");
ok(F.hotkeyNorm("Control+Alt+Shift+K") === F.hotkeyNorm("Shift+Ctrl+Alt+k"), "並び順・大文字小文字・Ctrl/Controlの違いは同じキー");
ok(F.hotkeyNorm("Control+Alt+Shift+K") !== F.hotkeyNorm("Control+Alt+Shift+J"), "違うキーは別");
ok(F.isLaunch0Hotkey("Control+Shift+Alt+K") && !F.isLaunch0Hotkey("Control+Alt+Shift+L"), "Launch-0を開くキーの判定");
// main.js と同じ規則か（関数を取り出して比べる）
{
  const msrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf-8");
  const msf = ts.createSourceFile("main.js", msrc, ts.ScriptTarget.ES2022, true);
  let mcode = "";
  msf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name && n.name.text === "hotkeyMapKey") mcode = msrc.slice(n.getStart(msf), n.end); });
  const mctx = {}; vm.createContext(mctx); vm.runInContext(mcode + "\nthis.f = hotkeyMapKey;", mctx);
  const samples = ["Control+Alt+Shift+K", "Shift+Ctrl+Alt+k", "CommandOrControl+Shift+A", "Alt+Control+Shift+9", "ctrl+alt+shift+z", ""];
  ok(samples.every((s) => mctx.f(s) === F.hotkeyNorm(s)), "画面側（renderer.js）とメイン側（main.js）の比較規則が同じ");
}

console.log("[重複の検出]");
ctx.tiles = [T("a", "Control+Alt+Shift+A", 0), T("b", "Control+Alt+Shift+B", 1), T("c", "", 0)];
let c = F.findHotkeyClash("Control+Alt+Shift+B", "launch", { id: "c" }, "launch");
ok(c && /画面2/.test(c.text), "他の画面のボタンと同じキーは重複（どの画面か分かる）");
ok(F.findHotkeyClash("Shift+Control+Alt+a", "launch", { id: "c" }, "launch"), "並び順が違っても重複とみなす");
ok(F.findHotkeyClash("Control+Alt+Shift+Q", "launch", { id: "c" }, "launch") === null, "使われていないキーは重複ではない");
ok(F.findHotkeyClash("Control+Alt+Shift+K", "launch", { id: "c" }, "launch") && /Launch-0/.test(F.findHotkeyClash("Control+Alt+Shift+K", "launch", { id: "c" }, "launch").text), "Launch-0を開くキーは、ボタンに設定できない");
ok(F.findHotkeyClash("Control+Alt+Shift+A", "launch", { id: "a" }, "launch") === null, "自分自身との比較は重複ではない");

console.log("[OSに登録する一覧]");
ctx.tiles = [T("a", "Control+Alt+Shift+A"), T("b", "Shift+Control+Alt+a"), T("k", "Control+Alt+Shift+K"), T("d", "Control+Alt+Shift+D")];
const act = F.computeActiveHotkeys();
ok(act.list.map((x) => x.id).join() === "a,d", "重複・Launch-0を開くキーは登録しない（先のものだけ登録）");
ok(act.blocked.map((x) => x.id).join() === "b,k", "登録しなかったボタンが分かる");
const list = [T("a", "Control+Alt+Shift+A"), T("b", "Control+Alt+Shift+A"), T("k", "Control+Alt+Shift+K")];
ok(F.clearConflictingLaunchHotkeys(list) === 2 && list[0].hotkey && !list[1].hotkey && !list[2].hotkey, "読み込みで重なったキーは、後のものと、Launch-0のキーが未設定になる");

console.log("[Discord・OBSの除去]");
ctx.settings = { l0BlockMicUnmute: true, obsHost: "x", accent: "#fff" };
ctx.tiles = [T("a", ""), { id: "d", type: "discord", sendHotkey: "Control+Alt+Shift+M", subActions: [] }, { id: "o", type: "obs", subActions: [] },
  { id: "m", type: "multi", subActions: [{ type: "discord" }, { type: "link", url: "https://a" }, { type: "obs" }] }];
const r = F.removeObsLeftovers();
ok(ctx.tiles.map((x) => x.id).join() === "a,m", "Discord・OBSのボタンが消える");
ok(ctx.tiles[1].subActions.length === 1 && ctx.tiles[1].subActions[0].type === "link", "マルチ操作の中のDiscord・OBSの動作が消える");
ok(r.removedDiscord === 2 && r.removedTiles === 2 && r.removedSubs === 2, "件数が正しい（Discord 2、合計 ボタン2＋動作2）");
ok(!("l0BlockMicUnmute" in ctx.settings) && !("obsHost" in ctx.settings) && ctx.settings.accent === "#fff" && r.settingsChanged, "廃止した設定だけが消える");

console.log("[タイマーのボタン]");
ok(F.tileOpensTimer({ type: "timer" }) && F.tileOpensTimer({ type: "multi", subActions: [{ type: "timer" }] }) && !F.tileOpensTimer({ type: "link" }) && !F.tileOpensTimer({ type: "multi", subActions: [{ type: "link" }] }), "タイマーを開くボタンの判定（マルチ操作の中も含む）");

console.log("[画面単体バックアップの取り込み]");
ctx.settings = { pageCount: 3 };
ctx.tiles = [T("x1", "Control+Alt+Shift+X", 0), T("x2", "", 1)];
ctx.activePage = 1;
const incoming = [T("n9", "", 0, { type: "app", filePath: "C:\\a.exe", needsConfirm: true }), T("n1", "Control+Alt+Shift+X", 0), T("n2", "Control+Alt+Shift+N", 0, { type: "discord" }), T("n3", "Control+Alt+Shift+K", 0), T("n4", "", 0, { type: "pageswitch", targetPage: 7 })];
const others = ctx.tiles.filter((t) => t.pageIndex !== 1);
const built = F.buildImportedPageTiles(incoming, others, 1, 3);
const all = built.tiles;
ok(!all.some((t) => t.type === "discord"), "Discordのボタンは入らない");
ok(all.find((t) => t.type === "app").needsConfirm === true, "確認がまだの印は、画面単体の取り込みでも残る");
ok(all.length === 4 && all.every((t) => t.pageIndex === 1), "読み込んだボタンは、現在の画面に入る");
ok(!all.find((t) => t.id === "n1").hotkey, "他の画面と同じキーは未設定になる");
ok(!all.find((t) => t.id === "n3").hotkey, "Launch-0を開くキーは未設定になる");
ok(all.find((t) => t.id === "n4").targetPage === null, "存在しない画面への切り替えは未設定になる");
ok(built.clearedHotkeys === 2, "未設定にした数が正しい");
console.log("[ハンバーガーメニューの並び]");
{
  const a = src.indexOf("function renderSettingsPanel");
  const body = src.slice(a, src.indexOf("\nfunction ", a + 10));
  const iPhone = body.indexOf("📱 スマホから操作"), iTail = body.indexOf("📶 Tailscaleの導入手順"), iFirst = body.indexOf("タイトル（Launch-K）を表示"), iShift = body.indexOf("画面切替");
  ok(iPhone > 0 && iPhone < iTail && iTail < iFirst && iFirst < iShift, "「スマホから操作」が最上部、その下に「Tailscaleの導入手順」、そのあとに、ほかの設定");
  ok(/<div class="settings-section boxed">\s*<h3>📱 スマホから操作<\/h3>/.test(body) && /<div class="settings-section boxed">\s*<h3>📶 Tailscaleの導入手順<\/h3>/.test(body), "2つとも枠（boxed）で囲まれている");
  ok((body.match(/id="launch0OpenBtn"/g) || []).length === 1 && (body.match(/id="tailscaleGuideLink"/g) || []).length === 1, "ボタンは1つずつ（重複なし）");
  ok(/tailscale\.com\/download/.test(body) && /Launch-pass/.test(body), "Tailscaleの手順に、入手先とLaunch-passの案内がある");
}
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
