// main.js のうち、Electronに依存しない部分を取り出して動かす自己テスト：node tools/main-selftest.js
// スマホからタイマーを開く条件、Launch-0を閉じるときのタイマー画面の扱いを確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let ts;
try { ts = require("typescript"); } catch (e) { ts = require("/opt/npm-tools/node_modules/typescript"); }
const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf-8");
const sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true);
let code = "";
sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name && n.name.text === "createOrShowTimerWindow") code = src.slice(n.getStart(sf), n.end); });

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  NG  " + n); } }

function run(state, args) {
  const made = [];
  class FakeWin {
    constructor(o) { this.opts = o; this.destroyed = false; this.webContents = { send() {}, once() {} }; made.push(this); }
    isDestroyed() { return this.destroyed; } show() {} focus() {} setMenuBarVisibility() {} loadFile() {} once() {} on() {} setAlwaysOnTop() {} moveTop() {} isFocused() { return false; }
  }
  const ctx = { remoteActive: state.remoteActive, timerWindow: state.existing ? new FakeWin({}) : null, BrowserWindow: FakeWin, path, __dirname: "/x", process: { platform: "linux" },
    timerAlwaysOnTopEnabled: true, timerSuspendReassert: false, broadcastTimerState() {}, Math, Number };
  vm.createContext(ctx);
  vm.runInContext(code + "\nthis.f = createOrShowTimerWindow;", ctx);
  ctx.f(...args);
  return { made: made.length - (state.existing ? 1 : 0), ctx };
}

console.log("[スマホからタイマーを開く]");
ok(run({ remoteActive: false }, [undefined, { fromLaunch0: false }]).made === 1, "ふだん（接続していない）は、タイマー画面を開く");
ok(run({ remoteActive: true }, [undefined, { fromLaunch0: false }]).made === 0, "スマホ接続中に、PC側の他の画面から開く要求は、これまでどおり開かない");
ok(run({ remoteActive: true }, [undefined, { fromLaunch0: true }]).made === 1, "スマホ接続中でも、スマホから（Launch-0の中から）押したときは、PCでタイマー画面を開く");
ok(run({ remoteActive: true }, [undefined, undefined]).made === 0, "引数がなくても、接続中は開かない");
ok(run({ remoteActive: true, existing: true }, [undefined, { fromLaunch0: true }]).made === 0, "すでに開いているときは、2つ目は作らない（前に出すだけ）");

console.log("[ソースの確認]");
ok(/ipcMain\.handle\("timer:open", \(event, seconds\) => \{\s*createOrShowTimerWindow\(seconds, \{ fromLaunch0: isLaunch0Sender\(event\) \}\);/.test(src), "timer:open は、要求の送り主がLaunch-0かを見て渡す");
ok(/timerWindow\.close\(\); \} catch/.test(src.slice(src.indexOf("function closeLaunch0"))), "Launch-0を閉じるとき（接続が終わるとき）、タイマー画面を確認なしで閉じる");
ok(/for \(const w of \[mainWindow, launch0Window, \.\.\.pageWindows\.values\(\)\]\)/.test(src), "タイマー画面の開閉は、Launch-0の窓にも知らせる（スマホのボタンを暗くするため）");
ok(/const timerHasFocus = !!\(timerWindow && !timerWindow\.isDestroyed\(\) && timerWindow\.isFocused\(\)\);/.test(src) && /!timerHasFocus\) win\.setAlwaysOnTop/.test(src), "タイマー画面がフォーカスを持っている間は、Launch-0が前面を取り戻さない");
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
