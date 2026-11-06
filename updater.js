// ============================================================
// 自動アップデート（electron-updater + GitHub Releases）
// ------------------------------------------------------------
// 起動の少し後と、その後6時間おきに新しいバージョンを確認し、見つかれば裏でダウンロードする。
// ダウンロードが終わったら「今すぐ再起動して更新／あとで」を尋ねる。
// 「あとで」を選んでも、Launch-Kを終了したタイミングで自動的に更新が適用される。
//
// electron-updaterが読み込めない場合や、開発中（npm start）は何もしない（アプリ本体は止めない）。
//
// 【v1.2.5 での変更点】
//  ・Launch-0：接続方法はTailscaleだけ（「同じWi-Fi」を廃止）。「Launch-0を開きますか？」の確認画面と、スマホの確認画面（「上記を理解しました」）をなくした。0 と K の同時押しで開く機能を廃止（メニューから開く）。
//  ・Launch-0：QRとパスワードは45秒ごとに更新（待ち時間90秒）。パスワードは英小文字4文字＋数字2文字。接続の許可の待ち時間は20秒。許可の画面はEnterキーでも許可できる。接続準備の画面はEnterで「QRを表示」。
//  ・Launch-0：通信が120秒途切れると警告、360秒で切断。途切れている間は、スマホからの操作・画面切り替えを受け付けない。
//  ・Launch-0：初期サイズをメイン画面・画面2以降と同じにした。アカウント名は「ac：●●●●●●●●(- -)」の形で、押すと表示・非表示（表示中は (o_o)）。
//  ・スマホ：☰に「接続の安全」の表示を追加。パスワード入力中・許可待ちにPCが閉じられたときなどの通知を追加。長押しは0.67秒。
//  ・マイクのミュート切り替えを、koffiでWindowsのCore Audioを直接呼ぶ方式にして高速化（失敗時は従来のPowerShell方式）。ミュート状態の読み取りは2秒ごと。
//  ・Ctrl+W・Ctrl+Shift+T（ブラウザにだけ送るショートカット）の、前面ウィンドウの確認をkoffiにして高速化。
//  ・サウンド：同じボタンの音は重ならない（別のボタンの音は同時に鳴る）。押すと一時停止、もう一度で続きから再生。最後まで鳴ると自動で止まる。アイコンは再生中／止まっているで切り替わる（斜線）。マルチ操作には入れられない。音声ファイルは「ファイル」ボタンに登録できない。
//  ・サウンドが鳴らない問題を修正（画面のCSPに media-src がなく、音声の読み込みが遮断されていた）。
//  ・ロック中のスクショ範囲選択で、ロック解除後にEscが効かなくなる問題を修正（Escをどこからでも受け取る・フォーカスを取り戻す・2分で自動キャンセル）。
//  ・設定パネル（ハンバーガーメニュー）で、↑↓キーで上下にスクロールできる。使い方・利用規約を更新。
//
// 【v1.2.4 での変更点】
//  ・Launch-0（スマホから操作）を追加。ハンバーガーメニュー最下部、または 0 と K の同時押しで開く。
//    通信は remote.js、PC側の画面は launch0.js、スマホ側のページは mobile.html。
//  ・更新のための終了では、Launch-0の通信（サーバー）も止めてから終了する。
//  ・接続方法に「Tailscale」を追加（tailscale.js）。Tailscale用IPアドレスだけで待ち受け、同じアカウントの端末だけ接続できる。
//  ・スマホで操作の実行中は、PC・スマホの両方から切断できない。マルチ操作の実行中は、ほかのボタンも押せない。
//  ・スマホでボタンを0.75秒以上押し続けると、名前を表示する（それより短ければ通常のタップ）。
//  ・画面分割・マルチ操作がLaunch-0自身に効いてしまう不具合を修正（Launch-0を対象から除外）。
//
// 【v1.2.3 での変更点】
//  ・更新の経過を userData フォルダの update.log に書き残す（失敗しても原因が後から分かるように）。
//  ・「今すぐ再起動して更新」では、先にアプリを完全に片付けてから（全ウィンドウ・常駐PowerShell・
//    ショートカット登録・トレイ）インストーラーを起動する。使用中のファイルが残ったまま
//    インストーラーが古い版を消してしまい、アイコンが「白い紙」になる問題への対策。
//  ・インストーラーは画面あり（INSTALL_SILENT = false）で動かす。失敗したときに理由が見えるようにする。
//    画面なしの旧動作に戻したいときは、下の INSTALL_SILENT を true にする。
//  ・インストーラーを呼んだのにアプリが終了しなかった場合（見張り番）は、アプリを作り直して
//    「ウィンドウが無いのに裏で動いているだけ」の状態を避ける。
// ============================================================
const { app, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (e) {
  console.warn("electron-updater unavailable:", e && e.message);
}

const FIRST_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// true: 画面なしで更新（旧動作）／ false: インストーラーの画面を出して更新（失敗の理由が見える）
const INSTALL_SILENT = false;
// インストーラーを呼んだあと、この時間を過ぎてもアプリが終了していなければ失敗とみなす
const QUIT_WATCHDOG_MS = 15 * 1000;
const LOG_MAX_BYTES = 256 * 1024;

let ctx = { getParentWindow: () => null, prepareQuit: async () => {} };
let state = "idle"; // idle | checking | downloading | downloaded
let downloadedVersion = null;
let restartPromptOpen = false;
let restartPromptDismissed = false;
let installing = false;
let lastProgressLogged = -1;

// ---------- ログ（userData/update.log） ----------
function getLogPath() {
  try {
    return path.join(app.getPath("userData"), "update.log");
  } catch (e) {
    return null;
  }
}
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function stringifyArg(a) {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}
// ログの書き込みに失敗してもアプリは止めない（ここで例外を外に出さない）
function writeLog(level, args) {
  try {
    const file = getLogPath();
    if (!file) return;
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_MAX_BYTES) {
        try { fs.renameSync(file, file.replace(/update\.log$/, "update.old.log")); } catch (e) { fs.writeFileSync(file, ""); }
      }
    } catch (e) { /* まだ無いだけ */ }
    const msg = Array.prototype.map.call(args, stringifyArg).join(" ");
    fs.appendFileSync(file, `[${stamp()}] [${level}] ${msg}\n`, "utf-8");
  } catch (e) { /* 無視 */ }
}
function log(...args) { writeLog("info", args); }
function warn(...args) { writeLog("warn", args); }
function logError(...args) { writeLog("error", args); }

// electron-updater 自身の内部ログも同じファイルに残す
const fileLogger = {
  info: (...a) => writeLog("info", a),
  warn: (...a) => writeLog("warn", a),
  error: (...a) => writeLog("error", a),
  debug: () => {},
};

function describeEnvironment() {
  let koffiVersion = "unknown";
  try { koffiVersion = require("koffi/package.json").version; } catch (e) { /* 無くてもよい */ }
  let updaterVersion = "unknown";
  try { updaterVersion = require("electron-updater/package.json").version; } catch (e) { /* 無くてもよい */ }
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    koffi: koffiVersion,
    electronUpdater: updaterVersion,
    platform: `${process.platform}/${process.arch}`,
    packaged: app.isPackaged,
    exe: process.execPath,
  };
}

function isEnabled() {
  return !!autoUpdater && app.isPackaged;
}

// "1.2.0" のような数字区切りのバージョンを比べる（a が b より新しければ true）
function isNewer(a, b) {
  const pa = String(a).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// 更新の途中で失敗した（またはアプリが終了しなかった）ときの後始末。
// すでに全ウィンドウを閉じているため、そのままだと「トレイにだけ残って何も操作できない」状態になる。
// アプリを作り直して、普通に使える状態に戻す。
function recoverAfterFailedInstall(reason) {
  logError("recover: restarting app because", reason);
  try {
    app.relaunch();
  } catch (e) {
    logError("recover: relaunch failed", e);
  }
  try {
    app.exit(0);
  } catch (e) {
    logError("recover: exit failed", e);
  }
}

async function installNow() {
  if (installing) {
    log("installNow ignored: already installing");
    return;
  }
  installing = true;
  log("installNow: start. downloadedVersion =", downloadedVersion, "silent =", INSTALL_SILENT);
  try {
    // ウィンドウを閉じてもトレイに残る作りのため、終了扱いにして全て片付ける（完了まで待つ）
    await ctx.prepareQuit();
    log("installNow: prepareQuit finished");
  } catch (e) {
    // 片付けに失敗しても、更新そのものは続行する（ここで止めるとアプリが中途半端な状態で残るため）
    logError("installNow: prepareQuit failed (continuing)", e);
  }
  try {
    log("installNow: calling quitAndInstall");
    autoUpdater.quitAndInstall(INSTALL_SILENT, true);
    // 見張り番：正常ならこの間にアプリは終了している。終了していなければ失敗とみなして復旧する。
    const timer = setTimeout(() => {
      recoverAfterFailedInstall(`app did not quit within ${QUIT_WATCHDOG_MS}ms after quitAndInstall`);
    }, QUIT_WATCHDOG_MS);
    if (timer.unref) timer.unref();
  } catch (e) {
    logError("installNow: quitAndInstall threw", e);
    recoverAfterFailedInstall("quitAndInstall threw");
  }
}

async function promptRestart() {
  if (restartPromptOpen) return;
  restartPromptOpen = true;
  restartPromptDismissed = false;
  try {
    const parent = ctx.getParentWindow();
    const options = {
      type: "info",
      title: "Launch-K アップデート",
      message: `新しいバージョン（v${downloadedVersion}）の準備ができました。`,
      detail: "今すぐ再起動して更新できます。更新用のインストーラーの画面が表示された場合は、そのまま進めてください。「あとで」を選んだ場合は、Launch-Kを終了したときに自動で更新されます。",
      buttons: ["今すぐ再起動して更新", "あとで"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const useParent = parent && !parent.isDestroyed() && parent.isVisible();
    const result = useParent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    log("promptRestart: user chose", result.response === 0 ? "install now" : "later");
    if (result.response === 0) installNow();
    else restartPromptDismissed = true;
  } catch (e) {
    warn("update prompt failed:", e && e.message);
  } finally {
    restartPromptOpen = false;
  }
}

// 手動確認／自動確認の共通処理。戻り値は設定画面の表示用。
// manual=true（設定画面から）のときだけ、ダウンロード済みの更新の再起動案内をもう一度出す。
async function checkNow(manual) {
  if (!autoUpdater) return { status: "unavailable" };
  if (!app.isPackaged) return { status: "dev" };
  if (installing) return { status: "downloaded", version: downloadedVersion };
  if (state === "downloaded") {
    if (manual) promptRestart();
    return { status: "downloaded", version: downloadedVersion };
  }
  if (state === "downloading") return { status: "downloading" };
  if (state === "checking") return { status: "checking" };

  state = "checking";
  log("check: start (manual =", !!manual, ")");
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      state = "idle";
      log("check: no result");
      return { status: "unavailable" };
    }
    const latest = result.updateInfo.version;
    log("check: latest =", latest, "current =", app.getVersion());
    if (isNewer(latest, app.getVersion())) {
      if (state === "checking") state = "downloading";
      return { status: "available", version: latest };
    }
    state = "idle";
    return { status: "latest", version: app.getVersion() };
  } catch (e) {
    if (state === "checking") state = "idle";
    logError("check: failed", e);
    return { status: "error", message: String((e && e.message) || e) };
  }
}

function init(options) {
  ctx = Object.assign(ctx, options || {});
  log("==== Launch-K started ====", describeEnvironment());
  if (!isEnabled()) {
    log("updater disabled (packaged =", app.isPackaged, ", electron-updater loaded =", !!autoUpdater, ")");
    return;
  }

  try { autoUpdater.logger = fileLogger; } catch (e) { /* 失敗しても更新機能は使える */ }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("update-available", (info) => {
    log("event update-available", info && info.version);
    if (state !== "downloaded") state = "downloading";
  });
  autoUpdater.on("update-not-available", () => {
    if (state !== "downloaded") state = "idle";
  });
  autoUpdater.on("download-progress", (p) => {
    const pct = p && typeof p.percent === "number" ? Math.floor(p.percent / 25) * 25 : -1;
    if (pct !== lastProgressLogged) {
      lastProgressLogged = pct;
      log("event download-progress", pct, "%");
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    state = "downloaded";
    downloadedVersion = info && info.version;
    log("event update-downloaded", downloadedVersion);
    // 「あとで」を選んだあとの定期確認では、同じ案内を繰り返さない
    if (!restartPromptDismissed) promptRestart();
  });
  autoUpdater.on("error", (err) => {
    logError("event error", err);
    if (state !== "downloaded") state = "idle";
  });

  setTimeout(() => checkNow(false), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => checkNow(false), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

// 設定画面の「更新ログを開く」用
function getUpdateLogPath() {
  const p = getLogPath();
  try {
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 無視 */ }
  return null;
}

module.exports = { init, checkNow, log, logError, getUpdateLogPath };
