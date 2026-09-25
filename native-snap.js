// ============================================================
// 画面分割（スナップ）をkoffiでuser32.dll/dwmapi.dllを直接呼び出して行う実装。
// main.jsのSNAP_WINDOW_CS（C#・PowerShell経由）とまったく同じアルゴリズムを
// そのままJavaScript化したもの。PowerShellの起動やAdd-Typeのコンパイルを
// 挟まないため、実行のたびに待たされることがなくなる。
//
// 重要な安全設計：
//  ここでの処理中に何か想定外のエラーが起きた場合は必ず例外を投げる。
//  呼び出し側（main.js）は例外を捕まえて、従来のPowerShell方式（SnapWin.Run／
//  snapWindowDirectFallback）にそのままフォールバックする。つまりこの実装が
//  仮に一部の環境で動かなくても、画面分割機能そのものは今まで通り動く。
// ============================================================
let available = false;
let user32 = null;
let dwmapi = null;
const fn = {};
let RECT = null;
let MONITORINFO = null;
let MONITORINFO_SIZE = 0;
let RECT_SIZE = 0;

if (process.platform === "win32") {
  try {
    const koffi = require("koffi");
    user32 = koffi.load("user32.dll");
    dwmapi = koffi.load("dwmapi.dll");

    RECT = koffi.struct("SnapRECT", {
      left: "int32",
      top: "int32",
      right: "int32",
      bottom: "int32",
    });
    MONITORINFO = koffi.struct("SnapMONITORINFO", {
      cbSize: "uint32",
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: "uint32",
    });
    MONITORINFO_SIZE = koffi.sizeof(MONITORINFO);
    RECT_SIZE = koffi.sizeof(RECT);

    fn.GetForegroundWindow = user32.func("uintptr_t __stdcall GetForegroundWindow()");
    fn.SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(uintptr_t hWnd)");
    fn.IsWindow = user32.func("bool __stdcall IsWindow(uintptr_t hWnd)");
    fn.IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(uintptr_t hWnd)");
    fn.IsIconic = user32.func("bool __stdcall IsIconic(uintptr_t hWnd)");
    fn.IsZoomed = user32.func("bool __stdcall IsZoomed(uintptr_t hWnd)");
    fn.ShowWindow = user32.func("bool __stdcall ShowWindow(uintptr_t hWnd, int32 nCmdShow)");
    fn.GetWindow = user32.func("uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)");
    fn.GetWindowLongW = user32.func("int32 __stdcall GetWindowLongW(uintptr_t hWnd, int32 nIndex)");
    fn.GetClassNameW = user32.func("int32 __stdcall GetClassNameW(uintptr_t hWnd, _Out_ uint8_t *lpClassName, int32 nMaxCount)");
    fn.GetWindowTextLengthW = user32.func("int32 __stdcall GetWindowTextLengthW(uintptr_t hWnd)");
    fn.GetWindowRect = user32.func("bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ SnapRECT *rect)");
    fn.SetWindowPos = user32.func(
      "bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int32 x, int32 y, int32 cx, int32 cy, uint32 flags)"
    );
    fn.MonitorFromWindow = user32.func("uintptr_t __stdcall MonitorFromWindow(uintptr_t hWnd, uint32 dwFlags)");
    fn.GetMonitorInfoW = user32.func("bool __stdcall GetMonitorInfoW(uintptr_t hMonitor, _Inout_ SnapMONITORINFO *info)");
    fn.GetTopWindow = user32.func("uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)");
    fn.SetProcessDPIAware = user32.func("bool __stdcall SetProcessDPIAware()");
    fn.SetProcessDpiAwarenessContext = user32.func("bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)");
    fn.DwmGetWindowAttributeInt = dwmapi.func(
      "int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, _Out_ int32 *pv, uint32 cb)"
    );
    fn.DwmGetWindowAttributeRect = dwmapi.func(
      "int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, _Out_ SnapRECT *pv, uint32 cb)"
    );

    // SetForegroundWindow失敗時の原因調査用（任意）。取得できなくても本体機能には
    // 影響がないよう、ここだけ独立したtry/catchにして、失敗時はfn.GetLastErrorをnullのままにする。
    try {
      const kernel32 = koffi.load("kernel32.dll");
      fn.GetLastError = kernel32.func("uint32 __stdcall GetLastError()");
    } catch (e) {
      fn.GetLastError = null;
    }

    available = true;
  } catch (e) {
    available = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClassName(hwnd) {
  const buf = Buffer.alloc(512); // 256文字（UTF-16なので1文字2バイト）分
  const len = fn.GetClassNameW(hwnd, buf, 256);
  if (!len) return "";
  return buf.toString("utf16le", 0, len * 2);
}

function isCloaked(hwnd) {
  const out = [0];
  const hr = fn.DwmGetWindowAttributeInt(hwnd, 14, out, 4); // DWMWA_CLOAKED
  return hr === 0 && out[0] !== 0;
}

function getWindowRect(hwnd) {
  const rect = {};
  if (!fn.GetWindowRect(hwnd, rect)) return null;
  return rect;
}

function getExtendedFrameBounds(hwnd) {
  const rect = {};
  const hr = fn.DwmGetWindowAttributeRect(hwnd, 9, rect, RECT_SIZE); // DWMWA_EXTENDED_FRAME_BOUNDS
  if (hr !== 0) return null;
  return rect;
}

function getMonitorInfo(hmonitor) {
  const info = { cbSize: MONITORINFO_SIZE };
  if (!fn.GetMonitorInfoW(hmonitor, info)) return null;
  return info;
}

// これ未満の幅または高さのウィンドウは、ツールバー的な小ウィンドウ・一時ポップアップとみなして除外する
const MIN_CANDIDATE_WIDTH = 200;
const MIN_CANDIDATE_HEIGHT = 150;

function isOwn(h, own) {
  return h !== 0 && own.includes(h);
}
function isUsed(h, used) {
  return used.includes(h);
}
function isCandidate(h, own) {
  if (!h) return false;
  if (isOwn(h, own)) return false;
  if (!fn.IsWindow(h) || !fn.IsWindowVisible(h) || fn.IsIconic(h)) return false;
  if (isCloaked(h)) return false;
  const ex = fn.GetWindowLongW(h, -20); // GWL_EXSTYLE
  if ((ex & 0x80) !== 0 && (ex & 0x40000) === 0) return false; // WS_EX_TOOLWINDOW かつ !WS_EX_APPWINDOW
  if (fn.GetWindowTextLengthW(h) === 0) return false;
  if (fn.GetWindow(h, 4) !== 0) return false; // GW_OWNER持ち（ダイアログ・更新確認ポップアップ等）は除外
  const rect = getWindowRect(h);
  if (rect && (rect.right - rect.left < MIN_CANDIDATE_WIDTH || rect.bottom - rect.top < MIN_CANDIDATE_HEIGHT)) return false;
  const cls = getClassName(h);
  if (["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"].includes(cls)) return false;
  return true;
}

// waitNewで待ち始める「前から」画面に存在していた候補ウィンドウを洗い出す。
// 画面に既存ウィンドウが多いと、待機中にそのどれかが一瞬前面に来ただけで
// 「新しく開いたアプリ」と誤認してしまうことがあるため、待ち始める前のスナップショットを
// 取っておき、以降そのウィンドウ群は「新規」としては絶対に採用しないようにする。
function collectPreExisting(own) {
  const set = new Set();
  try {
    let h = fn.GetTopWindow(0);
    let guard = 0;
    while (h && guard < 1000) {
      if (isCandidate(h, own)) set.add(h);
      h = fn.GetWindow(h, 2); // GW_HWNDNEXT
      guard++;
    }
  } catch (e) {
    // 取得に失敗しても致命的ではない（従来通り、事前除外なしで動く）
  }
  return set;
}

// direction: "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
// own: 自アプリ自身のhwnd配列, recorded: 記録済みhwnd（0なら未記録）, waitNew: 新規ウィンドウを待つか
// used: このマルチ操作の中ですでに配置済みのhwnd配列
// acceptExisting: true のときは「待ち始める前から画面にあったウィンドウ」の除外を行わない
//   （例：ブラウザのリンクを「既存ウィンドウにタブとして追加」設定で開いた直後の分割。
//    この場合、対象となる既存ブラウザウィンドウ自体が事前除外リストに載ってしまうため）
async function run(direction, own, recorded, waitNew, used, acceptExisting) {
  try {
    fn.SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  } catch (e) {
    try {
      fn.SetProcessDPIAware();
    } catch (e2) {
      // 失敗しても致命的ではないので無視する（元のC#実装と同じ扱い）
    }
  }

  let target = 0;
  const start = Date.now();
  // マルチ操作で開いたアプリ（LINE・OBS・編集ソフト等、起動に時間がかかるものを含む）の
  // ウィンドウ出現を待つ上限。以前は7秒だったが、重いアプリで取りこぼす例があったため延長した。
  // ※ main.js の SNAP_WAIT_LIMIT_MS / SNAP_WINDOW_CS 内の `int limit = waitNew ? ... : 0;` と
  //   同じ値にしておくこと。
  const limit = waitNew ? 12000 : 0;
  // 待ち始める前から画面にあった候補ウィンドウは、待機中に一瞬前面に来ただけで
  // 「新しく開いたウィンドウ」と誤認しないよう、あらかじめ除外リストに入れておく
  // （画面に既存ウィンドウが多いときほど誤爆しやすかったための対策）。
  // ただしacceptExisting指定時（既存ウィンドウへのタブ追加後の分割など）はこの除外を行わない。
  const preExisting = waitNew && !acceptExisting ? collectPreExisting(own) : null;
  while (true) {
    const fg0 = fn.GetForegroundWindow();
    if (isCandidate(fg0, own) && !(waitNew && isUsed(fg0, used)) && !(waitNew && !acceptExisting && preExisting.has(fg0))) {
      target = fg0;
      break;
    }
    if (Date.now() - start >= limit) break;
    await sleep(30);
  }

  if (waitNew && target) {
    let prev = getWindowRect(target);
    if (prev) {
      let stable = 0;
      const t0 = Date.now();
      while (stable < 3 && Date.now() - t0 < 600) {
        await sleep(50);
        const cur = getWindowRect(target);
        if (!cur) break;
        if (cur.left === prev.left && cur.top === prev.top && cur.right === prev.right && cur.bottom === prev.bottom) {
          stable++;
        } else {
          stable = 0;
          prev = cur;
        }
      }
    }
    if (!fn.IsWindow(target)) target = 0;
  }

  const fg = fn.GetForegroundWindow();
  if (!target && isCandidate(fg, own) && !(waitNew && isUsed(fg, used)) && !(waitNew && !acceptExisting && preExisting.has(fg))) target = fg;

  if (!target) {
    const from = isOwn(fg, own) ? fg : own.length > 0 ? own[0] : 0;
    if (from) {
      let h = fn.GetWindow(from, 2); // GW_HWNDNEXT
      let guard = 0;
      while (h && guard < 400) {
        // GW_OWNER持ちの除外はisCandidate内で行うようになったため、ここでの重複チェックは不要
        if (isCandidate(h, own) && !(waitNew && isUsed(h, used)) && !(waitNew && !acceptExisting && preExisting.has(h))) {
          target = h;
          break;
        }
        h = fn.GetWindow(h, 2);
        guard++;
      }
    }
  }

  if (!target && recorded) {
    // ここだけ他の除外チェックの対象外になっていたのを修正：waitNew中は、recordedも
    // 「待ち始める前から画面にあった＝別の無関係な元のウィンドウ」の可能性が高いため、
    // 他と同じくpreExisting除外の対象にする（acceptExisting指定時は従来通り例外）。
    if (isCandidate(recorded, own) && !(waitNew && isUsed(recorded, used)) && !(waitNew && !acceptExisting && preExisting.has(recorded))) target = recorded;
  }

  if (!target) return { ok: false, reason: "notarget" };

  if (fn.IsZoomed(target)) fn.ShowWindow(target, 9); // SW_RESTORE

  const mon = fn.MonitorFromWindow(target, 2); // MONITOR_DEFAULTTONEAREST
  if (!mon) return { ok: false, reason: "monitor" };
  const mi = getMonitorInfo(mon);
  if (!mi) return { ok: false, reason: "monitor" };

  const L = mi.rcWork.left;
  const T = mi.rcWork.top;
  const W = mi.rcWork.right - mi.rcWork.left;
  const H = mi.rcWork.bottom - mi.rcWork.top;
  const halfW = Math.trunc(W / 2);
  const halfH = Math.trunc(H / 2);
  let x = L;
  let y = T;
  let w = W;
  let hh = H;
  switch (direction) {
    case "left":
      w = halfW;
      break;
    case "right":
      x = L + halfW;
      w = W - halfW;
      break;
    case "top-left":
      w = halfW;
      hh = halfH;
      break;
    case "top-right":
      x = L + halfW;
      w = W - halfW;
      hh = halfH;
      break;
    case "bottom-left":
      y = T + halfH;
      w = halfW;
      hh = H - halfH;
      break;
    case "bottom-right":
      x = L + halfW;
      y = T + halfH;
      w = W - halfW;
      hh = H - halfH;
      break;
    default:
      return { ok: false, reason: "dir" };
  }

  // Windows10/11のウィンドウの見た目の外側にある、見えない影の枠の分を補正する
  const wr = getWindowRect(target);
  const fr = getExtendedFrameBounds(target);
  let dl = 0;
  let dt = 0;
  let dr = 0;
  let db = 0;
  if (wr && fr) {
    dl = fr.left - wr.left;
    dt = fr.top - wr.top;
    dr = wr.right - fr.right;
    db = wr.bottom - fr.bottom;
  }
  x -= dl;
  y -= dt;
  w += dl + dr;
  hh += dt + db;

  // SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)
  if (!fn.SetWindowPos(target, 0, x, y, w, hh, 0x4 | 0x10)) return { ok: false, reason: "setpos" };
  // SetForegroundWindowは、フォーカスを奪おうとしたプロセスが直前に入力を
  // 受け取っていない等の理由でOS側の制限により失敗することが珍しくない
  // （＝Windowsの仕様上の正常な拒否であり、異常ではない）。ここでの主目的は
  // すでに成功しているウィンドウの移動・リサイズなので、失敗してもスナップ
  // 操作全体は成功として扱うが、原因調査ができるよう戻り値とGetLastErrorを記録しておく。
  // GetLastErrorはfn.SetForegroundWindowの直後・他のWin32呼び出しを挟まずに取得しているため、
  // 値の取り違えは起きない。失敗時のみ呼ぶので成功時の実行速度には影響しない。
  const focused = fn.SetForegroundWindow(target);
  if (!focused) {
    let lastError = null;
    if (fn.GetLastError) {
      try { lastError = fn.GetLastError(); } catch (e) { lastError = null; }
    }
    return { ok: true, hwnd: target, focused: false, lastError };
  }
  return { ok: true, hwnd: target, focused: true };
}

module.exports = { available, run };
