const COLORS = ["#FF6B5E", "#FFB238", "#7C9CFF", "#7BD87B", "#FFDE59", "#FFFFFF", "#9AA1AC", "#000000"];
const CUSTOM_COLOR_KEY = "custom";
// 固定色スワッチ＋「カスタマイズ」（カラーピッカー）を1行に描画する共通ヘルパー。
// タイルのアイコン色（CSS・絵文字どちらでも使う共通の「カラー」欄）と、
// 設定パネルのアクセントカラーの両方から呼び出す。
// currentColor がプリセットのどれとも一致しない場合は、カスタムの丸をその色で
// 塗って「選択中」として表示する（＝自由に選んだ色を保持・表示できる）。
// onPick(color, committed) の第2引数 committed は「値が確定したか」を示す。
// ・プリセットの丸をクリック／ネイティブ色選択ポップアップを閉じたとき → true（呼び出し元で全体を再描画してよい）
// ・ネイティブ色選択ポップアップをドラッグ操作中 → false（呼び出し元は軽い見た目更新だけに留めること）
// 行数・列数の設定用「スピナー」＋左に「自動」ボタン。
// 「自動」がオン（初期設定はこちら）のときはスピナーは薄く表示されるが、
// ▲▼はそのまま操作可能で、押した瞬間に自動から固定値へ切り替わる。
function buildDimensionSpinner(container, settingsKey, min, max) {
  container.innerHTML = "";
  const isAuto = currentPageTheme()[settingsKey] === "auto";

  const autoBtn = document.createElement("div");
  autoBtn.className = "opt-btn" + (isAuto ? " active" : "");
  autoBtn.textContent = "自動";
  autoBtn.addEventListener("click", () => applyDimensionValue(settingsKey, "auto"));
  container.appendChild(autoBtn);

  const spinner = document.createElement("div");
  spinner.className = "spinner" + (isAuto ? " is-auto" : "");

  const valueEl = document.createElement("div");
  valueEl.className = "spinner-value mono";
  valueEl.textContent = isAuto ? "-" : String(currentPageTheme()[settingsKey]);
  spinner.appendChild(valueEl);

  const arrows = document.createElement("div");
  arrows.className = "spinner-arrows";
  const upArrow = document.createElement("div");
  upArrow.className = "spinner-arrow";
  upArrow.textContent = "▲";
  upArrow.addEventListener("click", () => {
    const base = isAuto ? min - 1 : Number(currentPageTheme()[settingsKey]);
    applyDimensionValue(settingsKey, Math.min(max, base + 1));
  });
  const downArrow = document.createElement("div");
  downArrow.className = "spinner-arrow";
  downArrow.textContent = "▼";
  downArrow.addEventListener("click", () => {
    const base = isAuto ? min + 1 : Number(currentPageTheme()[settingsKey]);
    applyDimensionValue(settingsKey, Math.max(min, base - 1));
  });
  arrows.appendChild(upArrow);
  arrows.appendChild(downArrow);
  spinner.appendChild(arrows);

  container.appendChild(spinner);
}
async function applyDimensionValue(settingsKey, value) {
  currentPageTheme()[settingsKey] = value; // このウィンドウの画面だけに反映（他の画面には影響しない）
  currentPage = 0;
  lastClampNotice = null;
  await persistSettings();
  renderGrid();
  renderSettingsPanel();
  peekBehindPanel();
}

function buildColorRow(container, currentColor, onPick) {
  container.innerHTML = "";
  const isCustom = !COLORS.includes(currentColor);
  const presetDots = [];
  COLORS.forEach((c) => {
    const dot = document.createElement("div");
    dot.className = "color-dot" + (!isCustom && currentColor === c ? " active" : "");
    dot.style.background = c;
    dot.addEventListener("click", () => onPick(c, true));
    container.appendChild(dot);
    presetDots.push(dot);
  });
  const customDot = document.createElement("div");
  customDot.className = "color-dot" + (isCustom ? " active" : "");
  customDot.title = "カスタマイズ";
  customDot.style.background = isCustom
    ? currentColor
    : "conic-gradient(red, orange, yellow, green, blue, violet, red)";
  customDot.style.position = "relative";
  customDot.style.overflow = "hidden";
  customDot.innerHTML = `<input type="color" value="${isCustom ? safeColor(currentColor) : "#FFB238"}" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0;" />`;
  const customInput = customDot.querySelector("input");
  // 「常に最前面」表示中は、ネイティブの色選択ポップアップが開いた瞬間の
  // フォーカス移動でメインウィンドウの最前面設定が再適用され、
  // ポップアップが裏に隠れてしまうため、開く前に一旦それを止めておく。
  customInput.addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
  // 以前は色をドラッグして選んでいる最中（inputイベントのたび）に呼び出し元で
  // モーダル全体を再描画していたため、この<input type="color">自体が毎回作り直され、
  // ネイティブの色選択ポップアップとの紐付けが失われて「うまく設定できない」不具合に
  // なっていた。ドラッグ中は見た目（このスウォッチの色）だけをその場で直接更新し、
  // 呼び出し元への通知はするが全体の再描画はさせない。ポップアップを閉じて値が
  // 確定した（change）時にだけ、全体の再描画をしてよいことを伝える。
  customInput.addEventListener("input", (e) => {
    customDot.style.background = e.target.value;
    presetDots.forEach((d) => d.classList.remove("active"));
    customDot.classList.add("active");
    onPick(e.target.value, false);
  });
  customInput.addEventListener("change", (e) => onPick(e.target.value, true));
  container.appendChild(customDot);
}

const TYPE_META = {
  link: { label: "リンク" },
  app: { label: "アプリ" },
  sound: { label: "サウンド" },
  file: { label: "ファイル" },
  folder: { label: "フォルダ" },
  volume: { label: "音量" },
  power: { label: "電源" },
  mic: { label: "マイク" },
  clipboard: { label: "コピー" },
  window: { label: "画面分割" },
  pageswitch: { label: "Launch-K画面切り替え" },
  brightness: { label: "明るさ" },
  media: { label: "メディア" },
  qr: { label: "QRコード" },
  zoom: { label: "ズーム" },
  timer: { label: "タイマー" },
  discord: { label: "Discord" },
  obs: { label: "OBS" },
  shortcutKeys: { label: "ショートカット" },
  screenshotFull: { label: "全画面スクショ" },
  multi: { label: "マルチ操作" },
};
// マルチ操作の中に入れられる動作の種類（無限再帰になる「マルチ操作」自身と、
// 常時ユーザーの操作待ちで一連の自動実行に向かない「QRコード」表示は除く）
const SUB_ACTION_TYPES = Object.keys(TYPE_META).filter((k) => k !== "multi" && k !== "qr");
// Windows標準の「メモ」（notepad.exe）だけは、新しいウィンドウ・新しいタブを
// 区別する一般的な起動方法が無いため、専用の判定・選択肢を用意する。
// 選ばれたのが notepad.exe そのものではなく、デスクトップ等の「メモ帳.lnk」（ショートカット）の
// 場合もあるため、.lnk はリンク先まで辿って判定する（解決結果はパスごとに記憶しておく）。
// isNotepadPath は画面描画中にも使う同期関数なので、.lnk の判定は resolveNotepadShortcut で
// 先に済ませておき、その結果（記憶済みの答え）だけを参照する。
const notepadLnkCache = new Map(); // 小文字化した.lnkのパス -> true/false
const notepadLnkPending = new Map(); // 判定中の問い合わせ（同じパスの二重問い合わせ防止）
function lnkKey(p) { return String(p || "").trim().toLowerCase(); }
function isLnkPath(p) { return /\.lnk$/i.test(String(p || "").trim()); }
function isNotepadPath(p) {
  const s = String(p || "").trim();
  if (/(^|[\\/])notepad\.exe$/i.test(s)) return true;
  return isLnkPath(s) && notepadLnkCache.get(lnkKey(s)) === true;
}
// .lnk でまだリンク先を調べていないか（＝ resolveNotepadShortcut を呼ぶ必要があるか）
function needsNotepadResolve(p) {
  return isLnkPath(p) && !notepadLnkCache.has(lnkKey(p));
}
async function resolveNotepadShortcut(p) {
  if (!isLnkPath(p)) return isNotepadPath(p);
  const key = lnkKey(p);
  if (notepadLnkCache.has(key)) return notepadLnkCache.get(key) === true;
  if (!notepadLnkPending.has(key)) {
    const job = (async () => {
      let result = false;
      try { result = !!(await window.api.isNotepadShortcut(String(p).trim())); } catch (e) { result = false; }
      notepadLnkCache.set(key, result);
      notepadLnkPending.delete(key);
      return result;
    })();
    notepadLnkPending.set(key, job);
  }
  return notepadLnkPending.get(key);
}
const MEMO_MODES = {
  open: { label: "既存のウィンドウを開く" },
  addTab: { label: "既存のウィンドウに追加" },
  newWindow: { label: "新規のウィンドウ" },
};
// リンクを開くブラウザの選択肢。「既定」以外を選ぶと、そのブラウザで直接開く
// （マルチ操作で「画面分割」を続ける場合は、既存ウィンドウのタブにせず新しいウィンドウで開く）。
const BROWSER_OPTIONS = {
  default: { label: "既定のブラウザ" },
  chrome: { label: "Google Chrome" },
  edge: { label: "Microsoft Edge" },
};
const CLIPBOARD_ACTIONS = {
  text: { label: "テキスト", glyph: "📋" },
  image: { label: "画像", glyph: "🖼" },
  file: { label: "ファイル", glyph: "📄" },
  folder: { label: "フォルダ", glyph: "📁" },
};
const BRIGHTNESS_ACTIONS = {
  up: { label: "明るくする", glyph: "🔆" },
  down: { label: "暗くする", glyph: "🌙" },
};
const MEDIA_ACTIONS = {
  playpause: { label: "再生/一時停止", glyph: "⏯" },
  next: { label: "次の曲", glyph: "⏭" },
  prev: { label: "前の曲", glyph: "⏮" },
};
const OBS_ACTIONS = {
  mute: { label: "ミュート切替", glyph: "🎙" },
  recordStart: { label: "録画開始", glyph: "⏺" },
  recordStop: { label: "録画停止", glyph: "⏹" },
  streamStart: { label: "配信開始", glyph: "📡" },
  streamStop: { label: "配信停止", glyph: "🛑" },
};
const WINDOW_ACTIONS = {
  left: { label: "左半分にスナップ", glyph: "◧" },
  right: { label: "右半分にスナップ", glyph: "◨" },
  "top-left": { label: "左上1/4にスナップ", glyph: "◰" },
  "top-right": { label: "右上1/4にスナップ", glyph: "◳" },
  "bottom-left": { label: "左下1/4にスナップ", glyph: "◱" },
  "bottom-right": { label: "右下1/4にスナップ", glyph: "◲" },
};
const VOLUME_ACTIONS = {
  up: { label: "音量を上げる", glyph: "🔊" },
  down: { label: "音量を下げる", glyph: "🔉" },
  mute: { label: "ミュート切替", glyph: "🔇" },
};
const POWER_ACTIONS = {
  sleep: { label: "スリープ", glyph: "💤" },
  shutdown: { label: "シャットダウン", glyph: "⏻" },
  restart: { label: "再起動", glyph: "🔁" },
};
const ZOOM_ACTIONS = {
  in: { label: "ズームイン", glyph: "🔍" },
  out: { label: "ズームアウト", glyph: "🔍" },
};
// 基本的なショートカットをワンクリックで送る（ボタン式・キーの自由登録はなし）。
// 実際に送るキーの組み合わせはmain.js側の固定リスト（BASIC_SHORTCUTS）が決めるので、
// ここでは「識別名」と表示だけを持つ。
const SHORTCUT_ACTIONS = {
  copy: { label: "コピー", glyph: "Ctrl+C" },
  cut: { label: "切り取り", glyph: "Ctrl+X" },
  paste: { label: "貼り付け", glyph: "Ctrl+V" },
  undo: { label: "元に戻す", glyph: "Ctrl+Z" },
  redo: { label: "やり直し", glyph: "Ctrl+Y" },
  selectAll: { label: "すべて選択", glyph: "Ctrl+A" },
  save: { label: "保存", glyph: "Ctrl+S" },
  find: { label: "検索", glyph: "Ctrl+F" },
};

// ---------- CSSアイコン（自分で描いたSVGアイコン集） ----------
// 「なし」を廃止した代わりに用意する、絵文字にも画像挿入にも頼らない内蔵アイコン。
// オン/オフの状態を持つもの（スピーカー・マイク）は、選択肢としては1つだけ見せて、
// 実際の状態（ミュート中かどうか）に応じて内部で自動的にオフ用の見た目に切り替える。
function svgWrap(inner) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
const CSS_ICONS = {
  link:        { label: "リンク",       svg: svgWrap(`<path d="M9 15l6-6"/><path d="M10 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>`) },
  app:         { label: "アプリ",       svg: svgWrap(`<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>`) },
  file:        { label: "ファイル",     svg: svgWrap(`<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>`) },
  folder:      { label: "フォルダ",     svg: svgWrap(`<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v10A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/>`) },
  clipboard:   { label: "コピー",       svg: svgWrap(`<rect x="7" y="4" width="10" height="16" rx="1.5"/><rect x="9.5" y="2" width="5" height="3" rx="1"/>`) },
  qr:          { label: "QR",          svg: svgWrap(`<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01"/>`) },
  music:       { label: "音符",         svg: svgWrap(`<circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M10 18V5l10-2v13"/>`) },
  sun:         { label: "太陽",         svg: svgWrap(`<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>`) },
  moon:        { label: "月",           svg: svgWrap(`<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>`) },
  sleep:       { label: "スリープ",     svg: `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" stroke="none"><text x="2" y="9" font-size="8.5" font-weight="700" font-family="'Space Grotesk',system-ui,sans-serif">Z</text><text x="8.5" y="15" font-size="6.5" font-weight="700" font-family="'Space Grotesk',system-ui,sans-serif">Z</text><text x="13.5" y="20.5" font-size="4.5" font-weight="700" font-family="'Space Grotesk',system-ui,sans-serif">z</text></svg>` },
  power:       { label: "電源",         svg: svgWrap(`<path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>`) },
  restart:     { label: "再起動",       svg: svgWrap(`<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v5h-5"/>`) },
  "volume-up": { label: "音量アップ",   svg: svgWrap(`<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/><path d="M19.5 6.5a8 8 0 0 1 0 11"/>`) },
  "volume-down": { label: "音量ダウン", svg: svgWrap(`<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 10.5a2.5 2.5 0 0 1 0 3"/>`) },
  speaker:     { label: "スピーカー",   svg: svgWrap(`<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/>`), toggle: true,
                 offSvg: svgWrap(`<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 5M21 9l-5 5" stroke="#FF6B5E"/>`) },
  mic:         { label: "マイク",       svg: svgWrap(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4M9 21h6"/>`), toggle: true,
                 offSvg: svgWrap(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4M9 21h6"/><path d="M4 4l16 16" stroke="#FF6B5E"/>`) },
  "snap-left": { label: "左スナップ",   svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><rect x="4.5" y="6" width="6" height="12" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  "snap-right": { label: "右スナップ",  svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><rect x="13.5" y="6" width="6" height="12" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  "snap-top-left":     { label: "左上1/4スナップ", svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M3 12h18" stroke-dasharray="2 2"/><rect x="4.5" y="6" width="6" height="5" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  "snap-top-right":    { label: "右上1/4スナップ", svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M3 12h18" stroke-dasharray="2 2"/><rect x="13.5" y="6" width="6" height="5" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  "snap-bottom-left":  { label: "左下1/4スナップ", svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M3 12h18" stroke-dasharray="2 2"/><rect x="4.5" y="13" width="6" height="5" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  "snap-bottom-right": { label: "右下1/4スナップ", svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M3 12h18" stroke-dasharray="2 2"/><rect x="13.5" y="13" width="6" height="5" fill="currentColor" stroke="none" opacity="0.65"/>`) },
  play:        { label: "再生",         svg: svgWrap(`<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>`) },
  pause:       { label: "一時停止",     svg: svgWrap(`<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>`) },
  "skip-next": { label: "次へ",         svg: svgWrap(`<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><rect x="17" y="5" width="2.5" height="14" fill="currentColor" stroke="none"/>`) },
  "skip-prev": { label: "前へ",         svg: svgWrap(`<path d="M19 5v14L9 12z" fill="currentColor" stroke="none"/><rect x="4.5" y="5" width="2.5" height="14" fill="currentColor" stroke="none"/>`) },
  "rotate-left":  { label: "回転（左）", svg: svgWrap(`<path d="M9 3.5A8.5 8.5 0 1 1 3.5 9"/><path d="M3 3v5.5h5.5"/>`) },
  "rotate-right": { label: "回転（右）", svg: svgWrap(`<path d="M15 3.5A8.5 8.5 0 1 0 20.5 9"/><path d="M21 3v5.5h-5.5"/>`) },
  camera:      { label: "カメラ",       svg: svgWrap(`<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.4-2.2h5.2L16 7"/><circle cx="12" cy="13.5" r="3.4"/>`) },
  cross:       { label: "×",           svg: svgWrap(`<path d="M6 6l12 12M18 6L6 18"/>`) },
  circleMark:  { label: "○",           svg: svgWrap(`<circle cx="12" cy="12" r="8"/>`) },
  check:       { label: "チェック",     svg: svgWrap(`<path d="M5 13l4 4 10-10"/>`) },
  bulb:        { label: "電球",         svg: svgWrap(`<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>`) },
  star:        { label: "星",           svg: svgWrap(`<path d="M12 3l2.6 5.8 6.2.6-4.7 4.2 1.4 6.2L12 16.9 6.5 19.8l1.4-6.2-4.7-4.2 6.2-.6z"/>`) },
  heart:       { label: "ハート",       svg: svgWrap(`<path d="M12 20s-7-4.5-9.3-9A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5c-2.3 4.5-9.3 9-9.3 9z"/>`) },
  gear:        { label: "設定",         svg: svgWrap(`<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`) },
  bell:        { label: "通知",         svg: svgWrap(`<path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>`) },
  calendar:    { label: "カレンダー",   svg: svgWrap(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`) },
  pc:          { label: "パソコン",     svg: svgWrap(`<rect x="3" y="4" width="18" height="11" rx="1.5"/><rect x="6" y="17" width="12" height="3" rx="1"/>`) },
  smartphone:  { label: "スマホ",       svg: svgWrap(`<rect x="7" y="2" width="10" height="20" rx="2.2"/><path d="M11 19h2"/>`) },
  usb:         { label: "USB",         svg: svgWrap(`<rect x="8" y="8" width="8" height="12" rx="1.5"/><path d="M12 8V3"/><path d="M9 3h1M14 3h1"/>`) },
  clock:       { label: "時計",         svg: svgWrap(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>`) },
  telephone:   { label: "電話",         svg: svgWrap(`<path d="M6 3c1 0 2 1 2 2l1 3c0 1 0 2-1 2l-1 1c1 3 3 5 6 6l1-1c0-1 1-1 2-1l3 1c1 0 2 1 2 2v2c0 1-1 2-2 2C10 20 4 14 4 5c0-1 1-2 2-2z"/>`) },
  trash:       { label: "ごみ箱",       svg: svgWrap(`<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/>`) },
  piano:       { label: "ピアノ",       svg: svgWrap(`<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M6 6v12M9 6v8M12 6v12M15 6v8M18 6v12"/>`) },
  guitar:      { label: "ギター",       svg: svgWrap(`<circle cx="8" cy="16" r="5"/><path d="M11 13l7-9"/><path d="M16 6l2 2"/><path d="M6.5 15.5h3"/>`) },
  drum:        { label: "ドラム",       svg: svgWrap(`<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v8a7 3 0 0 0 14 0V7"/><path d="M5 11a7 3 0 0 0 14 0"/>`) },
  map:         { label: "地図",         svg: svgWrap(`<path d="M9 4L4 6v14l5-2 6 2 5-2V4l-5 2-6-2z"/><path d="M9 4v14M15 6v14"/>`) },
  photo:       { label: "写真",         svg: svgWrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-3-3-5 5"/>`) },
  book:        { label: "本",           svg: svgWrap(`<path d="M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2z"/><path d="M20 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/>`) },
  wallet:      { label: "財布",         svg: svgWrap(`<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.3" fill="currentColor" stroke="none"/>`) },
  money:       { label: "お金",         svg: svgWrap(`<circle cx="12" cy="12" r="9"/><path d="M15 8.5h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9"/><path d="M12 6.5v2M12 15.5v2"/>`) },
  headphones:  { label: "ヘッドフォン", svg: svgWrap(`<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/>`) },
  earphones:   { label: "イヤホン",     svg: svgWrap(`<circle cx="7" cy="6" r="2"/><circle cx="17" cy="6" r="2"/><path d="M7 8v6a3 3 0 0 0 3 3M17 8v6a3 3 0 0 0-3 3"/>`) },
  tv:          { label: "テレビ",       svg: svgWrap(`<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 18v2"/><path d="M8 3l2 3M16 3l-2 3"/>`) },
  speakers2:   { label: "外部スピーカー", svg: svgWrap(`<rect x="3" y="4" width="7" height="16" rx="1.5"/><circle cx="6.5" cy="9" r="1.6"/><circle cx="6.5" cy="15" r="1.6"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><circle cx="17.5" cy="9" r="1.6"/><circle cx="17.5" cy="15" r="1.6"/>`) },
  car:         { label: "車",           svg: svgWrap(`<path d="M4 16l1.5-5A2 2 0 0 1 7.4 9.5h9.2a2 2 0 0 1 1.9 1.5L20 16"/><rect x="3" y="16" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="20" r="1.5"/><circle cx="16.5" cy="20" r="1.5"/>`) },
  "zoom-in":   { label: "ズームイン",   svg: svgWrap(`<circle cx="10" cy="10" r="7"/><path d="M10 7v6M7 10h6"/><path d="M15 15l6 6"/>`) },
  "zoom-out":  { label: "ズームアウト", svg: svgWrap(`<circle cx="10" cy="10" r="7"/><path d="M7 10h6"/><path d="M15 15l6 6"/>`) },
  thumbsUp:    { label: "いいね",       svg: svgWrap(`<path d="M7 11v9H4v-9z"/><path d="M7 11l4.5-7.5c.5-.8 1.7-.5 1.7.4V9h5.3c1 0 1.7 1 1.4 1.9l-2 6.5a2 2 0 0 1-1.9 1.6H9.5c-.9 0-1.7-.4-2.2-1.1"/>`) },
  share:       { label: "共有",         svg: svgWrap(`<path d="M12 15V3"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>`) },
  chatRound:   { label: "吹き出し（丸）", svg: svgWrap(`<ellipse cx="12" cy="10.5" rx="8" ry="6.5"/><path d="M8.3 16L6.5 20.5l5-3.6"/>`) },
  chatSquare:  { label: "吹き出し（四角）", svg: svgWrap(`<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.3 16.5L6.5 21l5-4"/>`) },
  eraser:      { label: "消しゴム",     svg: svgWrap(`<path d="M9 20H6l-3-3a1.5 1.5 0 0 1 0-2.1l9-9a1.5 1.5 0 0 1 2.1 0l4 4a1.5 1.5 0 0 1 0 2.1L11 19"/><path d="M7 14l5 5"/><path d="M9 20h9"/>`) },
  pencil:      { label: "鉛筆",         svg: svgWrap(`<path d="M4 20l1-4.2L15.5 5.3a1.5 1.5 0 0 1 2.1 0l1.1 1.1a1.5 1.5 0 0 1 0 2.1L8.2 19z"/><path d="M13.5 7.3l3.2 3.2"/><path d="M4 20l4.2-1"/>`) },
  layers:      { label: "マルチ操作",   svg: svgWrap(`<path d="M12 3l8 4.5-8 4.5-8-4.5z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5l8 4.5 8-4.5"/>`) },
  screens:     { label: "画面切替",     svg: svgWrap(`<rect x="3" y="4" width="13" height="10" rx="1.5"/><rect x="8" y="10" width="13" height="10" rx="1.5"/>`) },
};
// ピッカー内で「オン/オフに対応」グループと、ジャンル別のグループに分けて表示するため
const CSS_ICON_TOGGLE_KEYS = Object.keys(CSS_ICONS).filter((k) => CSS_ICONS[k].toggle);
const CSS_ICON_GROUPS = [
  { title: "オン/オフに対応（状態に応じて自動で切り替わります）", keys: CSS_ICON_TOGGLE_KEYS },
  { title: "システム・操作", keys: ["power", "restart", "sleep", "sun", "moon", "volume-up", "volume-down", "zoom-in", "zoom-out", "snap-left", "snap-right", "snap-top-left", "snap-top-right", "snap-bottom-left", "snap-bottom-right", "play", "pause", "skip-next", "skip-prev", "gear", "bell", "calendar", "link", "app", "qr", "layers", "screens"] },
  { title: "ファイル・書類", keys: ["file", "folder", "clipboard", "book", "wallet", "money"] },
  { title: "デバイス", keys: ["pc", "smartphone", "usb", "clock", "telephone", "tv", "headphones", "earphones", "speakers2", "car"] },
  { title: "音楽", keys: ["music", "piano", "guitar", "drum"] },
  { title: "その他", keys: ["cross", "circleMark", "check", "bulb", "star", "heart", "thumbsUp", "share", "chatRound", "chatSquare", "pencil", "eraser", "trash", "map", "photo"] },
];

// ---------- ミュート状態（スピーカー／マイク）----------
// アイコンの「ミュート中」表示は、押した回数からの推測ではなく、OSの実際の状態を読んで決める。
// （以前は、押すたびに保存済みの印を反転していたため、もともとミュートだった場合や、
//   キーボード・他のアプリ・Windowsの設定でミュートを切り替えた場合に、アイコンが実際と逆になっていた）
// true=ミュート中 / false=ミュートなし / null=まだ分からない（ミュートなしの見た目にしておく）。
const audioMuteState = { speaker: null, mic: null };
const MUTE_POLL_INTERVAL_MS = 5000; // 画面が見えている間、この間隔でOSの実際の状態を読み直す（5秒）
let muteRefreshInFlight = false;
let muteRefreshTimer = null;
function isMuteStateTile(t) {
  return !!t && ((t.type === "volume" && t.action === "mute") || t.type === "mic");
}
// 実際の状態を読み、変わっていたときだけ画面を描き直す。
// ミュート系のボタンが1つも無いときは、何も呼ばない（PowerShellを無駄に起動しない）。
const APP_STARTED_AT = Date.now();
const MUTE_READ_NOT_BEFORE_MS = 3000; // 起動直後の重い処理を避けるため、起動からこの時間は読まない（定期・フォーカス・再表示のどれからも）
async function refreshMuteStates() {
  if (muteRefreshInFlight || !tiles.some(isMuteStateTile)) return;
  const sinceStart = Date.now() - APP_STARTED_AT;
  if (sinceStart < MUTE_READ_NOT_BEFORE_MS) { scheduleMuteRefresh(MUTE_READ_NOT_BEFORE_MS - sinceStart + 50); return; }
  muteRefreshInFlight = true;
  try {
    const r = await window.api.getMuteStates();
    if (!r) return;
    let changed = false;
    for (const key of ["speaker", "mic"]) {
      // 取得できなかった（null）ときは、直前の表示をそのまま残す
      if (typeof r[key] === "boolean" && audioMuteState[key] !== r[key]) { audioMuteState[key] = r[key]; changed = true; }
    }
    if (changed) renderGrid();
  } catch (e) { /* 読み取りに失敗しても、表示はそのまま */ } finally {
    muteRefreshInFlight = false;
  }
}
function scheduleMuteRefresh(delayMs) {
  clearTimeout(muteRefreshTimer);
  muteRefreshTimer = setTimeout(refreshMuteStates, delayMs);
}
// このボタンが「今ミュート中か」（アイコンを「オフ」の見た目にするか）
function isTileMuted(tile) {
  if (tile.type === "volume" && tile.action === "mute") return audioMuteState.speaker === true;
  if (tile.type === "mic") return audioMuteState.mic === true;
  return false;
}
// このボタンが「今オフ状態か」を判定する（オン/オフ対応アイコンのみ意味を持つ）
function isIconOff(tile) {
  return isTileMuted(tile);
}
// このタイルがそもそも「オン/オフ」の状態を持つ種類か（ミュート系ボタン）。
// これらは「CSS」アイコンを個別選択する場合、オン用・オフ用の2つを両方選ぶ必要がある。
function tileHasToggle(tile) {
  return (tile.type === "volume" && tile.action === "mute") || tile.type === "mic";
}

// タイルの種類・動作から、CSSアイコンの初期値（デフォルト）を決める
function defaultCssIconFor(t) {
  switch (t.type) {
    case "link": return "link";
    case "app": return "app";
    case "sound": return "music";
    case "file": return "file";
    case "folder": return "folder";
    case "qr": return "qr";
    case "clipboard":
      if (t.action === "image") return "photo";
      if (t.action === "file") return "file";
      if (t.action === "folder") return "folder";
      return "clipboard";
    case "timer": return "clock";
    case "media":
      if (t.action === "next") return "skip-next";
      if (t.action === "prev") return "skip-prev";
      return "play";
    case "volume":
      if (t.action === "up") return "volume-up";
      if (t.action === "down") return "volume-down";
      return "speaker";
    case "power":
      if (t.action === "shutdown") return "power";
      if (t.action === "restart") return "restart";
      return "sleep";
    case "window":
      return { left: "snap-left", right: "snap-right", "top-left": "snap-top-left", "top-right": "snap-top-right", "bottom-left": "snap-bottom-left", "bottom-right": "snap-bottom-right" }[t.action] || "snap-left";
    case "pageswitch":
      return "screens";
    case "brightness":
      return t.action === "down" ? "moon" : "sun";
    case "mic":
      return "mic";
    case "zoom":
      return t.action === "out" ? "zoom-out" : "zoom-in";
    case "discord":
      return "chatRound";
    case "obs":
      return t.action === "mute" ? "mic" : "tv";
    case "shortcutKeys":
      return { copy: "layers", cut: "eraser", paste: "clipboard", undo: "rotate-left", redo: "rotate-right", selectAll: "check", save: "file", find: "zoom-in" }[t.action] || "clipboard";
    case "screenshotFull":
      return "camera";
    case "multi":
      return "layers";
    default:
      return "circleMark";
  }
}
// アイコンが「css」以外（絵文字・画像を明示的に選んでいる場合）はそのまま尊重する。
// 「css」（ユーザーが個別にアイコンを選んだ状態）は、種類・動作を変えても上書きしない
// （＝一度選んだアイコンは維持される）。「default（既定）」は値を保存せず、常に
// defaultCssIconFor() で毎回その場で自動計算するので、ここでは何もしなくてよい。
// 後方互換のため、旧データ（kind未設定・"none"）だけは「default」に正規化する。
function normalizeIcon(t) {
  // 廃止した「CSSアイコンの上に重ねる絵文字」の保存済みデータが残っていれば取り除く
  if (t.icon && "overlayEmoji" in t.icon) delete t.icon.overlayEmoji;
  if (!t.icon || (t.icon.kind !== "emoji" && t.icon.kind !== "image" && t.icon.kind !== "css" && t.icon.kind !== "default")) {
    t.icon = { kind: "default", value: "" };
  } else if (t.icon.kind === "css" && !CSS_ICONS[t.icon.value]) {
    t.icon.value = defaultCssIconFor(t);
  }
}
// 現在のタイルに対して実際に描画すべきCSSアイコンのキーを決める
// （kindが"css"で有効な値があればそれを、それ以外（"default"など）は自動計算する）。
function resolveCssIconKey(t) {
  if (t.icon?.kind === "css" && CSS_ICONS[t.icon.value]) return t.icon.value;
  return defaultCssIconFor(t);
}

// タイルの種類・動作に応じた「おすすめの初期カラー」。
// あくまで新規追加時の初期値であり、カラー欄からいつでも個別に変更できる。
function suggestedColorFor(t) {
  if (t.type === "power") {
    if (t.action === "shutdown") return "#FFFFFF";
    if (t.action === "sleep") return "#7FD8F5";
    return null;
  }
  if (t.type === "brightness") return t.action === "down" ? "#FFDE59" : "#FF7A45";
  if (t.type === "mic") return "#3ED67A";
  if (t.type === "volume" && t.action === "mute") return "#5B8CFF";
  if (t.type === "timer") return "#FFDE59";
  return null;
}
// 追加モードで、まだ手動でカラーを触っていない場合にだけ、種類・動作に
// 合わせたおすすめカラーを自動で当てる（一度でも手で変更したら以後は上書きしない）。
function applySuggestedColorIfNeeded(t) {
  if (!modalData || modalData.mode !== "add" || modalData.colorTouched) return;
  const sc = suggestedColorFor(t);
  if (sc) t.color = sc;
}

const THEME_PRESETS = {
  black:   { bg1: "#14161B", bg2: "#111319", panel: "#1D2129", panelAlt: "#262B35", border: "#2B303A", text: "#EDEFF2", textMuted: "#8B92A0" },
  navy:    { bg1: "#0B1B3A", bg2: "#071328", panel: "#142C52", panelAlt: "#1A3563", border: "#24437A", text: "#EAF0FF", textMuted: "#8FAEDE" },
  gray:    { bg1: "#32353F", bg2: "#2B2D31", panel: "#3B3E44", panelAlt: "#444850", border: "#4C515A", text: "#EDEFF0", textMuted: "#9095A0" },
  white:   { bg1: "#FFFFFF", bg2: "#F5F6F8", panel: "#FFFFFF", panelAlt: "#F2F3F5", border: "#E2E4E8", text: "#1A1C20", textMuted: "#6B7178" },
  beige:   { bg1: "#F2E8DA", bg2: "#EBDFCC", panel: "#FAF4E9", panelAlt: "#EFE3D0", border: "#DDCBAE", text: "#4A3F2E", textMuted: "#8A7B60" },
  image:   { bg1: "transparent", bg2: "transparent", panel: "rgba(20,22,27,0.72)", panelAlt: "rgba(38,43,53,0.72)", border: "rgba(255,255,255,0.14)", text: "#EDEFF2", textMuted: "#C7CCD6" },
};
const THEME_LABELS = { black: "黒", navy: "紺", gray: "グレー", white: "白", beige: "ベージュ" };

// ボタン（タイル）アイコンが、枠に対してどれくらいの大きさを占めるかの比率。
// 「大」は既存の見た目そのまま、「小」はひとまわり控えめに表示する。
// ※ ハンバーガーメニュー／ロックボタン／サブページ切替ボタンは --icon-size を
//   まったく参照しない別サイズ（--top-btn-size, --pager-btn-size）で描画されるため、
//   ここを変えてもそれらのボタン同士の幅が干渉することはない。
const ICON_SIZE_RATIOS = {
  large:  { shown: 0.56, hidden: 0.82 },
  medium: { shown: 0.45, hidden: 0.62 },
  small:  { shown: 0.40, hidden: 0.54 },
};
const ICON_SIZE_KEYS = ["large", "medium", "small"];

// 画面（ページ）ごとに独立して持つ設定の保存領域。
// settings.pageThemes[pageIndex] に、テーマ系（背景・アイコンの大きさ）だけでなく、
// レイアウト（行数・列数）、名前／ショートカットキーの表示、影、アイコンボタン裏の枠の透明度、
// アクセントカラーも画面ごとに保存する。
// ※ 保存名は昔の互換性のため pageThemes のままにしている（main.jsの背景画像整理も参照している）。
const PAGE_SETTING_KEYS = [
  "themeMode", "customColor", "bgImagePath", "bgImageFit", "bgImageBrightness", "panelColorOverride", "iconSize",
  "accent", "gridColumns", "gridRows", "showNameLabel", "showHotkeyLabel", "showShadows", "panelOpacity",
  "iconRingEnabled", "iconRingBrightness",
];
// 以前のバージョンでは全画面共通（settings直下）だったキー。
// 画面別の値がまだ無いときだけ、その共通値を引き継ぐ（＝更新しても見た目が変わらない）。
const LEGACY_GLOBAL_PAGE_KEYS = ["accent", "gridColumns", "gridRows", "showNameLabel", "showHotkeyLabel", "showShadows", "panelOpacity"];
const PANEL_OPACITY_DEFAULT = 0.7;
// 画面ごとの設定の初期値（「初期設定で新しい画面を作る」ときにも使う）。
function pageSettingDefaults() {
  const d = {};
  PAGE_SETTING_KEYS.forEach((k) => { d[k] = DEFAULT_SETTINGS[k]; });
  d.panelOpacity = PANEL_OPACITY_DEFAULT;
  return d;
}
// バックアップなど外部由来の値も入り得るため、形が壊れていれば初期値に戻す。
function sanitizePageSetting(key, value, fallback) {
  switch (key) {
    case "gridColumns":
    case "gridRows": {
      if (value === "auto") return "auto";
      const n = Number(value);
      return Number.isFinite(n) && n >= 1 && n <= 8 ? Math.round(n) : "auto";
    }
    case "showNameLabel":
    case "showHotkeyLabel":
    case "showShadows":
      return typeof value === "boolean" ? value : fallback;
    case "panelOpacity":
      return typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
    case "accent":
    case "customColor":
      return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
    case "themeMode":
      return ["black", "navy", "gray", "white", "beige", "image", "custom"].includes(value) ? value : fallback;
    case "bgImageFit":
      return ["cover", "contain", "repeat"].includes(value) ? value : fallback;
    case "bgImagePath":
      return typeof value === "string" ? value : fallback;
    case "bgImageBrightness":
      return typeof value === "number" && value >= 0.3 && value <= 1.7 ? value : fallback;
    case "panelColorOverride":
      return typeof value === "string" && (value === "" || /^#[0-9a-fA-F]{6}$/.test(value)) ? value : fallback;
    case "iconRingEnabled":
      return typeof value === "boolean" ? value : fallback;
    case "iconRingBrightness":
      return typeof value === "number" && value >= 0 && value <= 100 ? Math.round(value) : fallback;
    default:
      return value;
  }
}
function ensurePageThemes() {
  if (!Array.isArray(settings.pageThemes)) settings.pageThemes = [];
  const defaults = pageSettingDefaults();
  for (let i = 0; i < MAX_PAGE_COUNT; i++) {
    const cur = settings.pageThemes[i];
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) settings.pageThemes[i] = {};
    const p = settings.pageThemes[i];
    PAGE_SETTING_KEYS.forEach((key) => {
      let v = p[key];
      if (v === undefined) {
        v = LEGACY_GLOBAL_PAGE_KEYS.includes(key) && settings[key] !== undefined ? settings[key] : defaults[key];
      }
      p[key] = sanitizePageSetting(key, v, defaults[key]);
    });
    // 既存の保存データ（iconSize未保存、または旧バージョンの値）を読み込んだ場合の移行措置。デフォルトは「大」。
    if (!ICON_SIZE_KEYS.includes(p.iconSize)) p.iconSize = defaults.iconSize;
  }
}
// ある画面の設定を丸ごと複製する（新しい画面を「ほかの画面と同じ設定」で作るときに使う）。
function copyPageSettings(src) {
  const out = {};
  PAGE_SETTING_KEYS.forEach((k) => { out[k] = src[k]; });
  return out;
}
// このウィンドウが担当しているページ（WINDOW_PAGE_INDEX）の「画面ごとの設定」を返す。
// 設定パネルのテーマ・レイアウト・表示系の項目は、常にこのオブジェクトを直接書き換える＝
// 編集内容はこのウィンドウのページだけに反映され、他ページには影響しない。
// ※ persistSettings() は settings オブジェクト自体を作り直すため、返り値を長く持ち回らず、
//   書き込みのたびに currentPageTheme() を呼び直すこと。
function currentPageTheme() {
  ensurePageThemes();
  return settings.pageThemes[WINDOW_PAGE_INDEX];
}

// ※ themeMode〜showShadows のうち PAGE_SETTING_KEYS に入っているものは「画面ごとの設定」の初期値。
//   settings直下の値は、旧バージョンからの引き継ぎ用（画面別の値が無いときだけ参照）。
const DEFAULT_SETTINGS = {
  themeMode: "gray",
  customColor: "#3A3F4B",
  bgImagePath: "",
  bgImageFit: "cover",
  bgImageBrightness: 1,
  panelColorOverride: "",
  iconSize: "large",
  iconRingEnabled: false,
  iconRingBrightness: 55,
  accent: "#FF6B5E",
  buttonShape: "square",
  gridColumns: "auto",
  gridRows: "auto",
  presets: [],
  showTitle: false, // 初期設定ではタイトルを非表示（ハンバーガーメニュー最上部で切替）
  showNameLabel: true,
  showHotkeyLabel: true,
  showShadows: true,
  alwaysOnTop: false,
  pageLocks: [], // 画面（ページ）ごとの「常に最前面」。画面番号順のtrue/false
  launchAtLogin: false,
  pageCount: 1,
  obsHost: "127.0.0.1",
  obsPort: 4455,
  obsPassword: "",
};

const BASE_TILE = 126; // 自動モードでの基準アイコンサイズ
const RECOMMENDED_PRESETS = [{ name: "おすすめ3×5", rows: 3, columns: 5 }];
const GRID_GAP = 11; // ボタン同士の左右の間隔（CSSの.gridのgap列側と必ず一致させること）
const GRID_ROW_GAP = 7.5; // ボタン同士の上下の間隔（CSSの.gridのgap行側と必ず一致させること）
const MIN_TILE = 30;   // 行数・列数を固定しているときの絶対的な下限
const MAX_TILE = 220;  // これより大きくはしない
const AUTO_MIN_TILE = 56; // 行数・列数が両方「自動」のときに縮小してよい下限（これより小さいと逆に見づらいため、MIN_TILEより少し大きめ）
const MAX_PAGE_COUNT = 6; // ページの最大数（1ページ最大8×8=64個 × 最大6ページ＝合計最大384個）

// このウィンドウが担当する「ページ」番号。ページ0は常にメインウィンドウで、
// ページ1以降はURLのクエリ文字列（?page=N）で渡され、別画面（別ウィンドウ）として開く。
// 1つのウィンドウが担当するページは起動時に固定され、以後このウィンドウ内で
// 他のページへ切り替わることはない（切り替えたい場合は該当ページの別画面を開く）。
const WINDOW_PAGE_INDEX = Math.max(0, Math.min(MAX_PAGE_COUNT - 1, parseInt(new URLSearchParams(location.search).get("page"), 10) || 0));
let selfClosing = false; // ページ削除などでこのウィンドウを自動で閉じている最中の二重呼び出し防止

let tiles = [];
let settings = { ...DEFAULT_SETTINGS };
let modalData = null;
let confirmDeleteId = null;
let toastTimer = null;
let holdTimer = null;
let dragSourceId = null;
let dragGhostEl = null; // ドラッグ中だけ使う不透明な代役プレビュー要素（壁紙の焼き付き防止用）
let currentPage = 0;
let activePage = WINDOW_PAGE_INDEX;
let recordingHotkey = false;
let activeHotkeyKeydownHandler = null;

// OS標準の予約済みショートカット（重複登録を禁止）
const RESERVED_HOTKEYS = new Set([
  "Alt+Tab", "Alt+F4", "Alt+Escape", "Alt+Space",
  "Control+Alt+Delete", "Control+Shift+Escape", "Control+Escape",
  "Control+Alt+Tab",
  "Meta+L", "Meta+D", "Meta+E", "Meta+R", "Meta+I", "Meta+Tab", "Meta+M",
  "Meta+Up", "Meta+Down", "Meta+Left", "Meta+Right", "Meta+Space", "Meta+P",
  "Meta+Shift+S", "Meta+Control+Delete",
  "Control+Alt+Escape",
  // ほぼ全てのアプリで使われる共通の編集ショートカット（乗っ取り防止）
  "Control+A", "Control+C", "Control+V", "Control+X", "Control+Z", "Control+Y",
  "Control+S", "Control+F", "Control+P", "Control+N", "Control+O", "Control+W",
  "Control+T", "Control+Tab", "Control+PageUp", "Control+PageDown",
]);
function isReservedHotkey(combo) {
  return RESERVED_HOTKEYS.has(combo);
}

const gridEl = document.getElementById("grid");
gridEl.addEventListener("dragover", (e) => e.preventDefault());
gridEl.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!dragSourceId) return;
  const sourceId = dragSourceId;
  dragSourceId = null;
  moveTileToEndOfPage(sourceId);
});
const emptyHintEl = document.getElementById("emptyHint");
const overlayEl = document.getElementById("overlay");
const modalBodyEl = document.getElementById("modalBody");
const settingsOverlayEl = document.getElementById("settingsOverlay");
const settingsBodyEl = document.getElementById("settingsBody");
const typeSelectOverlayEl = document.getElementById("typeSelectOverlay");
const typeSelectListEl = document.getElementById("typeSelectList");
const typeSelectCancelBtn = document.getElementById("typeSelectCancelBtn");
const toastEl = document.getElementById("toast");
const hamburgerBtn = document.getElementById("hamburgerBtn");
const lockBtn = document.getElementById("lockBtn");

function uid() { return "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

// 保存・登録用のアクセラレータ形式（"Control+Alt+Shift+K"）はそのまま保持しつつ、
// 画面表示のときだけ短く読みやすい表記（"Ctrl+Alt+Shift+K"）に変換する。
function formatHotkeyDisplay(hotkey) {
  if (!hotkey) return "";
  return hotkey.replace(/Control/g, "Ctrl");
}
// ツールチップ用のショートカット表示：「Ctrl Alt Sft G」のように、修飾キーを短くして空白で区切る
function formatHotkeyForTooltip(hotkey) {
  if (!hotkey) return "";
  const parts = String(hotkey).split("+").map((p) => p.trim());
  if (parts.length > 1 && parts[parts.length - 1] === "") { parts.pop(); parts.push("+"); } // 「+」キー自体（例：Ctrl++）
  const names = { Control: "Ctrl", CommandOrControl: "Ctrl", Ctrl: "Ctrl", Shift: "Sft", Alt: "Alt", Option: "Alt", Meta: "Win", Super: "Win", Command: "Win", Cmd: "Win" };
  return parts.filter((p) => p !== "").map((p) => names[p] || p).join(" ");
}
// ボタンの上に表示するショートカットキーは「英字または数字1文字」だけにする
// （例：Ctrl+Alt+Shift+K → K）。1文字でないもの（古いデータなど）は従来どおり全体を表示する。
function formatHotkeyKeyOnly(hotkey) {
  if (!hotkey) return "";
  const last = String(hotkey).split("+").pop();
  return /^[A-Za-z0-9]$/.test(last) ? last.toUpperCase() : formatHotkeyDisplay(hotkey);
}

// キー入力から「割り当てるキー1文字（A-Z / 0-9）」を取り出す。
// Shiftを押していると ev.key は "1"→"!"、"2"→"\""、"7"→"'" のように記号へ変わってしまうため、
// 押された物理キーを表す ev.code（"Digit1" / "KeyA"）から判定する。
// これによりShift併用でも 1〜0 が正しく数字として扱われ、キーボード配列（JIS/US）にも依存しない。
function hotkeyCharFromEvent(ev) {
  const code = ev.code || "";
  let m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  return null;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

function toFileUrl(p) {
  if (!p) return "";
  // アプリのアイコン自動取得ではdata URLをそのまま使うため、素通しする
  if (p.startsWith("data:")) return p;
  let clean = p.replace(/\\/g, "/");
  if (!clean.startsWith("/")) clean = "/" + clean;
  return "file://" + encodeURI(clean);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// tile.color はバックアップのインポート等、UIの色選択（<input type="color">）を
// 経由しない経路からも値が入り得る。HTML文字列（style属性等）にそのまま埋め込むと
// 不正な値（例："red\" onerror=\"..."）でタグ属性から抜け出されるおそれがあるため、
// テンプレート文字列に差し込む直前に必ずこれを通し、正規のCSSカラー表記
// （#RGB/#RGBA/#RRGGBB/#RRGGBBAA または既知のCSSキーワード程度）以外は
// 既定色にフォールバックする。
const SAFE_COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// 数値のつもりの値（バックアップのインポート等で文字列が混ざり得る）をHTML属性に埋め込む前に数値へそろえる
function numAttr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}
function safeColor(c) {
  return typeof c === "string" && SAFE_COLOR_RE.test(c.trim()) ? c.trim() : "#FFB238";
}

// ---------- 色計算 ----------
function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function clampByte(v) { return Math.max(0, Math.min(255, v)); }
function shade(hex, percent) {
  const { r, g, b } = hexToRgb(hex);
  const amt = Math.round(2.55 * percent);
  return "#" + [clampByte(r + amt), clampByte(g + amt), clampByte(b + amt)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// 黒 or 白に向かって指定した割合だけ混ぜる。shade()（各チャンネルに一定量を加算）は
// 彩度の高い色だと途中でチャンネルが0や255に張り付いてしまい、十分な差が出ないことがあるため、
// カスタムテーマの背景・パネル色の差をはっきり付けたい箇所ではこちらを使う。
function mix(hex, towardHex, weight) {
  const a = hexToRgb(hex);
  const b = hexToRgb(towardHex);
  const r = Math.round(a.r + (b.r - a.r) * weight);
  const g = Math.round(a.g + (b.g - a.g) * weight);
  const bl = Math.round(a.b + (b.b - a.b) * weight);
  return "#" + [r, g, bl].map((x) => clampByte(x).toString(16).padStart(2, "0")).join("");
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
// luminance()はhex専用だが、テーマプリセットの一部（imageテーマのpanel等）はrgba()文字列で
// 保持されているため、どちらの形式でも明るさを計算できるようにしたもの。
function luminanceOfAny(colorStr) {
  const s = String(colorStr || "");
  if (s.startsWith("rgba") || s.startsWith("rgb(")) {
    const nums = (s.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    return (0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) / 255;
  }
  return luminance(s);
}
// 画像背景テーマのときだけ、アイコンボタン裏の枠色をユーザーが指定した色に差し替えるための計算。
// カスタムテーマ（deriveThemeFromColor）と同じ考え方で、指定色から黒/白に混ぜてpanel/panelAlt/borderを作る。
function deriveTilePanelColors(hex) {
  const dark = luminance(hex) < 0.5;
  const toward = dark ? "#FFFFFF" : "#000000";
  return { panel: mix(hex, toward, 0.16), panelAlt: mix(hex, toward, 0.27), border: mix(hex, toward, 0.4) };
}
function deriveThemeFromColor(hex) {
  const dark = luminance(hex) < 0.5;
  // 彩度の高い色（原色の緑・青など）を選んでも、パネルやボタンが背景に埋もれて
  // 見分けづらくならないよう、黒／白へのブレンドで明確な差を作る。
  const toward = dark ? "#FFFFFF" : "#000000";
  return {
    bg1: hex, bg2: mix(hex, "#000000", dark ? 0.08 : 0.1),
    panel: mix(hex, toward, 0.16), panelAlt: mix(hex, toward, 0.27), border: mix(hex, toward, 0.4),
    text: dark ? "#EDEFF2" : "#1A1C20", textMuted: dark ? "#9BA2AF" : "#5B6270",
  };
}

// 選択済みのファイルパスなど「薄字で見づらい」情報表示用の色を、
// 実際に乗る背景（panel-alt）の明暗に応じて自動調整する。
// テーマカラーを変えても常に一定以上のコントラストを保てるようにする。
function readableDimColor(bgHex) {
  const isDarkBg = luminance(bgHex) < 0.5;
  return isDarkBg ? shade(bgHex, 62) : shade(bgHex, -62);
}

// hex("#RRGGBB")でもrgba("rgba(r,g,b,a)")でも受け取り、指定した不透明度(0〜1)を
// 上書きしたrgba文字列を返す。アイコンボタン裏などの枠色に、ユーザーが自由に
// 設定した透明度を反映させるために使う。
function colorWithAlpha(colorStr, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  if (colorStr.startsWith("rgba") || colorStr.startsWith("rgb(")) {
    const nums = colorStr.match(/[\d.]+/g) || [];
    const [r = 0, g = 0, b = 0] = nums;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const { r, g, b } = hexToRgb(colorStr);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// この画面における「枠（アイコンボタン裏）」の実効透明度(0〜1)。画面ごとに独立している。
// ユーザーがスライダーで一度も変更していない場合は、初期設定として70%を返す。
function currentPanelOpacity() {
  const v = currentPageTheme().panelOpacity;
  return typeof v === "number" ? v : PANEL_OPACITY_DEFAULT;
}

// ハンバーガーメニュー最上部の「タイトルを表示」設定を反映する。
// 非表示のときは、サブページ切替（◀ 1 / 2 ▶）がタイトルの位置に来て、2段にならないようにする。
function applyTitleVisibility() {
  const hidden = settings.showTitle !== true;
  const titleWrap = document.getElementById("appTitle") && document.getElementById("appTitle").parentElement;
  if (titleWrap) titleWrap.style.display = hidden ? "none" : "";
  const header = document.querySelector(".header");
  if (header) header.classList.toggle("no-title", hidden);
}

function applyTheme() {
  applyTitleVisibility();
  const pt = currentPageTheme();
  document.body.classList.toggle("no-btn-shadow", pt.showShadows === false);
  const root = document.documentElement.style;
  const preset = pt.themeMode === "custom" ? deriveThemeFromColor(pt.customColor || "#3A3F4B") : (THEME_PRESETS[pt.themeMode] || THEME_PRESETS.black);
  // 画像背景のときだけ、アイコンボタン裏の枠色をユーザー指定の色に差し替えられる（透明度は既存のスライダーと共通）。
  // ただしこれは「アイコンボタン（.tile）だけ」の見た目にする。ハンバーガー・ロック・ページ切替ボタン等
  // （panel-solid系）や、モーダルなど全体で使うborderには影響させない（presetそのものは書き換えない）。
  const tilePanel = (pt.themeMode === "image" && pt.panelColorOverride) ? deriveTilePanelColors(pt.panelColorOverride) : preset;
  root.setProperty("--bg1", preset.bg1);
  root.setProperty("--bg2", preset.bg2);
  const panelAlpha = currentPanelOpacity();
  // --panel / --panel-alt はアイコンボタン（.tile）の背景専用。透明度スライダーの値を反映する。
  root.setProperty("--panel", colorWithAlpha(tilePanel.panel, panelAlpha));
  root.setProperty("--panel-alt", colorWithAlpha(tilePanel.panelAlt, panelAlpha));
  // --panel-solid / --panel-alt-solid はハンバーガーメニュー・ハンバーガーボタン・ロックボタン・
  // サブページ切替ボタンなど、アイコンボタン以外の背景用。アイコンボタン裏の透明度スライダーとは
  // 連動させず、常に固定76%の透明度にする（画像背景テーマのpanel/panelAltは元々rgba()に薄い
  // 透明度が付いているため、colorWithAlpha()で上書きして固定値にする）。ここは常にpreset（未上書き）
  // を使い、アイコンボタン裏の枠色の変更につられて色が変わらないようにする。
  const FIXED_PANEL_SOLID_ALPHA = 0.76;
  root.setProperty("--panel-solid", colorWithAlpha(preset.panel, FIXED_PANEL_SOLID_ALPHA));
  root.setProperty("--panel-alt-solid", colorWithAlpha(preset.panelAlt, FIXED_PANEL_SOLID_ALPHA));
  // --border は全体（モーダル・ページ切替ボタンなど）で使う共通の枠色なので、こちらもpreset（未上書き）を使う。
  root.setProperty("--border", preset.border);
  // --tile-border-color はアイコンボタン（.tile）専用の枠線色。ここだけtilePanel（上書き対応）を使い、
  // 透明度が0%のときはボタン本体が透明になっても枠線だけ残って見えてしまうため、一緒に消す。
  root.setProperty("--tile-border-color", panelAlpha <= 0 ? "transparent" : tilePanel.border);
  root.setProperty("--text", preset.text);
  root.setProperty("--text-muted", preset.textMuted);
  root.setProperty("--text-dim", readableDimColor(preset.panelAlt));
  const accent = pt.accent || "#FFB238";
  root.setProperty("--accent", accent);
  root.setProperty("--accent-contrast", luminance(accent) > 0.6 ? "#14161B" : "#FFFFFF");
  if (settings.buttonShape === "circle") {
    root.setProperty("--tile-radius", "50%");
    root.setProperty("--icon-radius", "50%");
  } else {
    // タイルが小さくなっても角丸だけが大きいまま残って丸く見えないよう、タイルの大きさに比例させる
    // （最大は従来どおり20px／12px）。--tile-size はrenderGridで設定される。
    root.setProperty("--tile-radius", "clamp(4px, calc(var(--tile-size, 96px) * 0.18), 20px)");
    root.setProperty("--icon-radius", "clamp(3px, calc(var(--tile-size, 96px) * 0.11), 12px)");
  }
  if (pt.themeMode === "image" && pt.bgImagePath) {
    // 画像そのものはbody::before（専用の背景レイヤー）にCSS変数経由で渡す。
    // フィルター（明るさ）をこの層だけにかけるためで、タイルや文字には影響しない。
    root.setProperty("--bg-image", `url("${toFileUrl(pt.bgImagePath)}")`);
    if (pt.bgImageFit === "repeat") {
      root.setProperty("--bg-size", "256px");
      root.setProperty("--bg-repeat", "repeat");
    } else {
      root.setProperty("--bg-size", pt.bgImageFit === "contain" ? "contain" : "cover");
      root.setProperty("--bg-repeat", "no-repeat");
    }
    const brightness = typeof pt.bgImageBrightness === "number" ? pt.bgImageBrightness : 1;
    root.setProperty("--bg-brightness", brightness);
  } else {
    root.setProperty("--bg-image", "none");
    root.setProperty("--bg-brightness", "1");
  }
  // アイコン周りの囲み線（画像背景などでアイコンが見づらいときの差別化用）。
  // ハンバーガーメニュー→見た目でオン/オフと明暗度（黒〜白）を設定できる。
  if (pt.iconRingEnabled) {
    const v = Math.round(((typeof pt.iconRingBrightness === "number" ? pt.iconRingBrightness : 55) / 100) * 255);
    root.setProperty("--icon-ring-color", `rgba(${v}, ${v}, ${v}, 0.9)`);
  } else {
    root.setProperty("--icon-ring-color", "transparent");
  }
  // サブページ切替（◀ 1 / 2 ▶）の文字縁取り色。パネルが明るいテーマでは黒縁が汚く見えるため、
  // パネルの明るさに応じて縁取りを黒/白に切り替える。
  root.setProperty("--pager-outline-rgb", luminanceOfAny(preset.panel) > 0.5 ? "255, 255, 255" : "0, 0, 0");
}

// ---------- 左上のロックボタン（常に最前面に表示のショートカット）----------
// 画面ごとに独立したロック状態（pageLocksが空の古い設定では、従来のalwaysOnTopを全画面共通で使う）
function isPageLockedAt(idx) {
  const a = settings.pageLocks;
  if (Array.isArray(a) && a.length > 0) return !!a[idx];
  return !!settings.alwaysOnTop;
}
function updateLockButton() {
  const active = isPageLockedAt(WINDOW_PAGE_INDEX);
  lockBtn.textContent = active ? "🔒" : "🔓";
  lockBtn.classList.toggle("active", active);
  lockBtn.title = active ? "この画面を常に最前面に表示：オン" : "この画面を常に最前面に表示：オフ";
}
lockBtn.addEventListener("click", async () => {
  const count = Math.max(1, Number(settings.pageCount) || 1);
  const locks = [];
  for (let i = 0; i < count; i++) locks.push(isPageLockedAt(i));
  locks[WINDOW_PAGE_INDEX] = !locks[WINDOW_PAGE_INDEX];
  settings.pageLocks = locks;
  settings.alwaysOnTop = locks.some(Boolean);
  await persistSettings();
  updateLockButton();
});

function applyPresetWindowSize(preset) {
  const gap = GRID_GAP;
  const rowGap = GRID_ROW_GAP;
  const gridWidth = preset.columns * BASE_TILE + (preset.columns - 1) * gap;
  const gridHeight = preset.rows * BASE_TILE + (preset.rows - 1) * rowGap;
  const width = gridWidth + 12 * 2 + 4;
  const height = gridHeight + 90 + 14 * 2;
  window.api.resizeWindow({ width, height });
}

async function persistTiles() {
  await window.api.saveTiles(tiles);
  syncHotkeys();
  scheduleMuteRefresh(300); // ミュート系のボタンを追加・変更したときに、実際の状態をすぐ反映する
}
async function persistSettings() {
  settings = await window.api.saveSettings(settings);
  applyTheme();
}
function syncHotkeys() {
  const list = tiles.filter((t) => t.hotkey).map((t) => ({ id: t.id, accelerator: t.hotkey }));
  window.api.registerHotkeys(list).then((failed) => {
    if (failed && failed.length) showToast(`一部のショートカットを登録できませんでした（${failed.length}件・他アプリと重複の可能性）`);
  });
}

async function init() {
  tiles = (await window.api.loadTiles()) || [];
  const loaded = await window.api.loadSettings();
  settings = { ...DEFAULT_SETTINGS, ...(loaded || {}) };
  ensurePageThemes();
  applyTheme();
  updateLockButton();
  renderGrid();
  syncHotkeys();
  // ミュート系のアイコンを、OSの実際の状態に合わせる。起動時に1回、その後は画面に戻ってきたとき
  // （フォーカス・再表示）と、見えている間の定期的な読み直し（5秒ごと）で最新に保つ。
  // 起動直後はPowerShellの起動・C#のコンパイルが重く、PC起動時の立ち上がりを遅くするため、起動から3秒は読まない（定期・フォーカス・再表示の読み直しも同様）。
  scheduleMuteRefresh(MUTE_READ_NOT_BEFORE_MS);
  window.addEventListener("focus", () => scheduleMuteRefresh(100));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleMuteRefresh(100); });
  setInterval(() => { if (document.visibilityState === "visible") refreshMuteStates(); }, MUTE_POLL_INTERVAL_MS);
  window.api.onHotkeyTriggered((id) => {
    const tile = tiles.find((t) => t.id === id);
    if (tile) handleTileClick(tile);
  });
  // 他のウィンドウ（メイン／ページ別画面）でタイルや設定が変更されたときに、
  // このウィンドウにも反映する。
  window.api.onTilesChanged(async () => {
    tiles = (await window.api.loadTiles()) || [];
    renderGrid();
    syncHotkeys();
  });
  window.api.onSettingsChanged(async () => {
    const reloaded = await window.api.loadSettings();
    settings = { ...DEFAULT_SETTINGS, ...(reloaded || {}) };
    ensurePageThemes();
    applyTheme();
    updateLockButton();
    renderGrid();
    if (settingsOverlayEl.classList.contains("show")) renderSettingsPanel();
  });
  // マルチ操作の実行中は、このウィンドウ・他ページの別画面を問わず、
  // 全ボタンとページ切替をロックする。
  window.api.onBusyChange((isBusy) => {
    document.body.classList.toggle("global-busy", !!isBusy);
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGrid, 120);
  });
}

// ---------- レイアウト計算（列数・ページング）----------
let lastClampNotice = null;

// レイアウトの優先順位：
// ・行数/列数が両方「自動」→ 画面幅に沿って列数・行数が変わる（アイコンサイズはほぼ一定）
// ・行数or列数を固定 → その数を絶対に保ち、代わりにアイコンサイズが自動で伸縮する（アイコンは常に最優先度が低い）
function computeLayout() {
  const containerWidth = gridEl.clientWidth || Math.max(300, window.innerWidth - 24);
  const gap = GRID_GAP;
  const rowGap = GRID_ROW_GAP;
  const gridTop = gridEl.getBoundingClientRect().top || 160;
  // 下端の無駄な余白をさらに詰めるため、安全マージンを最小限まで削っている
  // （#appのpadding-bottom=4pxと、行数計算の丸め誤差を防ぐための予備8pxの合計＝12px）。
  const availableHeight = Math.max(MIN_TILE, window.innerHeight - gridTop - 4 - 8);

  const pageLayout = currentPageTheme(); // 行数・列数はこのウィンドウの画面ごとの設定
  const colsFixed = pageLayout.gridColumns !== "auto";
  const rowsFixed = pageLayout.gridRows !== "auto";
  let columns, rows, tileSize, clamp = null;

  if (colsFixed && rowsFixed) {
    columns = Math.max(1, Number(pageLayout.gridColumns));
    rows = Math.max(1, Number(pageLayout.gridRows));
    const widthBased = (containerWidth - gap * (columns - 1)) / columns;
    const heightBased = (availableHeight - rowGap * (rows - 1)) / rows;
    tileSize = Math.floor(Math.min(widthBased, heightBased));
  } else if (colsFixed) {
    columns = Math.max(1, Number(pageLayout.gridColumns));
    tileSize = Math.floor((containerWidth - gap * (columns - 1)) / columns);
    rows = Math.max(1, Math.floor((availableHeight + rowGap) / (tileSize + rowGap)));
  } else if (rowsFixed) {
    rows = Math.max(1, Number(pageLayout.gridRows));
    tileSize = Math.floor((availableHeight - rowGap * (rows - 1)) / rows);
    columns = Math.max(1, Math.floor((containerWidth + gap) / (tileSize + gap)));
  } else {
    // 行数・列数が両方「自動」：列数を1つずつ試しながら、今のページの個数
    // （＋追加ボタン分）がちょうど収まる行数になったときにボタンが一番
    // 大きくなる組み合わせを探す。
    // 以前は基準サイズから決め打ちで列数を決めていたため、実際には画面に
    // もっと大きく収まる余地があってもそこまで使い切れず、最後の行の下などに
    // 無駄な余白が残ることがあった。
    const totalItems = currentPageTiles().length + 1;
    const maxColsByWidth = Math.max(1, Math.floor((containerWidth + gap) / (AUTO_MIN_TILE + gap)));
    const maxRowsByHeight = Math.max(1, Math.floor((availableHeight + rowGap) / (AUTO_MIN_TILE + rowGap)));
    let best = null;
    for (let cols = 1; cols <= maxColsByWidth; cols++) {
      const neededRows = Math.max(1, Math.ceil(totalItems / cols));
      // 縦に収まらない列数は基本除外するが、どの列数を試しても収まりきらない
      // ほど極端に狭い画面のための保険として、最後（最大列数）の候補だけは残す。
      if (neededRows > maxRowsByHeight && cols < maxColsByWidth) continue;
      const widthBased = Math.floor((containerWidth - gap * (cols - 1)) / cols);
      const heightBased = Math.floor((availableHeight - rowGap * (neededRows - 1)) / neededRows);
      const size = Math.min(widthBased, heightBased);
      if (size < AUTO_MIN_TILE) continue;
      if (!best || size > best.size) best = { cols, rows: neededRows, size };
    }
    if (best) {
      columns = best.cols;
      rows = best.rows;
      tileSize = best.size;
    } else {
      // 何を試しても収まらない極端に狭いケースのフォールバック
      columns = maxColsByWidth;
      rows = Math.max(1, Math.ceil(totalItems / columns));
      tileSize = AUTO_MIN_TILE;
    }
  }

  if (tileSize < MIN_TILE) { tileSize = MIN_TILE; clamp = "min"; }
  if (tileSize > MAX_TILE) { tileSize = MAX_TILE; clamp = "max"; }

  if ((colsFixed || rowsFixed) && clamp !== lastClampNotice) {
    if (clamp === "min") showToast("指定した行数・列数だと、アイコンをこれ以上小さくできません");
    if (clamp === "max") showToast("指定した行数・列数だと、アイコンをこれ以上大きくできません");
  }
  lastClampNotice = clamp;

  return { columns, rows, perPage: columns * rows, tileSize };
}

function currentPageTiles() {
  return tiles.filter((t) => (t.pageIndex || 0) === activePage);
}

// ページ切替UIはハンバーガーメニュー内（設定パネル）に移動したが、新しいモデルでは
// 1つのウィンドウが担当するページは固定（WINDOW_PAGE_INDEX）。設定でページ数が
// 減らされ、このウィンドウのページ自体が無くなった場合は、他ページの中身に
// 差し替えるのではなく、このウィンドウ（別画面）を自動的に閉じる。
function clampActivePage() {
  if (WINDOW_PAGE_INDEX > 0 && WINDOW_PAGE_INDEX > settings.pageCount - 1 && !selfClosing) {
    selfClosing = true;
    window.close();
  }
}

// PC画面（作業領域）の1/7以下の広さのときは、削除ボタンを出さない
function isSmallWindow() {
  const areaWin = window.innerWidth * window.innerHeight;
  const areaScr = (window.screen.availWidth || window.screen.width) * (window.screen.availHeight || window.screen.height);
  return areaScr > 0 && areaWin <= areaScr / 7;
}
let lastTotalPages = 1;
let gridRelayoutGuard = false;
function renderGrid() {
  window.api.hideTooltip(); // 再描画で消えるボタンのツールチップが残らないようにする
  clampActivePage();
  const gridTopUsed = gridEl.getBoundingClientRect().top; // この値でレイアウトを計算する（後でページ切替UIの有無でずれたら計算し直す）
  const pageTiles = currentPageTiles();
  emptyHintEl.style.display = pageTiles.length === 0 ? "block" : "none";
  const { columns, rows, perPage, tileSize } = computeLayout();
  gridEl.style.gridTemplateColumns = `repeat(${columns}, ${tileSize}px)`;
  // サブページ（画面に入りきらない分の送り）の切替ボタンが、埋まっている行数によって
  // 上下にガタつかないよう、常に「1ページ分フルに埋まったときの高さ」を確保しておく。
  gridEl.style.minHeight = Math.max(0, rows * tileSize + (rows - 1) * GRID_ROW_GAP) + "px";
  // 「名前を表示」「ショートカットキーを表示」が両方オフのときは、
  // ラベル用のスペースが不要になるため、アイコンを枠のギリギリまで大きく表示する。
  const pageView = currentPageTheme();
  const labelsHidden = pageView.showNameLabel === false && pageView.showHotkeyLabel === false;
  // アイコンの大中小（枠に対する占有率）はページごとのテーマ設定から取得する。
  const iconSizeKey = ICON_SIZE_KEYS.includes(pageView.iconSize) ? pageView.iconSize : "large";
  const iconSizeRatios = ICON_SIZE_RATIOS[iconSizeKey];
  document.documentElement.style.setProperty("--icon-size", Math.round(tileSize * (labelsHidden ? iconSizeRatios.hidden : iconSizeRatios.shown)) + "px");
  // 編集・削除ボタン（.icon-btn）を、ウィンドウサイズやタイル自体の大きさに応じて
  // 自動で小さくするための基準値。現状の固定サイズ（24px相当）を上限として、
  // タイルが小さいときはそれより縮小し、GUIとして破綻しない程度の下限（16px）で止める。
  document.documentElement.style.setProperty("--tile-size", tileSize + "px");
  // ボタンが小さいときは、編集・削除ボタンを横並びにするとアイコンの中央付近を覆ってしまうため、
  // 縦に並べて右端に寄せる（CSSの .grid.compact-tiles）。
  gridEl.classList.toggle("compact-tiles", tileSize < 110);
  gridEl.classList.toggle("small-window", isSmallWindow());

  const combined = [...pageTiles, { __addTile: true }];
  const totalPages = Math.max(1, Math.ceil(combined.length / perPage));
  lastTotalPages = totalPages;
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  if (currentPage < 0) currentPage = 0;
  const start = currentPage * perPage;
  const pageItems = combined.slice(start, start + perPage);

  gridEl.innerHTML = "";
  pageItems.forEach((item) => {
    if (item.__addTile) {
      const addBtn = document.createElement("button");
      addBtn.className = "add-tile";
      addBtn.innerHTML = `<span style="font-size:26px;">＋</span><span class="mono" style="font-size:11px;">追加</span>`;
      addBtn.addEventListener("click", openAddModal);
      gridEl.appendChild(addBtn);
      return;
    }
    gridEl.appendChild(buildTileElement(item));
  });

  renderPager(totalPages);

  // ページ切替（◀ 1 / 2 ▶）の表示・非表示でグリッドの上端がずれると、計算に使った上端との差で
  // アイコンの大きさがサブページ切替のたびに変わってしまう。ずれていたら、実際の上端で1回だけ計算し直す。
  if (!gridRelayoutGuard && Math.abs(gridEl.getBoundingClientRect().top - gridTopUsed) > 0.5) {
    gridRelayoutGuard = true;
    try { renderGrid(); } finally { gridRelayoutGuard = false; }
  }
}

// 並べ替えドラッグの直後、移動したボタンが今見えているサブページの外に
// 出てしまって「見切れて消えた」ように見えないよう、そのボタンを含む
// サブページへ自動的に移動してから再描画する。
function ensureTileVisibleThenRender(tileId) {
  const { perPage } = computeLayout();
  const idx = currentPageTiles().findIndex((x) => x.id === tileId);
  if (idx !== -1 && perPage > 0) currentPage = Math.floor(idx / perPage);
  renderGrid();
}

// ドラッグしたボタンを、そのページの一番最後（＋ボタンの直前）に移動する。
// 「＋」ボタンやグリッドの余白部分にドロップしたときの受け皿として使う
// （＝これが無いと、他のボタンにピッタリ重ねてドロップしないと反応せず、
// 「うまく位置を変えられない」と感じる原因になっていた）。
function moveTileToEndOfPage(tileId) {
  const fromIdx = tiles.findIndex((x) => x.id === tileId);
  if (fromIdx === -1) return;
  const [moved] = tiles.splice(fromIdx, 1);
  let insertAt = tiles.length;
  for (let i = tiles.length - 1; i >= 0; i--) {
    if ((tiles[i].pageIndex || 0) === (moved.pageIndex || 0)) { insertAt = i + 1; break; }
  }
  tiles.splice(insertAt, 0, moved);
  persistTiles();
  ensureTileVisibleThenRender(moved.id);
}

function renderPager(totalPages) {
  const pager = document.getElementById("headerPager");
  if (totalPages <= 1) {
    pager.style.display = "none";
    pager.innerHTML = "";
    return;
  }
  pager.style.display = "flex";
  pager.innerHTML = `
    <button class="btn default pager-btn" id="prevPage" title="前のページ">◀</button>
    <span class="mono pager-count">${currentPage + 1} / ${totalPages}</span>
    <button class="btn default pager-btn" id="nextPage" title="次のページ">▶</button>
  `;
  const prevBtn = document.getElementById("prevPage");
  const nextBtn = document.getElementById("nextPage");
  prevBtn.addEventListener("click", () => { currentPage = Math.max(0, currentPage - 1); renderGrid(); });
  nextBtn.addEventListener("click", () => { currentPage = currentPage + 1; renderGrid(); });
  // アイコンをドラッグしたまま◀/▶の上に0.7秒ホバーし続けると、掴んだままサブページを送れるようにする
  // （iOSのホーム画面編集などでおなじみの「エッジオートフリップ」）。
  attachPagerDragFlip(prevBtn, -1, totalPages);
  attachPagerDragFlip(nextBtn, 1, totalPages);
}

const PAGER_DRAG_FLIP_DELAY_MS = 700;
function attachPagerDragFlip(btn, delta, totalPages) {
  let timer = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  btn.addEventListener("dragover", (e) => {
    if (!dragSourceId) return; // アイコンをドラッグ中でなければ何もしない（通常のクリックに影響させない）
    e.preventDefault();
    if (timer) return; // 既に予約済みなら何もしない（ホバーし続けている間は1回だけ発火させる）
    timer = setTimeout(() => {
      timer = null;
      if (!dragSourceId) return; // タイマー待ちの間にドラッグが終わっていたら何もしない
      currentPage = delta < 0 ? Math.max(0, currentPage - 1) : Math.min(totalPages - 1, currentPage + 1);
      renderGrid();
    }, PAGER_DRAG_FLIP_DELAY_MS);
  });
  btn.addEventListener("dragleave", clear);
  btn.addEventListener("drop", (e) => { e.preventDefault(); clear(); });
}

function buildTileElement(tile) {
  const wrap = document.createElement("div");
  wrap.className = "tile-wrap";
  wrap.draggable = true;
  wrap.dataset.id = tile.id;

  wrap.addEventListener("dragstart", (e) => {
    dragSourceId = tile.id;
    cancelHold();
    // 壁紙モード（背景を画像にしている）だとタイルの背景が半透明になっており、
    // ブラウザ標準のドラッグ用サムネイルをそのまま使うと、dragstart時点の
    // 背後の壁紙が透けた状態が1枚絵として焼き付いてしまい、ドラッグ中その
    // 「壁紙の切れ端」だけがタイルにくっついて一緒に動くように見えてしまう。
    // これを防ぐため、ドラッグ中だけ使う不透明な代役（クローン）を画面外に
    // 用意し、setDragImageでそちらを使わせる。
    try {
      const rect = btn.getBoundingClientRect();
      const ghost = btn.cloneNode(true);
      ghost.style.position = "fixed";
      ghost.style.top = "-2000px";
      ghost.style.left = "-2000px";
      ghost.style.margin = "0";
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      ghost.style.pointerEvents = "none";
      // テーマの半透明色に関わらず、ドラッグ画像だけは必ず不透明にする
      ghost.style.backgroundColor = "#262B35";
      ghost.style.backgroundImage = "linear-gradient(160deg, var(--panel-alt), var(--panel))";
      document.body.appendChild(ghost);
      dragGhostEl = ghost;
      e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
    } catch (err) {
      /* 代役の生成に失敗しても、通常のドラッグ動作自体は継続させる */
    }
  });
  wrap.addEventListener("dragend", () => {
    dragSourceId = null;
    if (dragGhostEl) { dragGhostEl.remove(); dragGhostEl = null; }
  });
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragSourceId || dragSourceId === tile.id) return;
    const fromIdx = tiles.findIndex((x) => x.id === dragSourceId);
    const toIdx = tiles.findIndex((x) => x.id === tile.id);
    if (fromIdx === -1 || toIdx === -1) { dragSourceId = null; return; }
    // 以前は「間に挟まっている他のボタンまで詰めて動く」挿入方式だったため、
    // 2つを入れ替えたつもりが、間のボタンまでズレて予想外の並びになっていた。
    // ドラッグしたボタンとドロップ先のボタンの位置だけを、他は動かさずそのまま入れ替える。
    const draggedTile = tiles[fromIdx];
    [tiles[fromIdx], tiles[toIdx]] = [tiles[toIdx], tiles[fromIdx]];
    dragSourceId = null;
    persistTiles();
    ensureTileVisibleThenRender(draggedTile.id);
  });

  const btn = document.createElement("button");
  btn.className = "tile";
  const pageViewForLabels = currentPageTheme();
  const hotkeyLabel = tile.hotkey && pageViewForLabels.showHotkeyLabel
    ? `<div class="tile-hotkey mono">${escapeHtml(formatHotkeyKeyOnly(tile.hotkey))}</div>`
    : "";
  const nameStyle = tile.matchNameColor ? ` style="color:${safeColor(tile.color)}"` : "";
  const nameLabel = pageViewForLabels.showNameLabel !== false
    ? `<div class="tile-name"${nameStyle}>${escapeHtml(tile.name || "無題")}</div>`
    : "";
  btn.innerHTML = `
    <div class="tile-icon-wrap">
      <div class="tile-icon" style="${iconBg(tile)}">${iconInner(tile)}</div>
    </div>
    ${nameLabel}
    ${hotkeyLabel}
  `;

  const isHoldType = (tile.type === "volume" || tile.type === "brightness" || tile.type === "zoom") && (tile.action === "up" || tile.action === "down" || tile.action === "in" || tile.action === "out");
  if (isHoldType) {
    btn.addEventListener("pointerdown", () => startHold(tile));
    btn.addEventListener("pointerup", () => releaseHold(tile));
    btn.addEventListener("pointerleave", cancelHold);
    btn.addEventListener("pointercancel", cancelHold);
    btn.addEventListener("dragstart", cancelHold);
  } else {
    btn.addEventListener("click", () => handleTileClick(tile));
  }

  const actions = document.createElement("div");
  actions.className = "tile-actions";
  actions.innerHTML = `<div class="icon-btn" data-act="edit">✎</div><div class="icon-btn danger" data-act="del">🗑</div>`;
  actions.querySelector('[data-act="edit"]').addEventListener("click", (e) => { e.stopPropagation(); openEditModal(tile); });
  actions.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); openConfirmDelete(tile.id); });

  wrap.appendChild(btn);
  wrap.appendChild(actions);

  // ツールチップ（名前・ショートカット表示）は、アプリ画面の枠で見切れないよう、
  // 画面内のDOMではなく、メインプロセス側の専用ウィンドウに表示する（画面外にもはみ出せる）。
  wrap.addEventListener("mouseenter", () => {
    // アイコン枠（ボタン裏の枠）が見えない設定（透明度0%）のときは、枠ではなくアイコンの下に出す
    const iconEl = btn.querySelector(".tile-icon");
    const r = (currentPanelOpacity() <= 0 && iconEl) ? iconEl.getBoundingClientRect() : btn.getBoundingClientRect();
    window.api.showTooltip({
      name: tile.name || "無題",
      key: tile.hotkey ? formatHotkeyForTooltip(tile.hotkey) : "",
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  });
  wrap.addEventListener("mouseleave", () => window.api.hideTooltip());
  wrap.addEventListener("dragstart", () => window.api.hideTooltip());

  return wrap;
}

let holdStartTimer = null;
let holdFired = false; // 保留時間内に一度でも実行済みかどうか
let brightnessSessionActive = false; // 明るさ調整の連打中だけ、PowerShellのプロセス再起動コストを避けるためのセッションを張っておく
function startHold(tile) {
  cancelHold();
  // ドラッグ（並び替え）操作との判別のため、少しだけ待ってから連続実行を開始する。
  // この間に dragstart が発生した場合は cancelHold() で取り消される。
  holdStartTimer = setTimeout(() => {
    holdStartTimer = null;
    holdFired = true;
    // 明るさ調整は（マイクミュート等と同様に）実装が複雑なWMI経由のため、
    // koffiのネイティブ実装がなくPowerShellを都度起動している。220ms間隔の
    // 連打のたびに新しいPowerShellプロセスを起動すると反応が遅れがちになるため、
    // 「マルチ操作」と同じ常駐PowerShellセッションを流用し、押している間だけ
    // プロセスを使い回すことで体感速度を上げる（失敗時は従来通り都度起動にフォールバックする）。
    if (tile.type === "brightness" && !brightnessSessionActive) {
      brightnessSessionActive = true;
      window.api.startMultiSession?.({});
    }
    handleTileClick(tile);
    holdTimer = setInterval(() => handleTileClick(tile), 220);
  }, 140);
}
// 指を離したとき：保留タイマーがまだ発火していなければ「シングルタップ」とみなし、
// その場で1回だけ実行する（これがないと素早いタップ・連打が反応しなくなる）。
function releaseHold(tile) {
  if (holdStartTimer) {
    clearTimeout(holdStartTimer);
    holdStartTimer = null;
    if (!holdFired) handleTileClick(tile);
  }
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
  holdFired = false;
  endBrightnessSessionIfActive();
}
// ドラッグ開始・ポインタ消失など「クリックとして扱わない」ケース用。実行はしない。
function cancelHold() {
  if (holdStartTimer) clearTimeout(holdStartTimer);
  holdStartTimer = null;
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
  holdFired = false;
  endBrightnessSessionIfActive();
}
function endBrightnessSessionIfActive() {
  if (brightnessSessionActive) {
    brightnessSessionActive = false;
    window.api.endMultiSession?.();
  }
}

// forceOff：編集モーダルで「オフのとき」のプレビューを見せるためだけの引数（省略時は実際の状態を使う）。
function iconBg(tile, forceOff) {
  if (tile.icon?.kind === "image" && tile.icon.value) return "";
  const muted = forceOff !== undefined ? forceOff : isTileMuted(tile);
  if (muted) return "background:#FF6B5E33;";
  // 「CSS」アイコンは、背景を薄い着色（既定）ではなく、テーマカラーで塗りつぶすことができる。
  if (tile.icon?.kind === "css" && tile.icon.filled) return `background:${safeColor(tile.color)};`;
  return `background:${safeColor(tile.color)}26;`;
}
function iconInner(tile, forceOff) {
  if (tile.icon?.kind === "image" && tile.icon.value) return `<img src="${escapeHtml(toFileUrl(tile.icon.value))}" alt="" />`;
  if (tile.icon?.kind === "emoji" && tile.icon.value) {
    // 絵文字1文字ならこれまでと同じ大きさで表示。
    // 文字数が多い（例：日本語の略称テキスト）場合は、アイコン枠から
    // はみ出さないよう文字数に応じて縮小し、2行に折り返して中央に収める。
    const chars = Array.from(tile.icon.value);
    const scale = chars.length <= 1 ? 0.64 : chars.length === 2 ? 0.46 : 0.4;
    return `<span class="tile-icon-emoji" style="font-size:calc(var(--icon-size) * ${scale})">${escapeHtml(tile.icon.value)}</span>`;
  }
  // css（自作アイコン・個別選択固定）または default（自動追従）はここで描画する。
  const off = forceOff !== undefined ? forceOff : isIconOff(tile);
  let svg;
  // オン/オフを持つタイル（ミュート系）でCSSアイコンを個別選択している場合は、
  // ユーザーがオン用・オフ用として選んだ2つのアイコンをそのまま出し分ける。
  if (tile.icon?.kind === "css" && tileHasToggle(tile) && tile.icon.offValue) {
    const key = off ? tile.icon.offValue : tile.icon.value;
    svg = (CSS_ICONS[key] || CSS_ICONS.circleMark).svg;
  } else {
    const iconKey = resolveCssIconKey(tile);
    const def = CSS_ICONS[iconKey] || CSS_ICONS.circleMark;
    svg = off && def.toggle && def.offSvg ? def.offSvg : def.svg;
  }
  // ミュート系の赤い状態表示は、塗りつぶし設定より優先してそのまま見せる。
  const mutedOverride = forceOff !== undefined ? forceOff : isTileMuted(tile);
  const filled = tile.icon?.kind === "css" && tile.icon.filled && !mutedOverride;
  let color;
  if (off && tileHasToggle(tile)) {
    color = "#FF6B5E";
  } else if (filled) {
    // 塗りつぶし背景の上でもアイコンがくっきり見えるよう、背景色の明るさに応じて白/黒を選ぶ。
    color = luminance(safeColor(tile.color)) < 0.5 ? "#FFFFFF" : "#14161B";
  } else {
    color = safeColor(tile.color);
  }
  return `<span style="color:${color};display:flex;align-items:center;justify-content:center;width:68%;height:68%;">${svg}</span>`;
}

// ---------- タイルを押したときの動作 ----------
let volumeCallInFlight = false;
let volumePendingTile = null;
// 音量操作はOS側の処理に少し時間がかかるため、実行中に連打された分は
// 取りこぼさず「実行中の分が終わったら直後にもう1回だけ」追いかけて実行する。
async function runVolumeAction(tile) {
  if (volumeCallInFlight) {
    volumePendingTile = tile;
    return;
  }
  volumeCallInFlight = true;
  try {
    const err = await window.api.setVolumeAction(tile.action, tile.repeatCount || 1);
    if (err) showToast(err);
    else if (tile.action === "mute") {
      // 押した直後は、いまの状態が分かっていれば反転して見た目にすぐ反映する。
      // そのあと、OSの実際の状態を読み直して正しい状態に合わせる（保存はしない）。
      if (audioMuteState.speaker !== null) { audioMuteState.speaker = !audioMuteState.speaker; renderGrid(); }
      scheduleMuteRefresh(250);
    }
  } finally {
    volumeCallInFlight = false;
    if (volumePendingTile) {
      const next = volumePendingTile;
      volumePendingTile = null;
      runVolumeAction(next);
    }
  }
}
async function handleTileClick(tile, fromMulti) {
  // マルチ操作の実行中は、それ自身の内部処理（サブ動作の順次実行）以外からの
  // ボタン操作をすべて受け付けない。これを許すと、例えば「LINEを開いて応答待ち」の
  // 最中に別のマルチ操作や画面分割ボタンが動いてしまい、直前の動作を引き継ぐための
  // 共有情報（snapContextや、使用済みウィンドウの記録など）が2つの実行で混線し、
  // どちらか（または両方）の画面分割が誤ったウィンドウに効いてしまう恐れがあるため。
  if (!fromMulti && multiRunningIds.size > 0) {
    return showToast("マルチ操作の実行中は他のボタンを使用できません（完了までお待ちください）");
  }
  if (tile.type === "link") {
    if (!tile.url) return showToast("URLが設定されていません");
    const opts = {};
    if (snapContext && snapContext.newWindow) opts.newWindow = true;
    if (tile.browser && tile.browser !== "default") {
      opts.browser = tile.browser;
    }
    const err = await window.api.openExternal(tile.url, Object.keys(opts).length ? opts : undefined);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "sound") {
    if (!tile.filePath) return showToast("音声ファイルが設定されていません");
    try {
      const audio = new Audio(toFileUrl(tile.filePath));
      audio.volume = Math.max(0, Math.min(1, (tile.volume ?? 100) / 100));
      audio.play().catch(() => showToast("再生できませんでした"));
    } catch (e) { showToast("再生できませんでした"); }
    return;
  }
  if (tile.type === "file" || tile.type === "app") {
    if (!tile.filePath) return showToast(tile.type === "app" ? "アプリが設定されていません" : "ファイルが設定されていません");
    if (tile.type === "app") await resolveNotepadShortcut(tile.filePath);
    if (tile.type === "app" && isNotepadPath(tile.filePath)) {
      const err = await window.api.memoAction(tile.memoMode || "open");
      if (err) showToast("開けませんでした：" + err);
      return;
    }
    const err = await window.api.openPath(tile.filePath, tile.type === "file" ? { maximize: tile.openMaximized === true } : undefined);
    if (err) showToast("開けませんでした：" + err);
    return;
  }
  if (tile.type === "folder") {
    if (!tile.filePath) return showToast("フォルダが設定されていません");
    const err = await window.api.openPath(tile.filePath, { maximize: tile.openMaximized === true });
    if (err) showToast("開けませんでした：" + err);
    return;
  }
  if (tile.type === "qr") {
    openQrModal(tile);
    return;
  }
  if (tile.type === "media") {
    if (!tile.action) return showToast("動作が設定されていません");
    const err = await window.api.setMediaAction(tile.action);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "volume") {
    if (!tile.action) return showToast("動作が設定されていません");
    runVolumeAction(tile);
    return;
  }
  if (tile.type === "power") {
    if (!tile.action) return showToast("動作が設定されていません");
    openConfirmPower(tile.action);
    return;
  }
  if (tile.type === "mic") {
    const result = await window.api.setMicAction();
    if (result && result.error) { showToast(result.error); return; }
    // 切り替え後の実際の状態が返ってくるので、そのまま表示に反映する（保存はしない）
    audioMuteState.mic = !!(result && result.muted);
    renderGrid();
    return;
  }
  if (tile.type === "clipboard") {
    if (tile.action === "image") {
      if (!tile.filePath) return showToast("コピーする画像が設定されていません");
      const err = await window.api.copyImageToClipboard(tile.filePath);
      if (err) return showToast(err);
    } else if (tile.action === "file" || tile.action === "folder") {
      if (!tile.filePath) return showToast(tile.action === "folder" ? "コピーするフォルダが設定されていません" : "コピーするファイルが設定されていません");
      const err = await window.api.copyFileToClipboard(tile.filePath);
      if (err) return showToast(err);
    } else {
      if (!tile.text) return showToast("コピーする内容が設定されていません");
      await window.api.copyToClipboard(tile.text);
    }
    if (tile.autoPaste !== false) {
      const err = await window.api.pasteToActiveWindow();
      showToast(err ? err : "貼り付けました");
    } else {
      showToast("コピーしました");
    }
    return;
  }
  if (tile.type === "timer") {
    await window.api.openTimer();
    return;
  }
  if (tile.type === "window") {
    if (!tile.action) return showToast("動作が設定されていません");
    const err = await window.api.setSnapAction(tile.action, snapContext);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "pageswitch") {
    if (tile.targetPage === undefined || tile.targetPage === null) return showToast("切り替え先の画面が設定されていません");
    window.api.openPage(tile.targetPage);
    // switchMode==="replace"のときだけ、切り替え先を開いたあとに今の画面を閉じる
    // （既定"add"は今まで通り、追加のウィンドウとして両方開いたままにする）。
    if (tile.switchMode === "replace") window.api.closeCurrentWindow();
    return;
  }
  if (tile.type === "brightness") {
    if (!tile.action) return showToast("動作が設定されていません");
    const delta = tile.action === "up" ? (tile.repeatCount || 3) : -(tile.repeatCount || 3);
    const err = await window.api.setBrightness(delta);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "zoom") {
    if (!tile.action) return showToast("動作が設定されていません");
    const err = await window.api.setZoomAction(tile.action, tile.repeatCount || 1);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "discord") {
    if (!tile.sendHotkey) return showToast("送信するキーが設定されていません");
    const err = await window.api.sendHotkey(tile.sendHotkey);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "obs") {
    if (!tile.action) return showToast("動作が設定されていません");
    await runObsAction(tile);
    return;
  }
  if (tile.type === "shortcutKeys") {
    if (!SHORTCUT_ACTIONS[tile.action]) return showToast("ショートカットが設定されていません");
    const err = await window.api.basicShortcut(tile.action);
    if (err) showToast(err);
    return;
  }
  if (tile.type === "screenshotFull") {
    const result = await window.api.captureFullScreenshot();
    if (result && result.error) showToast(result.error);
    else if (result && result.path) showToast("スクリーンショットを保存しました（ピクチャ → Launch-K Screenshots）");
    return;
  }
  if (tile.type === "multi") {
    await runMultiAction(tile);
    return;
  }
}

// 各動作の間隔。0にすると一部の動作（特にOS側の連続キー送信など）が
// 詰まって反応しないことがあるため、PCへの負担を抑えつつ「順番に実行されている」
// と体感できる程度の適度な間隔を空けて実行する。
const MULTI_ACTION_DELAY_MS = 300;
// アプリ・リンク・ファイルを「開く」動作の直後だけは、これより長めに待つ。
// 開いたウィンドウが実際に画面に現れて前面フォーカスを持つまでには、
// 通常の動作（音量やクリップボードなど）よりずっと時間がかかることがあり、
// ここが短いと「まだ前のウィンドウが前面にあるうちに次のスナップ動作が
// 実行されてしまい、開いたばかりのウィンドウではなく別のウィンドウに
// 効いてしまう」という順序のズレが起きる。
const MULTI_ACTION_OPEN_DELAY_MS = 500;
// 各動作の「このあとの待ち」を自動で決める。動作ごとに個別指定（waitAfter）があれば、そちらが優先される。
//  ・開く系の直後が画面分割のとき：画面分割側が新しいウィンドウの出現を30msごとに確認して待つ
//    （出現後は位置が落ち着くまで最大0.6秒待つ）ので、固定の待ちは不要。
//    ただし、最初の「開く→画面分割」で、実行を始めたときLaunch-K自身が前面にいない
//    （ショートカットキーで実行した）場合は、開く前の前面ウィンドウを新しいウィンドウと取り違えないよう、
//    これまで通り固定の待ちを残す。すでに1回画面分割したあとなら、配置済みウィンドウは
//    除外されるので取り違えない（canSkipOpenWait）。
//  ・画面分割の直後が「画面分割」または「開く系」のとき：配置は完了済みで、次の動作は
//    今配置したウィンドウの状態に依存しないので待たない。キー送信系（音量・ズームなど）の前は従来の待ちを残す。
function autoWaitAfterMs(type, nextType, canSkipOpenWait) {
  if (MULTI_ACTION_OPEN_TYPES.has(type)) {
    if (nextType === "window" && canSkipOpenWait) return 0;
    return MULTI_ACTION_OPEN_DELAY_MS;
  }
  if (type === "window" && (nextType === "window" || MULTI_ACTION_OPEN_TYPES.has(nextType))) return 0;
  return MULTI_ACTION_DELAY_MS;
}
const MULTI_ACTION_OPEN_TYPES = new Set(["app", "link", "file", "folder"]);
// 実行が終わった直後は、OS側のスナップ操作などがまだ裏で処理中のことがあるため、
// すぐに連打されても次の実行を受け付けないよう、完了後も少しだけ間を空ける。
const MULTI_ACTION_COOLDOWN_MS = 200;
const multiRunningIds = new Set();
// マルチ操作の実行中だけ使う、画面分割（スナップ）への引き継ぎ情報。
//  waitForNew: 直前の動作が「アプリ・リンク・ファイル・フォルダを開く」だったため、開いた新しいウィンドウが前面に出るまで待つ
//  newWindow: 次の動作が画面分割のとき、リンクを新しいブラウザウィンドウで開く
//  fresh: このマルチ操作の中で最初の画面分割（前回の実行で配置したウィンドウの記憶を使わない）
let snapContext = null;
async function runMultiAction(tile) {
  // 実行中〜クールダウン中は、同じボタンからの再実行を完全に無視する
  // （連打でマルチ操作が重なって走り、動作が混線するのを防ぐため）。
  if (multiRunningIds.has(tile.id)) return;
  // 「アプリ・リンクを開く」→「画面分割」という一連の流れは、前面に出てきたウィンドウを
  // 手がかりに判定しているため、別のマルチ操作が同時に動いて何かを開いてしまうと、
  // お互いの「新しいウィンドウ」を取り違えてしまう（例：LINEの応答待ち中に、別ボタンで
  // 先にブラウザが開くと、そのブラウザをLINEの分割先だと誤認してしまう）。
  // これを避けるため、マルチ操作は常にどれか1つだけが実行できるようにする。
  if (multiRunningIds.size > 0) {
    return showToast("ほかのマルチ操作の実行中です。終わってからお試しください");
  }
  const list = (Array.isArray(tile.subActions) ? tile.subActions : []).filter((s) => s && s.type && s.type !== "multi" && s.type !== "qr");
  if (list.length < 2) return showToast("マルチ操作には動作を2つ以上設定してください");
  multiRunningIds.add(tile.id);
  // 実行を始めた時点でLaunch-K自身が前面にいるか（ボタンのクリックで実行したか）。
  // ショートカットキーで実行した場合は、他のアプリが前面にいる。
  const startedWithOwnFocus = document.hasFocus();
  const wrapEl = gridEl.querySelector(`.tile-wrap[data-id="${tile.id}"]`);
  if (wrapEl) wrapEl.classList.add("busy");
  // 実行中は、このウィンドウ内の他のボタンだけでなく、他ページの別画面のボタン・
  // ページ切替も一括でロックする（全ウィンドウへブロードキャストされる）。
  document.body.classList.add("global-busy");
  window.api.setBusy(true);
  // マルチ操作の間だけPowerShellプロセスを使い回し、動作ごとの起動コストを減らす。
  // あくまで高速化のための追加ルートなので、失敗しても致命的にならないよう
  // ベストエフォートで呼ぶ（await に失敗しても以降の処理は今まで通り進む）。
  try {
    // 画面分割を含むときは、PowerShell側で画面分割用C#の先読みも頼む（最初の画面分割を速くする）
    await window.api.startMultiSession?.({ preloadSnap: list.some((s) => s.type === "window") });
  } catch (e) {
    // 無視: セッションが使えなくても、各動作は個別に今まで通り動作する
  }
  try {
    let snappedInRun = false;
    for (let i = 0; i < list.length; i++) {
      const prevType = i > 0 ? list[i - 1].type : null;
      const nextType = i < list.length - 1 ? list[i + 1].type : null;
      const prevSub = i > 0 ? list[i - 1] : null;
      // 直前が「既存ウィンドウにタブとして追加する」設定のリンクだった場合、新しいウィンドウは
      // 作られない（＝待つ意味がない）ので、通常の「新規ウィンドウ待ち」ではなく、
      // 追加直後にすでに前面に来ているはずの既存ウィンドウをそのまま対象にする。
      const prevKeepsExistingWindow = !!(prevSub && prevSub.type === "link" && prevSub.keepInExistingWindow);
      snapContext = {
        waitForNew: !!prevType && MULTI_ACTION_OPEN_TYPES.has(prevType),
        // 「既存ウィンドウに追加」のときは、そのウィンドウ自体が新規ウィンドウ判定の
        // 除外リスト（＝待ち始める前から画面にあったもの）に載ってしまうため、
        // ここだけは例外的にその除外を無効にする。
        acceptExisting: prevKeepsExistingWindow,
        fresh: !snappedInRun,
        // 次の動作が画面分割で、かつこのリンク自身が「既存ウィンドウに追加」設定でなければ、
        // 新しいブラウザウィンドウで開く
        newWindow: nextType === "window" && !(list[i].type === "link" && list[i].keepInExistingWindow),
      };
      await handleTileClick(list[i], true);
      if (list[i].type === "window") snappedInRun = true;
      if (i < list.length - 1) {
        // 動作ごとの指定（秒）があればそれを使い、なければ状況に応じた自動の待ちにする
        const custom = list[i].waitAfter;
        const delay = typeof custom === "number" && isFinite(custom) && custom >= 0
          ? Math.round(custom * 1000)
          : autoWaitAfterMs(list[i].type, nextType, startedWithOwnFocus || snappedInRun);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    snapContext = null;
    try {
      await window.api.endMultiSession?.();
    } catch (e) {
      // 無視: 通常は都度execにフォールバックされるため実害はない
    }
    setTimeout(() => {
      multiRunningIds.delete(tile.id);
      if (wrapEl) wrapEl.classList.remove("busy");
      document.body.classList.remove("global-busy");
      window.api.setBusy(false);
    }, MULTI_ACTION_COOLDOWN_MS);
  }
}

// ---------- OBS連携（obs-websocket v5、レンダラーから直接WebSocket接続）----------
async function sha256Base64(str) {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
let obsSocket = null;
let obsReadyPromise = null;
function obsConnect() {
  if (obsSocket && obsSocket.readyState === WebSocket.OPEN && obsReadyPromise) return obsReadyPromise;
  const host = settings.obsHost || "127.0.0.1";
  const port = settings.obsPort || 4455;
  const password = settings.obsPassword || "";
  obsReadyPromise = new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${port}`);
    } catch (e) {
      reject(new Error("OBSに接続できませんでした（接続先の設定を確認してください）"));
      return;
    }
    obsSocket = ws;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("OBSに接続できませんでした（タイムアウト）")); ws.close(); }
    }, 4000);
    ws.addEventListener("message", async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.op === 0) {
        const d = msg.d || {};
        const identify = { rpcVersion: d.rpcVersion || 1 };
        if (d.authentication) {
          const secret = await sha256Base64(password + d.authentication.salt);
          identify.authentication = await sha256Base64(secret + d.authentication.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (msg.op === 2) {
        clearTimeout(timeout);
        if (!settled) { settled = true; resolve(ws); }
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error("OBSに接続できませんでした（起動・WebSocketサーバー設定を確認してください）")); }
    });
    ws.addEventListener("close", () => { obsSocket = null; obsReadyPromise = null; });
  });
  return obsReadyPromise;
}
function obsRequest(ws, requestType, requestData) {
  return new Promise((resolve, reject) => {
    const requestId = "req_" + Math.random().toString(36).slice(2);
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.op === 7 && msg.d && msg.d.requestId === requestId) {
        ws.removeEventListener("message", onMsg);
        const status = msg.d.requestStatus || {};
        if (status.result) resolve(msg.d.responseData);
        else reject(new Error(status.comment || "OBSでの操作に失敗しました"));
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
  });
}
async function runObsAction(tile) {
  try {
    const ws = await obsConnect();
    if (tile.action === "mute") {
      if (!tile.obsSource) return showToast("ミュートする音声ソース名を設定してください");
      await obsRequest(ws, "ToggleInputMute", { inputName: tile.obsSource });
    } else if (tile.action === "recordStart") {
      await obsRequest(ws, "StartRecord");
    } else if (tile.action === "recordStop") {
      await obsRequest(ws, "StopRecord");
    } else if (tile.action === "streamStart") {
      await obsRequest(ws, "StartStream");
    } else if (tile.action === "streamStop") {
      await obsRequest(ws, "StopStream");
    }
  } catch (e) {
    showToast(e.message || "OBSでの操作に失敗しました");
  }
}

// ---------- QRコード表示 ----------
function openQrModal(tile) {
  if (!tile.url) return showToast("URLが設定されていません");
  let dataUrl = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(tile.url);
    qr.make();
    dataUrl = qr.createDataURL(6, 4);
  } catch (e) {
    showToast("QRコードの生成に失敗しました");
    return;
  }
  modalBodyEl.innerHTML = `
    <h2 style="font-size:17px;font-weight:700;margin-bottom:16px;">${escapeHtml(tile.name || "QRコード")}</h2>
    <div style="display:flex;justify-content:center;margin-bottom:14px;">
      <img src="${dataUrl}" style="width:220px;height:220px;border-radius:10px;background:#fff;padding:12px;" />
    </div>
    <div class="path-preview" style="word-break:break-all;text-align:center;">${escapeHtml(tile.url)}</div>
    <div class="modal-actions"><button class="btn default" id="closeQrBtn">閉じる</button></div>
  `;
  document.getElementById("closeQrBtn").addEventListener("click", closeModal);
  overlayEl.classList.add("show");
}

// ---------- 追加・編集モーダル ----------
function openAddModal() {
  modalData = {
    mode: "add",
    colorTouched: false,
    tile: {
      id: uid(), name: "", type: "link", url: "", filePath: "", volume: 100,
      action: "up", repeatCount: 1, text: "", hotkey: "", matchNameColor: false, pageIndex: activePage,
      icon: { kind: "default", value: "" }, color: COLORS[tiles.length % COLORS.length], subActions: [],
    },
  };
  renderModal();
  overlayEl.classList.add("show");
}
function openEditModal(tile) {
  modalData = { mode: "edit", tile: { ...tile, icon: { ...tile.icon } } };
  renderModal();
  overlayEl.classList.add("show");
}
function stopRecordingHotkey() {
  if (activeHotkeyKeydownHandler) {
    document.removeEventListener("keydown", activeHotkeyKeydownHandler, true);
    activeHotkeyKeydownHandler = null;
  }
  recordingHotkey = false;
}

function closeModal() {
  stopRecordingHotkey();
  modalData = null;
  overlayEl.classList.remove("show");
}

let multiSubDragIndex = null; // マルチ操作編集中、ドラッグで並び替え中の元インデックス

// ---------- マルチ操作：サブ動作リストの描画 ----------
// モーダル全体を再描画すると入力中の他フィールドやスクロール位置が崩れるため、
// サブ動作の追加・削除・並び替え・種類変更のときはこのリスト部分だけを再描画する。
function renderMultiSubList(t) {
  const listEl = document.getElementById("multiSubList");
  const countEl = document.getElementById("multiSubCount");
  const addBtn = document.getElementById("addMultiSubBtn");
  if (!listEl) return;
  listEl.innerHTML = "";
  t.subActions.forEach((sub, i) => {
    const row = document.createElement("div");
    row.className = "multi-sub-row";
    row.innerHTML = `
      <div class="multi-sub-head">
        <span class="drag-handle" draggable="true" title="ドラッグして並び替え">⠿</span>
        <span class="act-index">${i + 1}</span>
        <div class="type-row mini" id="multiTypeRow-${i}" style="flex:1;margin:0;"></div>
        <div class="icon-btn danger multi-sub-del" title="削除">✕</div>
      </div>
      <div class="multi-sub-fields" id="multiFields-${i}"></div>
    `;
    const typeRow = row.querySelector(`#multiTypeRow-${i}`);
    const typeTrigger = document.createElement("button");
    typeTrigger.type = "button";
    typeTrigger.className = "type-select-trigger mini";
    typeTrigger.innerHTML = `<span>${escapeHtml(TYPE_META[sub.type].label)}</span><span class="type-select-trigger-caret">▾</span>`;
    typeTrigger.addEventListener("click", () => {
      openTypeSelect(SUB_ACTION_TYPES, sub.type, (key) => {
        sub.type = key;
        if (key === "volume" && !VOLUME_ACTIONS[sub.action]) sub.action = "up";
        if (key === "power" && !POWER_ACTIONS[sub.action]) sub.action = "sleep";
        if (key === "window" && !WINDOW_ACTIONS[sub.action]) sub.action = "left";
        if (key === "pageswitch" && (sub.targetPage === undefined || sub.targetPage === null)) sub.targetPage = 0;
        if (key === "brightness" && !BRIGHTNESS_ACTIONS[sub.action]) sub.action = "up";
        if (key === "media" && !MEDIA_ACTIONS[sub.action]) sub.action = "playpause";
        if (key === "zoom" && !ZOOM_ACTIONS[sub.action]) sub.action = "in";
        if (key === "clipboard" && !CLIPBOARD_ACTIONS[sub.action]) sub.action = "text";
        if (key === "obs" && !OBS_ACTIONS[sub.action]) sub.action = "mute";
        if (key === "shortcutKeys" && !SHORTCUT_ACTIONS[sub.action]) sub.action = "copy";
        renderMultiSubList(t);
      });
    });
    typeRow.appendChild(typeTrigger);
    row.querySelector(".multi-sub-del").addEventListener("click", () => {
      if (t.subActions.length <= 2) { showToast("マルチ操作には動作を2つ以上残してください"); return; }
      t.subActions.splice(i, 1);
      renderMultiSubList(t);
    });
    // ドラッグ＆ドロップでの並び替え（タイマー画面のマルチタイマー編集と同じ操作感）
    const handle = row.querySelector(".drag-handle");
    handle.addEventListener("dragstart", () => { multiSubDragIndex = i; row.classList.add("dragging"); });
    handle.addEventListener("dragend", () => {
      multiSubDragIndex = null;
      listEl.querySelectorAll(".multi-sub-row").forEach((r) => r.classList.remove("dragging", "drag-over"));
    });
    row.addEventListener("dragover", (e) => {
      if (multiSubDragIndex === null || multiSubDragIndex === i) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (multiSubDragIndex === null || multiSubDragIndex === i) return;
      const [moved] = t.subActions.splice(multiSubDragIndex, 1);
      t.subActions.splice(i, 0, moved);
      multiSubDragIndex = null;
      renderMultiSubList(t);
    });
    listEl.appendChild(row);
    renderSubFields(row.querySelector(`#multiFields-${i}`), sub, t);
    // 「このあとの待ち」：自動のほか、0〜2秒を選べる（最後の動作のあとは待たないので表示しない）
    if (i < t.subActions.length - 1) {
      const waitBox = document.createElement("div");
      waitBox.style.cssText = "margin-top:8px;padding-left:24px;";
      waitBox.innerHTML = `<div class="path-preview" style="margin:0 0 4px;">このあとの待ち</div><div class="type-row mini" style="margin:0;"></div>`;
      const waitRow = waitBox.querySelector(".type-row");
      [{ v: null, label: "自動" }, { v: 0, label: "0s" }, { v: 0.1, label: "0.1s" }, { v: 0.3, label: "0.3s" }, { v: 0.5, label: "0.5s" }, { v: 1, label: "1s" }, { v: 2, label: "2s" }].forEach((o) => {
        const isActive = typeof sub.waitAfter === "number" ? sub.waitAfter === o.v : o.v === null;
        const b = document.createElement("div");
        b.className = "opt-btn mini" + (isActive ? " active" : "");
        b.textContent = o.label;
        b.title = o.v === null ? "状況に応じて自動で最短の待ちにします（おすすめ）" : `この動作のあと ${o.v}秒 待ちます`;
        b.addEventListener("click", () => {
          if (o.v === null) delete sub.waitAfter; else sub.waitAfter = o.v;
          renderMultiSubList(t);
        });
        waitRow.appendChild(b);
      });
      row.appendChild(waitBox);
    }
  });
  countEl.textContent = `${t.subActions.length} / 15`;
  addBtn.classList.toggle("at-max", t.subActions.length >= 15);
  addBtn.disabled = t.subActions.length >= 15;
}

// ---------- マルチ操作：サブ動作1つ分の設定欄（種類に応じて出し分け）----------
function renderSubFields(fieldsEl, sub, t) {
  const pickBtn = (label, exts) => {
    fieldsEl.innerHTML = `
      <div class="file-pick-btn sub-pick" style="margin-bottom:4px;">${label}</div>
      <div class="path-preview" style="margin-bottom:0;">${sub.filePath ? escapeHtml(sub.filePath) : "未選択"}</div>
    `;
    fieldsEl.querySelector(".sub-pick").addEventListener("click", async () => {
      const picked = sub.type === "folder" ? await window.api.pickFolder() : await window.api.pickFile(exts || []);
      if (picked) {
        sub.filePath = picked;
        if (sub.type === "app") await resolveNotepadShortcut(picked); // ショートカット経由の「メモ」も判定
        renderMultiSubList(t);
      }
    });
  };
  const actionButtons = (metaMap, onPick) => {
    fieldsEl.innerHTML = `<div class="type-row" style="margin:0 0 6px;" id="sf-action"></div>`;
    const row = fieldsEl.querySelector("#sf-action");
    Object.entries(metaMap).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn mini" + (sub.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { sub.action = key; onPick && onPick(); renderMultiSubList(t); });
      row.appendChild(b);
    });
  };
  if (sub.type === "link") {
    fieldsEl.innerHTML = `
      <input type="text" class="sub-url" placeholder="https://example.com" value="${escapeHtml(sub.url || "")}" style="margin-bottom:8px;" />
      <div class="field-label" style="margin:0 0 6px;">開くブラウザ</div>
      <div class="type-row mini" id="sf-browserRow"></div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;">
        <input type="checkbox" id="sf-keepExisting" ${sub.keepInExistingWindow ? "checked" : ""} />
        既存のブラウザウィンドウに追加
      </label>
    `;
    fieldsEl.querySelector(".sub-url").addEventListener("change", (e) => { sub.url = e.target.value.trim(); });
    fieldsEl.querySelector("#sf-keepExisting").addEventListener("change", (e) => { sub.keepInExistingWindow = !!e.target.checked; });
    const browserRow = fieldsEl.querySelector("#sf-browserRow");
    Object.entries(BROWSER_OPTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn mini" + ((sub.browser || "default") === key ? " active" : "");
      b.textContent = meta.label;
      b.addEventListener("click", () => { sub.browser = key; renderMultiSubList(t); });
      browserRow.appendChild(b);
    });
  } else if (sub.type === "sound") {
    pickBtn("🎵 音声ファイルを選択", [{ name: "音声ファイル", extensions: ["mp3", "wav", "ogg", "m4a"] }]);
  } else if (sub.type === "app") {
    pickBtn("🖥 アプリ（.exe等）を選択", [{ name: "アプリケーション", extensions: ["exe", "lnk", "bat", "cmd"] }]);
    // 以前に設定済みの.lnk（まだリンク先を調べていないもの）は、裏で判定して、メモだった場合だけ描き直す
    if (needsNotepadResolve(sub.filePath)) {
      resolveNotepadShortcut(sub.filePath).then((isMemo) => { if (isMemo) renderMultiSubList(t); });
    }
    if (isNotepadPath(sub.filePath)) {
      if (!MEMO_MODES[sub.memoMode]) sub.memoMode = "open";
      fieldsEl.insertAdjacentHTML("beforeend", `<div class="field-label" style="margin:8px 0 6px;">メモの開き方</div><div class="type-row mini" id="sf-memoModeRow"></div>`);
      const memoModeRow = fieldsEl.querySelector("#sf-memoModeRow");
      Object.entries(MEMO_MODES).forEach(([key, meta]) => {
        const b = document.createElement("div");
        b.className = "opt-btn mini" + ((sub.memoMode || "open") === key ? " active" : "");
        b.textContent = meta.label;
        b.addEventListener("click", () => { sub.memoMode = key; renderMultiSubList(t); });
        memoModeRow.appendChild(b);
      });
    }
  } else if (sub.type === "file") {
    pickBtn("📄 ファイルを選択", []);
  } else if (sub.type === "folder") {
    pickBtn("📁 フォルダを選択", []);
  } else if (sub.type === "volume") {
    actionButtons(VOLUME_ACTIONS);
  } else if (sub.type === "power") {
    actionButtons(POWER_ACTIONS);
    fieldsEl.insertAdjacentHTML("beforeend", `<div class="path-preview" style="margin:6px 0 0;">実行前に確認画面が出ます。</div>`);
  } else if (sub.type === "mic") {
    fieldsEl.innerHTML = `<div class="path-preview" style="margin:0;">マイクのミュート・ミュート解除を切り替えます。</div>`;
  } else if (sub.type === "window") {
    actionButtons(WINDOW_ACTIONS);
  } else if (sub.type === "pageswitch") {
    const pageSwitchCount = Math.max(settings.pageCount, (sub.targetPage || 0) + 1);
    fieldsEl.innerHTML = `
      <div class="type-row mini" id="sf-pageSwitchRow"></div>
      <div class="type-row mini" id="sf-pageSwitchModeRow" style="margin-top:6px;"></div>
    `;
    const pageSwitchRow = fieldsEl.querySelector("#sf-pageSwitchRow");
    for (let i = 0; i < pageSwitchCount; i++) {
      const b = document.createElement("div");
      b.className = "opt-btn mini" + ((sub.targetPage || 0) === i ? " active" : "");
      b.textContent = `画面${i + 1}`;
      b.addEventListener("click", () => { sub.targetPage = i; renderMultiSubList(t); });
      pageSwitchRow.appendChild(b);
    }
    const subMode = sub.switchMode === "replace" ? "replace" : "add";
    const pageSwitchModeRow = fieldsEl.querySelector("#sf-pageSwitchModeRow");
    [
      { key: "add", label: "追加でウィンドウを開く" },
      { key: "replace", label: "今の画面を閉じてから開く" },
    ].forEach((opt) => {
      const b = document.createElement("div");
      b.className = "opt-btn mini" + (subMode === opt.key ? " active" : "");
      b.textContent = opt.label;
      b.addEventListener("click", () => { sub.switchMode = opt.key; renderMultiSubList(t); });
      pageSwitchModeRow.appendChild(b);
    });
  } else if (sub.type === "brightness") {
    actionButtons(BRIGHTNESS_ACTIONS);
    fieldsEl.insertAdjacentHTML("beforeend", `
      <div class="field-label" style="margin-top:8px;">変える量（<span id="sf-brightLabel">${numAttr(sub.repeatCount || 3, 3)}</span>%）</div>
      <input type="range" id="sf-brightInput" min="1" max="5" value="${numAttr(sub.repeatCount || 3, 3)}" style="width:100%;accent-color:var(--accent);margin-bottom:0;" />
    `);
    fieldsEl.querySelector("#sf-brightInput").addEventListener("input", (e) => {
      sub.repeatCount = Number(e.target.value);
      fieldsEl.querySelector("#sf-brightLabel").textContent = sub.repeatCount;
    });
  } else if (sub.type === "media") {
    actionButtons(MEDIA_ACTIONS);
  } else if (sub.type === "zoom") {
    if ((sub.repeatCount || 1) > 5) sub.repeatCount = 5;
    actionButtons(ZOOM_ACTIONS);
    fieldsEl.insertAdjacentHTML("beforeend", `
      <div class="field-label" style="margin-top:8px;">押す回数（<span id="sf-zoomLabel">${numAttr(sub.repeatCount || 1, 1)}</span>回・1回＝5%）</div>
      <input type="range" id="sf-zoomInput" min="1" max="5" value="${numAttr(sub.repeatCount || 1, 1)}" style="width:100%;accent-color:var(--accent);margin-bottom:0;" />
    `);
    fieldsEl.querySelector("#sf-zoomInput").addEventListener("input", (e) => {
      sub.repeatCount = Number(e.target.value);
      fieldsEl.querySelector("#sf-zoomLabel").textContent = sub.repeatCount;
    });
  } else if (sub.type === "timer") {
    fieldsEl.innerHTML = `<div class="path-preview" style="margin:0;">押すとタイマー画面を開きます。</div>`;
  } else if (sub.type === "clipboard") {
    if (sub.autoPaste === undefined) sub.autoPaste = true;
    fieldsEl.innerHTML = `<div class="type-row" style="margin:0 0 6px;" id="sf-clipAction"></div><div id="sf-clipContent"></div>`;
    const row = fieldsEl.querySelector("#sf-clipAction");
    Object.entries(CLIPBOARD_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn mini" + (sub.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { sub.action = key; renderMultiSubList(t); });
      row.appendChild(b);
    });
    const contentArea = fieldsEl.querySelector("#sf-clipContent");
    if (sub.action === "image") {
      contentArea.innerHTML = `
        <div class="file-pick-btn sub-pick" style="margin-bottom:4px;">🖼 コピーする画像を選択</div>
        <div class="path-preview" style="margin-bottom:6px;">${sub.filePath ? escapeHtml(sub.filePath) : "未選択"}</div>
      `;
      contentArea.querySelector(".sub-pick").addEventListener("click", async () => {
        const picked = await window.api.pickFile([{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "bmp"] }]);
        if (picked) { sub.filePath = picked; renderMultiSubList(t); }
      });
    } else if (sub.action === "file") {
      contentArea.innerHTML = `
        <div class="file-pick-btn sub-pick" style="margin-bottom:4px;">📄 コピーするファイルを選択</div>
        <div class="path-preview" style="margin-bottom:6px;">${sub.filePath ? escapeHtml(sub.filePath) : "未選択"}</div>
      `;
      contentArea.querySelector(".sub-pick").addEventListener("click", async () => {
        const picked = await window.api.pickFile([]);
        if (picked) { sub.filePath = picked; renderMultiSubList(t); }
      });
    } else if (sub.action === "folder") {
      contentArea.innerHTML = `
        <div class="file-pick-btn sub-pick" style="margin-bottom:4px;">📁 コピーするフォルダを選択</div>
        <div class="path-preview" style="margin-bottom:6px;">${sub.filePath ? escapeHtml(sub.filePath) : "未選択"}</div>
      `;
      contentArea.querySelector(".sub-pick").addEventListener("click", async () => {
        const picked = await window.api.pickFolder();
        if (picked) { sub.filePath = picked; renderMultiSubList(t); }
      });
    } else {
      contentArea.innerHTML = `
        <textarea class="sub-clip-text" maxlength="500" placeholder="コピーする内容"
          style="width:100%;min-height:60px;max-height:140px;overflow-y:auto;resize:vertical;background:var(--panel-alt);border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text);font-size:12.5px;margin-bottom:6px;outline:none;font-family:inherit;line-height:1.5;white-space:pre-wrap;">${escapeHtml(sub.text || "")}</textarea>
      `;
      contentArea.querySelector(".sub-clip-text").addEventListener("change", (e) => { sub.text = e.target.value; });
    }
    fieldsEl.insertAdjacentHTML("beforeend", `<label class="checkbox-row" style="margin:2px 0 0;"><input type="checkbox" class="sub-autopaste" ${sub.autoPaste ? "checked" : ""} />直前の入力欄に貼り付ける（Ctrl+V相当）</label>`);
    fieldsEl.querySelector(".sub-autopaste").addEventListener("change", (e) => { sub.autoPaste = e.target.checked; });
  } else if (sub.type === "discord") {
    fieldsEl.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;">
        <div class="path-preview" style="margin:0;flex:1;">${sub.sendHotkey ? escapeHtml(formatHotkeyDisplay(sub.sendHotkey)) : "未設定"}</div>
        <button class="btn default" id="sf-recordDiscord" type="button">設定</button>
        ${sub.sendHotkey ? '<button class="btn default" id="sf-clearDiscord" type="button">解除</button>' : ""}
      </div>
    `;
    fieldsEl.querySelector("#sf-recordDiscord").addEventListener("click", (e) => {
      stopRecordingHotkey();
      e.target.textContent = "キーを押してください…（Escで取消）";
      recordingHotkey = true;
      const onKey = (ev) => {
        ev.preventDefault();
        if (["Control", "Alt", "Shift", "Meta"].includes(ev.key)) return;
        stopRecordingHotkey();
        if (ev.key === "Escape" && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) { renderMultiSubList(t); return; }
        const hotkeyChar = hotkeyCharFromEvent(ev);
        const isSingleAlnum = !!hotkeyChar;
        if (!(ev.ctrlKey && ev.altKey && ev.shiftKey) || !isSingleAlnum) {
          showToast("「Ctrl+Alt+Shift＋数字1文字 または 英字1文字」のみ設定できます。");
          renderMultiSubList(t);
          return;
        }
        sub.sendHotkey = `Control+Alt+Shift+${hotkeyChar}`;
        renderMultiSubList(t);
      };
      activeHotkeyKeydownHandler = onKey;
      document.addEventListener("keydown", onKey, true);
    });
    const clearBtn = fieldsEl.querySelector("#sf-clearDiscord");
    if (clearBtn) clearBtn.addEventListener("click", () => { sub.sendHotkey = ""; renderMultiSubList(t); });
  } else if (sub.type === "obs") {
    actionButtons(OBS_ACTIONS);
    if (sub.action === "mute") {
      fieldsEl.insertAdjacentHTML("beforeend", `<input type="text" class="sub-obs-source" maxlength="60" placeholder="ミュートする音声ソース名" value="${escapeHtml(sub.obsSource || "")}" style="margin:6px 0 0;" />`);
      fieldsEl.querySelector(".sub-obs-source").addEventListener("change", (e) => { sub.obsSource = e.target.value; });
    }
  } else if (sub.type === "shortcutKeys") {
    actionButtons(SHORTCUT_ACTIONS);
    fieldsEl.insertAdjacentHTML("beforeend", `<div class="path-preview" style="margin:6px 0 0;">基本的なショートカットをワンボタンで操作できます。</div>`);
  } else if (sub.type === "screenshotFull") {
    fieldsEl.innerHTML = `<div class="path-preview" style="margin:0;">画面全体を撮影して、ピクチャフォルダの「Launch-K Screenshots」に保存します。</div>`;
  }
}

function renderModal() {
  const t = modalData.tile;
  normalizeIcon(t);
  // 「ショートカット」ボタンはボタンを押して使うだけなので、起動用のショートカットキーは持たない
  const showHotkeyField = t.type !== "shortcutKeys";
  if (!showHotkeyField) t.hotkey = "";
  modalBodyEl.innerHTML = `
    <h2 style="font-size:17px;font-weight:700;margin-bottom:16px;">${modalData.mode === "edit" ? "ボタンを編集" : "追加"}</h2>
    <div class="field-label">種類</div>
    <div class="type-row" id="typeRow"></div>
    <div class="field-label">名前</div>
    <input type="text" id="nameInput" maxlength="20" placeholder="例：Gmail" value="${escapeHtml(t.name)}" />
    <div id="typeSpecific"></div>
    <div class="field-label">アイコン</div>
    <div class="icon-row" id="iconRow"></div>
    <div id="iconSpecific"></div>
    <div class="field-label">カラー</div>
    <div class="color-row" id="colorRow"></div>
    <label class="checkbox-row">
      <input type="checkbox" id="matchNameColorInput" ${t.matchNameColor ? "checked" : ""} />
      ボタンの名前のカラーも変更する
    </label>
    ${settings.pageCount > 1 ? `
    <div class="field-label" style="margin-top:14px;">表示する画面</div>
    <div class="type-row" id="pageRow"></div>
    ` : ""}
    ${showHotkeyField ? `
    <div class="field-label" style="margin-top:14px;">ショートカットキー（任意）</div>
    <div class="path-preview" style="margin-top:0;">「Ctrl+Alt+Shift＋数字1文字 または 英字1文字」のみ設定できます。</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
      <div class="path-preview" id="hotkeyPreview" style="margin:0;flex:1;">${t.hotkey ? escapeHtml(formatHotkeyDisplay(t.hotkey)) : "未設定"}</div>
      <button class="btn default" id="recordHotkeyBtn">設定</button>
      ${t.hotkey ? '<button class="btn default" id="clearHotkeyBtn">解除</button>' : ""}
    </div>
    ` : `<div style="height:14px;"></div>`}
    <div class="modal-actions">
      <button class="btn default" id="cancelBtn">キャンセル</button>
      <button class="btn primary" id="saveBtn">保存</button>
    </div>
  `;

  const typeRow = document.getElementById("typeRow");
  const typeTrigger = document.createElement("button");
  typeTrigger.type = "button";
  typeTrigger.className = "type-select-trigger";
  typeTrigger.innerHTML = `<span>${escapeHtml(TYPE_META[t.type].label)}</span><span class="type-select-trigger-caret">▾</span>`;
  typeTrigger.addEventListener("click", () => {
    openTypeSelect(Object.keys(TYPE_META), t.type, (key) => {
      t.type = key;
      if (key === "volume" && !VOLUME_ACTIONS[t.action]) t.action = "up";
      if (key === "power" && !POWER_ACTIONS[t.action]) t.action = "sleep";
      if (key === "window" && !WINDOW_ACTIONS[t.action]) t.action = "left";
      if (key === "pageswitch" && (t.targetPage === undefined || t.targetPage === null)) t.targetPage = 0;
      if (key === "brightness" && !BRIGHTNESS_ACTIONS[t.action]) t.action = "up";
      if (key === "media" && !MEDIA_ACTIONS[t.action]) t.action = "playpause";
      if (key === "zoom" && !ZOOM_ACTIONS[t.action]) t.action = "in";
      if (key === "clipboard" && !CLIPBOARD_ACTIONS[t.action]) t.action = "text";
      if (key === "obs" && !OBS_ACTIONS[t.action]) t.action = "mute";
      if (key === "shortcutKeys" && !SHORTCUT_ACTIONS[t.action]) t.action = "copy";
      if (key === "multi" && (!Array.isArray(t.subActions) || t.subActions.length < 2)) {
        t.subActions = [{ type: "link", url: "" }, { type: "link", url: "" }];
      }
      applySuggestedColorIfNeeded(t);
      normalizeIcon(t);
      renderModal();
    });
  });
  typeRow.appendChild(typeTrigger);

  const pageRow = document.getElementById("pageRow");
  if (pageRow) {
    const currentPageIdx = t.pageIndex || 0;
    for (let i = 0; i < settings.pageCount; i++) {
      const b = document.createElement("div");
      b.className = "opt-btn" + (currentPageIdx === i ? " active" : "");
      b.textContent = `画面${i + 1}`;
      b.addEventListener("click", () => { t.pageIndex = i; renderModal(); });
      pageRow.appendChild(b);
    }
  }

  const typeSpecific = document.getElementById("typeSpecific");
  if (t.type === "link" || t.type === "qr") {
    const label = t.type === "qr" ? "QRコードにするURL" : "リンク先URL";
    typeSpecific.innerHTML = `<div class="field-label">${label}</div><input type="text" id="urlInput" placeholder="https://example.com" value="${escapeHtml(t.url || "")}" />`;
    if (t.type === "link") {
      typeSpecific.innerHTML += `
        <div class="field-label" style="margin-top:14px;">開くブラウザ</div>
        <div class="type-row mini" id="browserRow"></div>
      `;
      const browserRow = document.getElementById("browserRow");
      Object.entries(BROWSER_OPTIONS).forEach(([key, meta]) => {
        const b = document.createElement("div");
        b.className = "opt-btn mini" + ((t.browser || "default") === key ? " active" : "");
        b.textContent = meta.label;
        b.addEventListener("click", () => { t.browser = key; renderModal(); });
        browserRow.appendChild(b);
      });
    }
  } else if (t.type === "sound") {
    typeSpecific.innerHTML = `
      <div class="path-preview" style="margin-top:0;">クリックすると、選んだ音声ファイル（mp3・wav・ogg・m4a）をそのまま再生します。</div>
      <div class="file-pick-btn" id="pickSoundBtn">🎵 音声ファイルを選択</div>
      <div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>
      <div class="field-label">個別音量（<span id="volLabel">${numAttr(t.volume ?? 100, 100)}</span>）</div>
      <input type="range" id="volInput" min="0" max="100" value="${numAttr(t.volume ?? 100, 100)}" style="width:100%;accent-color:var(--accent);margin-bottom:14px;" />
    `;
    document.getElementById("pickSoundBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFile([{ name: "音声ファイル", extensions: ["mp3", "wav", "ogg", "m4a"] }]);
      if (picked) { t.filePath = picked; renderModal(); }
    });
  } else if (t.type === "app") {
    typeSpecific.innerHTML = `<div class="file-pick-btn" id="pickAppBtn">🖥 起動するアプリ（.exe等）を選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>`;
    // 以前に設定済みの.lnk（まだリンク先を調べていないもの）は、裏で判定して、メモだった場合だけ描き直す
    if (needsNotepadResolve(t.filePath)) {
      const checkedPath = t.filePath;
      resolveNotepadShortcut(checkedPath).then((isMemo) => {
        if (isMemo && modalData && modalData.tile === t && t.filePath === checkedPath) renderModal();
      });
    }
    if (isNotepadPath(t.filePath)) {
      typeSpecific.innerHTML += `<div class="field-label" style="margin-top:14px;">メモの開き方</div><div class="type-row" id="memoModeRow"></div><div class="path-preview">既にメモが開いているときの動作です（開いていなければ、どれを選んでも新しく起動します）。</div>`;
    }
    document.getElementById("pickAppBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFile([{ name: "アプリケーション", extensions: ["exe", "lnk", "bat", "cmd"] }]);
      if (!picked) return;
      t.filePath = picked;
      await resolveNotepadShortcut(picked); // ショートカット（.lnk）のリンク先がメモかどうかを先に判定
      if (isNotepadPath(picked) && !MEMO_MODES[t.memoMode]) t.memoMode = "open";
      // アイコンをまだ自分で選んでいない（「既定」のまま）場合は、
      // 選んだアプリ本体のアイコンを自動で拾ってきて使う。
      if (t.icon.kind === "default") {
        const iconDataUrl = await window.api.getFileIcon(picked);
        if (iconDataUrl) t.icon = { kind: "image", value: iconDataUrl };
      }
      renderModal();
    });
    const memoModeRow = document.getElementById("memoModeRow");
    if (memoModeRow) {
      Object.entries(MEMO_MODES).forEach(([key, meta]) => {
        const b = document.createElement("div");
        b.className = "opt-btn" + ((t.memoMode || "open") === key ? " active" : "");
        b.textContent = meta.label;
        b.addEventListener("click", () => { t.memoMode = key; renderModal(); });
        memoModeRow.appendChild(b);
      });
    }
  } else if (t.type === "file") {
    typeSpecific.innerHTML = `<div class="file-pick-btn" id="pickFileBtn">📄 開くファイルを選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>${openMaximizedRowHtml(t)}`;
    bindOpenMaximizedRow(t);
    document.getElementById("pickFileBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFile([]);
      if (picked) { t.filePath = picked; renderModal(); }
    });
  } else if (t.type === "folder") {
    typeSpecific.innerHTML = `<div class="file-pick-btn" id="pickFolderBtn">📁 開くフォルダを選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>${openMaximizedRowHtml(t)}`;
    bindOpenMaximizedRow(t);
    document.getElementById("pickFolderBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFolder();
      if (picked) { t.filePath = picked; renderModal(); }
    });
  } else if (t.type === "media") {
    typeSpecific.innerHTML = `<div class="field-label">動作</div><div class="type-row" id="mediaActionRow"></div><div class="path-preview">今使っている音楽・動画アプリに操作を送ります。</div>`;
    const row = document.getElementById("mediaActionRow");
    Object.entries(MEDIA_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      row.appendChild(b);
    });
  } else if (t.type === "volume") {
    typeSpecific.innerHTML = `
      <div class="field-label">動作</div><div class="type-row" id="volumeActionRow"></div>
      <div id="repeatCountWrap"></div>
      <div class="path-preview">「上げる／下げる」は押し続けると連続実行されます。</div>
    `;
    const row = document.getElementById("volumeActionRow");
    Object.entries(VOLUME_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; applySuggestedColorIfNeeded(t); normalizeIcon(t); renderModal(); });
      row.appendChild(b);
    });
    const repeatWrap = document.getElementById("repeatCountWrap");
    if (t.action === "up" || t.action === "down") {
      repeatWrap.innerHTML = `<div class="field-label">1回のクリックで押す回数（<span id="repeatLabel">${numAttr(t.repeatCount || 1, 1)}</span>回）</div><input type="range" id="repeatInput" min="1" max="10" value="${numAttr(t.repeatCount || 1, 1)}" style="width:100%;accent-color:var(--accent);margin-bottom:14px;" />`;
      document.getElementById("repeatInput").addEventListener("input", (e) => {
        t.repeatCount = Number(e.target.value);
        document.getElementById("repeatLabel").textContent = t.repeatCount;
      });
    }
  } else if (t.type === "power") {
    typeSpecific.innerHTML = `<div class="field-label">動作</div><div class="type-row" id="powerActionRow"></div><div class="path-preview">実行前に確認画面が出ます。</div>`;
    const row = document.getElementById("powerActionRow");
    Object.entries(POWER_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; applySuggestedColorIfNeeded(t); normalizeIcon(t); renderModal(); });
      row.appendChild(b);
    });
  } else if (t.type === "mic") {
    typeSpecific.innerHTML = `<div class="path-preview" style="margin-top:0;">クリックするたびに、パソコンの既定のマイク（録音デバイス）のミュート・ミュート解除を切り替えます。</div>`;
  } else if (t.type === "zoom") {
    if ((t.repeatCount || 1) > 5) t.repeatCount = 5;
    typeSpecific.innerHTML = `
      <div class="field-label" style="margin-top:0;">動作</div><div class="type-row" id="zoomActionRow"></div>
      <div class="field-label">1回のクリックで押す回数（<span id="zoomRepeatLabel">${numAttr(t.repeatCount || 1, 1)}</span>回・1回＝画面の5%）</div>
      <input type="range" id="zoomRepeatInput" min="1" max="5" value="${numAttr(t.repeatCount || 1, 1)}" style="width:100%;accent-color:var(--accent);margin-bottom:4px;" />
      <div class="path-preview">Windowsの「Ctrl + ／Ctrl −」相当（多くのアプリの画面拡大・縮小）を送ります。1回押すごとに画面が約5%拡大・縮小します。押し続けると連続実行されます。</div>
    `;
    const zoomRow = document.getElementById("zoomActionRow");
    Object.entries(ZOOM_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = (key === "in" ? "🔍＋" : "🔍－") + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      zoomRow.appendChild(b);
    });
    document.getElementById("zoomRepeatInput").addEventListener("input", (e) => {
      t.repeatCount = Number(e.target.value);
      document.getElementById("zoomRepeatLabel").textContent = t.repeatCount;
    });
  } else if (t.type === "clipboard") {
    if (t.autoPaste === undefined) t.autoPaste = true;
    typeSpecific.innerHTML = `
      <div class="field-label">コピーする内容の種類</div>
      <div class="type-row" id="clipActionRow"></div>
      <div id="clipContentArea"></div>
      <label class="checkbox-row"><input type="checkbox" id="autoPasteInput" ${t.autoPaste ? "checked" : ""} />コピーだけでなく、直前まで使っていた画面の入力欄にそのまま貼り付ける（Ctrl+V相当）</label>
    `;
    const clipRow = document.getElementById("clipActionRow");
    Object.entries(CLIPBOARD_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      clipRow.appendChild(b);
    });
    const contentArea = document.getElementById("clipContentArea");
    if (t.action === "image") {
      contentArea.innerHTML = `<div class="file-pick-btn" id="pickClipImageBtn">🖼 コピーする画像を選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>`;
      document.getElementById("pickClipImageBtn").addEventListener("click", async () => {
        const picked = await window.api.pickFile([{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "bmp"] }]);
        if (picked) { t.filePath = picked; renderModal(); }
      });
    } else if (t.action === "file") {
      contentArea.innerHTML = `<div class="file-pick-btn" id="pickClipFileBtn">📄 コピーするファイルを選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>`;
      document.getElementById("pickClipFileBtn").addEventListener("click", async () => {
        const picked = await window.api.pickFile([]);
        if (picked) { t.filePath = picked; normalizeIcon(t); renderModal(); }
      });
    } else if (t.action === "folder") {
      contentArea.innerHTML = `<div class="file-pick-btn" id="pickClipFolderBtn">📁 コピーするフォルダを選択</div><div class="path-preview">${t.filePath ? escapeHtml(t.filePath) : "未選択"}</div>`;
      document.getElementById("pickClipFolderBtn").addEventListener("click", async () => {
        const picked = await window.api.pickFolder();
        if (picked) { t.filePath = picked; normalizeIcon(t); renderModal(); }
      });
    } else {
      contentArea.innerHTML = `
        <div class="field-label">コピーする内容（<span id="clipLenLabel">${(t.text || "").length}</span>/500文字）</div>
        <textarea id="clipTextInput" maxlength="500" placeholder="例：お世話になっております。&#10;株式会社かせき 田中太郎&#10;tanaka@kaseki-corp.co.jp"
          style="width:100%;min-height:110px;max-height:220px;overflow-y:auto;resize:vertical;background:var(--panel-alt);border:1px solid var(--border);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13px;margin-bottom:14px;outline:none;font-family:inherit;line-height:1.5;white-space:pre-wrap;">${escapeHtml(t.text || "")}</textarea>
      `;
      document.getElementById("clipTextInput").addEventListener("input", (e) => {
        t.text = e.target.value;
        document.getElementById("clipLenLabel").textContent = t.text.length;
      });
    }
    document.getElementById("autoPasteInput").addEventListener("change", (e) => { t.autoPaste = e.target.checked; });
  } else if (t.type === "timer") {
    typeSpecific.innerHTML = `
      <div class="path-preview" style="margin-top:0;">押すと専用のタイマー画面が開きます。時間の編集やマルチタイマー（最大15個）の管理は、タイマー画面右上のメニュー（☰）から行えます。タイマー画面はロック（常に最前面）が既定でオン、鳴ったら音でお知らせします。</div>
    `;
  } else if (t.type === "window") {
    typeSpecific.innerHTML = `<div class="field-label">動作</div><div class="type-row" id="windowActionRow"></div><div class="path-preview">今アクティブなウィンドウを画面の半分または1/4にスナップします。</div>`;
    const row = document.getElementById("windowActionRow");
    Object.entries(WINDOW_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      row.appendChild(b);
    });
  } else if (t.type === "pageswitch") {
    const pageSwitchCount = Math.max(settings.pageCount, (t.targetPage || 0) + 1);
    typeSpecific.innerHTML = `
      <div class="field-label" style="margin-top:0;">切り替え先の画面</div><div class="type-row" id="pageSwitchRow"></div>
      <div class="field-label" style="margin-top:10px;">切り替え方</div><div class="type-row" id="pageSwitchModeRow"></div>
      <div class="path-preview" id="pageSwitchModeHint"></div>
    `;
    const pageSwitchRow = document.getElementById("pageSwitchRow");
    for (let i = 0; i < pageSwitchCount; i++) {
      const b = document.createElement("div");
      b.className = "opt-btn" + ((t.targetPage || 0) === i ? " active" : "");
      b.textContent = `画面${i + 1}`;
      b.addEventListener("click", () => { t.targetPage = i; renderModal(); });
      pageSwitchRow.appendChild(b);
    }
    const mode = t.switchMode === "replace" ? "replace" : "add";
    const pageSwitchModeRow = document.getElementById("pageSwitchModeRow");
    [
      { key: "add", label: "追加でウィンドウを開く" },
      { key: "replace", label: "今の画面を閉じてから開く" },
    ].forEach((opt) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (mode === opt.key ? " active" : "");
      b.textContent = opt.label;
      b.addEventListener("click", () => { t.switchMode = opt.key; renderModal(); });
      pageSwitchModeRow.appendChild(b);
    });
    document.getElementById("pageSwitchModeHint").textContent = mode === "replace"
      ? "選んだ画面を開いたあと、今の画面（このウィンドウ）を閉じます。メイン画面（画面1）はトレイに隠れるだけで、アプリ自体は終了しません。"
      : "選んだ画面を別ウィンドウとして開きます（既に開いていれば前面に表示）。今の画面はそのまま残ります。";
  } else if (t.type === "brightness") {
    typeSpecific.innerHTML = `
      <div class="field-label">動作</div><div class="type-row" id="brightnessActionRow"></div>
      <div class="field-label">1回のクリックで変える量（<span id="brightRepeatLabel">${numAttr(t.repeatCount || 3, 3)}</span>%）</div>
      <input type="range" id="brightRepeatInput" min="1" max="5" step="1" value="${numAttr(t.repeatCount || 3, 3)}" style="width:100%;accent-color:var(--accent);margin-bottom:4px;" />
      <div class="path-preview">対応しているノートPCの内蔵ディスプレイのみ対応です。押し続けると連続実行されます。</div>
    `;
    const row = document.getElementById("brightnessActionRow");
    Object.entries(BRIGHTNESS_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; applySuggestedColorIfNeeded(t); normalizeIcon(t); renderModal(); });
      row.appendChild(b);
    });
    document.getElementById("brightRepeatInput").addEventListener("input", (e) => {
      t.repeatCount = Number(e.target.value);
      document.getElementById("brightRepeatLabel").textContent = t.repeatCount;
    });
  } else if (t.type === "discord") {
    typeSpecific.innerHTML = `
      <div class="path-preview" style="margin-top:0;">Discordを直接は操作できないため、Discord側の「設定 → キーボードショートカット」で設定した“ミュート切替”のキーと、下記で登録するキーを同じものにしてください。ボタンを押すと、そのキーの組み合わせをこのアプリから送信します（現在Windowsのみ対応）。</div>
      <div class="field-label">送信するキー</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <div class="path-preview" id="discordHotkeyPreview" style="margin:0;flex:1;">${t.sendHotkey ? escapeHtml(formatHotkeyDisplay(t.sendHotkey)) : "未設定"}</div>
        <button class="btn default" id="recordDiscordHotkeyBtn">設定</button>
        ${t.sendHotkey ? '<button class="btn default" id="clearDiscordHotkeyBtn">解除</button>' : ""}
      </div>
    `;
    document.getElementById("recordDiscordHotkeyBtn").addEventListener("click", (e) => {
      stopRecordingHotkey();
      e.target.textContent = "キーを押してください…（Escで取消）";
      recordingHotkey = true;
      const onKey = (ev) => {
        ev.preventDefault();
        if (["Control", "Alt", "Shift", "Meta"].includes(ev.key)) return;
        stopRecordingHotkey();
        if (ev.key === "Escape" && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) { renderModal(); return; }
        const hotkeyChar = hotkeyCharFromEvent(ev);
        const isSingleAlnum = !!hotkeyChar;
        if (!(ev.ctrlKey && ev.altKey && ev.shiftKey) || !isSingleAlnum) {
          showToast("「Ctrl+Alt+Shift＋数字1文字 または 英字1文字」のみ設定できます。");
          renderModal();
          return;
        }
        t.sendHotkey = `Control+Alt+Shift+${hotkeyChar}`;
        renderModal();
      };
      activeHotkeyKeydownHandler = onKey;
      document.addEventListener("keydown", onKey, true);
    });
    const clearDiscordBtn = document.getElementById("clearDiscordHotkeyBtn");
    if (clearDiscordBtn) clearDiscordBtn.addEventListener("click", () => { t.sendHotkey = ""; renderModal(); });
  } else if (t.type === "obs") {
    typeSpecific.innerHTML = `
      <div class="field-label" style="margin-top:0;">動作</div><div class="type-row" id="obsActionRow"></div>
      <div id="obsSourceWrap"></div>
      <div class="path-preview">OBSの「ツール → WebSocketサーバー設定」を有効にしてください。接続先（ホスト・ポート・パスワード）は設定メニューの「OBS連携」から登録します。</div>
    `;
    const obsRow = document.getElementById("obsActionRow");
    Object.entries(OBS_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      obsRow.appendChild(b);
    });
    const obsSourceWrap = document.getElementById("obsSourceWrap");
    if (t.action === "mute") {
      obsSourceWrap.innerHTML = `<div class="field-label">ミュートする音声ソース名</div><input type="text" id="obsSourceInput" maxlength="60" placeholder="例：マイク/Aux" value="${escapeHtml(t.obsSource || "")}" />`;
      document.getElementById("obsSourceInput").addEventListener("input", (e) => { t.obsSource = e.target.value; });
    }
  } else if (t.type === "shortcutKeys") {
    typeSpecific.innerHTML = `
      <div class="field-label" style="margin-top:0;">ショートカット</div><div class="type-row" id="shortcutActionRow"></div>
      <div class="path-preview">基本的なショートカットをワンボタンで操作できます。</div>
    `;
    const shortcutRow = document.getElementById("shortcutActionRow");
    Object.entries(SHORTCUT_ACTIONS).forEach(([key, meta]) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (t.action === key ? " active" : "");
      b.textContent = meta.glyph + " " + meta.label;
      b.addEventListener("click", () => { t.action = key; normalizeIcon(t); renderModal(); });
      shortcutRow.appendChild(b);
    });
  } else if (t.type === "screenshotFull") {
    typeSpecific.innerHTML = `<div class="path-preview" style="margin-top:0;">押すと画面全体を撮影して、ピクチャフォルダの「Launch-K Screenshots」に保存します（Windowsのみ）。</div>`;
  } else if (t.type === "multi") {
    if (!Array.isArray(t.subActions)) t.subActions = [];
    typeSpecific.innerHTML = `
      <div class="path-preview" style="margin-top:0;">登録した動作を上から順に実行します（同時には実行されません）。動作の間の待ちは自動で最短になり、各動作の「このあとの待ち」で変えることもできます。マルチ操作以外の動作を2〜15個まで登録できます。</div>
      <div id="multiSubList"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <span class="path-preview" id="multiSubCount" style="margin:0;"></span>
        <button class="btn default" id="addMultiSubBtn">＋ 動作を追加</button>
      </div>
    `;
    document.getElementById("addMultiSubBtn").addEventListener("click", () => {
      if (t.subActions.length >= 15) return;
      t.subActions.push({ type: "link", url: "" });
      renderMultiSubList(t);
    });
    renderMultiSubList(t);
  }

  const iconRow = document.getElementById("iconRow");
  const ICON_KIND_OPTIONS = [
    { kind: "default", label: "既定", title: "種類・動作に合わせて自動でアイコンが選ばれます（おすすめ）" },
    { kind: "css", label: "CSS", title: "用意した約50種のアイコンから自分で選びます" },
    { kind: "emoji", label: "絵文字", title: "好きな絵文字を1つ入力します" },
    { kind: "image", label: "画像", title: "画像ファイルを選ぶか、画面をキャプチャして使います" },
  ];
  ICON_KIND_OPTIONS.forEach((opt) => {
    const b = document.createElement("div");
    b.className = "opt-btn" + (t.icon.kind === opt.kind ? " active" : "");
    b.textContent = opt.label;
    b.title = opt.title;
    b.addEventListener("click", async () => {
      if (opt.kind === "image") {
        // 「ファイルから選ぶ」か「画面を撮る」かを下の欄で選べるよう、ここではタブを切り替えるだけにする
        t.icon = { kind: "image", value: t.icon.kind === "image" ? t.icon.value : "" };
        renderModal();
      } else if (opt.kind === "css") {
        // 「既定」から切り替えたときは、いま自動で表示されているアイコンから編集を始められるようにする
        // （塗りつぶしの設定・オフ用アイコンは、CSSタブ内での切り替えでは保持する）。
        t.icon = { kind: "css", value: resolveCssIconKey(t), filled: t.icon.filled, offValue: t.icon.offValue };
        renderModal();
      } else if (opt.kind === "default") {
        t.icon = { kind: "default", value: "" };
        renderModal();
      } else {
        t.icon = { kind: opt.kind, value: opt.kind === t.icon.kind ? t.icon.value : "" };
        renderModal();
      }
    });
    iconRow.appendChild(b);
  });

  const iconSpecific = document.getElementById("iconSpecific");
  if (t.icon.kind === "emoji") {
    iconSpecific.innerHTML = `<input type="text" class="icon-emoji-input" id="emojiInput" maxlength="4" placeholder="例：🚀" value="${escapeHtml(t.icon.value || "")}" />`;
    document.getElementById("emojiInput").addEventListener("input", (e) => { t.icon.value = e.target.value.slice(0, 4); });
  } else if (t.icon.kind === "image") {
    iconSpecific.innerHTML = `
      ${t.icon.value ? `<div class="icon-preview-row"><img src="${toFileUrl(t.icon.value)}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;" /><span style="font-size:12px;color:var(--text-muted);">プレビュー</span></div>` : ""}
      <div style="display:flex;gap:8px;">
        <div class="file-pick-btn" id="iconPickFileBtn" style="flex:1;justify-content:center;margin-bottom:6px;">📁 ファイルから選ぶ</div>
        <div class="file-pick-btn" id="iconCaptureBtn" style="flex:1;justify-content:center;margin-bottom:6px;">📸 画面を撮る</div>
      </div>`;
    document.getElementById("iconPickFileBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFile([{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]);
      if (picked) { t.icon = { kind: "image", value: picked }; renderModal(); }
    });
    document.getElementById("iconCaptureBtn").addEventListener("click", async () => {
      const res = await window.api.captureScreen("icon");
      if (!res) return; // 範囲選択をキャンセル
      if (res.error) return showToast(res.error);
      t.icon = { kind: "image", value: res.dataUrl };
      renderModal();
    });
  } else if (t.icon.kind === "default") {
    // 「既定」は種類・動作に応じて毎回自動計算されるプレビューを見せるだけで、選択肢は出さない
    const autoKey = defaultCssIconFor(t);
    const def = CSS_ICONS[autoKey] || CSS_ICONS.circleMark;
    iconSpecific.innerHTML = `
      <div class="icon-preview-row">
        <span id="defaultIconPreviewSwatch" style="width:36px;height:36px;border-radius:10px;background:var(--panel-alt);display:flex;align-items:center;justify-content:center;color:${safeColor(t.color)};">${def.svg}</span>
        <span style="font-size:12px;color:var(--text-muted);">「${escapeHtml(def.label)}」が種類・動作に応じて自動で選ばれます</span>
      </div>`;
  } else if (t.icon.kind === "css") {
    // オン/オフを持つタイル（ミュート系）は、オン用・オフ用のアイコンを両方選ばないと
    // 見分けがつかなくなるため、どちらを編集中かをタブで切り替えられるようにする。
    const hasToggle = tileHasToggle(t);
    if (hasToggle && !modalData.iconEditTarget) modalData.iconEditTarget = "on";
    const editingOff = hasToggle && modalData.iconEditTarget === "off";
    const activeValueKey = editingOff ? "offValue" : "value";

    // カテゴリが多いと一覧が縦に長くなり見た目が悪いため、既定では折りたたんでおき、
    // クリックしたカテゴリだけ開閉できるようにする。今選択中のアイコンが入っている
    // カテゴリだけは、見失わないよう自動的に開いておく。
    if (!modalData.openIconGroups) modalData.openIconGroups = new Set();
    const activeGroup = CSS_ICON_GROUPS.find((g) => g.keys.includes(t.icon[activeValueKey]));
    if (activeGroup) modalData.openIconGroups.add(activeGroup.title);

    // 塗りつぶしは、実際のタイル描画と全く同じ関数（iconBg/iconInner）
    // を使ってプレビューするため、モーダル内の見た目と実際のタイルの見た目が食い違わない。
    const previewRow = `
      <div class="icon-preview-row">
        <div class="tile-icon-wrap" style="position:relative;width:36px;height:36px;--icon-size:36px;">
          <div class="tile-icon" style="width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;${iconBg(t, hasToggle ? editingOff : undefined)}">${iconInner(t, hasToggle ? editingOff : undefined)}</div>
        </div>
        <span style="font-size:12px;color:var(--text-muted);">プレビュー</span>
      </div>
      <label class="checkbox-row" style="margin-bottom:10px;">
        <input type="checkbox" id="cssIconFilledInput" ${t.icon.filled ? "checked" : ""} />
        CSSの塗りつぶし
      </label>
      ${hasToggle ? `
      <div class="type-row" id="iconOnOffTabs" style="margin-bottom:10px;">
        <div class="opt-btn${!editingOff ? " active" : ""}" data-target="on">オンのとき</div>
        <div class="opt-btn${editingOff ? " active" : ""}" data-target="off">オフ（ミュート中）のとき</div>
      </div>
      <div class="path-preview" style="margin-top:0;">オン・オフそれぞれで使うアイコンを選んでください。両方選ぶまで保存できません。${!t.icon.offValue ? "（オフ用のアイコンが未選択です）" : ""}</div>
      ` : ""}
    `;

    const swatchGrid = (keys) => `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:10px;">${keys.map((k) => {
      const active = t.icon[activeValueKey] === k;
      return `<div class="css-icon-swatch" data-key="${k}" title="${escapeHtml(CSS_ICONS[k].label)}" style="aspect-ratio:1/1;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:6px;cursor:pointer;background:var(--panel-alt);border:1px solid ${active ? "var(--accent)" : "var(--border)"};color:${active ? "var(--accent)" : "var(--text-muted)"};">${CSS_ICONS[k].svg}</div>`;
    }).join("")}</div>`;
    iconSpecific.innerHTML = previewRow + CSS_ICON_GROUPS.map((g) => {
      const isOpen = modalData.openIconGroups.has(g.title);
      return `
        <div class="icon-group-header" data-group="${escapeHtml(g.title)}">
          <span>${escapeHtml(g.title)}</span>
          <span class="icon-group-caret${isOpen ? " open" : ""}">▾</span>
        </div>
        <div class="icon-group-body" style="${isOpen ? "" : "display:none;"}">${swatchGrid(g.keys)}</div>
      `;
    }).join("");
    document.getElementById("cssIconFilledInput").addEventListener("change", (e) => {
      t.icon.filled = e.target.checked;
      renderModal();
    });
    const tabsEl = document.getElementById("iconOnOffTabs");
    if (tabsEl) {
      tabsEl.querySelectorAll(".opt-btn").forEach((el) => {
        el.addEventListener("click", () => {
          modalData.iconEditTarget = el.dataset.target;
          renderModal();
        });
      });
    }
    iconSpecific.querySelectorAll(".icon-group-header").forEach((el) => {
      el.addEventListener("click", () => {
        const title = el.dataset.group;
        if (modalData.openIconGroups.has(title)) modalData.openIconGroups.delete(title);
        else modalData.openIconGroups.add(title);
        renderModal();
      });
    });
    iconSpecific.querySelectorAll(".css-icon-swatch").forEach((el) => {
      el.addEventListener("click", () => {
        t.icon = { ...t.icon, [activeValueKey]: el.dataset.key };
        renderModal();
      });
    });
  } else {
    iconSpecific.innerHTML = "";
  }

  const colorRow = document.getElementById("colorRow");
  buildColorRow(colorRow, t.color, (c, committed) => {
    t.color = c;
    modalData.colorTouched = true;
    if (committed) {
      renderModal();
    } else {
      // ドラッグ中はモーダル全体を再描画せず、影響する見た目だけをその場で更新する
      const swatch = document.getElementById("defaultIconPreviewSwatch");
      if (swatch) swatch.style.color = c;
    }
  });
  document.getElementById("matchNameColorInput").addEventListener("change", (e) => { t.matchNameColor = e.target.checked; });

  document.getElementById("nameInput").addEventListener("input", (e) => (t.name = e.target.value));
  const urlInput = document.getElementById("urlInput");
  if (urlInput) urlInput.addEventListener("input", (e) => (t.url = e.target.value));
  const volInput = document.getElementById("volInput");
  if (volInput) volInput.addEventListener("input", (e) => { t.volume = Number(e.target.value); document.getElementById("volLabel").textContent = t.volume; });

  const recordHotkeyBtn = document.getElementById("recordHotkeyBtn");
  if (recordHotkeyBtn) recordHotkeyBtn.addEventListener("click", (e) => {
    stopRecordingHotkey();
    e.target.textContent = "キーを押してください…（Escで取消）";
    recordingHotkey = true;
    const onKey = (ev) => {
      ev.preventDefault();
      if (["Control", "Alt", "Shift", "Meta"].includes(ev.key)) return;
      stopRecordingHotkey();
      if (ev.key === "Escape" && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
        renderModal();
        return;
      }
      // Ctrl+Alt+Shift＋英数字1文字のみ許可する
      const hotkeyChar = hotkeyCharFromEvent(ev);
      const isSingleAlnum = !!hotkeyChar;
      if (!(ev.ctrlKey && ev.altKey && ev.shiftKey) || !isSingleAlnum) {
        showToast("「Ctrl+Alt+Shift＋数字1文字 または 英字1文字」のみ設定できます。");
        renderModal();
        return;
      }
      const combo = `Control+Alt+Shift+${hotkeyChar}`;
      // 同じショートカットキーは、別の画面のボタンも含めて重複して設定できない
      const clash = tiles.find((o) => o.id !== t.id && o.hotkey === combo);
      if (clash) {
        showToast(`このショートカットキーは、画面${(clash.pageIndex || 0) + 1}の「${clash.name || "無題"}」で使われています。`);
        renderModal();
        return;
      }
      t.hotkey = combo;
      renderModal();
    };
    activeHotkeyKeydownHandler = onKey;
    document.addEventListener("keydown", onKey, true);
  });
  const clearBtn = document.getElementById("clearHotkeyBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => { t.hotkey = ""; renderModal(); });

  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("saveBtn").addEventListener("click", saveModal);

  // 保存ボタンまでスクロールしなくても、Enterキーで保存できるようにする。
  // ただし、コピー内容のテキストエリアでは改行入力にEnterを使うため対象外にし、
  // ショートカットキー登録中（recordingHotkey）はEnterがキー割り当てとして
  // 扱われるべきなので、ここでは横取りしない。
  modalBodyEl.onkeydown = (e) => {
    if (e.key !== "Enter" || recordingHotkey) return;
    // 日本語入力の「変換の確定」のEnterでは保存しない（確定のつもりが保存・終了になってしまうため）
    if (e.isComposing || e.keyCode === 229) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "textarea") return;
    // マルチ操作の各動作欄（リンクのURLなど）でのEnterでは保存しない（入力の途中で閉じてしまわないように）
    if (e.target && e.target.closest && e.target.closest(".multi-sub-row")) return;
    e.preventDefault();
    saveModal();
  };
}

// ファイル・フォルダのボタンだけに付く「開くとき最大化」のチェック（ボタンごとの設定）
function openMaximizedRowHtml(t) {
  return `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;"><input type="checkbox" id="tileOpenMaxChk" ${t.openMaximized === true ? "checked" : ""} /> 開くとき最大化する</label>`;
}
function bindOpenMaximizedRow(t) {
  document.getElementById("tileOpenMaxChk").addEventListener("change", (e) => { t.openMaximized = e.target.checked; });
}

async function saveModal() {
  const t = modalData.tile;
  if (!t.name.trim()) return showToast("名前を入力してください");
  if (t.icon?.kind === "css" && tileHasToggle(t) && !t.icon.offValue) {
    return showToast("オン用・オフ用のアイコンを両方選んでください");
  }
  if ((t.type === "link" || t.type === "qr") && !t.url.trim()) return showToast(t.type === "qr" ? "QRコードにするURLを入力してください" : "リンク先URLを入力してください");
  if ((t.type === "sound" || t.type === "file" || t.type === "folder" || t.type === "app") && !t.filePath) return showToast(t.type === "folder" ? "フォルダを選択してください" : t.type === "app" ? "起動するアプリを選択してください" : "ファイルを選択してください");
  if (t.type === "clipboard") {
    if (t.action === "image" || t.action === "file" || t.action === "folder") {
      if (!t.filePath) return showToast(t.action === "folder" ? "コピーするフォルダを選択してください" : t.action === "file" ? "コピーするファイルを選択してください" : "コピーする画像を選択してください");
    } else if (!t.text.trim()) return showToast("コピーする内容を入力してください");
  }
  if (t.type === "multi") {
    const subs = Array.isArray(t.subActions) ? t.subActions : [];
    if (subs.length < 2) return showToast("マルチ操作には動作を2つ以上登録してください");
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const n = i + 1;
      if ((s.type === "link") && !(s.url || "").trim()) return showToast(`${n}番目の動作：リンク先URLを入力してください`);
      if ((s.type === "sound" || s.type === "file" || s.type === "folder" || s.type === "app") && !s.filePath) return showToast(`${n}番目の動作：ファイルまたはフォルダを選択してください`);
      if (s.type === "clipboard") {
        if (s.action === "image" || s.action === "file" || s.action === "folder") {
          if (!s.filePath) return showToast(`${n}番目の動作：コピーする${s.action === "folder" ? "フォルダ" : s.action === "file" ? "ファイル" : "画像"}を選択してください`);
        } else if (!(s.text || "").trim()) return showToast(`${n}番目の動作：コピーする内容を入力してください`);
      }
      if (s.type === "discord" && !s.sendHotkey) return showToast(`${n}番目の動作：送信するキーを設定してください`);
    }
    if (subs.some((s) => s.type === "link")) {
      subs.forEach((s) => { if (s.type === "link" && !/^https?:\/\//i.test(s.url)) s.url = "https://" + s.url.trim(); });
    }
    // 「このあとの待ち」は0〜10秒の数値だけを残す（それ以外は自動に戻す）
    subs.forEach((s) => {
      if (typeof s.waitAfter !== "number" || !isFinite(s.waitAfter) || s.waitAfter < 0) delete s.waitAfter;
      else s.waitAfter = Math.min(10, s.waitAfter);
    });
  }

  const cleaned = { ...t, name: t.name.trim() };
  if ((cleaned.type === "link" || cleaned.type === "qr") && !/^https?:\/\//i.test(cleaned.url)) cleaned.url = "https://" + cleaned.url.trim();

  const exists = tiles.some((x) => x.id === cleaned.id);
  tiles = exists ? tiles.map((x) => (x.id === cleaned.id ? cleaned : x)) : [...tiles, cleaned];
  await persistTiles();
  renderGrid();
  closeModal();
}

// ---------- 削除確認 ----------
function openConfirmDelete(id) {
  confirmDeleteId = id;
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">このボタンを削除しますか？この操作は取り消せません。</p>
    <div class="modal-actions"><button class="btn default" id="cancelDel">キャンセル</button><button class="btn danger" id="confirmDel">削除する</button></div>
  `;
  document.getElementById("cancelDel").addEventListener("click", closeModal);
  document.getElementById("confirmDel").addEventListener("click", async () => {
    tiles = tiles.filter((x) => x.id !== confirmDeleteId);
    await persistTiles();
    renderGrid();
    closeModal();
  });
  overlayEl.classList.add("show");
}

// ---------- 電源操作の確認 ----------
function openConfirmPower(action) {
  const isShutdown = action === "shutdown";
  const isRestart = action === "restart";
  const message = isShutdown
    ? "本当にPCをシャットダウンしますか？保存していない作業は失われます。"
    : isRestart
    ? "本当にPCを再起動しますか？保存していない作業は失われます。"
    : "PCをスリープさせますか？";
  const btnLabel = isShutdown ? "シャットダウンする" : isRestart ? "再起動する" : "スリープする";
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">${message}</p>
    <div class="modal-actions"><button class="btn default" id="cancelPower">キャンセル</button><button class="btn danger" id="confirmPower">${btnLabel}</button></div>
  `;
  document.getElementById("cancelPower").addEventListener("click", closeModal);
  document.getElementById("confirmPower").addEventListener("click", async () => {
    closeModal();
    const err = await window.api.setPowerAction(action);
    if (err) showToast(err);
  });
  overlayEl.classList.add("show");
}

// 背景（暗い部分）をクリックしたときだけ閉じる。ただし「押した位置」も「離した位置」も背景のときだけ。
// 入力欄の文字をドラッグして選択し、背景側でマウスを離したときや、スクロールバーをドラッグして
// 背景側で離したときも、ブラウザは「背景のクリック」として扱うため、
// 編集中の画面が突然閉じてメイン画面に戻ってしまっていた。
function closeOnBackdropClick(overlay, closeFn) {
  let pressedOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => { pressedOnBackdrop = e.target === overlay; });
  overlay.addEventListener("click", (e) => {
    const shouldClose = e.target === overlay && pressedOnBackdrop;
    pressedOnBackdrop = false;
    if (shouldClose) closeFn();
  });
}
closeOnBackdropClick(overlayEl, closeModal);

// ---------- 「種類」選択ダイアログ ----------
// ボタンの種類が増えてきたため、一覧をボタン列で並べる代わりに、
// トリガーボタンを押すとこのダイアログが開き、リストから1つ選ぶ形にしている。
// 現在選択中の種類にはチェックマークを付ける。
let typeSelectOnPick = null;
function openTypeSelect(keys, currentKey, onPick) {
  typeSelectOnPick = onPick;
  typeSelectListEl.innerHTML = "";
  keys.forEach((key) => {
    const item = document.createElement("div");
    const isActive = key === currentKey;
    item.className = "type-select-item" + (isActive ? " active" : "");
    item.innerHTML = `<span class="type-select-check">${isActive ? "✓" : ""}</span><span>${escapeHtml(TYPE_META[key].label)}</span>`;
    item.addEventListener("click", () => {
      const pick = typeSelectOnPick;
      closeTypeSelect();
      if (!isActive && pick) pick(key);
    });
    typeSelectListEl.appendChild(item);
  });
  typeSelectOverlayEl.classList.add("show");
}
function closeTypeSelect() {
  typeSelectOverlayEl.classList.remove("show");
  typeSelectOnPick = null;
}
typeSelectCancelBtn.addEventListener("click", closeTypeSelect);
closeOnBackdropClick(typeSelectOverlayEl, closeTypeSelect);
// ボタンの追加・編集モーダルが開いているときは、Enterキーでも「保存」できるようにする。
// ・複数行入力中（テキストエリア）はEnterで改行できるよう対象から外す。
// ・ショートカットキー記録中は、記録用のキー入力（キャプチャフェーズで先に処理される）を
//   優先させるため、こちらは何もしない。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  // 日本語入力の「変換の確定」のEnterでは保存しない（確定のつもりが保存・終了になってしまうため）
  if (e.isComposing || e.keyCode === 229) return;
  if (!overlayEl.classList.contains("show")) return;
  if (recordingHotkey) return;
  if (e.target && e.target.tagName === "TEXTAREA") return;
  // マルチ操作の各動作欄（リンクのURLなど）でのEnterでは保存しない。
  // 動作を1つずつ入力している途中で、編集画面が閉じてしまわないようにするため。
  if (e.target && e.target.closest && e.target.closest(".multi-sub-row")) return;
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) { e.preventDefault(); saveBtn.click(); }
}, true);

// ---------- 矢印キーでサブページ切り替え ----------
// ←/→ で前後のサブページへ。入力欄・ホットキー記録中・モーダル/設定が開いている間は何もしない。
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.isComposing) return;
  if (recordingHotkey) return;
  if (overlayEl.classList.contains("show") || settingsOverlayEl.classList.contains("show")) return;
  if (document.body.classList.contains("global-busy")) return;
  const t = e.target;
  if (t && (t.isContentEditable || (t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
  if (lastTotalPages <= 1) return;
  const next = e.key === "ArrowLeft" ? Math.max(0, currentPage - 1) : Math.min(lastTotalPages - 1, currentPage + 1);
  if (next === currentPage) return;
  e.preventDefault();
  currentPage = next;
  renderGrid();
});

// ---------- インポート確認 ----------
function openConfirmImport(data) {
  const count = Array.isArray(data.tiles) ? data.tiles.length : 0;
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">現在登録されているボタン（${tiles.length}個）を、バックアップの内容（${count}個）で上書きします。よろしいですか？</p>
    <div class="modal-actions"><button class="btn default" id="cancelImport">キャンセル</button><button class="btn danger" id="confirmImport">上書きする</button></div>
  `;
  document.getElementById("cancelImport").addEventListener("click", closeModal);
  document.getElementById("confirmImport").addEventListener("click", async () => {
    tiles = Array.isArray(data.tiles) ? data.tiles : [];
    // 同じショートカットキーは1つのボタンにしか設定できないため、バックアップ内で重なっている場合は後のものを未設定にする
    const seenHotkeys = new Set();
    let clearedDup = 0;
    tiles.forEach((t) => {
      if (!t || !t.hotkey) return;
      if (seenHotkeys.has(t.hotkey)) { t.hotkey = ""; clearedDup++; } else seenHotkeys.add(t.hotkey);
    });
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    await persistTiles();
    await persistSettings();
    currentPage = 0;
    activePage = WINDOW_PAGE_INDEX; // このページ自体がインポート後に無くなっていればclampActivePage()で自動的に閉じる
    closeModal();
    renderGrid();
    renderSettingsPanel();
    showToast(clearedDup ? `バックアップを読み込みました（重なっていたショートカットキー${clearedDup}個は未設定にしました）` : "バックアップを読み込みました");
  });
  overlayEl.classList.add("show");
}

// ---------- 画面単体のバックアップの読み込み ----------
// 読み込んだボタンを「いま開いている画面」に入れるための整形（他の画面のボタンは触らない）。
// ・IDが他の画面のボタンと重なるものは振り直す（同じ端末の別画面のバックアップを読み込んだ場合など）
// ・ショートカットキーが他の画面のボタンと重なるものは未設定にする（同じキーは2つ登録できないため）
// ・存在しない画面を指す「画面切り替え」は未設定にする
function buildImportedPageTiles(incoming, otherTiles, pageIndex, pageCount) {
  const usedIds = new Set(otherTiles.map((t) => t.id));
  const usedHotkeys = new Set(otherTiles.map((t) => t.hotkey).filter(Boolean));
  const fixTarget = (p) => (typeof p === "number" && p >= pageCount ? null : p);
  let clearedHotkeys = 0;
  const list = incoming.slice(0, 64).map((raw) => {
    const t = { ...raw, pageIndex };
    if (typeof t.id !== "string" || !t.id || usedIds.has(t.id)) t.id = uid();
    usedIds.add(t.id);
    if (t.hotkey) {
      if (usedHotkeys.has(t.hotkey)) { t.hotkey = ""; clearedHotkeys++; }
      else usedHotkeys.add(t.hotkey);
    }
    if ("targetPage" in t) t.targetPage = fixTarget(t.targetPage);
    if (Array.isArray(t.subActions)) {
      t.subActions = t.subActions.map((sub) => (sub && typeof sub === "object" && "targetPage" in sub ? { ...sub, targetPage: fixTarget(sub.targetPage) } : sub));
    }
    return t;
  });
  return { tiles: list, clearedHotkeys, cutOff: Math.max(0, incoming.length - 64) };
}
function openConfirmImportPage(data) {
  const incoming = (Array.isArray(data.tiles) ? data.tiles : []).filter((t) => t && typeof t === "object");
  const currentCount = tiles.filter((t) => (t.pageIndex || 0) === WINDOW_PAGE_INDEX).length;
  const label = settings.pageCount > 1 ? `画面${WINDOW_PAGE_INDEX + 1}` : "この画面";
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">${label}の現在のボタン（${currentCount}個）と設定を、バックアップの内容（ボタン${incoming.length}個）で上書きします。他の画面は変わりません。よろしいですか？</p>
    <div class="modal-actions"><button class="btn default" id="cancelImportPage">キャンセル</button><button class="btn danger" id="confirmImportPage">上書きする</button></div>
  `;
  document.getElementById("cancelImportPage").addEventListener("click", closeModal);
  document.getElementById("confirmImportPage").addEventListener("click", async () => {
    const otherTiles = tiles.filter((t) => (t.pageIndex || 0) !== WINDOW_PAGE_INDEX);
    const built = buildImportedPageTiles(incoming, otherTiles, WINDOW_PAGE_INDEX, settings.pageCount);
    tiles = [...otherTiles, ...built.tiles];
    // 画面ごとの設定（バックアップに含まれているものだけ）を、この画面へ反映する
    const pt = currentPageTheme();
    const defaults = pageSettingDefaults();
    const ps = data.pageSettings && typeof data.pageSettings === "object" ? data.pageSettings : {};
    PAGE_SETTING_KEYS.forEach((k) => { if (ps[k] !== undefined) pt[k] = sanitizePageSetting(k, ps[k], defaults[k]); });
    if (!ICON_SIZE_KEYS.includes(pt.iconSize)) pt.iconSize = defaults.iconSize;
    currentPage = 0;
    lastClampNotice = null;
    await persistTiles();
    await persistSettings();
    closeModal();
    renderGrid();
    renderSettingsPanel();
    let msg = `${label}のバックアップを読み込みました`;
    if (built.clearedHotkeys) msg += `（他の画面と重なるショートカットキー${built.clearedHotkeys}個は未設定にしました）`;
    if (built.cutOff) msg += `（1画面の上限64個を超えた${built.cutOff}個は読み込んでいません）`;
    showToast(msg);
  });
  overlayEl.classList.add("show");
}

// ---------- プリセット適用確認 ----------
function openConfirmPreset(preset) {
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">プリセット「${escapeHtml(preset.name)}」（${preset.rows}行×${preset.columns}列）を${settings.pageCount > 1 ? `画面${WINDOW_PAGE_INDEX + 1}に` : ""}適用しますか？ウィンドウのサイズが自動的に変更されます。</p>
    <div class="modal-actions"><button class="btn default" id="cancelPreset">キャンセル</button><button class="btn primary" id="confirmPreset">適用する</button></div>
  `;
  document.getElementById("cancelPreset").addEventListener("click", closeModal);
  document.getElementById("confirmPreset").addEventListener("click", async () => {
    const pgLayout = currentPageTheme();
    pgLayout.gridColumns = preset.columns;
    pgLayout.gridRows = preset.rows;
    currentPage = 0;
    lastClampNotice = null;
    await persistSettings();
    applyPresetWindowSize(preset);
    closeModal();
    renderGrid();
    renderSettingsPanel();
  });
  overlayEl.classList.add("show");
}

// ---------- 設定パネル ----------
function openSettingsPanel() { renderSettingsPanel(); settingsOverlayEl.classList.add("show"); }
function closeSettingsPanel() { settingsOverlayEl.classList.remove("show"); }
closeOnBackdropClick(settingsOverlayEl, closeSettingsPanel);
hamburgerBtn.addEventListener("click", openSettingsPanel);
document.getElementById("closeSettingsBtn").addEventListener("click", closeSettingsPanel);

const PEEK_DURATION_MS = 550; // レイアウト・表示系の設定を変えたときに裏のアイコンを確認できる時間
let peekTimer = null;
function peekBehindPanel(duration = PEEK_DURATION_MS) {
  settingsOverlayEl.classList.add("peeking");
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { settingsOverlayEl.classList.remove("peeking"); }, duration);
}

// 「画像背景」を押したがまだ画像が決まっていない間、ファイル/画面キャプチャの選択欄を出しておくためのフラグ
let bgPickerOpen = false;
// 設定パネルの「挙動」「見た目」セクションの開閉状態（既定は開いた状態。
// アプリ再起動でリセットされる程度の一時的な状態なので設定ファイルには保存しない）
const settingsSectionOpen = { behavior: true, appearance: true };
function renderSettingsPanel() {
  // 複数画面あるときは、画面ごとに独立している項目の見出しに「（画面Nのみ）」を付ける。
  const scope = settings.pageCount > 1 ? `（画面${WINDOW_PAGE_INDEX + 1}のみ）` : "";
  const pt = currentPageTheme();
  settingsBodyEl.innerHTML = `
    <h2 style="font-size:17px;font-weight:700;margin-bottom:16px;">設定</h2>
    <div class="settings-section">
      <div class="toggle-row"><span>タイトル（Launch-K）を表示</span><input type="checkbox" id="showTitleChk" ${settings.showTitle === true ? "checked" : ""} /></div>
      <div class="toggle-row"><span>Windows起動時に自動起動</span><input type="checkbox" id="loginChk" ${settings.launchAtLogin ? "checked" : ""} /></div>
    </div>
    <div class="settings-section">
      <h3>画面切替</h3>
      <div class="page-tabs" id="settingsPageTabs" style="${settings.pageCount <= 1 ? "display:none;" : ""}"></div>
      <div class="path-preview" style="margin-top:${settings.pageCount <= 1 ? "0" : "8px"};margin-bottom:8px;">現在 ${settings.pageCount} / 最大${MAX_PAGE_COUNT}画面（1画面max64ボタン）。番号をクリックすると、別ウィンドウとして開きます。</div>
      <div style="display:flex;gap:8px;">
        <button class="btn default${settings.pageCount >= MAX_PAGE_COUNT ? " at-max" : ""}" id="addPageBtn">＋画面を追加</button>
        <button class="btn default" id="removePageBtn" ${settings.pageCount <= 1 ? "disabled" : ""}>－画面を削除</button>
      </div>
    </div>
    <div class="settings-section">
      <h3>レイアウト${scope}</h3>
      <div class="field-label">行数</div>
      <div class="type-row" id="rowsRow"></div>
      <div class="field-label">列数</div>
      <div class="type-row" id="columnsRow"></div>
      <div class="path-preview" style="margin-top:0;">行列数は、1ページにつきそれぞれ最大8まで設定できます。</div>
      <div class="field-label" style="margin-top:14px;">プリセット</div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input type="text" id="presetNameInput" placeholder="プリセット名" style="flex:1;background:var(--panel-alt);border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text);font-size:12px;" />
        <button class="btn default" id="savePresetBtn">現在の形で保存</button>
      </div>
      <div class="type-row" id="presetRow"></div>
      <div class="path-preview" id="presetHint"></div>
    </div>
    <div class="settings-section">
      <div class="icon-group-header" id="behaviorSectionHeader">
        <span>挙動${scope}</span>
        <span class="icon-group-caret${settingsSectionOpen.behavior ? " open" : ""}">▾</span>
      </div>
      <div class="icon-group-body" id="behaviorSectionBody" style="${settingsSectionOpen.behavior ? "" : "display:none;"}">
        <div class="toggle-row"><span>ボタンに名前を表示</span><input type="checkbox" id="showNameChk" ${pt.showNameLabel ? "checked" : ""} /></div>
        <div class="toggle-row"><span>ボタンにショートカットキーを表示</span><input type="checkbox" id="showHotkeyChk" ${pt.showHotkeyLabel ? "checked" : ""} /></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="icon-group-header" id="appearanceSectionHeader">
        <span>見た目${scope}</span>
        <span class="icon-group-caret${settingsSectionOpen.appearance ? " open" : ""}">▾</span>
      </div>
      <div class="icon-group-body" id="appearanceSectionBody" style="${settingsSectionOpen.appearance ? "" : "display:none;"}">
        <div class="toggle-row"><span>ボタンに影を付ける</span><input type="checkbox" id="showShadowsChk" ${pt.showShadows !== false ? "checked" : ""} /></div>
        <div class="field-label" style="margin-top:10px;">アイコンボタン裏の枠の透明度</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="range" id="panelOpacitySlider" min="0" max="100" step="1" value="${Math.round(currentPanelOpacity() * 100)}" style="flex:1;" />
          <span id="panelOpacityValue" class="path-preview" style="margin:0;width:44px;text-align:right;">${Math.round(currentPanelOpacity() * 100)}%</span>
        </div>
        <div class="field-label" style="margin-top:10px;">ボタンのアイコンの大きさ</div>
        <div class="type-row" id="iconSizeRow"></div>
        <div class="toggle-row" style="margin-top:10px;"><span>アイコンの周りに囲み線を表示</span><input type="checkbox" id="iconRingChk" ${pt.iconRingEnabled ? "checked" : ""} /></div>
        <div class="path-preview" style="margin-top:0;">背景が画像などのとき、アイコンを見分けやすくするための細い線です。</div>
        <div id="iconRingBrightnessWrap" style="${pt.iconRingEnabled ? "" : "display:none;"}">
          <div class="field-label" style="margin-top:6px;">囲み線の明暗度（黒〜白）</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="range" id="iconRingBrightnessSlider" min="0" max="100" step="1" value="${typeof pt.iconRingBrightness === "number" ? pt.iconRingBrightness : 55}" style="flex:1;" />
            <span id="iconRingBrightnessValue" class="path-preview" style="margin:0;width:44px;text-align:right;">${typeof pt.iconRingBrightness === "number" ? pt.iconRingBrightness : 55}%</span>
          </div>
        </div>
      </div>
    </div>
    <div class="settings-section"><h3>テーマ${settings.pageCount > 1 ? `（画面${WINDOW_PAGE_INDEX + 1}のみ）` : ""}</h3><div class="theme-row" id="themeRow"></div><div id="themeExtra"></div></div>
    <div class="settings-section"><h3>アクセントカラー${scope}</h3><div class="color-row" id="accentRow"></div></div>
    <div class="settings-section">
      <h3>OBS連携</h3>
      <div class="path-preview" style="margin-top:0;">OBS側で「ツール → WebSocketサーバー設定」を開き、サーバーを有効にした上で、同じ接続先をここに登録してください。</div>
      <div class="field-label">ホスト</div>
      <input type="text" id="obsHostInput" placeholder="127.0.0.1" value="${escapeHtml(settings.obsHost || "")}" />
      <div class="field-label">ポート</div>
      <input type="text" id="obsPortInput" placeholder="4455" value="${escapeHtml(String(settings.obsPort ?? ""))}" />
      <div class="field-label">パスワード（設定している場合のみ）</div>
      <input type="password" id="obsPasswordInput" placeholder="未設定なら空欄のまま" value="${escapeHtml(settings.obsPassword || "")}" />
    </div>
    <div class="settings-section">
      <h3>バックアップ</h3>
      <div class="field-label">全体（すべてのLaunch-K画面）</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button class="btn default" id="exportBtn">エクスポート</button>
        <button class="btn default" id="importBtn">インポート</button>
      </div>
      <div class="field-label">${settings.pageCount > 1 ? `画面${WINDOW_PAGE_INDEX + 1}` : "この画面"}だけ</div>
      <div style="display:flex;gap:8px;">
        <button class="btn default" id="exportPageBtn">エクスポート</button>
        <button class="btn default" id="importPageBtn">インポート</button>
      </div>
      <div class="path-preview" style="margin-top:8px;margin-bottom:0;">画面だけのバックアップは、その画面のボタンと画面ごとの設定（レイアウト・表示・テーマなど）を保存します。読み込むと、いま開いている画面だけが上書きされ、他の画面は変わりません。</div>
    </div>
    <div id="linksSection"></div>
    <div class="settings-section">
      <h3 style="color:#FF6B5E;">危険な操作</h3>
      <button class="btn danger" id="resetAllBtn" style="width:100%;">すべて初期化する</button>
      <div class="path-preview" style="margin-top:8px;margin-bottom:0;">追加したすべてのボタン・操作・ショートカットキー・見た目の設定を、すべて設定前の初期状態に戻します。元に戻せません。</div>
    </div>
  `;

  document.getElementById("behaviorSectionHeader").addEventListener("click", () => {
    settingsSectionOpen.behavior = !settingsSectionOpen.behavior;
    renderSettingsPanel();
  });
  document.getElementById("appearanceSectionHeader").addEventListener("click", () => {
    settingsSectionOpen.appearance = !settingsSectionOpen.appearance;
    renderSettingsPanel();
  });

  const themeRow = document.getElementById("themeRow");
  Object.keys(THEME_LABELS).forEach((key) => {
    const preset = THEME_PRESETS[key];
    const sw = document.createElement("div");
    sw.className = "theme-swatch" + (pt.themeMode === key ? " active" : "");
    sw.style.background = preset.bg1;
    sw.title = THEME_LABELS[key];
    sw.addEventListener("click", async () => { bgPickerOpen = false; currentPageTheme().themeMode = key; await persistSettings(); renderSettingsPanel(); });
    themeRow.appendChild(sw);
  });
  const customBtn = document.createElement("div");
  customBtn.className = "theme-swatch" + (pt.themeMode === "custom" ? " active" : "");
  customBtn.title = "カスタム";
  customBtn.style.background = pt.themeMode === "custom" && pt.customColor
    ? pt.customColor
    : "conic-gradient(red, orange, yellow, green, blue, violet, red)";
  customBtn.addEventListener("click", async () => { bgPickerOpen = false; currentPageTheme().themeMode = "custom"; await persistSettings(); renderSettingsPanel(); });
  const imageBtn = document.createElement("div");
  imageBtn.className = "opt-btn" + (pt.themeMode === "image" ? " active" : "");
  imageBtn.textContent = "画像背景";
  imageBtn.addEventListener("click", async () => {
    // すでに背景画像があればそのまま画像背景に切り替える。まだなければ、下に
    // 「ファイルから選ぶ／画面を撮る」を出す（画像が決まるまでテーマは変えない）。
    if (pt.bgImagePath) { currentPageTheme().themeMode = "image"; await persistSettings(); }
    else bgPickerOpen = true;
    renderSettingsPanel();
  });
  const extraRow = document.createElement("div");
  extraRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;";
  extraRow.appendChild(customBtn);
  extraRow.appendChild(imageBtn);
  themeRow.after(extraRow);

  const themeExtra = document.getElementById("themeExtra");
  if (pt.themeMode === "custom") {
    themeExtra.innerHTML = `<div style="margin-top:6px;"><input type="color" id="customColorInput" value="${safeColor(pt.customColor)}" style="width:60px;height:32px;border:none;background:none;cursor:pointer;" /></div>`;
    document.getElementById("customColorInput").addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
    document.getElementById("customColorInput").addEventListener("input", (e) => {
      // ドラッグ中に毎回保存すると、その都度メインプロセスへ設定が送られてロック
      // （常に最前面）が再適用され、まだ開いているポップアップが裏に隠れてしまうため、
      // ドラッグ中は画面だけその場でプレビュー更新し、保存は確定時（change）にまとめて行う。
      currentPageTheme().customColor = e.target.value;
      applyTheme();
    });
    document.getElementById("customColorInput").addEventListener("change", async (e) => {
      currentPageTheme().customColor = e.target.value;
      await persistSettings();
    });
  } else if (pt.themeMode === "image" || bgPickerOpen) {
    const hasBg = !!pt.bgImagePath;
    const brightnessPct = Math.round(((typeof pt.bgImageBrightness === "number" ? pt.bgImageBrightness : 1)) * 100);
    themeExtra.innerHTML = `
      ${hasBg ? `<div class="path-preview" style="margin-top:10px;">背景：${escapeHtml(pt.bgImagePath)}</div>` : ""}
      <div style="display:flex;gap:8px;margin-top:${hasBg ? 0 : 10}px;">
        <div class="file-pick-btn" id="bgPickFileBtn" style="flex:1;justify-content:center;margin-bottom:6px;">📁 ${hasBg ? "別のファイルを選ぶ" : "ファイルから選ぶ"}</div>
        <div class="file-pick-btn" id="bgCaptureBtn" style="flex:1;justify-content:center;margin-bottom:6px;">📸 ${hasBg ? "画面を撮り直す" : "画面を撮る"}</div>
      </div>
      ${hasBg ? `<div class="field-label" style="margin-top:8px;">表示方法</div><div class="type-row" id="bgFitRow"></div>` : ""}
      ${hasBg ? `
      <div class="field-label" style="margin-top:10px;">背景画像の明るさ（標準100%）</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <input type="range" id="bgBrightnessSlider" min="30" max="170" step="1" value="${brightnessPct}" style="flex:1;" />
        <span id="bgBrightnessValue" class="path-preview" style="margin:0;width:44px;text-align:right;">${brightnessPct}%</span>
      </div>
      <div class="field-label" style="margin-top:10px;">アイコンボタン裏の枠の色（背景が画像時のみ）</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="color" id="panelColorOverrideInput" value="${pt.panelColorOverride || "#262B35"}" style="width:44px;height:32px;border:none;background:none;cursor:pointer;" />
        <button class="btn default" id="panelColorOverrideResetBtn">既定に戻す</button>
      </div>
      <div class="path-preview" style="margin-top:0;">透明度は上の「見た目」欄の「アイコンボタン裏の枠の透明度」と共通です。</div>
      ` : ""}
    `;
    const applyBg = async (path) => {
      currentPageTheme().bgImagePath = path; currentPageTheme().themeMode = "image"; bgPickerOpen = false;
      await persistSettings(); renderSettingsPanel();
    };
    document.getElementById("bgPickFileBtn").addEventListener("click", async () => {
      const picked = await window.api.pickFile([{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp"] }]);
      if (picked) await applyBg(picked);
    });
    document.getElementById("bgCaptureBtn").addEventListener("click", async () => {
      const res = await window.api.captureScreen("background");
      if (!res) return; // 範囲選択をキャンセル
      if (res.error) return showToast(res.error);
      await applyBg(res.path);
    });
    if (hasBg) {
      const bgFitRow = document.getElementById("bgFitRow");
      [{ key: "cover", label: "画面に合わせる" }, { key: "contain", label: "全体を表示" }, { key: "repeat", label: "タイル状に繰り返す" }].forEach((opt) => {
        const b = document.createElement("div");
        b.className = "opt-btn" + (pt.bgImageFit === opt.key ? " active" : "");
        b.textContent = opt.label;
        b.addEventListener("click", async () => { currentPageTheme().bgImageFit = opt.key; await persistSettings(); renderSettingsPanel(); });
        bgFitRow.appendChild(b);
      });
      const bgBrightnessSlider = document.getElementById("bgBrightnessSlider");
      bgBrightnessSlider.addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
      bgBrightnessSlider.addEventListener("input", (e) => {
        const v = Number(e.target.value);
        document.getElementById("bgBrightnessValue").textContent = v + "%";
        currentPageTheme().bgImageBrightness = v / 100;
        applyTheme();
      });
      bgBrightnessSlider.addEventListener("change", async (e) => {
        currentPageTheme().bgImageBrightness = Number(e.target.value) / 100;
        await persistSettings();
      });
      document.getElementById("panelColorOverrideInput").addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
      document.getElementById("panelColorOverrideInput").addEventListener("input", (e) => {
        currentPageTheme().panelColorOverride = e.target.value;
        applyTheme();
      });
      document.getElementById("panelColorOverrideInput").addEventListener("change", async (e) => {
        currentPageTheme().panelColorOverride = e.target.value;
        await persistSettings();
      });
      document.getElementById("panelColorOverrideResetBtn").addEventListener("click", async () => {
        currentPageTheme().panelColorOverride = "";
        await persistSettings();
        renderSettingsPanel();
      });
    }
  }

  const iconSizeRow = document.getElementById("iconSizeRow");
  const currentIconSize = ICON_SIZE_KEYS.includes(pt.iconSize) ? pt.iconSize : "large";
  [{ key: "large", label: "大" }, { key: "medium", label: "中" }, { key: "small", label: "小" }].forEach((opt) => {
    const b = document.createElement("div");
    b.className = "opt-btn" + (currentIconSize === opt.key ? " active" : "");
    b.textContent = opt.label;
    b.addEventListener("click", async () => {
      if (pt.iconSize === opt.key) return;
      currentPageTheme().iconSize = opt.key;
      await persistSettings();
      renderGrid();
      renderSettingsPanel();
      peekBehindPanel();
    });
    iconSizeRow.appendChild(b);
  });

  const accentRow = document.getElementById("accentRow");
  buildColorRow(accentRow, pt.accent, (c, committed) => {
    currentPageTheme().accent = c;
    if (committed) {
      persistSettings().then(() => renderSettingsPanel());
    } else {
      // ドラッグ中に毎回保存すると、その都度ロック（常に最前面）が再適用され、
      // まだ開いているネイティブの色選択ポップアップが裏に隠れてしまうため、
      // ドラッグ中は画面だけその場でプレビュー更新し、保存は確定時（change）にまとめて行う。
      applyTheme();
    }
  });

  const rowsRow = document.getElementById("rowsRow");
  buildDimensionSpinner(rowsRow, "gridRows", 1, 8);

  const columnsRow = document.getElementById("columnsRow");
  buildDimensionSpinner(columnsRow, "gridColumns", 1, 8);

  // ---- プリセット ----
  const presetRow = document.getElementById("presetRow");
  const presetHint = document.getElementById("presetHint");
  const isFixedLayout = pt.gridColumns !== "auto" && pt.gridRows !== "auto";
  presetHint.textContent = isFixedLayout
    ? ""
    : "※ 行数・列数を「自動」以外に固定すると、プリセットとして保存できます。";

  RECOMMENDED_PRESETS.filter((preset) => !(settings.dismissedPresetNames || []).includes(preset.name)).forEach((preset) => {
    const b = document.createElement("div");
    b.className = "opt-btn";
    b.style.position = "relative";
    b.style.paddingRight = "22px";
    b.textContent = `⭐ ${preset.name}（${preset.rows}×${preset.columns}）`;
    b.addEventListener("click", () => openConfirmPreset(preset));
    const del = document.createElement("span");
    del.textContent = "×";
    del.style.cssText = "position:absolute;right:6px;top:50%;transform:translateY(-50%);color:#FF6B5E;cursor:pointer;";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      settings.dismissedPresetNames = [...(settings.dismissedPresetNames || []), preset.name];
      await persistSettings();
      renderSettingsPanel();
    });
    b.appendChild(del);
    presetRow.appendChild(b);
  });

  (settings.presets || []).forEach((preset, idx) => {
    const b = document.createElement("div");
    b.className = "opt-btn";
    b.style.position = "relative";
    b.style.paddingRight = "22px";
    b.textContent = `${preset.name}（${preset.rows}×${preset.columns}）`;
    b.addEventListener("click", () => openConfirmPreset(preset));
    const del = document.createElement("span");
    del.textContent = "×";
    del.style.cssText = "position:absolute;right:6px;top:50%;transform:translateY(-50%);color:#FF6B5E;cursor:pointer;";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      settings.presets = settings.presets.filter((_, i) => i !== idx);
      await persistSettings();
      renderSettingsPanel();
    });
    b.appendChild(del);
    presetRow.appendChild(b);
  });

  document.getElementById("savePresetBtn").addEventListener("click", async () => {
    if (!isFixedLayout) { showToast("先に行数・列数を固定してください"); return; }
    const nameInput = document.getElementById("presetNameInput");
    const layoutNow = currentPageTheme();
    const name = nameInput.value.trim() || `${layoutNow.gridRows}×${layoutNow.gridColumns}`;
    settings.presets = [...(settings.presets || []), { name, rows: layoutNow.gridRows, columns: layoutNow.gridColumns }];
    await persistSettings();
    renderSettingsPanel();
  });

  document.getElementById("showTitleChk").addEventListener("change", async (e) => { settings.showTitle = e.target.checked; await persistSettings(); renderGrid(); peekBehindPanel(); });
  document.getElementById("showNameChk").addEventListener("change", async (e) => { currentPageTheme().showNameLabel = e.target.checked; await persistSettings(); renderGrid(); peekBehindPanel(); });
  document.getElementById("showHotkeyChk").addEventListener("change", async (e) => { currentPageTheme().showHotkeyLabel = e.target.checked; await persistSettings(); renderGrid(); peekBehindPanel(); });
  document.getElementById("loginChk").addEventListener("change", async (e) => { settings.launchAtLogin = e.target.checked; await persistSettings(); });
  document.getElementById("showShadowsChk").addEventListener("change", async (e) => { currentPageTheme().showShadows = e.target.checked; await persistSettings(); });
  document.getElementById("iconRingChk").addEventListener("change", async (e) => {
    currentPageTheme().iconRingEnabled = e.target.checked;
    await persistSettings();
    renderSettingsPanel();
  });
  const iconRingBrightnessSlider = document.getElementById("iconRingBrightnessSlider");
  if (iconRingBrightnessSlider) {
    iconRingBrightnessSlider.addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
    iconRingBrightnessSlider.addEventListener("input", (e) => {
      const v = Number(e.target.value);
      document.getElementById("iconRingBrightnessValue").textContent = v + "%";
      currentPageTheme().iconRingBrightness = v;
      applyTheme();
    });
    iconRingBrightnessSlider.addEventListener("change", async (e) => {
      currentPageTheme().iconRingBrightness = Number(e.target.value);
      await persistSettings();
    });
  }
  document.getElementById("panelOpacitySlider").addEventListener("mousedown", () => window.api.suspendAlwaysOnTop());
  document.getElementById("panelOpacitySlider").addEventListener("input", (e) => {
    // ドラッグ中に毎回保存すると常に最前面設定が再適用されてしまうため、ドラッグ中は
    // プレビューのみ更新し、確定時（change）にまとめて保存する。
    const v = Number(e.target.value);
    document.getElementById("panelOpacityValue").textContent = v + "%";
    currentPageTheme().panelOpacity = v / 100;
    applyTheme();
  });
  document.getElementById("panelOpacitySlider").addEventListener("change", async (e) => {
    currentPageTheme().panelOpacity = Number(e.target.value) / 100;
    await persistSettings();
  });

  document.getElementById("obsHostInput").addEventListener("change", async (e) => { settings.obsHost = e.target.value.trim() || "127.0.0.1"; await persistSettings(); });
  document.getElementById("obsPortInput").addEventListener("change", async (e) => { settings.obsPort = Number(e.target.value) || 4455; await persistSettings(); });
  document.getElementById("obsPasswordInput").addEventListener("change", async (e) => { settings.obsPassword = e.target.value; await persistSettings(); });

  const settingsPageTabsEl = document.getElementById("settingsPageTabs");
  if (settings.pageCount > 1) {
    for (let i = 0; i < settings.pageCount; i++) {
      const b = document.createElement("button");
      b.className = "page-tab" + (WINDOW_PAGE_INDEX === i ? " active" : "");
      b.title = WINDOW_PAGE_INDEX === i ? "このウィンドウが表示中の画面です" : "別画面で開く（既に開いていれば前面に表示）";
      b.textContent = String(i + 1);
      b.addEventListener("click", () => {
        if (WINDOW_PAGE_INDEX === i) return; // 自分自身のページ：何もしない
        // ページの切替は「今のウィンドウの中身を差し替える」のではなく、
        // 対象ページを別画面（別ウィンドウ）として開く（既に開いていれば前面に出すだけ）。
        window.api.openPage(i);
      });
      settingsPageTabsEl.appendChild(b);
    }
  }

  document.getElementById("addPageBtn").addEventListener("click", async () => {
    if (settings.pageCount >= MAX_PAGE_COUNT) {
      showToast("これ以上画面を追加できません");
      return;
    }
    openNewPageModal();
  });
  document.getElementById("removePageBtn").addEventListener("click", () => {
    if (settings.pageCount <= 1) return;
    openRemovePageModal();
  });

  document.getElementById("exportBtn").addEventListener("click", async () => {
    const err = await window.api.exportBackup({ tiles, settings });
    if (err) showToast(err === "キャンセルされました" ? err : "書き出しに失敗しました：" + err);
    else showToast("バックアップを保存しました");
  });
  document.getElementById("importBtn").addEventListener("click", async () => {
    const result = await window.api.importBackup();
    if (result.error) { if (result.error !== "キャンセルされました") showToast(result.error); return; }
    // 画面単体のバックアップを選んだ場合は、全体を上書きせず、いま開いている画面への読み込みとして確認する
    if (result.data && result.data.kind === "page") { openConfirmImportPage(result.data); return; }
    openConfirmImport(result.data || {});
  });
  document.getElementById("exportPageBtn").addEventListener("click", async () => {
    const pageTiles = tiles.filter((t) => (t.pageIndex || 0) === WINDOW_PAGE_INDEX).map((t) => ({ ...t, pageIndex: 0 }));
    const err = await window.api.exportBackup(
      { kind: "page", tiles: pageTiles, pageSettings: copyPageSettings(currentPageTheme()) },
      `mission-deck-screen${WINDOW_PAGE_INDEX + 1}.json`
    );
    if (err) showToast(err === "キャンセルされました" ? err : "書き出しに失敗しました：" + err);
    else showToast(`画面${WINDOW_PAGE_INDEX + 1}のバックアップを保存しました`);
  });
  document.getElementById("importPageBtn").addEventListener("click", async () => {
    const result = await window.api.importBackup();
    if (result.error) { if (result.error !== "キャンセルされました") showToast(result.error); return; }
    if (!result.data || result.data.kind !== "page") {
      showToast("これは全体のバックアップです。「全体」のインポートから読み込んでください");
      return;
    }
    openConfirmImportPage(result.data);
  });


  const linksSection = document.getElementById("linksSection");
  linksSection.innerHTML = `<div class="link-row" id="guideLink">📖 使い方</div><div class="link-row" id="homepageLink">🏠 かせき-Homepage</div><div class="link-row" id="updateLink">🔄 更新を確認</div><div class="link-row" id="tosLink">📄 利用規約</div>`;
  document.getElementById("guideLink").addEventListener("click", () => window.api.openGuide());
  document.getElementById("homepageLink").addEventListener("click", () => window.api.openExternal("https://kaseki-homepage.vercel.app/"));
  document.getElementById("tosLink").addEventListener("click", renderTosPanel);

  const updateLink = document.getElementById("updateLink");
  const updateLinkLabel = "🔄 更新を確認";
  window.api.getAppVersion().then((v) => { updateLink.textContent = `${updateLinkLabel}（現在 v${v}）`; }).catch(() => {});
  updateLink.addEventListener("click", async () => {
    if (updateLink.dataset.busy) return;
    updateLink.dataset.busy = "1";
    const shownLabel = updateLink.textContent;
    updateLink.textContent = "🔄 確認中…";
    let res;
    try { res = await window.api.checkForUpdates(); } catch (e) { res = { status: "error" }; }
    updateLink.textContent = shownLabel;
    delete updateLink.dataset.busy;
    const messages = {
      latest: `最新のバージョンです（v${res && res.version}）`,
      available: `新しいバージョン v${res && res.version} をダウンロードしています。完了したらお知らせします`,
      downloading: "新しいバージョンをダウンロード中です",
      downloaded: "更新の準備ができています",
      checking: "確認中です",
      dev: "更新の確認はインストール版でのみ使えます",
      unavailable: "更新の確認はいまは使えません",
      error: "更新を確認できませんでした。ネットワーク接続をご確認ください",
    };
    showToast(messages[res && res.status] || messages.error);
  });

  document.getElementById("resetAllBtn").addEventListener("click", openConfirmReset);
}

// ---------- 画面追加：新しい画面の設定の作り方を選ぶ ----------
// 「初期設定」か「既存のいずれかの画面と同じ設定」を選べる。コピーするのは画面ごとの設定
// （レイアウト・表示・影・枠の透明度・アイコンの大きさ・テーマ・アクセントカラー）で、ボタン自体はコピーしない。
function openNewPageModal() {
  let source = String(WINDOW_PAGE_INDEX); // 初期選択は「今開いている画面と同じ」
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:12px;">画面${settings.pageCount + 1}を追加します。設定をどうしますか？</p>
    <div class="type-row" id="newPageSourceRow" style="margin-bottom:8px;"></div>
    <div class="path-preview" style="margin-top:0;margin-bottom:16px;">登録したボタン以外は、すべて同じ設定になります（ボタン自体はコピーされません）。</div>
    <div class="modal-actions"><button class="btn default" id="cancelNewPage">キャンセル</button><button class="btn primary" id="confirmNewPage">追加する</button></div>
  `;
  const row = document.getElementById("newPageSourceRow");
  const renderOptions = () => {
    row.innerHTML = "";
    const options = [{ key: "default", label: "初期設定" }];
    for (let i = 0; i < settings.pageCount; i++) options.push({ key: String(i), label: `画面${i + 1}と同じ` });
    options.forEach((opt) => {
      const b = document.createElement("div");
      b.className = "opt-btn" + (source === opt.key ? " active" : "");
      b.textContent = opt.label;
      b.addEventListener("click", () => { source = opt.key; renderOptions(); });
      row.appendChild(b);
    });
  };
  renderOptions();
  document.getElementById("cancelNewPage").addEventListener("click", closeModal);
  document.getElementById("confirmNewPage").addEventListener("click", async () => {
    if (settings.pageCount >= MAX_PAGE_COUNT) { closeModal(); showToast("これ以上画面を追加できません"); return; }
    ensurePageThemes();
    const newIndex = settings.pageCount;
    // 以前に減らした画面の古い設定が残っていても引き継がないよう、追加のたびに作り直す
    settings.pageThemes[newIndex] = source === "default"
      ? pageSettingDefaults()
      : copyPageSettings(settings.pageThemes[Math.max(0, Math.min(settings.pageCount - 1, Number(source) || 0))]);
    settings.pageCount += 1;
    await persistSettings();
    closeModal();
    renderSettingsPanel();
    renderGrid();
    peekBehindPanel();
    showToast(`画面${settings.pageCount}を追加しました`);
  });
  overlayEl.classList.add("show");
}

// ---------- 画面の削除（どの画面でも選んで削除できる。確認つき） ----------
// 削除した画面より後ろの画面は番号が繰り上がる（例：1〜3の2を削除 → 旧3が新2）。
// 実際の削除・繰り上げ処理はmain.jsの pages:remove で一括して行う。
function openRemovePageModal() {
  let target = WINDOW_PAGE_INDEX; // 初期選択は今開いている画面
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:12px;">削除する画面を選んでください。</p>
    <div class="type-row" id="removePageRow" style="margin-bottom:8px;"></div>
    <div class="path-preview" id="removePageNote" style="margin-top:0;margin-bottom:16px;"></div>
    <div class="modal-actions"><button class="btn default" id="cancelRemovePage">キャンセル</button><button class="btn danger" id="confirmRemovePage">削除する</button></div>
  `;
  const row = document.getElementById("removePageRow");
  const note = document.getElementById("removePageNote");
  const render = () => {
    row.innerHTML = "";
    for (let i = 0; i < settings.pageCount; i++) {
      const b = document.createElement("div");
      b.className = "opt-btn" + (target === i ? " active" : "");
      b.textContent = `画面${i + 1}`;
      b.addEventListener("click", () => { target = i; render(); });
      row.appendChild(b);
    }
    const count = tiles.filter((t) => (t.pageIndex || 0) === target).length;
    note.textContent = `画面${target + 1}と、その画面の設定・登録済みのボタン（${count}個）を削除します。元に戻せません。`;
  };
  render();
  document.getElementById("cancelRemovePage").addEventListener("click", closeModal);
  document.getElementById("confirmRemovePage").addEventListener("click", async () => {
    const res = await window.api.removePage(target);
    closeModal();
    if (res && res.error) { showToast(res.error); return; }
    showToast(`画面${target + 1}を削除しました`);
  });
  overlayEl.classList.add("show");
}

// ---------- 初期化（リセット）確認 ----------
function openConfirmReset() {
  modalBodyEl.innerHTML = `
    <p style="font-size:14px;color:var(--text);margin-bottom:18px;">本当にすべて初期化しますか？<br>追加したボタン・ショートカットキー・見た目の設定がすべて消え、元に戻せません。</p>
    <div class="modal-actions"><button class="btn default" id="cancelReset">キャンセル</button><button class="btn danger" id="confirmReset">初期化する</button></div>
  `;
  document.getElementById("cancelReset").addEventListener("click", closeModal);
  document.getElementById("confirmReset").addEventListener("click", async () => {
    await window.api.resetAll();
    tiles = [];
    settings = { ...DEFAULT_SETTINGS };
    currentPage = 0;
    activePage = WINDOW_PAGE_INDEX; // 初期化でページが1つに戻るため、メイン以外はclampActivePage()で自動的に閉じる
    lastClampNotice = null;
    applyTheme();
    updateLockButton();
    closeModal();
    closeSettingsPanel();
    renderGrid();
    showToast("初期化しました");
  });
  overlayEl.classList.add("show");
}

function renderTosPanel() {
  settingsBodyEl.innerHTML = `
    <div class="back-btn" id="backToSettings">← 戻る</div>
    <h2 style="font-size:17px;font-weight:700;margin-bottom:14px;">利用規約</h2>
    <div class="tos-scroll">
      <h4>1. サービスの内容</h4>
      このアプリは、ユーザーが自由にリンク・サウンド・ファイル・音量操作・電源操作・クリップボードコピーのショートカットを登録し、ワンクリックまたはショートカットキーで実行できる個人用ランチャーツールです。
      <h4>2. リンク先コンテンツについて</h4>
      登録したリンク先ウェブサイトの内容、安全性、合法性、可用性について、運営者は一切の保証をせず、責任を負いません。リンク先で生じたいかなる損害についても自己責任でご対応ください。
      <h4>3. ファイル・電源操作について</h4>
      ファイルを開く機能、および音量・スリープ・シャットダウンなどの操作は、ユーザー自身が設定した内容に基づいて実行されます。誤操作による作業内容の損失等について運営者は責任を負いません。
      <h4>4. データの保存について</h4>
      登録した設定はお使いのパソコン内に保存されます。パソコンの初期化や設定変更等によりデータが消失する可能性があるため、重要な設定はバックアップ機能で別途保管してください。
      <h4>5. 自己責任でのご利用</h4>
      本アプリには、ウィンドウの配置・移動、キー操作の送信、音量・マイクのミュート切替、画面のキャプチャ、複数の動作の自動連続実行など、お使いのパソコンを操作する機能が含まれます。本アプリの利用（設定の誤りや操作ミス、他のソフトウェアとの組み合わせ、パソコンの環境による動作の違いを含みます）により生じた、データの損失、機器の不具合、第三者への損害、情報の漏えい、その他一切の損害・不利益は、すべてユーザー自身の責任とします。ユーザーは、ご自身の判断と責任において本アプリを利用するものとします。ただし、法令により運営者が責任を負う場合は除きます。
      また、画面キャプチャで取得した画像には、個人情報や機密情報が写り込むことがあります。取得・保存・共有は、ご自身の責任で行ってください。
      <h4>6. 免責事項</h4>
      本アプリは現状有姿で提供され、内容の正確性・完全性・特定目的への適合性についていかなる保証も行いません。本アプリの利用により生じたいかなる損害についても、運営者は責任を負いません。
      <div class="tos-copy">© kaseki</div>
    </div>
  `;
  document.getElementById("backToSettings").addEventListener("click", renderSettingsPanel);
}

init();

// ---------- 外部からのドラッグ&ドロップで即タイル化 ----------
// ブラウザのURLやエクスプローラーのファイルをウィンドウにドロップすると、
// 内容を汲み取った状態で追加モーダルを開く（内部の並べ替えドラッグとは
// dragSourceId の有無で区別する）
document.addEventListener("dragover", (e) => {
  if (dragSourceId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", async (e) => {
  if (dragSourceId) return;
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;

  if (dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    const filePath = file.path;
    if (!filePath) { showToast("ファイルのパスを取得できませんでした"); return; }
    const guessedName = file.name.replace(/\.[^./\\]+$/, "").slice(0, 20) || "無題";
    openAddModal();
    modalData.tile.type = "file";
    modalData.tile.filePath = filePath;
    modalData.tile.name = guessedName;
    renderModal();
    return;
  }

  const uri = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").trim();
  if (uri && /^https?:\/\//i.test(uri)) {
    openAddModal();
    modalData.tile.type = "link";
    modalData.tile.url = uri;
    try { modalData.tile.name = new URL(uri).hostname.replace(/^www\./, "").slice(0, 20); } catch (e) {}
    renderModal();
    return;
  }
});
