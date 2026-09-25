const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, clipboard, nativeImage, screen, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, execFile, spawn } = require("child_process");
const native = require("./native"); // koffiによるuser32.dll直接呼び出し（利用不可ならnative.availableがfalseになる）
const nativeSnap = require("./native-snap"); // 画面分割（スナップ）専用のkoffi実装。失敗時はPowerShell方式にフォールバック

const ICON_SCRIPT_PATH = path.join(__dirname, "scripts", "get-icon.ps1");

const CONFIG_PATH = path.join(app.getPath("userData"), "tiles.json");
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const ICON_PATH = path.join(__dirname, "assets", "icon.png");
const TRAY_ICON_PATH = path.join(__dirname, "assets", "tray-icon.png");

const DEFAULT_SETTINGS = {
  accent: "#FFB238",
  buttonShape: "square",
  iconScale: 100,
  gridColumns: "auto",
  alwaysOnTop: false,
  launchAtLogin: false,
  showShadows: true,
};

let mainWindow = null;
// ページ2以降を「別画面」として開いたときのウィンドウを保持するマップ（key: pageIndex）。
// 同じページを二重に開かないよう、既にあれば新規作成せず表示・フォーカスするだけにする。
const pageWindows = new Map();
let tray = null;
let suspendAlwaysOnTopReassert = false;
app.isQuitting = false;

// ---- スナップ／ズームの操作対象を「直前に使っていた他アプリのウィンドウ」に固定するための追跡 ----
// keybd_event によるキー送信はOS上で今フォーカスされているウィンドウに届く。
// ボタンをクリックした時点ではLaunch-K自身がフォーカスされてしまっているため、
// 何も対策しないとズーム・スナップの操作がLaunch-K自身に効いてしまい、
// 「アプリ画面に対してズームイン・スナップが効いてしまう／肝心の操作対象に効かない」
// という不具合になる。そこで、Launch-Kからフォーカスが外れた直後（＝他のアプリが
// 前面に来た直後）のウィンドウハンドルを記録しておき、ズーム・スナップ実行の直前に
// そのウィンドウを一旦前面に戻してからキーを送ることで、常に「Launch-Kを開く前に
// 使っていたウィンドウ」に対して操作できるようにする。
let lastExternalHwnd = null;
// 自アプリ自身のウィンドウ（メイン・タイマー・使い方）を、誤って「操作対象の
// 他アプリ」として記録してしまわないようにするための判定。
// （例：メインウィンドウからタイマーや使い方のウィンドウを開くと、メインの
// blurイベントが発生し、その時点の最前面ウィンドウ＝自分自身の別ウィンドウを
// 誤記録してしまい、スナップ操作が正しい対象に効かなくなる不具合があった）
function getNativeHwnd(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
    if (buf.length >= 4) return buf.readUInt32LE(0);
    return null;
  } catch {
    return null;
  }
}
// 現在生きている自アプリの全ウィンドウ（メイン＋ページ別画面）。破棄済みは除く。
function allAppWindows() {
  const list = [];
  if (mainWindow && !mainWindow.isDestroyed()) list.push(mainWindow);
  for (const w of pageWindows.values()) if (w && !w.isDestroyed()) list.push(w);
  return list;
}
function isOwnWindowHwnd(hwnd) {
  return [mainWindow, timerWindow, guideWindow, tooltipWindow, ...pageWindows.values()]
    .map(getNativeHwnd)
    .some((h) => h !== null && h === hwnd);
}
// 「常に最前面（ロック）」を、メインウィンドウ・ページ別画面のすべてに一括で適用する。
// 色選択ポップアップなどのOS標準ダイアログが開いている間（suspendAlwaysOnTopReassert）は、
// ここで上書きしてしまうとポップアップが裏に隠れてしまうためスキップする。
function reassertAlwaysOnTopForAll() {
  if (suspendAlwaysOnTopReassert) return;
  const s = loadSettings();
  for (const w of allAppWindows()) {
    w.setAlwaysOnTop(!!s.alwaysOnTop, "screen-saver");
    w.setVisibleOnAllWorkspaces(!!s.alwaysOnTop, { visibleOnFullScreen: true });
  }
}
// 上記ポップアップ用の一時停止フラグは、どのウィンドウでポップアップを開いても
// 正しく解除できるよう、フォーカスが戻ってきたウィンドウに関わらず共通で扱う。
function handleAnyWindowFocus() {
  if (suspendAlwaysOnTopReassert) {
    suspendAlwaysOnTopReassert = false;
    reassertAlwaysOnTopForAll();
  }
}
function rememberForegroundWindowAsExternal() {
  if (process.platform !== "win32") return;
  // 自分自身のポップアップ（色選択ダイアログ等）を記録してしまわないよう、
  // それらが開いている間（suspendAlwaysOnTopReassert中）は更新をスキップする。
  if (suspendAlwaysOnTopReassert) return;
  // これはウィンドウのblurのたびに呼ばれる頻度の高い処理なので、
  // koffiが使えるならPowerShellを起動せずその場で直接取得する。
  if (native.available) {
    const val = native.getForegroundWindowHandle();
    if (!val) return;
    if (isOwnWindowHwnd(val)) return; // 自アプリ自身のウィンドウは対象外
    lastExternalHwnd = val;
    return;
  }
  // koffiが使えない環境向けの従来方式（フォールバック）
  const script =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class FgHelper { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'; " +
    "[FgHelper]::GetForegroundWindow().ToInt64()";
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, (error, stdout) => {
    if (error) return;
    const val = parseInt(String(stdout).trim(), 10);
    if (!Number.isFinite(val) || val === 0) return;
    if (isOwnWindowHwnd(val)) return; // 自アプリ自身のウィンドウは対象外
    lastExternalHwnd = val;
  });
}
// 今この瞬間の最前面ウィンドウを取得する（restoreExternalFocusの事前チェック用）。
function getCurrentForegroundHwnd() {
  if (process.platform !== "win32") return Promise.resolve(null);
  if (native.available) {
    const val = native.getForegroundWindowHandle();
    return Promise.resolve(val || null);
  }
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class FgHelper2 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'; ";
  const callScript = "[FgHelper2]::GetForegroundWindow().ToInt64()";
  return runPsSmart("FgHelper2", defScript, callScript).then(({ error, stdout }) => {
    if (error) return null;
    const val = parseInt(String(stdout).trim(), 10);
    return Number.isFinite(val) ? val : null;
  });
}
// ズーム・スナップの直前に、記録しておいたウィンドウを前面に戻す。
// 対象が見つからない・既に閉じられている等で失敗しても、その場合は
// 何もせず（＝現状のフォーカス先に対して）そのままキー送信を続行する。
//
// ボタンをクリックして実行した場合はLaunch-K自身が前面にいるため、記録しておいた
// 「直前の他アプリ」に一旦戻す必要がある。一方、グローバルショートカット経由で
// 実行した場合はLaunch-Kにフォーカスが移っておらず、今前面にあるウィンドウが
// すでに正しい（記録しておいた値より新しい）操作対象になっている。そこで、まず
// 「今すでに自アプリ以外が前面にあるか」を確認し、そうであれば記録値より
// そちらを優先して何もせず終える（記録が古いまま別のウィンドウを前面に
// 呼び戻してしまう＝「開く順が早かった方に効いてしまう」不具合を防ぐ）。
async function restoreExternalFocus() {
  if (process.platform !== "win32") return;
  const cur = await getCurrentForegroundHwnd();
  if (cur !== null && !isOwnWindowHwnd(cur)) return; // 今すでに他アプリが前面＝それが正解
  if (!lastExternalHwnd || isOwnWindowHwnd(lastExternalHwnd)) return;
  if (native.available) {
    if (native.isWindowHandle(lastExternalHwnd)) {
      native.setForegroundWindowHandle(lastExternalHwnd);
      // PowerShell版と同じく、OS側の切り替えが反映されるまで一瞬待つ
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return;
  }
  // koffiが使えない環境向けの従来方式（フォールバック）
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class RestoreHelper { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); " +
    "[DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd); }'; ";
  const callScript = `$h = [IntPtr]${lastExternalHwnd}; if ([RestoreHelper]::IsWindow($h)) { [RestoreHelper]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 60 }`;
  await runPsSmart("RestoreHelper", defScript, callScript);
}

// ============================================================
// マルチ操作専用：常駐PowerShellセッション（安全設計）
// ------------------------------------------------------------
// 目的：マルチ操作の実行中だけPowerShellプロセスを1本使い回すことで、
//      アクションごとのプロセス起動コスト（Add-Typeのコンパイルを含む）を減らす。
//
// 安全設計の方針（最優先）：
//  1. セッションは「速くするための追加ルート」に過ぎない。セッションが
//     まったく機能しなくても、全操作が今まで通りの「都度exec起動」方式で
//     完全に動作することを大前提にする（=フォールバックが常に効く）。
//  2. セッション側で異常（応答なし・プロセス異常終了・書き込み失敗）が
//     起きたら、その場で即座にセッションを破棄し、それ以降のアクションは
//     自動的に元の方式に戻す。ユーザー操作を失敗させたり、無応答のまま
//     待たせたりしない。
//  3. 1コマンドごとにタイムアウトを設け、ハングしたセッションを検知する。
//  4. Add-Typeの二重定義エラー（同じセッション内で同じC#クラスを2回定義
//     しようとすると失敗する）を避けるため、型ごとに「このセッションで
//     すでに読み込み済みか」をJS側で管理し、初回だけ定義スクリプトを送る。
//     各アクションのC#クラス定義そのものは一切変更していない。
// ============================================================
let multiPsProcess = null;
let multiPsBuf = "";
let multiPsQueue = []; // { script, resolve, reject, sent, timer }
let multiPsLoadedTypes = new Set();
// セッション内で「型定義（Add-Type）を先に読み込み中」のものを型名で管理する。
// 読み込み中に同じ定義をもう一度送ると二重定義エラーになるため、後続の処理はこれの完了を待つ。
let multiPsPendingDefs = new Map();
const MULTI_PS_TIMEOUT_MS = 8000; // 1コマンドあたりの応答待ちタイムアウト（標準）
// 画面分割で「新しく開いたウィンドウ」を待つとき、SnapWin.Run（C#側）は最大この時間待つ。
// ※ SNAP_WINDOW_CS 内の `int limit = waitNew ? 12000 : 0;` と同じ値にしておくこと。
// 以前は7秒だったが、LINE・OBS・編集ソフトなど起動が重いアプリで取りこぼす例があったため延長した。
const SNAP_WAIT_LIMIT_MS = 12000;
// 待機（最大7秒）に加えて、初回のAdd-Type（C#コンパイル）や処理時間の余裕を見込んだタイムアウト。
// 標準の8秒のままだと余裕が1秒しかなく、待機が長引いたとき成功しかけた処理まで
// ハング扱いでセッションごと破棄され、従来方式で二重にやり直してしまうため、別に長めに取る。
// （フォールバック側のexecFileのタイムアウト15秒とも揃えている）
const SNAP_PS_TIMEOUT_MS = SNAP_WAIT_LIMIT_MS + 8000;
const MULTI_PS_MARK = "__LKPS_DONE__";
// このセッションが最後に使われた時刻。呼び出し側（マルチ操作・明るさの長押し）が
// 何らかの理由（ウィンドウを閉じた、レンダラーがクラッシュした等）でendMultiSessionを
// 呼び忘れても、PowerShellプロセスが起動しっぱなしで残り続けないようにするための
// 安全網（アイドルタイムアウト）に使う。
let multiPsLastActivity = 0;
let multiPsIdleCheckTimer = null;
const MULTI_PS_IDLE_KILL_MS = 60000; // これだけ何も実行されなければ、後始末漏れとみなして自動終了する

function killMultiPsSession(reason) {
  const proc = multiPsProcess;
  multiPsProcess = null;
  multiPsLoadedTypes = new Set();
  multiPsPendingDefs = new Map();
  multiPsBuf = "";
  if (multiPsIdleCheckTimer) {
    clearInterval(multiPsIdleCheckTimer);
    multiPsIdleCheckTimer = null;
  }
  const waiting = multiPsQueue.splice(0);
  for (const req of waiting) {
    if (req.timer) clearTimeout(req.timer);
    // 拒否＝呼び出し側(runPsSmart等)が必ずexec方式へフォールバックする
    req.reject(new Error(reason || "session-closed"));
  }
  if (proc) {
    try { proc.stdout.removeAllListeners(); } catch {}
    try { proc.stdin.end(); } catch {}
    try { proc.kill(); } catch {}
  }
}

function startMultiPsSession() {
  if (process.platform !== "win32") return;
  if (multiPsProcess) return; // 二重起動防止
  let proc;
  try {
    proc = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NoExit", "-Command", "-"], {
      windowsHide: true,
    });
  } catch (e) {
    multiPsProcess = null;
    return;
  }
  multiPsProcess = proc;
  multiPsBuf = "";
  multiPsLoadedTypes = new Set();
  multiPsLastActivity = Date.now();
  // 呼び出し側（マルチ操作・明るさの長押し）がendMultiSessionを呼び忘れて
  // セッションが残り続けた場合に備えて、一定時間何も実行されなければ自動的に終了する。
  if (!multiPsIdleCheckTimer) {
    multiPsIdleCheckTimer = setInterval(() => {
      if (multiPsProcess && multiPsQueue.length === 0 && Date.now() - multiPsLastActivity > MULTI_PS_IDLE_KILL_MS) {
        killMultiPsSession("idle-timeout");
      }
    }, 15000);
  }

  proc.stdout.on("data", (chunk) => {
    multiPsBuf += chunk.toString();
    let idx;
    while ((idx = multiPsBuf.indexOf(MULTI_PS_MARK)) !== -1) {
      const out = multiPsBuf.slice(0, idx);
      multiPsBuf = multiPsBuf.slice(idx + MULTI_PS_MARK.length);
      const req = multiPsQueue.shift();
      if (req) {
        if (req.timer) clearTimeout(req.timer);
        req.resolve(out);
      }
      sendNextMultiPsCommand();
    }
  });
  proc.stderr.on("data", () => {}); // エラー出力は無視（失敗判定はタイムアウト/exitで行う）
  // プロセスが予期せず終了・エラーになったら、即座にセッションを破棄して
  // 以降はフォールバック（都度exec）方式に自動的に戻す。
  proc.on("error", () => killMultiPsSession("process-error"));
  proc.on("exit", () => {
    if (multiPsProcess === proc) killMultiPsSession("process-exit");
  });
}

function endMultiPsSession() {
  killMultiPsSession("session-end");
}

function sendNextMultiPsCommand() {
  if (!multiPsProcess) return;
  const req = multiPsQueue[0];
  if (!req || req.sent) return;
  req.sent = true;
  req.timer = setTimeout(() => {
    // 応答が返らない＝ハング。セッションごと破棄し、以降はフォールバックへ委ねる。
    killMultiPsSession("timeout");
  }, req.timeoutMs || MULTI_PS_TIMEOUT_MS);
  try {
    multiPsProcess.stdin.write(req.script + `\r\nWrite-Output '${MULTI_PS_MARK}'\r\n`);
  } catch (e) {
    killMultiPsSession("write-error");
  }
}

function runInMultiPsSession(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!multiPsProcess) return reject(new Error("no-session"));
    multiPsLastActivity = Date.now(); // アイドルタイムアウトの起点を、実際に使われるたびに更新する
    multiPsQueue.push({ script, resolve, reject, sent: false, timer: null, timeoutMs });
    if (multiPsQueue.length === 1) sendNextMultiPsCommand();
  });
}

// 各アクションから呼ばれる共通の実行関数。
//  typeName   : このスクリプトが定義するC#クラス名（同一クラスの二重定義を避けるためのキー）
//  defScript  : "Add-Type ...;" の部分（クラス定義そのもの。中身は変更しない）
//  callScript : 定義済みのクラスを使って実際に処理を行う部分
// 戻り値は元のexec()のコールバック引数と同じ形（{error, stdout, stderr}）にして、
// 呼び出し側の後処理コードを変更しなくて済むようにしている。
function runPsSmart(typeName, defScript, callScript) {
  return new Promise((resolve) => {
    if (multiPsProcess) {
      const needsDef = !!typeName && !multiPsLoadedTypes.has(typeName);
      const body = (needsDef ? defScript : "") + callScript;
      runInMultiPsSession(body)
        .then((stdout) => {
          if (needsDef && typeName) multiPsLoadedTypes.add(typeName);
          resolve({ error: null, stdout, stderr: "" });
        })
        .catch(() => {
          // セッション経由で失敗 → このアクションだけは確実に成功させるため、
          // 従来のexec方式にフォールバックする（セッションはすでに破棄済み）。
          runPsExecFallback(defScript + callScript, resolve);
        });
      return;
    }
    runPsExecFallback(defScript + callScript, resolve);
  });
}

// 従来通りの「都度exec起動」方式。既存コードの挙動と完全に同一。
function runPsExecFallback(fullScript, resolve) {
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${fullScript.replace(/"/g, '\\"')}"`, (error, stdout, stderr) => {
    resolve({ error, stdout, stderr });
  });
}

ipcMain.handle("multi:sessionStart", (event, opts) => {
  startMultiPsSession();
  // このマルチ操作に画面分割が含まれるときは、PowerShellの起動やアプリの起動を待っている間に
  // 画面分割用のC#のコンパイルを先に済ませておく（最初の画面分割の待ちを短くするため）。
  if (opts && opts.preloadSnap) prewarmSnapType();
  return null;
});
ipcMain.handle("multi:sessionEnd", () => {
  endMultiPsSession();
  return null;
});

function loadTiles() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    return [];
  }
}
function saveTiles(tiles) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(tiles, null, 2), "utf-8");
}
function loadSettings() {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) };
    merged.buttonShape = "square"; // ボタンの形は四角のみに固定（過去の「丸」設定を上書き）
    return merged;
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}
function applySettings(settings) {
  // ネイティブの色選択ポップアップ表示中などで一時停止している間は、ここで
  // 上書きして再度最前面に戻してしまうとポップアップが裏に隠れてしまうため、
  // suspendAlwaysOnTopReassert中はここでの再適用をスキップする（関数内でチェック）。
  reassertAlwaysOnTopForAll();
  if (!app.isPackaged) return; // 開発時(npm start)は自動起動設定を変更しない
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  } catch (e) {}
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    backgroundColor: "#14161B",
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html");
  mainWindow = win;

  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("hide", () => hideTooltip(true));
  win.on("minimize", () => hideTooltip(true));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    if (tooltipWindow && !tooltipWindow.isDestroyed()) tooltipWindow.destroy();
  });

  // ロック（常に最前面）がオンのとき、他アプリの操作で前面指定が
  // 上書きされてしまうケースがあるため、フォーカスが外れるたびに再適用する。
  // ただし、色選択（<input type="color">）のようなOS標準のポップアップは
  // このウィンドウ自身が作る別ウィンドウで、開くと一時的にフォーカスが外れる
  // （＝blurが発生する）。そこで毎回screen-saverレベルに戻してしまうと、
  // その最前面ウィンドウがポップアップより手前に出てきてしまい、
  // ポップアップが裏に隠れて操作できなくなる。suspendAlwaysOnTopReassert中は
  // 再適用をスキップし、ポップアップが閉じてこのウィンドウにフォーカスが
  // 戻ったタイミングであらためて最前面設定を復元する。
  win.on("blur", () => {
    reassertAlwaysOnTopForAll();
    // Launch-Kからフォーカスが外れた＝他アプリが前面に来た直後なので、
    // そのウィンドウをズーム・スナップの操作対象として記録する。
    rememberForegroundWindowAsExternal();
  });
  win.on("focus", handleAnyWindowFocus);

  applySettings(loadSettings());
}

// ---- ページを「別画面」として開く ----
// ページ0は常にメインウィンドウ。ページ1以降は専用のウィンドウを1つだけ持ち、
// 既に開いていれば新しく作らず前面に出すだけにする（同じページの二重表示を防止）。
function openPageWindow(pageIndex) {
  const idx = Math.max(0, Math.round(Number(pageIndex) || 0));
  if (idx === 0) {
    if (!mainWindow) createWindow();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const existing = pageWindows.get(idx);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    backgroundColor: "#14161B",
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html", { query: { page: String(idx) } });
  pageWindows.set(idx, win);
  win.once("ready-to-show", () => win.show());
  // 色選択ポップアップ等が裏に隠れないよう、メインウィンドウと同じ抑制フラグ・
  // 再適用ロジックを共有する（常に最前面はメイン・ページ別画面すべてに一括適用）。
  if (loadSettings().alwaysOnTop) win.setAlwaysOnTop(true, "screen-saver");
  win.on("blur", reassertAlwaysOnTopForAll);
  win.on("focus", handleAnyWindowFocus);
  // 画面の削除で番号が繰り上がると、このウィンドウのキー(idx)が変わることがあるため、
  // 番号ではなくウィンドウ自体で探して外す。
  win.on("closed", () => {
    for (const [key, w] of [...pageWindows.entries()]) if (w === win) pageWindows.delete(key);
  });
}
ipcMain.handle("pages:open", (event, pageIndex) => {
  openPageWindow(pageIndex);
  return true;
});
// ---- 「画面切り替え」ボタンで、切り替え後に今の画面を閉じる（＝追加ではなく置き換える）----
// メインウィンドウ（ページ0）はもともとclose時に実際には閉じずトレイに隠れる仕様なので、
// ここでの「閉じる」もそれに従う（トレイに隠れる）。ページ別画面（ページ1以降）は実際に閉じる。
ipcMain.handle("pages:closeCurrent", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return true;
});
// ---- 画面（ページ）の個別削除 ----
// 削除と番号の繰り上げ（ボタン・画面ごとの設定・開いているウィンドウ）を、ここで一括して行う。
// 例：画面1〜3のうち2を削除 → 旧3が新2になる。削除した画面のボタンも一緒に消える。
// 「画面切り替え」ボタンの切り替え先も、繰り上がりに合わせて付け替える（削除した画面を指していたものは未設定になる）。
ipcMain.handle("pages:remove", (event, pageIndex) => {
  const k = Math.round(Number(pageIndex));
  const s = loadSettings();
  const count = Math.max(1, Math.round(Number(s.pageCount)) || 1);
  if (!Number.isInteger(k) || count <= 1 || k < 0 || k >= count) return { error: "この画面は削除できません" };

  const shiftTarget = (p) => (typeof p === "number" ? (p > k ? p - 1 : p === k ? null : p) : p);
  const oldTiles = loadTiles();
  const tiles = (Array.isArray(oldTiles) ? oldTiles : [])
    .filter((t) => t && typeof t === "object" && (t.pageIndex || 0) !== k)
    .map((t) => {
      const n = { ...t };
      if ((n.pageIndex || 0) > k) n.pageIndex = n.pageIndex - 1;
      if ("targetPage" in n) n.targetPage = shiftTarget(n.targetPage);
      if (Array.isArray(n.subActions)) {
        n.subActions = n.subActions.map((sub) =>
          sub && typeof sub === "object" && "targetPage" in sub ? { ...sub, targetPage: shiftTarget(sub.targetPage) } : sub
        );
      }
      return n;
    });
  if (Array.isArray(s.pageThemes) && k < s.pageThemes.length) s.pageThemes.splice(k, 1);
  s.pageCount = count - 1;
  saveTiles(tiles);
  saveSettings(s);

  // 開いている別画面ウィンドウを付け替える。削除した画面のウィンドウは閉じ、
  // それより後ろの画面は番号を1つ下げて開き直す（新しい番号の内容で読み込み直す）。
  // 画面1（メインウィンドウ）を削除した場合は、旧画面2の中身がメインウィンドウに移るため、
  // 旧画面2の別ウィンドウは重複するので閉じる。
  const next = new Map();
  for (const [idx, win] of [...pageWindows.entries()]) {
    if (!win || win.isDestroyed()) continue;
    if (idx === k || (k === 0 && idx === 1)) { win.close(); continue; }
    if (idx > k) {
      next.set(idx - 1, win);
      win.loadFile("index.html", { query: { page: String(idx - 1) } });
    } else {
      next.set(idx, win);
    }
  }
  pageWindows.clear();
  for (const [idx, win] of next.entries()) pageWindows.set(idx, win);

  for (const w of allAppWindows()) {
    w.webContents.send("tiles:changed");
    w.webContents.send("settings:changed");
  }
  return { ok: true, removedTiles: (Array.isArray(oldTiles) ? oldTiles : []).length - tiles.length };
});

// 実行中の「マルチ操作」の間、全ウィンドウ（メイン＋ページ別画面）を横断して
// ボタン操作・ページ切替をロックするための通知。
ipcMain.on("pages:busySet", (event, isBusy) => {
  for (const w of allAppWindows()) w.webContents.send("pages:busy", !!isBusy);
});

function createTray() {
  tray = new Tray(TRAY_ICON_PATH);
  tray.setToolTip("Launch-K");
  const menu = Menu.buildFromTemplate([
    {
      label: "開く",
      click: () => {
        if (!mainWindow) createWindow();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "終了",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // 既定のアプリケーションメニュー（View > Zoom In/Out に Ctrl+Plus/Ctrl+Minus が
  // 割り当てられている）を残したままだと、ズームボタンがLaunch-K自身にフォーカスが
  // 戻った直後に押された場合、そのショートカットがLaunch-K自身のウィンドウ表示倍率を
  // 変えてしまい、「ズームインが効かない（本来の対象に反映されない）」不具合の一因になる。
  // メニューバー自体は autoHideMenuBar で元々非表示なので、完全に取り除いても支障はない。
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  app.on("activate", () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

// リンクは常にOS標準のブラウザで開き、アプリ内に新規ウィンドウを作らせない
app.on("web-contents-created", (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 保険：現状アプリ内に外部URLへ直接遷移させる導線は無いが、万一どこかの
  // 不具合や未知の脆弱性でトップレベルナビゲーションが起きても、自分自身の
  // ローカルHTML（file://）以外への遷移は常に拒否する（preloadが有効なまま
  // 外部ページに乗っ取られる事態を防ぐ）。
  contents.on("will-navigate", (navEvent, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      const current = new URL(contents.getURL());
      if (target.protocol !== "file:" || target.origin !== current.origin) {
        navEvent.preventDefault();
      }
    } catch (e) {
      navEvent.preventDefault();
    }
  });
});

// レンダラーがクラッシュ（応答なし含む）した場合、トレイだけが残って
// 何も操作できなくなるのを防ぐため、該当ウィンドウを作り直す。
app.on("render-process-gone", (event, contents, details) => {
  if (details && (details.reason === "clean-exit" || details.reason === "killed")) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === contents) {
    mainWindow.destroy();
    mainWindow = null;
    createWindow();
  }
});

app.on("window-all-closed", () => {
  // トレイに常駐するため、ウィンドウを閉じてもアプリは終了しない
});

app.on("will-quit", () => {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) tooltipWindow.destroy();
  globalShortcut.unregisterAll();
  // 明るさの長押しやマルチ操作用に開いたままの常駐PowerShellセッションが
  // あれば、アプリ終了時にプロセスが残ってしまわないよう明示的に閉じる。
  killMultiPsSession("app-quit");
});

// ---- タイル設定の読み書き ----
ipcMain.handle("tiles:load", () => loadTiles());
ipcMain.handle("tiles:save", (event, tiles) => {
  saveTiles(tiles);
  // 複数ウィンドウ（メイン＋ページ別画面）を開いているとき、変更を保存した
  // ウィンドウ以外にも反映されるよう、他の全ウィンドウへ変更を知らせる。
  for (const w of allAppWindows()) {
    if (w.webContents !== event.sender) w.webContents.send("tiles:changed");
  }
  return true;
});

// ---- アプリ設定 ----
ipcMain.handle("settings:load", () => loadSettings());
ipcMain.handle("settings:save", (event, settings) => {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  merged.buttonShape = "square"; // ボタンの形は四角のみに固定
  saveSettings(merged);
  applySettings(merged);
  for (const w of allAppWindows()) {
    if (w.webContents !== event.sender) w.webContents.send("settings:changed");
  }
  return merged;
});

// ---- プリセット適用時にウィンドウ自体をぴったりのサイズにリサイズ ----
ipcMain.handle("window:resize", (event, { width, height }) => {
  // レイアウトが画面ごとに独立したため、プリセット適用時は「操作したウィンドウ」自身をリサイズする
  // （別画面で適用したのにメインウィンドウが変わってしまわないように）。
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win || win.isDestroyed()) return false;
  const w = Math.max(360, Math.round(width));
  const h = Math.max(300, Math.round(height));
  win.setContentSize(w, h);
  return true;
});

// ---- ファイル選択ダイアログ ----
ipcMain.handle("dialog:pickFile", async (event, filters) => {
  // 呼び出し元のウィンドウ（メイン／ページ別画面）を親として渡すことで、
  // 常に最前面（ロック中）でもファイル選択ダイアログがアプリの裏に隠れず、必ず前面に表示される
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const wasAlwaysOnTop = !!(win && !win.isDestroyed() && win.isAlwaysOnTop());
  let result;
  if (win && !win.isDestroyed()) {
    // ダイアログ自体を最優先の前面レベルに一時的に引き上げる
    win.setAlwaysOnTop(true, "screen-saver");
    result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: filters || [] });
    if (!win.isDestroyed()) win.setAlwaysOnTop(wasAlwaysOnTop, "screen-saver");
  } else {
    result = await dialog.showOpenDialog({ properties: ["openFile"], filters: filters || [] });
  }
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- 実際にファイル／アプリを開く ----
ipcMain.handle("shell:openPath", async (event, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return "ファイルが見つかりません（移動または削除された可能性があります）";
  }
  const errorMessage = await shell.openPath(targetPath);
  return errorMessage || null;
});

// ---- Windows標準の「メモ」（notepad.exe）専用の開き方 ----
// メモ（Windows 11の新しいメモ帳）は単一インスタンス・タブ方式になっており、
// 「新しいタブ」と「新しいウィンドウ」をコマンドラインの引数だけで作り分ける
// 一般的な方法が無い。そこで、既存のメモウィンドウを探して前面に出したうえで、
// 必要な場合だけアプリ内のショートカットキー（Ctrl+N＝新しいタブ、
// Ctrl+Shift+N＝新しいウィンドウ）をこちらから送信することで実現する。
function findNotepadWindowHwnd() {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = "(Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty MainWindowHandle)";
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, (error, stdout) => {
      if (error) return resolve(null);
      const val = parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(val) && val !== 0 ? val : null);
    });
  });
}
async function focusHwndAndWait(hwnd) {
  if (native.available && native.isWindowHandle(hwnd)) {
    native.setForegroundWindowHandle(hwnd);
  } else {
    const defScript =
      "Add-Type -Language CSharp -TypeDefinition " +
      "'using System; using System.Runtime.InteropServices; " +
      "public class MemoFocusHelper { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; ";
    const callScript = `[MemoFocusHelper]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`;
    await new Promise((resolve) => {
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${(defScript + callScript).replace(/"/g, '\\"')}"`, () => resolve());
    });
  }
  // OS側の切り替えが反映され、キー送信の宛先が確実にメモになるよう一呼吸置く
  await new Promise((resolve) => setTimeout(resolve, 150));
}
function spawnNotepad() {
  return new Promise((resolve) => {
    try {
      const child = spawn("notepad.exe", [], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => resolve("メモを起動できませんでした"));
      child.unref();
      resolve(null);
    } catch (e) {
      resolve("メモを起動できませんでした");
    }
  });
}
async function runMemoAction(mode) {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  const hwnd = await findNotepadWindowHwnd();
  if (!hwnd) {
    // 既存ウィンドウが無ければ、どのモードを選んでいても新しく起動するだけでよい
    return await spawnNotepad();
  }
  await focusHwndAndWait(hwnd);
  if (mode === "addTab") return await pressHotkeyCombo("Control+N");
  if (mode === "newWindow") return await pressHotkeyCombo("Control+Shift+N");
  return null; // "open"：前面に出すだけ
}
ipcMain.handle("app:memoAction", async (event, mode) => runMemoAction(mode));

// ---- .lnk（ショートカット）のリンク先が「メモ」（notepad.exe）かどうかを調べる ----
// デスクトップの「メモ帳.lnk」のように、ショートカット経由でメモが選ばれた場合、
// 選ばれたパスの末尾は notepad.exe ではないため、リンク先まで辿って判定する。
// 判定の流れ：
//   1) リンク先（TargetPath）が notepad.exe（System32 やApp実行エイリアスを含む）
//   2) 「explorer.exe shell:AppsFolder\Microsoft.WindowsNotepad_...」形式（Arguments側に印が出る）
//   3) リンク先も引数も空（ストアアプリのAUMIDだけを持つ形式）の場合は、
//      ショートカットの表示名でスタートメニューのアプリ一覧を引き、メモのAppIDか確認する
// パスはコマンドラインに埋め込まず環境変数で渡す（日本語・空白・引用符を含んでも壊れないように）。
// スクリプト自体もファイルではなく -EncodedCommand で渡すので、asarにパッケージ化された環境でも動く。
const NOTEPAD_LNK_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$lnk = $env:LK_LNK_PATH
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$t = [string]$sc.TargetPath
$a = [string]$sc.Arguments
$hit = $false
if ($t -match '(^|[\\/])notepad\.exe$') { $hit = $true }
elseif ($a -match 'Microsoft\.WindowsNotepad_' -or $a -match '(^|[\\/!])notepad\.exe(\s|$|")') { $hit = $true }
elseif (-not $t -and -not $a) {
  $n = [IO.Path]::GetFileNameWithoutExtension($lnk)
  $app = Get-StartApps | Where-Object { $_.Name -eq $n } | Select-Object -First 1
  if ($app -and ($app.AppID -match 'Microsoft\.WindowsNotepad_' -or $app.AppID -match 'notepad\.exe$')) { $hit = $true }
}
if ($hit) { 'yes' } else { 'no' }
`.replace(/\r?\n(?=\s*(elseif|else)\b)/g, " ");
const NOTEPAD_LNK_ENCODED = Buffer.from(NOTEPAD_LNK_SCRIPT, "utf16le").toString("base64");
ipcMain.handle("app:isNotepadShortcut", async (event, lnkPath) => {
  try {
    if (process.platform !== "win32") return false;
    const p = String(lnkPath || "").trim();
    if (!/\.lnk$/i.test(p) || !fs.existsSync(p)) return false;
    return await new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", NOTEPAD_LNK_ENCODED],
        { env: { ...process.env, LK_LNK_PATH: p }, timeout: 15000, windowsHide: true },
        (error, stdout) => resolve(!error && /yes/.test(String(stdout || "")))
      );
    });
  } catch (e) {
    return false;
  }
});

// ---- ボタンにマウスを乗せたときの説明（ツールチップ）----
// アプリ画面の中に描画すると、画面の枠（端）で見切れてしまうため、
// 専用の透明ウィンドウ（クリックを通さない・フォーカスを奪わない）に表示して、
// アプリ画面の外にもはみ出して表示できるようにしている。
let tooltipWindow = null;
let tooltipReady = null;
let tooltipSeq = 0;
const TOOLTIP_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; overflow: hidden; }
body { padding: 8px; opacity: 0; font-family: 'Space Grotesk', 'Yu Gothic UI', 'Segoe UI', system-ui, sans-serif; }
#tip { display: inline-block; background: #FAFAFA; color: #1A1A1A; padding: 5px 10px; border-radius: 8px;
  font-size: 12px; line-height: 1.4; white-space: nowrap; text-align: left; box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
#n { font-weight: 600; }
#k { color: #52525B; margin-top: 3px; font-size: 11px; font-family: 'JetBrains Mono', Consolas, monospace; }
</style></head><body><div id="tip"><div id="n"></div><div id="k"></div></div>
<script>
function setTip(name, key) {
  document.body.style.opacity = '0';
  document.getElementById('n').textContent = name;
  var k = document.getElementById('k');
  k.textContent = key || '';
  k.style.display = key ? 'block' : 'none';
  var r = document.getElementById('tip').getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
}
</script></body></html>`;
function ensureTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) return tooltipReady;
  const win = new BrowserWindow({
    width: 200, height: 60, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  tooltipWindow = win;
  tooltipReady = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TOOLTIP_HTML));
  win.on("closed", () => { if (tooltipWindow === win) tooltipWindow = null; });
  return tooltipReady;
}
// ツールチップは、ウィンドウ自体は隠さず「中身を透明にする」ことで消す。
// ウィンドウを隠すと描画が止まり、次に表示したとき直前の内容が一瞬だけ残って見えてしまうため
// （別のボタンに移ったとき、前のツールチップが少し出てから新しいものに切り替わっていた）。
// アプリ画面自体が隠れる・最小化するときだけ、ウィンドウごと隠す。
function hideTooltip(hideWindow) {
  tooltipSeq++;
  if (!tooltipWindow || tooltipWindow.isDestroyed()) return;
  tooltipWindow.webContents.executeJavaScript("document.body.style.opacity='0'").catch(() => {});
  if (hideWindow === true && tooltipWindow.isVisible()) tooltipWindow.hide();
}
ipcMain.on("tooltip:hide", () => hideTooltip(false));
ipcMain.on("tooltip:show", async (event, payload) => {
  try {
    if (!payload || !payload.rect) return;
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const seq = ++tooltipSeq;
    await ensureTooltipWindow();
    if (seq !== tooltipSeq || !tooltipWindow || tooltipWindow.isDestroyed()) return;
    const name = String(payload.name || "").slice(0, 200);
    const key = String(payload.key || "").slice(0, 100);
    const size = await tooltipWindow.webContents.executeJavaScript(`setTip(${JSON.stringify(name)}, ${JSON.stringify(key)})`);
    if (seq !== tooltipSeq || !tooltipWindow || tooltipWindow.isDestroyed()) return;
    const PAD = 8; // 影の分の余白（HTML側のbody paddingと合わせる）
    const GAP = 6;
    const cb = mainWindow.getContentBounds();
    const r = payload.rect;
    const tileLeft = cb.x + r.left, tileRight = cb.x + r.right;
    const tileTop = cb.y + r.top, tileBottom = cb.y + r.bottom;
    const wa = screen.getDisplayNearestPoint({
      x: Math.round((tileLeft + tileRight) / 2),
      y: Math.round((tileTop + tileBottom) / 2),
    }).workArea;
    // 基本はボタンの真下・中央。画面（モニター）の下端に収まらなければ真上に出す。
    let boxX = Math.round((tileLeft + tileRight) / 2 - size.w / 2);
    let boxY = Math.round(tileBottom + GAP);
    if (boxY + size.h > wa.y + wa.height) boxY = Math.round(tileTop - GAP - size.h);
    boxX = Math.max(wa.x + 2, Math.min(boxX, wa.x + wa.width - size.w - 2));
    boxY = Math.max(wa.y + 2, boxY);
    tooltipWindow.setBounds({ x: boxX - PAD, y: boxY - PAD, width: size.w + PAD * 2, height: size.h + PAD * 2 });
    // ロック（常に最前面）中のアプリ画面もTOPMOST同士で、後から前面に出し直されるため、
    // ツールチップも表示のたびに最前面の層へ出し直し、その中でも一番上に持ってくる
    // （これをしないとアプリ画面の後ろに隠れて見えない）。
    tooltipWindow.setAlwaysOnTop(true, "screen-saver");
    if (!tooltipWindow.isVisible()) tooltipWindow.showInactive();
    tooltipWindow.moveTop();
    // 内容の入れ替えと移動が終わってから、初めて見えるようにする
    if (seq !== tooltipSeq) return;
    await tooltipWindow.webContents.executeJavaScript("document.body.style.opacity='1'");
  } catch (e) { /* ツールチップの失敗で本体の動作を止めない */ }
});

// ---- 外部リンクを開く ----
// 通常は既定のブラウザに任せる（すでにブラウザが開いていれば新しいタブになる）。
// マルチ操作で「リンクを開く→画面分割」を続けるときは、同じブラウザの別タブに入ってしまうと
// 左右など別々の場所に分けられないため、newWindow指定のときは新しいウィンドウで開く。
let defaultBrowserExeCache;
function regQueryValue(key, valueArgs) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, ...valueArgs], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const m = /REG_\w+\s+(.+)$/m.exec(String(stdout || ""));
      resolve(m ? m[1].trim() : null);
    });
  });
}
async function getDefaultBrowserExe() {
  // 検出に成功した結果だけキャッシュする。失敗（null）を記憶したままにすると、
  // 起動直後にたまたま一度だけ検出に失敗しただけで、以後ずっと「新しいウィンドウで
  // 開く」処理が無言でスキップされ続けてしまう（＝普通のタブとして開かれてしまう）ため。
  if (defaultBrowserExeCache) return defaultBrowserExeCache;
  let result = null;
  try {
    const progId = await regQueryValue("HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", ["/v", "ProgId"]);
    if (progId) {
      const cmd = await regQueryValue(`HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, ["/ve"]);
      if (cmd) {
        const m = /^"([^"]+\.exe)"/i.exec(cmd) || /^(\S+\.exe)/i.exec(cmd);
        if (m && fs.existsSync(m[1])) result = m[1];
      }
    }
  } catch (e) { /* 取得できなければ通常の開き方にフォールバック */ }
  if (result) defaultBrowserExeCache = result;
  return result;
}
// ---- 指定ブラウザで開く（リンクの「開くブラウザ」設定）----
// 「既定」以外が選ばれている場合は、その特定のブラウザを直接起動してURLを渡す。
// レジストリのApp Paths（多くの環境で最も確実にインストール場所が取れる方法）を優先し、
// 見つからない場合はよくあるインストール先も候補として確認する。
const BROWSER_EXE_NAMES = {
  chrome: "chrome.exe",
  edge: "msedge.exe",
};
const browserExeCache = {};
async function findBrowserExeByName(exeName) {
  // こちらも同様に、成功結果だけをキャッシュする（失敗を永久記憶しない）。
  if (browserExeCache[exeName]) return browserExeCache[exeName];
  let found = null;
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const p = await regQueryValue(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, ["/ve"]);
      if (p && fs.existsSync(p)) { found = p; break; }
    } catch (e) { /* 次の候補を試す */ }
  }
  if (!found) {
    const pf = process.env["ProgramFiles"];
    const pf86 = process.env["ProgramFiles(x86)"];
    const local = process.env["LocalAppData"];
    const candidates = [];
    if (exeName === "chrome.exe") {
      if (pf) candidates.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
      if (pf86) candidates.push(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
      if (local) candidates.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
    } else if (exeName === "msedge.exe") {
      if (pf86) candidates.push(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
      if (pf) candidates.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    for (const c of candidates) { if (c && fs.existsSync(c)) { found = c; break; } }
  }
  if (found) browserExeCache[exeName] = found;
  return found;
}
function browserLaunchArgs(exePath, url, forceNewWindow) {
  const name = path.basename(exePath).toLowerCase();
  const chromiumFamily = ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "chromium.exe"];
  if (chromiumFamily.includes(name)) {
    // マルチ操作の画面分割のために新しいウィンドウを要求されたときは、--new-window で
    // 普通のブラウザウィンドウ（タブ・アドレスバーつき）を新しく開く。
    // 以前は --app=URL（タブ・アドレスバーの無い「アプリ」表示のウィンドウ）にしていたが、
    // ブラウザの設定に関係なくアプリ表示で開いてしまうため、やめた。
    // 画面分割の予定が無い普段のリンクは、これまで通り [url] だけを渡す。
    if (forceNewWindow) return ["--new-window", url];
    return [url];
  }
  return [url];
}
function spawnBrowser(exePath, url, forceNewWindow) {
  return new Promise((resolve) => {
    try {
      const args = browserLaunchArgs(exePath, url, forceNewWindow);
      const child = spawn(exePath, args, { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch (e) {
      resolve(false);
    }
  });
}
async function openUrlInNewBrowserWindow(url) {
  if (process.platform !== "win32" || !/^https?:\/\//i.test(url)) return false;
  const exe = await getDefaultBrowserExe();
  if (!exe) return false;
  const name = path.basename(exe).toLowerCase();
  let args = null;
  if (["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "chromium.exe"].includes(name)) args = ["--new-window", url];
  else if (name === "firefox.exe") args = ["-new-window", url];
  if (!args) return false;
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}
// リンクを開く実処理
async function runOpenExternal(url, opts) {
  try {
    // ブラウザの実行ファイルに直接渡す経路（spawn）があるため、ここで渡されるurlは
    // 必ずhttp(s)であることを保証する。そうでなければブラウザ側のコマンドライン
    // スイッチ（例："--remote-debugging-port=..."）として解釈されてしまう余地があるため。
    if (!/^https?:\/\//i.test(String(url || ""))) return "無効なURLです";
    const browserKey = opts && opts.browser;
    // 「既定」以外のブラウザ（Chrome／Edge）が明示的に選ばれている場合は、そのブラウザを直接起動する。
    if (browserKey && browserKey !== "default") {
      if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
      const exeName = BROWSER_EXE_NAMES[browserKey];
      const exePath = exeName ? await findBrowserExeByName(exeName) : null;
      if (!exePath) return "指定したブラウザが見つかりませんでした（インストールされているか確認してください）";
      const ok = await spawnBrowser(exePath, url, !!(opts && opts.newWindow));
      return ok ? null : "指定したブラウザを起動できませんでした";
    }
    if (opts && opts.newWindow) {
      const ok = await openUrlInNewBrowserWindow(url);
      if (ok) return null;
      // 新しいウィンドウを要求されたのに実現できなかった場合、これまでは黙って
      // 普通のタブとして開いていたため、マルチ操作で複数ウィンドウに分割したいのに
      // 実際には同じウィンドウにタブが増えるだけ、という不具合に気づけなかった。
      // 開くこと自体は続行しつつ、原因に気づけるようトーストで知らせる。
      await shell.openExternal(url);
      return "既定のブラウザを新しいウィンドウで開けなかったため、通常の方法（タブ）で開きました";
    }
    await shell.openExternal(url);
    return null;
  } catch (e) {
    return e.message;
  }
}
ipcMain.handle("shell:openExternal", async (event, url, opts) => runOpenExternal(url, opts));

// ---- クリップボードにコピー ----
ipcMain.handle("clipboard:write", (event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

// ---- クリップボードに画像をコピー ----
ipcMain.handle("clipboard:writeImage", (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "画像ファイルが見つかりません";
    const img = nativeImage.createFromPath(filePath);
    if (!img || img.isEmpty()) return "画像を読み込めませんでした";
    clipboard.writeImage(img);
    return null;
  } catch (e) {
    return e.message;
  }
});

// ---- クリップボードにファイル／フォルダそのものをコピー（Explorerなどに貼り付けるとファイルコピーになる） ----
// ElectronのclipboardモジュールにはCF_HDROP（ファイル参照）を書き込む手段が無いため、
// 既存のPowerShell依存の他機能と同様、Windows標準のSet-Clipboard -LiteralPathで実現する。
ipcMain.handle("clipboard:writeFile", (event, filePath) => {
  return new Promise((resolve) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return resolve("ファイル・フォルダが見つかりません（移動または削除された可能性があります）");
      if (process.platform !== "win32") return resolve("この機能はWindowsのみ対応しています");
      // 文字列のシェル引数化を避けるため、パスは-EncodedCommandでBase64化したスクリプトの中に
      // 直接埋め込む（PowerShellの単一引用符内なので、埋め込み前に ' だけ '' へエスケープする）。
      const psPath = String(filePath).replace(/'/g, "''");
      const script = `Set-Clipboard -LiteralPath '${psPath}'`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        (error, stdout, stderr) => {
          if (error) return resolve("コピーに失敗しました：" + String(stderr || error.message).trim());
          resolve(null);
        }
      );
    } catch (e) {
      resolve(e.message);
    }
  });
});

// ---- クリップボードの内容を、直前まで使っていた他アプリの入力欄にそのまま貼り付ける ----
// VK_CONTROL=0x11, VK_V=0x56
function pressPasteKeys() {
  if (native.available && native.pressKeyCombo([0x11, 0x56])) { // Ctrl+V
    return Promise.resolve(null);
  }
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class PasteHelper { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; ";
  const callScript =
    "[PasteHelper]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); " +
    "[PasteHelper]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero); " +
    "[PasteHelper]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero); " +
    "[PasteHelper]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);";
  return runPsSmart("PasteHelper", defScript, callScript).then(({ error, stderr }) =>
    error ? (stderr && stderr.toString()) || error.message : null
  );
}
ipcMain.handle("system:pasteToActiveWindow", async () => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  // コピー操作ボタンをクリックした時点ではLaunch-K自身にフォーカスがあるため、
  // ズーム・スナップと同様に、直前まで使っていたウィンドウへ一旦フォーカスを
  // 戻してからCtrl+Vを送ることで、そのウィンドウの入力欄に直接貼り付ける。
  await restoreExternalFocus();
  return await pressPasteKeys();
});

// ---- 任意のキーの組み合わせを送信（Discordなど、他アプリ側に割り当てた
//      キーボードショートカットを間接的に操作するための汎用機能）----
// 「Control+Alt+Shift+M」のような文字列を受け取り、各キーのkeydownを押す順、
// keyupを逆順で送信する。対応するのは英数字1文字＋Control/Alt/Shift/Metaの組み合わせのみ。
function parseAcceleratorToVkCodes(combo) {
  const parts = String(combo || "").split("+").filter(Boolean);
  if (!parts.length) return null;
  const codes = [];
  for (const part of parts) {
    if (part === "Control") codes.push(0x11);
    else if (part === "Alt") codes.push(0x12);
    else if (part === "Shift") codes.push(0x10);
    else if (part === "Meta") codes.push(0x5b);
    else if (/^[A-Z0-9]$/.test(part)) codes.push(part.charCodeAt(0));
    else return null;
  }
  return codes;
}
function pressHotkeyCombo(combo) {
  const codes = parseAcceleratorToVkCodes(combo);
  if (!codes) return Promise.resolve("送信するキーが設定されていません");
  if (native.available && native.pressKeyCombo(codes)) {
    return Promise.resolve(null);
  }
  const downs = codes.map((c) => `[HotkeyHelper]::keybd_event(${c}, 0, 0, [UIntPtr]::Zero);`).join(" ");
  const ups = codes.slice().reverse().map((c) => `[HotkeyHelper]::keybd_event(${c}, 0, 2, [UIntPtr]::Zero);`).join(" ");
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class HotkeyHelper { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; ";
  const callScript = downs + " " + ups;
  return runPsSmart("HotkeyHelper", defScript, callScript).then(({ error, stderr }) =>
    error ? (stderr && stderr.toString()) || error.message : null
  );
}
ipcMain.handle("system:sendHotkey", async (event, combo) => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  // 直前まで使っていたウィンドウ（Discordなど）にキーを届けるため、
  // スナップ・ズームと同様に一旦そちらへフォーカスを戻してから送信する。
  await restoreExternalFocus();
  return await pressHotkeyCombo(combo);
});

// ---- スリープ・シャットダウン ----
function runPowerAction(action) {
  if (process.platform !== "win32") return Promise.resolve("この機能は現在Windowsのみ対応しています");
  const commands = {
    sleep: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
    shutdown: "shutdown /s /t 0",
    restart: "shutdown /r /t 0",
  };
  const cmd = commands[action];
  if (!cmd) return Promise.resolve("不明な操作です");
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve(error ? (stderr && stderr.toString()) || error.message : null);
    });
  });
}
ipcMain.handle("system:power", async (event, action) => runPowerAction(action));

// ---- PC全体の音量操作 ----
const VOLUME_KEY_CODES = { up: 0xaf, down: 0xae, mute: 0xad };
function pressVolumeKey(code, count) {
  if (native.available && native.pressKeyRepeat(code, count)) {
    return Promise.resolve(null);
  }
  const n = Math.max(1, Math.min(10, Number(count) || 1));
  const callScript = Array.from(
    { length: n },
    () => `[VolumeHelper]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero); [VolumeHelper]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero);`
  ).join(" ");
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class VolumeHelper { " +
    "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; ";
  return runPsSmart("VolumeHelper", defScript, callScript).then(({ error, stderr }) =>
    error ? (stderr && stderr.toString()) || error.message : null
  );
}
ipcMain.handle("system:volume", async (event, action, count) => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  const code = VOLUME_KEY_CODES[action];
  if (!code) return "不明な操作です";
  return await pressVolumeKey(code, count);
});

// ---- 今使っているウィンドウを画面の半分・4分の1にスナップ ----
// VK_LWIN=0x5B, VK_LEFT=0x25, VK_UP=0x26, VK_RIGHT=0x27, VK_DOWN=0x28
// 4分の1スナップは、Windows標準の挙動（半分にスナップした直後に上下キーを送ると
// その半分の中でさらに上下にスナップされる）を利用して、2段階のキー送信で実現する。
function pressSnapKeys(arrowCodes) {
  const codes = Array.isArray(arrowCodes) ? arrowCodes : [arrowCodes];
  return new Promise((resolve) => {
    const seq = codes
      .map((code, i) => {
        // 1段階目のスナップが画面に反映されるまで少し待ってから2段階目を送る。
        // 待たずに連続で送ると、Windows側の処理が追いつかず反応しないことがある。
        const wait = i > 0 ? "Start-Sleep -Milliseconds 120; " : "";
        return `${wait}[SnapHelper]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); [SnapHelper]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero); [SnapHelper]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero); [SnapHelper]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero);`;
      })
      .join(" ");
    // スナップを実行すると、Windowsが「反対側に何を表示するか選んでください」という
    // スナップアシストの候補一覧をポップアップで出してくることがある。これが出たまま
    // だと画面がそこで止まって見え、次の操作の邪魔にもなるため、少し待ってから
    // Escapeキーを送って自動的に閉じる（ポップアップが出ていない場合は何も起きない）。
    const dismissSnapAssist = "Start-Sleep -Milliseconds 180; [SnapHelper]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [SnapHelper]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero);";
    const script =
      "Add-Type -Language CSharp -TypeDefinition " +
      "'using System; using System.Runtime.InteropServices; " +
      "public class SnapHelper { " +
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; " +
      seq + " " + dismissSnapAssist;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, (error, stdout, stderr) => {
      resolve(error ? (stderr && stderr.toString()) || error.message : null);
    });
  });
}
// ---- 画面分割（スナップ）----
// 以前は「Windowsキー＋矢印キー」をキー送信で再現していたため、
//  ・直前に使っていたウィンドウを取り違えて別のウィンドウに効く／Launch-K自身に効く
//  ・スナップアシストの一覧やタイミングのズレで、四分割のウィンドウが同じ場所に重なる
// といった不具合が起きやすかった。
// そこで、対象ウィンドウを特定したうえで、そのウィンドウが今いるモニターの作業領域から
// 半分／四分の一の矩形を計算し、SetWindowPosで直接配置する方式に変更した（1回のPowerShell実行で完結）。
// 対象の特定は次の順：
//   (1) 今すでに他アプリが前面ならそれ  (2) Launch-Kの1つ後ろ（＝直前に使っていた）ウィンドウ  (3) 記録済みのウィンドウ
// 失敗した場合（管理者権限のアプリ等）のみ、従来のキー送信方式にフォールバックする。
const SNAP_WINDOW_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SnapWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(IntPtr h, int attr, out int v, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeRect(IntPtr h, int attr, out RECT r, int size);

  static bool IsOwn(IntPtr h, long[] own) {
    long v = h.ToInt64();
    for (int i = 0; i < own.Length; i++) { if (own[i] == v) return true; }
    return false;
  }
  static bool IsUsed(IntPtr h, long[] used) {
    long v = h.ToInt64();
    for (int i = 0; i < used.Length; i++) { if (used[i] == v) return true; }
    return false;
  }
  const int MinCandidateWidth = 200;
  const int MinCandidateHeight = 150;
  static bool IsCandidate(IntPtr h, long[] own) {
    if (h == IntPtr.Zero) return false;
    if (IsOwn(h, own)) return false;
    if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) return false;
    int cloaked = 0;
    if (DwmGetWindowAttributeInt(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return false;
    if (GetWindowTextLength(h) == 0) return false;
    if (GetWindow(h, 4) != IntPtr.Zero) return false; // GW_OWNER持ち（ダイアログ・更新確認ポップアップ等）は除外
    RECT rect;
    if (GetWindowRect(h, out rect) && (rect.Right - rect.Left < MinCandidateWidth || rect.Bottom - rect.Top < MinCandidateHeight)) return false;
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Windows.UI.Core.CoreWindow") return false;
    return true;
  }

  // waitNewで待ち始める前から画面にあった候補ウィンドウの一覧（詳細はnative-snap.js参照）
  static System.Collections.Generic.HashSet<long> CollectPreExisting(long[] own) {
    var set = new System.Collections.Generic.HashSet<long>();
    try {
      IntPtr h = GetTopWindow(IntPtr.Zero);
      int guard = 0;
      while (h != IntPtr.Zero && guard < 1000) {
        if (IsCandidate(h, own)) set.Add(h.ToInt64());
        h = GetWindow(h, 2);
        guard++;
      }
    } catch (Exception) { }
    return set;
  }

  public static string Run(string dir, long[] own, long recorded, bool waitNew, long[] used, bool acceptExisting) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }

    IntPtr target = IntPtr.Zero;
    int start = Environment.TickCount;
    // マルチ操作で複数のアプリ・ウィンドウを開いて連続で分割する場合、LINEやメモ帳のような
    // 起動・表示に時間がかかるアプリでも取りこぼさないよう、待つ時間には余裕を持たせる。
    int limit = waitNew ? 12000 : 0;
    // 待ち始める前から画面にあった候補ウィンドウは「新しいウィンドウ」として採用しない
    // （詳細はnative-snap.jsのcollectPreExisting参照）。ただしacceptExisting指定時は行わない。
    var preExisting = (waitNew && !acceptExisting) ? CollectPreExisting(own) : null;
    // 直前の動作で開いたウィンドウが前面に出てくるまで待つ（マルチ操作のときのみ）。
    // Launch-K自身や、このマルチ操作の中ですでに配置済みのウィンドウ（used）が前面にいる間は
    // 「まだ新しいウィンドウが来ていない」とみなす。
    while (true) {
      IntPtr fg0 = GetForegroundWindow();
      if (IsCandidate(fg0, own) && !(waitNew && IsUsed(fg0, used)) && !(waitNew && !acceptExisting && preExisting.Contains(fg0.ToInt64()))) { target = fg0; break; }
      if (Environment.TickCount - start >= limit) break;
      System.Threading.Thread.Sleep(30);
    }
    // 新しいウィンドウを検出した直後は、アプリ自身が起動処理の途中で位置・大きさを
    // 変えることがある（その場合、配置してもすぐ上書きされてしまう）。固定の待ち時間の代わりに、
    // 位置・大きさが一定になる（50msごとに3回連続で同じ）まで、最大0.6秒だけ待つ。
    if (waitNew && target != IntPtr.Zero) {
      RECT prev; RECT cur;
      if (GetWindowRect(target, out prev)) {
        int stable = 0;
        int t0 = Environment.TickCount;
        while (stable < 3 && Environment.TickCount - t0 < 600) {
          System.Threading.Thread.Sleep(50);
          if (!GetWindowRect(target, out cur)) break;
          if (cur.Left == prev.Left && cur.Top == prev.Top && cur.Right == prev.Right && cur.Bottom == prev.Bottom) stable++;
          else { stable = 0; prev = cur; }
        }
      }
      // 待っている間に閉じられた（スプラッシュ画面など）場合は、以降の探し直しに回す
      if (!IsWindow(target)) target = IntPtr.Zero;
    }
    IntPtr fg = GetForegroundWindow();
    // 重要：waitNewのときは、時間切れになっても「すでに配置済みのウィンドウ」には
    // 絶対にフォールバックしない。ここで除外しないと、例えば同じブラウザで新しい
    // ウィンドウが実際には開かれず（タブとして既存ウィンドウに吸収された等）、
    // すでに右半分へ配置したウィンドウを誤って左半分へ動かしてしまい、
    // 「2つのタブが1つのウィンドウにまとまる」ように見える不具合になっていた。
    if (target == IntPtr.Zero && IsCandidate(fg, own) && !(waitNew && IsUsed(fg, used)) && !(waitNew && !acceptExisting && preExisting.Contains(fg.ToInt64()))) target = fg;
    if (target == IntPtr.Zero) {
      IntPtr from = IsOwn(fg, own) ? fg : (own.Length > 0 ? new IntPtr(own[0]) : IntPtr.Zero);
      if (from != IntPtr.Zero) {
        IntPtr h = GetWindow(from, 2);
        int guard = 0;
        while (h != IntPtr.Zero && guard < 400) {
          // GW_OWNER持ちの除外はIsCandidate内で行うようになったため、ここでの重複チェックは不要
          if (IsCandidate(h, own) && !(waitNew && IsUsed(h, used)) && !(waitNew && !acceptExisting && preExisting.Contains(h.ToInt64()))) { target = h; break; }
          h = GetWindow(h, 2);
          guard++;
        }
      }
    }
    if (target == IntPtr.Zero && recorded != 0) {
      IntPtr r = new IntPtr(recorded);
      // JS版と同じく、recordedもpreExisting除外の対象にする（acceptExisting指定時は例外）
      if (IsCandidate(r, own) && !(waitNew && IsUsed(r, used)) && !(waitNew && !acceptExisting && preExisting.Contains(r.ToInt64()))) target = r;
    }
    if (target == IntPtr.Zero) return "ERR:notarget";

    if (IsZoomed(target)) ShowWindow(target, 9);

    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    IntPtr mon = MonitorFromWindow(target, 2);
    if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref mi)) return "ERR:monitor";
    int L = mi.rcWork.Left, T = mi.rcWork.Top;
    int W = mi.rcWork.Right - mi.rcWork.Left, H = mi.rcWork.Bottom - mi.rcWork.Top;
    int halfW = W / 2, halfH = H / 2;
    int x = L, y = T, w = W, hh = H;
    switch (dir) {
      case "left": w = halfW; break;
      case "right": x = L + halfW; w = W - halfW; break;
      case "top-left": w = halfW; hh = halfH; break;
      case "top-right": x = L + halfW; w = W - halfW; hh = halfH; break;
      case "bottom-left": y = T + halfH; w = halfW; hh = H - halfH; break;
      case "bottom-right": x = L + halfW; y = T + halfH; w = W - halfW; hh = H - halfH; break;
      default: return "ERR:dir";
    }
    // Windows10/11のウィンドウは、見た目の外側に見えない影の枠を持つため、その分を補正して
    // 画面（作業領域）にぴったり・隣のウィンドウと重ならないように配置する。
    RECT wr; RECT fr;
    int dl = 0, dt = 0, dr = 0, db = 0;
    if (GetWindowRect(target, out wr) && DwmGetWindowAttributeRect(target, 9, out fr, Marshal.SizeOf(typeof(RECT))) == 0) {
      dl = fr.Left - wr.Left; dt = fr.Top - wr.Top; dr = wr.Right - fr.Right; db = wr.Bottom - fr.Bottom;
    }
    x -= dl; y -= dt; w += dl + dr; hh += dt + db;
    // SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)
    if (!SetWindowPos(target, IntPtr.Zero, x, y, w, hh, 0x4 | 0x10)) return "ERR:setpos";
    SetForegroundWindow(target);
    return "OK:" + target.ToInt64().ToString();
  }
}
`;
// このマルチ操作の中ですでに配置（分割）したウィンドウのhwnd一覧。
// waitForNewで新しいウィンドウを待つときに、これらへ誤って再フォールバックしないよう
// PowerShell側に渡して除外する（「新しいウィンドウのつもりが、既に配置済みの
// ウィンドウが動かされてしまう」不具合の対策）。マルチ操作の最初の分割（fresh）で
// リセットする。
let usedSnapHwnds = [];
let snapQueue = Promise.resolve();
// 画面分割用C#クラス（SnapWin）の定義スクリプト。先読み（prewarmSnapType）と通常実行で共有する。
const SNAP_DEF_SCRIPT = "Add-Type -TypeDefinition @'\n" + SNAP_WINDOW_CS + "\n'@\n";
// 型が本当に定義できたかをPowerShell自身に確かめさせる（失敗を「読み込み済み」と誤認しないため）
const SNAP_DEF_CHECK = "[bool]('SnapWin' -as [type])";
function prewarmSnapType() {
  if (!multiPsProcess) return;
  if (multiPsLoadedTypes.has("SnapWin") || multiPsPendingDefs.has("SnapWin")) return;
  const proc = multiPsProcess;
  const p = runInMultiPsSession(SNAP_DEF_SCRIPT + SNAP_DEF_CHECK, SNAP_PS_TIMEOUT_MS)
    .then((stdout) => {
      // 同じセッションのままで、かつ定義に成功したときだけ「読み込み済み」にする
      if (multiPsProcess === proc && /True/.test(String(stdout || ""))) multiPsLoadedTypes.add("SnapWin");
    })
    .catch(() => {}) // 失敗しても、通常の画面分割が自分で定義するので何もしない
    .then(() => { if (multiPsPendingDefs.get("SnapWin") === p) multiPsPendingDefs.delete("SnapWin"); });
  multiPsPendingDefs.set("SnapWin", p);
}
async function snapWindowDirect(direction, waitForNew, usedHwnds, acceptExisting) {
  const own = [mainWindow, timerWindow, guideWindow, tooltipWindow, ...pageWindows.values()].map(getNativeHwnd).filter((h) => h !== null);
  // まずkoffiによるネイティブ実装を試す（PowerShell起動もコンパイルも挟まないため高速）。
  // ここで何か想定外のエラーが起きた場合だけ、下の従来方式（PowerShell）にフォールバックする。
  if (nativeSnap.available) {
    try {
      const res = await nativeSnap.run(direction, own, Number(lastExternalHwnd) || 0, !!waitForNew, usedHwnds || [], !!acceptExisting);
      return res;
    } catch (e) {
      // 何もしない：このまま下の従来方式へフォールバック
    }
  }
  const usedList = (usedHwnds || []).join(",");
  const defScript = SNAP_DEF_SCRIPT;
  const callScript = `[SnapWin]::Run('${direction}', [long[]]@(${own.join(",")}), ${Number(lastExternalHwnd) || 0}, ${waitForNew ? "$true" : "$false"}, [long[]]@(${usedList}), ${acceptExisting ? "$true" : "$false"})`;

  // 先読み中なら、その完了を待つ（二重定義を避ける。待ち中に先読みが終わっていればすぐ進む）
  if (multiPsProcess) {
    const pending = multiPsPendingDefs.get("SnapWin");
    if (pending) await pending;
  }
  if (multiPsProcess) {
    const needsDef = !multiPsLoadedTypes.has("SnapWin");
    const body = (needsDef ? defScript : "") + callScript;
    // 新しいウィンドウを待つ場合は、待機時間（最大7秒）を見込んだ長めのタイムアウトを使う
    return runInMultiPsSession(body, waitForNew ? SNAP_PS_TIMEOUT_MS : undefined)
      .then((stdout) => {
        // OK:/ERR: が返ってきた＝クラスが実際に使えた。何も返らないときは定義に失敗している可能性があるので登録しない
        if (needsDef && /(OK|ERR):/.test(String(stdout || ""))) multiPsLoadedTypes.add("SnapWin");
        const m = /OK:(\d+)/.exec(String(stdout || ""));
        if (m) return { ok: true, hwnd: Number(m[1]) };
        return { ok: false };
      })
      .catch(() => snapWindowDirectFallback(defScript, callScript));
  }
  return snapWindowDirectFallback(defScript, callScript);
}
// セッションが使えない場合の従来方式（-EncodedCommandでの都度exec起動）。挙動は変更していない。
function snapWindowDirectFallback(defScript, callScript) {
  const script = defScript + callScript;
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
      { timeout: 20000, windowsHide: true }, // SNAP_WAIT_LIMIT_MS(12秒)延長に合わせて、待ちきる前にタイムアウトしないよう調整
      (error, stdout) => {
        const m = /OK:(\d+)/.exec(String(stdout || ""));
        if (m) return resolve({ ok: true, hwnd: Number(m[1]) });
        resolve({ ok: false });
      }
    );
  });
}
function runSnapAction(direction, opts) {
  if (process.platform !== "win32") return Promise.resolve("この機能は現在Windowsのみ対応しています");
  const codes = {
    left: [0x25],
    right: [0x27],
    "top-left": [0x25, 0x26],
    "top-right": [0x27, 0x26],
    "bottom-left": [0x25, 0x28],
    "bottom-right": [0x27, 0x28],
  };
  const code = codes[direction];
  if (!code) return Promise.resolve("不明な操作です");
  const waitForNew = !!(opts && opts.waitForNew);
  const acceptExisting = !!(opts && opts.acceptExisting);
  const fresh = !!(opts && opts.fresh);
  if (fresh) usedSnapHwnds = [];
  // 連打・マルチ操作でも1つずつ順番に処理し、同時に走って配置が混線しないようにする
  const job = snapQueue.then(async () => {
    const res = await snapWindowDirect(direction, waitForNew, usedSnapHwnds, acceptExisting);
    if (res.ok) {
      if (usedSnapHwnds.indexOf(res.hwnd) === -1) usedSnapHwnds.push(res.hwnd);
      return null;
    }
    // 直接配置できなかった場合（管理者権限のアプリなど、または新しいウィンドウを
    // 見つけられなかった場合）のみ、従来のキー送信方式で試す
    await restoreExternalFocus();
    const fallbackErr = await pressSnapKeys(code);
    if (fallbackErr) return fallbackErr;
    if (waitForNew) return "新しく開いたウィンドウを検出できなかったため、直前のウィンドウに対して分割操作を行いました";
    return null;
  });
  snapQueue = job.catch(() => {});
  return job;
}
ipcMain.handle("system:snap", (event, direction, opts) => runSnapAction(direction, opts));

// ---- 画面の拡大・縮小（Ctrl+ / Ctrl- 相当）----
// VK_CONTROL=0x11, VK_OEM_PLUS=0xBB, VK_OEM_MINUS=0xBD
const ZOOM_KEY_CODES = { in: 0xbb, out: 0xbd };
function pressZoomKeys(keyCode, count) {
  const n = Math.max(1, Math.min(5, Number(count) || 1));
  if (native.available) {
    // Ctrlを押したまま対象キーをn回押して離し、最後にCtrlを離す。
    // 途中で失敗しても、Ctrlキーが押しっぱなしのまま残ってしまう（＝以降の
    // ユーザー操作すべてにCtrlがかかり続ける）方がPowerShell側との二重送信より
    // 実害が大きいため、成否に関わらずkeyUpだけは必ず試みる。
    let ok = native.keyDown(0x11);
    for (let i = 0; i < n; i++) {
      if (!native.pressKey(keyCode)) ok = false;
    }
    if (!native.keyUp(0x11)) ok = false;
    if (ok) return Promise.resolve(null);
    // 失敗時のみPowerShell側でも実行するため、稀にCtrl+キーが二重に送られる
    // 可能性はあるが、上記の理由によりrelease優先とする。
  }
  const presses = Array.from(
    { length: n },
    () => `[ZoomHelper]::keybd_event(${keyCode}, 0, 0, [UIntPtr]::Zero); [ZoomHelper]::keybd_event(${keyCode}, 0, 2, [UIntPtr]::Zero);`
  ).join(" ");
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class ZoomHelper { " +
    "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; ";
  const callScript =
    "[ZoomHelper]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); " +
    presses +
    "[ZoomHelper]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);";
  return runPsSmart("ZoomHelper", defScript, callScript).then(({ error, stderr }) =>
    error ? (stderr && stderr.toString()) || error.message : null
  );
}
ipcMain.handle("system:zoom", async (event, direction, count) => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  const code = ZOOM_KEY_CODES[direction];
  if (!code) return "不明な操作です";
  // Launch-K自身ではなく、直前まで使っていたウィンドウをズーム対象にするため、
  // キーを送る前にそのウィンドウを前面に戻す。
  await restoreExternalFocus();
  return await pressZoomKeys(code, count);
});

// ---- 画面の明るさ調整（対応しているノートPCの内蔵ディスプレイのみ）----
function adjustBrightness(delta) {
  const callScript =
    "$ErrorActionPreference='Stop'; " +
    "try { " +
    "$cur = (Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness | Select-Object -First 1 -ExpandProperty CurrentBrightness); " +
    `$new = [Math]::Max(0, [Math]::Min(100, $cur + (${delta}))); ` +
    "(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods | Select-Object -First 1).WmiSetBrightness(1, $new); " +
    // 変化がなかった＝すでに上限/下限だったかどうかを判定して出力する
    "if ($new -eq $cur) { Write-Output 'CLAMPED' } else { Write-Output 'OK' }" +
    "} catch { Write-Error $_.Exception.Message }";
  return runPsSmart(null, "", callScript).then(({ error, stdout }) => {
    const out = String(stdout || "");
    // セッション経由の場合、Write-Errorの内容は拾えないため、成功マーカー
    // (OK/CLAMPED)が出力に含まれるかどうかで成否を判定する（execのerror有無だけに頼らない）。
    if (error || (!out.includes("OK") && !out.includes("CLAMPED"))) {
      return "このPCでは明るさ調整に対応していない可能性があります";
    } else if (out.includes("CLAMPED")) {
      return "明るさはすでに上限（または下限）です";
    }
    return null;
  });
}
ipcMain.handle("system:brightness", async (event, delta) => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  return await adjustBrightness(delta);
});

// ---- メディア操作（再生/一時停止・次/前の曲）----
// VK_MEDIA_NEXT_TRACK=0xB0, VK_MEDIA_PREV_TRACK=0xB1, VK_MEDIA_PLAY_PAUSE=0xB3
const MEDIA_KEY_CODES = { playpause: 0xb3, next: 0xb0, prev: 0xb1 };
function pressMediaKey(code) {
  if (native.available && native.pressKey(code)) {
    return Promise.resolve(null);
  }
  const defScript =
    "Add-Type -Language CSharp -TypeDefinition " +
    "'using System; using System.Runtime.InteropServices; " +
    "public class MediaHelper { " +
    "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; ";
  const callScript = `[MediaHelper]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero); [MediaHelper]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero);`;
  return runPsSmart("MediaHelper", defScript, callScript).then(({ error, stderr }) =>
    error ? (stderr && stderr.toString()) || error.message : null
  );
}
ipcMain.handle("system:media", async (event, action) => {
  if (process.platform !== "win32") return "この機能は現在Windowsのみ対応しています";
  const code = MEDIA_KEY_CODES[action];
  if (!code) return "不明な操作です";
  return await pressMediaKey(code);
});

// ---- ミュートの操作と状態の取得（マイク／スピーカー）----
// Windowsには音量ミュートのようなVK（仮想キー）がマイク用には存在しないため、
// Core Audio APIのIAudioEndpointVolumeインターフェースをPowerShell経由のC#で直接呼び出す。
// 同じC#で、マイクとスピーカーの「いまの実際のミュート状態」も読み取る
// （アイコンの「ミュート中」表示を、押した回数からの推測ではなく実際の状態に合わせるため）。
const CORE_AUDIO_CS =
  "using System; using System.Runtime.InteropServices; " +
  // IMMDeviceEnumerator と IAudioEndpointVolume のGUIDが取り違えられていたのが
  // 「E_NOINTERFACE / InvalidCastException」の原因だった。
  // 正しくは IMMDeviceEnumerator = A95664D2-9614-4F35-A746-DE8DB63617E6、
  // IAudioEndpointVolume = 5CDF2C82-841E-4546-9722-0CF74078229A（Windows SDK定義）。
  "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] " +
  "interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice); } " +
  "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] " +
  "interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev); } " +
  "[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] " +
  "interface IAudioEndpointVolume { int NotImpl1(); int NotImpl2(); int GetChannelCount(out int c); " +
  "int SetMasterVolumeLevel(float l, Guid g); int SetMasterVolumeLevelScalar(float l, Guid g); " +
  "int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l); " +
  "int SetChannelVolumeLevel(int ch, float l, Guid g); int SetChannelVolumeLevelScalar(int ch, float l, Guid g); " +
  "int GetChannelVolumeLevel(int ch, out float l); int GetChannelVolumeLevelScalar(int ch, out float l); " +
  "int SetMute(bool m, Guid g); int GetMute(out bool m); } " +
  "[ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumeratorComObject { } " +
  "public class AudioMuteHelper { " +
  // dataFlow: 0=再生（スピーカー）, 1=録音（マイク）／role: 0=eConsole, 1=eMultimedia
  "static IAudioEndpointVolume VolFor(int flow, int role) { " +
  "var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); IMMDevice dev; " +
  "Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(flow, role, out dev)); " +
  "IAudioEndpointVolume epv; var epvId = typeof(IAudioEndpointVolume).GUID; " +
  "Marshal.ThrowExceptionForHR(dev.Activate(ref epvId, 23, IntPtr.Zero, out epv)); return epv; } " +
  "public static bool ToggleMicMute() { var epv = VolFor(1, 1); bool muted; epv.GetMute(out muted); epv.SetMute(!muted, Guid.Empty); return !muted; } " +
  // 1=ミュート中, 0=ミュートなし, -1=取得できなかった（デバイスが無いなど）
  "public static int GetMuteState(int flow, int role) { try { var epv = VolFor(flow, role); bool m; epv.GetMute(out m); return m ? 1 : 0; } catch { return -1; } } }";
const CORE_AUDIO_DEF_SCRIPT = `Add-Type -Language CSharp -TypeDefinition '${CORE_AUDIO_CS.replace(/'/g, "''")}'; `;

function toggleMicMute() {
  const defScript = CORE_AUDIO_DEF_SCRIPT;
  // $ErrorActionPreference='Stop'を付けて明示的にtry/catchすることで、セッション経由でも
  // 例外発生時に必ず「ERROR:メッセージ」という判定可能な文字列が出力されるようにする
  // （元々はexecの成否だけを見ていたが、セッション経由ではその判定方法が使えないため）。
  const callScript =
    "$ErrorActionPreference='Stop'; try { " +
    "if ([AudioMuteHelper]::ToggleMicMute()) { Write-Output 'MUTED' } else { Write-Output 'UNMUTED' } " +
    "} catch { Write-Output ('ERROR:' + $_.Exception.Message) }";
  return runPsSmart("AudioMuteHelper", defScript, callScript).then(({ error, stderr, stdout }) => {
    const out = String(stdout || "");
    if (error) return { error: (stderr && stderr.toString()) || error.message };
    if (out.includes("ERROR:")) return { error: out.slice(out.indexOf("ERROR:") + 6).trim() };
    // MUTED/UNMUTEDのどちらのマーカーも無い＝想定外の応答なので、必ずエラー扱いにする
    // （セッション経由で万一マーカーを取りこぼしても、誤って成功扱いにしないための安全策）。
    if (!out.includes("MUTED") && !out.includes("UNMUTED")) {
      return { error: "マイクの操作に失敗しました（応答を確認できませんでした）" };
    }
    return { muted: out.includes("MUTED") && !out.includes("UNMUTED") };
  });
}
ipcMain.handle("system:mic", async () => {
  if (process.platform !== "win32") return { error: "この機能は現在Windowsのみ対応しています" };
  return await toggleMicMute();
});

// スピーカーとマイクの「いまの実際のミュート状態」を返す。分からないものは null。
// 例）{ speaker: true, mic: false }
async function readMuteStates() {
  const callScript =
    "$ErrorActionPreference='Stop'; try { " +
    "Write-Output ('SPK=' + [AudioMuteHelper]::GetMuteState(0, 0) + ';MIC=' + [AudioMuteHelper]::GetMuteState(1, 1)) " +
    "} catch { Write-Output ('ERROR:' + $_.Exception.Message) }";
  const { error, stdout } = await runPsSmart("AudioMuteHelper", CORE_AUDIO_DEF_SCRIPT, callScript);
  const out = String(stdout || "");
  const spk = /SPK=(-?\d)/.exec(out);
  const mic = /MIC=(-?\d)/.exec(out);
  // クラスの読み込みに失敗した場合などは、どちらの値も返らない（＝分からない）
  if (error || (!spk && !mic)) return { speaker: null, mic: null };
  const toBool = (m) => (m && m[1] === "1" ? true : m && m[1] === "0" ? false : null);
  return { speaker: toBool(spk), mic: toBool(mic) };
}
ipcMain.handle("audio:getMuteStates", async () => {
  if (process.platform !== "win32") return { speaker: null, mic: null };
  try {
    return await readMuteStates();
  } catch (e) {
    return { speaker: null, mic: null };
  }
});

// ---- ネイティブの色選択ポップアップなど、このウィンドウ自身が開く別ウィンドウが
// 「常に最前面」設定に隠されてしまわないよう、開く直前に一時停止する ----
ipcMain.handle("window:suspendAlwaysOnTop", () => {
  suspendAlwaysOnTopReassert = true;
  if (mainWindow) mainWindow.setAlwaysOnTop(false);
  return true;
});

// ---- 選んだアプリ／ファイルのアイコンを自動取得（「アプリ」タイル用）----
// LINEやMicrosoft 365版PowerPointなど、Windowsストア（UWP/Appx）版のアプリは
// デスクトップの.lnkが実体のexeではなく「explorer.exe shell:AppsFolder\...」を
// 指しているため、Electron標準のapp.getFileIcon()では実アイコンが取得できず、
// 汎用の「アイコンなしショートカット」画像になってしまう。
// そこでまずPowerShell(get-icon.ps1)で.lnkの中身を調べ、必要なら
// shell:AppsFolder\<パッケージID> 形式に変換したうえでIShellItemImageFactory
// 経由の高解像度アイコン取得を試み、失敗した場合のみ従来の方法にフォールバックする。
function getRobustFileIconDataUrl(targetPath, size) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ICON_SCRIPT_PATH, "-Path", targetPath, "-Size", String(size || 256)],
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const b64 = String(stdout || "").trim();
        resolve(b64 ? `data:image/png;base64,${b64}` : null);
      }
    );
  });
}
ipcMain.handle("shell:getFileIcon", async (event, targetPath) => {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return null;
    if (process.platform === "win32") {
      const robust = await getRobustFileIconDataUrl(targetPath, 256);
      if (robust) return robust;
    }
    const icon = await app.getFileIcon(targetPath, { size: "large" });
    if (!icon || icon.isEmpty()) return null;
    return icon.toDataURL();
  } catch (e) {
    return null;
  }
});

// ---- タイマー専用のミニウィンドウ ----
// ・ハンバーガーメニューなしのシンプルな専用画面
// ・ロック（常に最前面）は既定でオン
// ・鳴ったら音でお知らせする（音自体はレンダラー側でWeb Audioにより生成）
let timerWindow = null;
let timerAlwaysOnTopEnabled = true; // タイマー画面側のロック状態をメインプロセス側でも把握しておく
let timerSuspendReassert = false; // ネイティブの色選択ポップアップ表示中など、一時的にロック再適用を止めるためのフラグ
function createOrShowTimerWindow(seconds) {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.show();
    timerWindow.focus();
    if (seconds) timerWindow.webContents.send("timer:start", Math.max(1, Math.round(Number(seconds))));
    return;
  }
  timerWindow = new BrowserWindow({
    width: 300,
    height: 390,
    minWidth: 230,
    minHeight: 300,
    resizable: true, // ウィンドウ比率に応じて文字サイズが追従するようにするため、サイズ変更を許可
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true, // ロックの初期設定はオン
    frame: false,
    show: false,
    title: "タイマー",
    icon: process.platform === "win32" ? path.join(__dirname, "assets", "icon.ico") : undefined,
    webPreferences: {
      preload: path.join(__dirname, "timer-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  timerWindow.setMenuBarVisibility(false);
  timerWindow.loadFile("timer.html");
  timerWindow.once("ready-to-show", () => timerWindow.show());
  // 常に最前面ロック中でも、このウィンドウ自身が開くネイティブの色選択ポップアップなどが
  // 裏に隠れてしまわないよう、メインウィンドウと同じ仕組み（一時停止→再フォーカスで再適用）を用意する。
  timerWindow.on("blur", () => {
    if (timerAlwaysOnTopEnabled && timerWindow && !timerSuspendReassert) {
      timerWindow.setAlwaysOnTop(true, "screen-saver");
    }
  });
  timerWindow.on("focus", () => {
    if (timerSuspendReassert) {
      timerSuspendReassert = false;
      if (timerAlwaysOnTopEnabled && timerWindow) timerWindow.setAlwaysOnTop(true, "screen-saver");
    }
  });
  // 時間の指定がある場合だけ強制的にその時間で開始する。指定がなければ、
  // タイマー画面側が自分の状態（前回の続き・既定の5分）をそのまま復元する。
  if (seconds) {
    timerWindow.webContents.once("did-finish-load", () => {
      timerWindow.webContents.send("timer:start", Math.max(1, Math.round(Number(seconds))));
    });
  }
  timerWindow.on("closed", () => { timerWindow = null; });
}
ipcMain.handle("timer:open", (event, seconds) => {
  createOrShowTimerWindow(seconds);
  return true;
});
ipcMain.on("timer:setAlwaysOnTop", (event, val) => {
  timerAlwaysOnTopEnabled = !!val;
  if (timerWindow && !timerWindow.isDestroyed()) timerWindow.setAlwaysOnTop(!!val, "screen-saver");
});
ipcMain.handle("timer:suspendAlwaysOnTop", () => {
  timerSuspendReassert = true;
  if (timerWindow && !timerWindow.isDestroyed()) timerWindow.setAlwaysOnTop(false);
  return true;
});
ipcMain.on("timer:close", () => {
  if (timerWindow && !timerWindow.isDestroyed()) timerWindow.close();
});

// ---- 「使い方」専用のミニウィンドウ ----
// ・テキストのみのシンプルな専用画面（ハンバーガーメニューなし）
// ・ロック（常に最前面）は、メインウィンドウと同じ仕様で既定オフ
let guideWindow = null;
function createOrShowGuideWindow() {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.show();
    guideWindow.focus();
    return;
  }
  guideWindow = new BrowserWindow({
    width: 420,
    height: 480,
    minWidth: 280,
    minHeight: 260,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false, // メインウィンドウと同じく、ロックの初期設定はオフ
    frame: false,
    show: false,
    title: "使い方",
    icon: process.platform === "win32" ? path.join(__dirname, "assets", "icon.ico") : undefined,
    webPreferences: {
      preload: path.join(__dirname, "guide-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  guideWindow.setMenuBarVisibility(false);
  guideWindow.loadFile("guide.html");
  guideWindow.once("ready-to-show", () => guideWindow.show());
  guideWindow.on("closed", () => { guideWindow = null; });
}
ipcMain.handle("guide:open", () => {
  createOrShowGuideWindow();
  return true;
});
ipcMain.on("guide:setAlwaysOnTop", (event, val) => {
  if (guideWindow && !guideWindow.isDestroyed()) guideWindow.setAlwaysOnTop(!!val, "screen-saver");
});
ipcMain.on("guide:close", () => {
  if (guideWindow && !guideWindow.isDestroyed()) guideWindow.close();
});

// ---- フォルダ選択ダイアログ ----
ipcMain.handle("dialog:pickFolder", async () => {
  const wasAlwaysOnTop = !!(mainWindow && mainWindow.isAlwaysOnTop());
  let result;
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    mainWindow.setAlwaysOnTop(wasAlwaysOnTop, "screen-saver");
  } else {
    result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  }
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- グローバルショートカット ----
ipcMain.handle("hotkeys:register", (event, list) => {
  globalShortcut.unregisterAll();
  const failed = [];
  (list || []).forEach(({ id, accelerator }) => {
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (mainWindow) mainWindow.webContents.send("hotkey:triggered", id);
      });
      if (!ok) failed.push(accelerator);
    } catch (e) {
      failed.push(accelerator);
    }
  });
  return failed;
});

// ---- スクリーンショット（範囲を選んで、そのままアイコン／背景に使う）----
// 流れ：Launch-Kの窓を一時的に隠す → 画面を撮る → 全画面の選択用ウィンドウ（capture.html）に
//       固まった画面を出してドラッグで範囲を選ばせる → 切り抜いて用途に合わせて整える → 窓を元に戻す。
//   kind="icon"       : 正方形で選ばせ、最大256pxのPNG(data URL)にする（既存のアプリアイコン取得と同じ形式）。
//   kind="background" : メインウィンドウと同じ縦横比で選ばせ（Shiftで自由）、userData/backgrounds に保存してパスを返す。
const BG_DIR = path.join(app.getPath("userData"), "backgrounds");
const ICON_CAPTURE_SIZE = 256;
const BG_CAPTURE_MAX_WIDTH = 2560;
let captureBusy = false;

function runCaptureSelector(display, jpegDataUrl, aspect, hint) {
  return new Promise((resolve) => {
    const b = display.bounds;
    const sel = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false,
      backgroundColor: "#000000",
      webPreferences: {
        preload: path.join(__dirname, "capture-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    sel.setAlwaysOnTop(true, "screen-saver");
    sel.setBounds(b); // 拡大率の異なる別モニターでも位置・大きさがずれないよう、作成後にもう一度指定する
    let settled = false;
    let fallbackTimer = null;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      ipcMain.removeListener("capture:done", onDone);
      ipcMain.removeListener("capture:ready", onReady);
      if (!sel.isDestroyed()) sel.destroy();
      resolve(rect || null);
    };
    const showSel = () => { if (!sel.isDestroyed() && !sel.isVisible()) { sel.show(); sel.focus(); } };
    const onDone = (event, rect) => { if (event.sender === sel.webContents) finish(rect); };
    const onReady = (event) => { if (event.sender === sel.webContents) showSel(); };
    ipcMain.on("capture:done", onDone);
    ipcMain.on("capture:ready", onReady);
    sel.on("closed", () => finish(null));
    // 画像の読み込みが何らかの理由で通知されなくても、操作不能のまま残らないようにする
    fallbackTimer = setTimeout(showSel, 2500);
    sel.webContents.on("did-finish-load", () => {
      sel.webContents.send("capture:init", { image: jpegDataUrl, aspect, hint });
    });
    sel.loadFile("capture.html");
  });
}

ipcMain.handle("capture:screen", async (event, kind) => {
  if (captureBusy) return { error: "すでにスクリーンショットの範囲選択中です" };
  if (kind !== "icon" && kind !== "background") return { error: "不明な用途です" };
  captureBusy = true;

  // 撮影中に映り込まないよう、表示中の自分のウィンドウをいったん隠す。
  // 比率や「編集中の画面に戻す」対象は、呼び出し元のウィンドウ（メイン／ページ別画面）を優先する。
  const callerWin = BrowserWindow.fromWebContents(event.sender);
  const refWin = (callerWin && !callerWin.isDestroyed()) ? callerWin : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  const display = refWin ? screen.getDisplayMatching(refWin.getBounds()) : screen.getPrimaryDisplay();
  let aspect = 1;
  if (kind === "background") {
    const [cw, ch] = refWin ? refWin.getContentSize() : [960, 680];
    aspect = ch > 0 ? cw / ch : 960 / 680;
  }
  const hidden = [mainWindow, timerWindow, guideWindow, ...pageWindows.values()].filter((w) => w && !w.isDestroyed() && w.isVisible());
  const refWasHidden = !!refWin && hidden.includes(refWin);
  try {
    hideTooltip(true);
    hidden.forEach((w) => w.hide());
    await new Promise((r) => setTimeout(r, 300)); // 画面から実際に消えるのを待つ

    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
    });
    const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[idx] || sources[0];
    if (!source || source.thumbnail.isEmpty()) return { error: "画面を取得できませんでした" };
    const thumb = source.thumbnail;

    const hint = kind === "icon"
      ? "ドラッグで正方形の範囲を選択　／　Enterで画面全体　／　Escでキャンセル"
      : "ドラッグで範囲を選択（アプリと同じ比率・Shiftで自由）　／　Enterで画面全体　／　Escでキャンセル";
    const jpeg = "data:image/jpeg;base64," + thumb.toJPEG(88).toString("base64");
    const rect = await runCaptureSelector(display, jpeg, aspect, hint);
    if (!rect) return null; // キャンセル

    const size = thumb.getSize();
    const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x * size.width)));
    const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y * size.height)));
    const w = Math.max(1, Math.min(size.width - x, Math.round(rect.w * size.width)));
    const h = Math.max(1, Math.min(size.height - y, Math.round(rect.h * size.height)));
    let img = thumb.crop({ x, y, width: w, height: h });

    if (kind === "icon") {
      // アイコン枠は正方形（object-fit: cover）なので、あらかじめ正方形の中央で切り抜いて表示と一致させる
      const s = img.getSize();
      const side = Math.min(s.width, s.height);
      if (s.width !== s.height) {
        img = img.crop({ x: Math.floor((s.width - side) / 2), y: Math.floor((s.height - side) / 2), width: side, height: side });
      }
      const target = Math.min(ICON_CAPTURE_SIZE, side); // 小さい範囲を無理に拡大しない
      if (side !== target) img = img.resize({ width: target, height: target, quality: "best" });
      return { dataUrl: img.toDataURL() };
    }

    const s = img.getSize();
    if (s.width > BG_CAPTURE_MAX_WIDTH) img = img.resize({ width: BG_CAPTURE_MAX_WIDTH, quality: "best" });
    fs.mkdirSync(BG_DIR, { recursive: true });
    const fileName = `bg-${Date.now()}.png`;
    const filePath = path.join(BG_DIR, fileName);
    fs.writeFileSync(filePath, img.toPNG());
    // 撮り直しのたびにファイルが溜まらないよう、古い背景ファイルを削除する。
    // ただし、ページごとに別々の背景画像を持てるようになったため、他のページで
    // 今まさに使われているファイルまで消してしまわないよう、現在いずれかの
    // ページで参照中のファイル名は削除対象から除外する。
    try {
      const s = loadSettings();
      const inUse = new Set(
        (Array.isArray(s.pageThemes) ? s.pageThemes : [])
          .map((pt) => pt && pt.bgImagePath)
          .filter(Boolean)
          .map((p) => path.basename(p))
      );
      for (const f of fs.readdirSync(BG_DIR)) {
        if (f !== fileName && /^bg-\d+\.png$/.test(f) && !inUse.has(f)) {
          try { fs.unlinkSync(path.join(BG_DIR, f)); } catch {}
        }
      }
    } catch {}
    return { path: filePath };
  } catch (e) {
    return { error: "スクリーンショットに失敗しました：" + (e && e.message ? e.message : e) };
  } finally {
    // 隠していたウィンドウを戻す。呼び出し元のウィンドウは前面に出して、編集中の画面にそのまま戻れるようにする
    hidden.forEach((w) => { if (!w.isDestroyed() && w !== refWin) w.showInactive(); });
    if (refWasHidden && refWin && !refWin.isDestroyed()) { refWin.show(); refWin.focus(); }
    captureBusy = false;
  }
});

// ---- 全データの初期化（リセット） ----
ipcMain.handle("app:reset", (event) => {
  globalShortcut.unregisterAll();
  try { saveTiles([]); } catch (e) {}
  try { saveSettings({ ...DEFAULT_SETTINGS }); } catch (e) {}
  try { fs.rmSync(BG_DIR, { recursive: true, force: true }); } catch (e) {}
  applySettings(DEFAULT_SETTINGS);
  // 初期化するとページは1つに戻るため、ページ別画面として開いていたウィンドウは全て閉じる。
  for (const w of pageWindows.values()) { if (w && !w.isDestroyed()) w.close(); }
  pageWindows.clear();
  for (const w of allAppWindows()) {
    if (w.webContents !== event.sender) { w.webContents.send("tiles:changed"); w.webContents.send("settings:changed"); }
  }
  return true;
});

// ---- 設定のバックアップ／復元 ----
ipcMain.handle("backup:export", async (event, data, defaultName) => {
  // 画面単体のバックアップでは「mission-deck-screen2.json」のような名前を初期値にする（安全な文字だけ許可）
  const safeName = typeof defaultName === "string" && /^[\w.\-]{1,60}\.json$/.test(defaultName) ? defaultName : "mission-deck-backup.json";
  const result = await dialog.showSaveDialog({
    defaultPath: safeName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return "キャンセルされました";
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), "utf-8");
    return null;
  } catch (e) {
    return e.message;
  }
});

// バックアップJSONは外部ファイル（第三者から受け取ったものを含む）由来のため、
// 中身は信用しない前提で最低限の形だけをここで保証する。個々のタイルのフィールドは
// 種類が多く数値/文字列いずれも取り得るため、詳細な検証はレンダラー側の描画時
// （エスケープ・safeColor等）で行い、ここでは「オブジェクトの配列／オブジェクト」
// という構造だけを壊れたデータから守る。
function sanitizeBackupData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  if (Array.isArray(raw.tiles)) {
    out.tiles = raw.tiles.filter((t) => t && typeof t === "object" && !Array.isArray(t));
  }
  if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
    out.settings = raw.settings;
  }
  // 画面単体のバックアップ（kind: "page"）：その画面のボタンと、画面ごとの設定だけを持つ
  if (raw.kind === "page") {
    out.kind = "page";
    if (raw.pageSettings && typeof raw.pageSettings === "object" && !Array.isArray(raw.pageSettings)) {
      out.pageSettings = raw.pageSettings;
    }
  }
  return out;
}
ipcMain.handle("backup:import", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { error: "キャンセルされました" };
  try {
    const raw = fs.readFileSync(result.filePaths[0], "utf-8");
    const parsed = JSON.parse(raw);
    return { data: sanitizeBackupData(parsed) };
  } catch (e) {
    return { error: "読み込みに失敗しました：" + e.message };
  }
});
