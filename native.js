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

module.exports = {
  available,
  pressKey,
  keyDown,
  keyUp,
  pressKeyRepeat,
  pressKeyCombo,
  getForegroundWindowHandle,
  setForegroundWindowHandle,
  isWindowHandle,
};
