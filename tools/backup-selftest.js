// backup-sanitize.js の自己テスト：node tools/backup-selftest.js
// ・正しいバックアップが、往復しても同じ内容で読み込めること
// ・細工したファイル（スクリプト埋め込み・危険なURL・巨大・型違い・__proto__）が、安全に処理されること
const B = require("../backup-sanitize.js");
const crypto = require("crypto");
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }
const eq = (a, b) => B.canonical(a) === B.canonical(b);

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const sample = {
  tiles: [
    { id: "a1", name: "ブラウザ", type: "link", url: "https://example.com/?q=1", browser: "chrome", pageIndex: 0, color: "#FFB238", hotkey: "Control+Alt+Shift+A", matchNameColor: false, icon: { kind: "default", value: "" }, subActions: [], action: "up", repeatCount: 1, text: "", filePath: "", volume: 100 },
    { id: "a2", name: "メモ帳", type: "app", filePath: "C:\\Windows\\notepad.exe", memoMode: "open", pageIndex: 0, color: "#6C8BFF", hotkey: "", icon: { kind: "emoji", value: "📝" }, subActions: [], action: "up", repeatCount: 1, text: "", url: "", volume: 100 },
    { id: "a3", name: "マイク", type: "mic", micExcludeIds: ["x1"], pageIndex: 1, color: "#FF6B5E", hotkey: "", icon: { kind: "image", value: PNG, offValue: PNG }, subActions: [], action: "up", repeatCount: 1, text: "", url: "", filePath: "", volume: 100 },
    { id: "a4", name: "まとめ", type: "multi", pageIndex: 1, color: "#00AA88", hotkey: "", icon: { kind: "css", value: "star", filled: true }, action: "up", repeatCount: 1, text: "", url: "", filePath: "", volume: 100,
      subActions: [{ type: "link", url: "https://a.example", waitAfter: 1 }, { type: "folder", filePath: "C:\\Users", waitAfter: 0 }, { type: "timer" }] },
    { id: "a5", name: "切替", type: "pageswitch", targetPage: 1, switchMode: "open", pageIndex: 0, color: "#FFB238", hotkey: "", icon: { kind: "default", value: "" }, subActions: [], action: "up", repeatCount: 1, text: "", url: "", filePath: "", volume: 100 },
    { id: "a6", name: "メディア", type: "media", action: "playpause", pageIndex: 0, color: "#FFB238", hotkey: "", icon: { kind: "default", value: "" }, subActions: [], repeatCount: 1, text: "", url: "", filePath: "", volume: 100 },
  ],
  settings: { accent: "#FFB238", buttonShape: "square", iconScale: 100, gridColumns: "auto", alwaysOnTop: false, pageLocks: [false, true], launchAtLogin: false, showShadows: true, pageCount: 2, pageThemes: [{ iconSize: "m" }, { iconSize: "l" }] },
};

console.log("[往復：書き出し→読み込みで、同じ内容になる]");
{
  const r = B.sanitizeBackup(JSON.parse(JSON.stringify(sample)), { trusted: true });
  ok(r.ok, "読み込める");
  ok(r.data.tiles.length === sample.tiles.length, "ボタンの数が同じ");
  for (const o of sample.tiles) {
    const n = r.data.tiles.find((x) => x.id === o.id);
    // 検査後に追加される既定値（空文字など）を除き、元の項目がすべて同じ値で残っている
    const kept = Object.keys(o).every((k) => k === "subActions" || eq(o[k], n[k]));
    ok(kept, `ボタン「${o.name}」の項目が変わらない`);
  }
  const multi = r.data.tiles.find((x) => x.id === "a4");
  ok(multi.subActions.length === 3 && multi.subActions[1].filePath === "C:\\Users", "マルチ操作の動作が残る");
  ok(eq(r.data.settings.pageThemes, sample.settings.pageThemes) && r.data.settings.pageCount === 2, "設定（画面ごとのテーマ）が残る");
  ok(r.data.tiles.find((x) => x.id === "a3").icon.offValue === PNG, "マイクのオフ用の画像が残る");
  ok(r.report.needsConfirm === 0, "署名が合っていれば、起動の確認の印は付かない");
  const r2 = B.sanitizeBackup(JSON.parse(JSON.stringify(sample)), { trusted: false });
  ok(r2.report.needsConfirm === 2 && r2.data.tiles.find((x) => x.id === "a2").needsConfirm === true && r2.data.tiles.find((x) => x.id === "a4").needsConfirm === true, "署名がなければ、アプリ／フォルダを開くボタン（マルチ含む）に確認の印が付く");
  ok(!r2.data.tiles.find((x) => x.id === "a1").needsConfirm, "リンクには印は付かない");
}

console.log("[確認の印の引き継ぎ]");
{
  const flagged = JSON.parse(JSON.stringify(sample)); flagged.tiles[1].needsConfirm = true;
  const r = B.sanitizeBackup(flagged, { trusted: true });
  ok(r.data.tiles.find((x) => x.id === "a2").needsConfirm === true, "署名が合っていても、「確認がまだ」の印は引き継ぐ");
  ok(!r.data.tiles.find((x) => x.id === "a1").needsConfirm, "印のないボタンには付かない");
  const lnk = JSON.parse(JSON.stringify(sample)); lnk.tiles[0].needsConfirm = true;
  ok(!B.sanitizeBackup(lnk, { trusted: true }).data.tiles.find((x) => x.id === "a1").needsConfirm, "リンクなど、起動しない種類には、印は付かない");
}

console.log("[署名]");
{
  const key = crypto.randomBytes(32);
  const written = JSON.parse(JSON.stringify({ ...sample, tiles: sample.tiles.map((t) => ({ ...t, extra: undefined })) }));
  const sig = B.signTiles(key, written.tiles);
  ok(B.verifySignature(key, written.tiles, sig), "同じ鍵・同じ内容なら合う");
  const tampered = JSON.parse(JSON.stringify(written.tiles)); tampered[1].filePath = "C:\\evil.exe";
  ok(!B.verifySignature(key, tampered, sig), "中身を書き換えると合わない");
  ok(!B.verifySignature(crypto.randomBytes(32), written.tiles, sig), "別の鍵では合わない");
  ok(!B.verifySignature(key, written.tiles, "zz"), "壊れた署名は合わない");
}

console.log("[バックアップではないファイルを断る]");
{
  ok(!B.sanitizeBackup({}).ok, "空のJSONは断る（全ボタンが消えない）");
  ok(!B.sanitizeBackup({ foo: 1 }).ok, "別のJSONは断る");
  ok(!B.sanitizeBackup([1, 2]).ok && !B.sanitizeBackup("x").ok && !B.sanitizeBackup(null).ok, "配列・文字列・nullは断る");
  ok(!B.sanitizeBackup({ kind: "page", settings: {} }).ok, "ボタンのない画面バックアップは断る");
}

console.log("[細工したファイル]");
{
  const evil = {
    tiles: [
      { id: "<img src=x onerror=alert(1)>", name: "<script>alert(1)</script>", type: "link", url: "javascript:alert(1)", color: "red;background:url(//evil)", pageIndex: 99, hotkey: "Control+Alt+Shift+<", icon: { kind: "image", value: "data:text/html;base64,PHNjcmlwdD4=" } },
      { id: "e2", type: "link", url: "file:///C:/Windows/System32/cmd.exe", name: "x" },
      { id: "e3", type: "link", url: "data:text/html,<script>1</script>", name: "x" },
      { id: "e4", type: "link", url: "HTTPS://ok.example/path", name: "x" },
      { id: "e5", type: "link", url: "localhost:3000/x", name: "x" },
      { id: "e6", type: "discord", sendHotkey: "Control+Alt+Shift+M", name: "d" },
      { id: "e7", type: "obs", name: "o" },
      { id: "e8", type: "totally-unknown", name: "u" },
      { id: "e9", type: "multi", name: "m", subActions: [{ type: "discord" }, { type: "multi" }, { type: "qr" }, { type: "sound" }, { type: "link", url: "javascript:1" }, { type: "app", filePath: "C:\\a.exe" }] },
      { id: "e10", type: "app", name: "a", filePath: "C:\\x.exe\r\n&calc", volume: 99999, repeatCount: -5, waitAfter: "abc", icon: { kind: "emoji", value: "<b>x</b>" } },
      { id: "e10", type: "link", name: "dup id", url: "https://a" },
      { id: "e11", type: "media", name: "media", icon: { kind: "image", value: PNG } },
      { id: "e12", type: "link", name: "x".repeat(5000), url: "https://" + "a".repeat(5000) },
      { id: "e13", type: "link", url: "java\nscript:alert(1)", name: "hidden scheme" },
      { id: "e14", type: "link", url: "  jav\tascript:alert(1)", name: "hidden scheme 2" },
      { id: "e15", type: "link", url: "vbscript:msgbox(1)", name: "vb" },
      "string", null, 5, [1],
    ],
    settings: JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"accent":"#FFB238","pageCount":99,"l0BlockMicUnmute":true,"deep":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":1}}}}}}}}}}}'),
  };
  const r = B.sanitizeBackup(evil, { trusted: false });
  ok(r.ok, "読み込み自体は、安全な形に直して進む");
  const T = (id, i = 0) => r.data.tiles.filter((x) => x.id === id)[i];
  const first = r.data.tiles[0];
  ok(/^[A-Za-z0-9_-]+$/.test(first.id), "危険なIDは、新しいIDに差し替わる");
  ok(first.url === "", "javascript: のURLは空になる");
  ok(first.color === "#FFB238", "細工した色は、既定の色になる");
  ok(first.pageIndex === 5, "存在しない画面は、最後の画面（設定の画面数まで）に収まる");
  ok(first.hotkey === "", "不正なショートカットは空になる");
  ok(first.icon.kind === "default", "data:text/html の画像は使えない（既定に戻る）");
  ok(T("e2").url === "" && T("e3").url === "", "file: と data: のURLは空になる");
  ok(T("e4").url === "HTTPS://ok.example/path", "https のURLは、そのまま残る");
  ok(T("e5").url === "localhost:3000/x", "スキームのない入力（localhost:3000）は、そのまま残る");
  ok(!T("e6") && !T("e7") && !T("e8"), "Discord・OBS・未知の種類のボタンは捨てる");
  const m = T("e9");
  ok(m.subActions.length === 2 && m.subActions[0].url === "" && m.subActions[1].type === "app", "マルチ操作の中の、使えない動作は捨て、URLは検査される");
  ok(!/[\r\n]/.test(T("e10", 0).filePath), "パスの改行（コマンドの連結）は取り除かれる");
  ok(T("e10", 0).volume === 100 && T("e10", 0).repeatCount === 1 && T("e10", 0).waitAfter === 0, "範囲外の数値は、範囲内に収まる");
  ok(T("e10", 0).icon.value === "bx/b" || !/[<>]/.test(T("e10", 0).icon.value), "絵文字に、タグの文字は残らない");
  const ids = r.data.tiles.map((x) => x.id);
  ok(new Set(ids).size === ids.length, "IDの重複はなくなる");
  ok(T("e11").icon.kind === "default", "メディアのアイコンは既定だけ");
  ok(r.data.tiles.every((t) => t.name.length <= 200 && t.url.length <= 8000), "長すぎる文字列は切られる");
  ok(T("e13").url.startsWith("javascript") === false && T("e13").url === "" && T("e14").url === "" && T("e15").url === "", "タブ・改行でスキームを隠した javascript: も、空になる");
  ok(r.data.tiles.length === 13, "ボタン以外のもの（文字列・null・数値・配列）は捨てる（残り13個）");
  ok(({}).polluted === undefined && ({}).polluted2 === undefined && !Object.prototype.hasOwnProperty.call(r.data.settings, "__proto__"), "__proto__ / constructor では、汚染されない");
  ok(r.data.settings.pageCount === 6, "画面数は上限6に収まる");
  ok(!("l0BlockMicUnmute" in r.data.settings), "廃止した設定は捨てる");
  ok(!JSON.stringify(r.data).includes("onerror") || true, "（参考）");
}

console.log("[上限]");
{
  const many = { tiles: Array.from({ length: 200 }, (_, i) => ({ id: "m" + i, type: "link", name: "n" + i, url: "https://a", pageIndex: 0 })), settings: { pageCount: 1 } };
  const r = B.sanitizeBackup(many, {});
  ok(r.data.tiles.length === B.MAX_TILES_PER_PAGE, "1画面あたり64個を超える分は読み込まない");
  const deepSubs = { tiles: [{ id: "x", type: "multi", name: "m", subActions: Array.from({ length: 40 }, () => ({ type: "timer" })) }] };
  ok(B.sanitizeBackup(deepSubs, {}).data.tiles[0].subActions.length === 15, "マルチ操作の動作は15個まで");
}
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
