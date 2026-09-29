// ============================================================
// 自動アップデート（electron-updater + GitHub Releases）
// ------------------------------------------------------------
// 起動の少し後と、その後6時間おきに新しいバージョンを確認し、見つかれば裏でダウンロードする。
// ダウンロードが終わったら「今すぐ再起動して更新／あとで」を尋ねる。
// 「あとで」を選んでも、Launch-Kを終了したタイミングで自動的に更新が適用される。
//
// electron-updaterが読み込めない場合や、開発中（npm start）は何もしない（アプリ本体は止めない）。
// ============================================================
const { app, dialog } = require("electron");

let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (e) {
  console.warn("electron-updater unavailable:", e && e.message);
}

const FIRST_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let ctx = { getParentWindow: () => null, prepareQuit: () => {} };
let state = "idle"; // idle | checking | downloading | downloaded
let downloadedVersion = null;
let restartPromptOpen = false;
let restartPromptDismissed = false;

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

function installNow() {
  // ウィンドウを閉じてもトレイに残る作りのため、終了扱いにしてからインストーラーへ渡す
  ctx.prepareQuit();
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
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
      detail: "今すぐ再起動して更新できます。「あとで」を選んだ場合は、Launch-Kを終了したときに自動で更新されます。",
      buttons: ["今すぐ再起動して更新", "あとで"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const useParent = parent && !parent.isDestroyed() && parent.isVisible();
    const result = useParent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (result.response === 0) installNow();
    else restartPromptDismissed = true;
  } catch (e) {
    console.warn("update prompt failed:", e && e.message);
  } finally {
    restartPromptOpen = false;
  }
}

// 手動確認／自動確認の共通処理。戻り値は設定画面の表示用。
// manual=true（設定画面から）のときだけ、ダウンロード済みの更新の再起動案内をもう一度出す。
async function checkNow(manual) {
  if (!autoUpdater) return { status: "unavailable" };
  if (!app.isPackaged) return { status: "dev" };
  if (state === "downloaded") {
    if (manual) promptRestart();
    return { status: "downloaded", version: downloadedVersion };
  }
  if (state === "downloading") return { status: "downloading" };
  if (state === "checking") return { status: "checking" };

  state = "checking";
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      state = "idle";
      return { status: "unavailable" };
    }
    const latest = result.updateInfo.version;
    if (isNewer(latest, app.getVersion())) {
      if (state === "checking") state = "downloading";
      return { status: "available", version: latest };
    }
    state = "idle";
    return { status: "latest", version: app.getVersion() };
  } catch (e) {
    if (state === "checking") state = "idle";
    return { status: "error", message: String((e && e.message) || e) };
  }
}

function init(options) {
  ctx = Object.assign(ctx, options || {});
  if (!isEnabled()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("update-available", () => {
    if (state !== "downloaded") state = "downloading";
  });
  autoUpdater.on("update-not-available", () => {
    if (state !== "downloaded") state = "idle";
  });
  autoUpdater.on("update-downloaded", (info) => {
    state = "downloaded";
    downloadedVersion = info && info.version;
    // 「あとで」を選んだあとの定期確認では、同じ案内を繰り返さない
    if (!restartPromptDismissed) promptRestart();
  });
  autoUpdater.on("error", (err) => {
    console.warn("auto update error:", err && err.message);
    if (state !== "downloaded") state = "idle";
  });

  setTimeout(() => checkNow(false), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => checkNow(false), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { init, checkNow };
