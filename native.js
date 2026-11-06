// ============================================================
// koffiによるuser32.dllの直接呼び出し（PowerShell不要の高速版）
// ------------------------------------------------------------
// 対象は「keybd_event（キー送信）」「GetForegroundWindow／SetForegroundWindow／
// IsWindow（フォーカスの取得・復元）」など、単純なuser32.dll関数のみ。
// 画面分割（SnapWin）・マイクミュート（Core Audio API）・明るさ調整（WMI）は
// 実装が複雑で、既存のPowerShellセッション方式のまま変更していない。
//
// koffiの読み込みや関数取得に万一失敗しても、このモジュールが使えないというだけで
// アプリ全体は止まらないようにする（呼び出し側は available を見て、従来の
// PowerShell方式にフォールバックできるようにしておく）。
// ============================================================
let user32 = null;
let keybd_event = null;
let GetForegroundWindowNative = null;
let SetForegroundWindowNative = null;
let IsWindowNative = null;
let ShowWindowNative = null;
let SetWindowPosNative = null;

if (process.platform === "win32") {
  try {
    const koffi = require("koffi");
    user32 = koffi.load("user32.dll");
    // HWNDはポインタサイズの値だが、実際の値は十分小さいため（アプリ内の既存コードも
    // 同様に）普通のJSの数値として扱う。uintptr_t型で宣言することでkoffi側の
    // 数値⇔ポインタの変換を任せる。
    keybd_event = user32.func("keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr_t"]);
    GetForegroundWindowNative = user32.func("GetForegroundWindow", "uintptr_t", []);
    SetForegroundWindowNative = user32.func("SetForegroundWindow", "bool", ["uintptr_t"]);
    IsWindowNative = user32.func("IsWindow", "bool", ["uintptr_t"]);
    ShowWindowNative = user32.func("ShowWindow", "bool", ["uintptr_t", "int"]);
    SetWindowPosNative = user32.func("SetWindowPos", "bool", ["uintptr_t", "intptr_t", "int", "int", "int", "int", "uint32"]);
  } catch (e) {
    // koffi自体が読み込めない／関数が取得できない環境では使用不可扱いにする
    user32 = null;
    keybd_event = null;
  }
}

const available = !!keybd_event;

const KEYEVENTF_KEYUP = 2;

// 1つのキーを「押して離す」。戻り値で成否を返し、呼び出し側で失敗時に
// 従来のPowerShell方式へフォールバックできるようにする（例外を外に投げない）。
function pressKey(code) {
  try {
    keybd_event(code, 0, 0, 0);
    keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// キーを押したままにする／離す（Ctrlを押したまま他のキーを連打する、等の組み立て用）
function keyDown(code) {
  try {
    keybd_event(code, 0, 0, 0);
    return true;
  } catch (e) {
    return false;
  }
}
function keyUp(code) {
  try {
    keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// 同じキーをn回（1〜10回）連続で押す
function pressKeyRepeat(code, times) {
  const n = Math.max(1, Math.min(10, Number(times) || 1));
  let ok = true;
  for (let i = 0; i < n; i++) {
    if (!pressKey(code)) ok = false; // pressKey自体が内部で例外を握りつぶすため、ここでは戻り値だけ見る
  }
  return ok;
}

// 複数のキーを同時押し（押す順→逆順で離す）。例：Ctrl+V、Windows+矢印
// 押す途中で失敗した場合、そこまでに押してしまったキーが押しっぱなしのまま
// 残ってしまう（＝以降のユーザー操作に予期せぬ修飾キーがかかり続ける）と実害が
// 大きいため、失敗時はそこまで押したキーだけ逆順でreleaseを試みてから false を返す。
function pressKeyCombo(codes) {
  const pressed = [];
  try {
    for (const c of codes) {
      keybd_event(c, 0, 0, 0);
      pressed.push(c);
    }
    for (const c of codes.slice().reverse()) keybd_event(c, 0, KEYEVENTF_KEYUP, 0);
    return true;
  } catch (e) {
    for (const c of pressed.slice().reverse()) {
      try { keybd_event(c, 0, KEYEVENTF_KEYUP, 0); } catch (e2) {}
    }
    return false;
  }
}

function getForegroundWindowHandle() {
  try {
    const h = GetForegroundWindowNative();
    return Number(h) || 0;
  } catch (e) {
    return 0;
  }
}

function setForegroundWindowHandle(hwnd) {
  try {
    return !!SetForegroundWindowNative(hwnd);
  } catch (e) {
    return false;
  }
}

function isWindowHandle(hwnd) {
  try {
    return !!IsWindowNative(hwnd);
  } catch (e) {
    return false;
  }
}

// 他アプリのウィンドウの表示状態を変える（SW_MAXIMIZE=3 など）。失敗しても例外は外へ出さない。
function showWindowHandle(hwnd, cmd) {
  try {
    return !!ShowWindowNative(hwnd, cmd);
  } catch (e) {
    return false;
  }
}

// ウィンドウを「最前面（TOPMOST）の層の一番上」へ出し直す。位置・大きさは変えず、フォーカスも奪わない。
// すでに最前面のウィンドウでも、他アプリの最前面ウィンドウに抜かれていた順位を取り戻せる。
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
function setTopmostNoActivate(hwnd) {
  try {
    return !!SetWindowPosNative(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// 前面のウィンドウの「プロセス名」（実行ファイル名・拡張子なし・小文字）をkoffiで取得する。
// 「ブラウザにだけ送るショートカット（Ctrl+W など）」の安全確認に使う。以前はPowerShellを起動して
// 調べていたため、そのぶん押してから反応するまで遅かった。
//   GetForegroundWindow → GetWindowThreadProcessId → OpenProcess（読み取り専用の最小権限）
//   → QueryFullProcessImageNameW → CloseHandle
// 取得できなかったとき（管理者権限のアプリなど）は空文字を返す。呼び出し側は、従来のPowerShell方式で確かめ直す。
// ------------------------------------------------------------
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
function createProcessNameReader(koffi, user32lib, kernel32lib) {
  const getFg = user32lib.func("uintptr_t __stdcall GetForegroundWindow()");
  const getPid = user32lib.func("uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)");
  const openProc = kernel32lib.func("uintptr_t __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)");
  const closeH = kernel32lib.func("int32 __stdcall CloseHandle(uintptr_t h)");
  const queryName = kernel32lib.func("int32 __stdcall QueryFullProcessImageNameW(uintptr_t h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)");
  return function readForegroundProcessName() {
    const hwnd = getFg();
    if (!hwnd) return "";
    const pidOut = [0];
    getPid(hwnd, pidOut);
    const pid = pidOut[0] >>> 0;
    if (!pid) return "";
    const h = openProc(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) return "";
    try {
      const buf = new Uint16Array(1024);
      const size = [1024];
      if (!queryName(h, 0, buf, size)) return "";
      const len = Math.max(0, Math.min(1024, size[0] | 0));
      const full = Buffer.from(buf.buffer, buf.byteOffset, len * 2).toString("utf16le");
      const base = full.split(/[\\/]/).pop() || "";
      return base.replace(/\.[^.]*$/, "").toLowerCase();
    } finally {
      try { closeH(h); } catch (e) { /* 無視 */ }
    }
  };
}
let readForegroundProcessName = null;
if (process.platform === "win32") {
  try {
    const koffi2 = require("koffi");
    readForegroundProcessName = createProcessNameReader(koffi2, koffi2.load("user32.dll"), koffi2.load("kernel32.dll"));
  } catch (e) {
    readForegroundProcessName = null; // このモジュールの他の機能（キー送信など）には影響しない
  }
}
const processNameAvailable = !!readForegroundProcessName;
function getForegroundProcessName() {
  if (!readForegroundProcessName) return "";
  try { return readForegroundProcessName(); } catch (e) { return ""; }
}

module.exports = {
  available,
  showWindowHandle,
  setTopmostNoActivate,
  pressKey,
  keyDown,
  keyUp,
  pressKeyRepeat,
  pressKeyCombo,
  getForegroundWindowHandle,
  setForegroundWindowHandle,
  isWindowHandle,
  processNameAvailable,
  getForegroundProcessName,
  createProcessNameReader, // テスト用
};
