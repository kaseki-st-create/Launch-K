// ============================================================
// mic-core.js — マイクのミュート操作の「判断だけ」を行う部分（Windowsに依存しない・副作用なし）
//
// メインプロセス（Node）と画面（ブラウザ）の両方から、同じ関数を使う。
// ここでは「COMを呼ぶ」「ファイルを書く」などは一切しない。入力を受け取って、結果を返すだけ。
// （だから、Windows以外でもテストできる）
//
// 安全のための考え方
//  ・「ミュート中」と言い切れるのは、対象のマイクが全部「ミュート中」と確認できたときだけ。
//    取得できなかった（null）ものがあれば、ミュート中とは言わない。
//  ・押したときは、1台でも「開いている／不明」があれば、ミュートする方へ倒す（声が漏れる事故を避ける）。
//  ・デバイスのIDは、外から来た文字列として検査してから使う。
// ============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MicCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Windowsのデバイス状態（DEVICE_STATE_*）
  const STATE = { ACTIVE: 1, DISABLED: 2, NOTPRESENT: 4, UNPLUGGED: 8 };
  // EndpointFormFactor
  const FF = { REMOTE: 0, SPEAKERS: 1, LINE: 2, HEADPHONES: 3, MICROPHONE: 4, HEADSET: 5, HANDSET: 6, PASSTHRU: 7, SPDIF: 8, HDMI: 9, UNKNOWN: 10 };

  const MAX_ID_LEN = 200;
  const MAX_NAME_LEN = 100;
  const MAX_EXCLUDE = 32;

  // 名前から「仮想デバイス・ミキサー」らしいものを見分ける（確実ではない。種類の目安と、まとめてミュートの初期の対象外に使う）
  const VIRTUAL_NAME_RE = /(vb-?audio|voicemeeter|virtual|仮想|cable\s*(in|out|output|input)|stereo\s*mix|ステレオ\s*ミキサー|wave\s*link|loopback|what\s*u\s*hear|obs)/i;
  const BLUETOOTH_CALL_RE = /(hands-?free|ハンズフリー)/i; // Bluetoothヘッドセットの「通話用」の入口は、名前に Hands-Free が付く

  // 内蔵マイク：Windowsは、ノートPCの内蔵マイクを「マイク配列（内蔵向けドライバの長い名前）」などの名前で出す。
  // 画面では、短く「内蔵マイク」と表示する（元の名前は、小さく添える。内部の照合には、元の名前を使い続ける）。
  // 「マイク配列」は、USBのWebカメラや会議用スピーカーフォンなど、外付けの機器にも付く名前なので、
  // 内蔵向けのドライバ名（Intel・Realtekなど）が付いているとき、または名前が「マイク配列」だけのときに限る（外付けを「内蔵」と誤って表示しない）。
  // さらに、Windowsが持っている情報で分かったときは、それを優先する（分からないとき＝bus・machine が null のときは、名前だけで判断する）：
  //  ・USB・Bluetoothの機器だと分かったら、名前が何であっても「内蔵」にしない。
  //  ・名前が「マイク配列」だけのときは、容器IDが本体の値（machine=true）と分かった場合だけ「内蔵」にする（machine=false なら「内蔵」にしない）。
  // 名前に当てはまらないマイクを、容器IDだけで「内蔵」と推測することはしない（イヤホン端子に挿した外付けマイクを、誤って「内蔵」と出さないため）。
  const EXPLICIT_INTERNAL_RE = /^\s*(内蔵マイク|internal mic|built-?in mic)/i;
  const ARRAY_NAME_RE = /^\s*(マイク配列|microphone array)\s*(?:[（(]((?:[^（()）]|[（(][^（()）]*[）)])*)[）)])?\s*$/i; // かっこの中に、(R) や (TM) のような小さなかっこが何個あってもよい
  const INTERNAL_ADAPTER_RE = /(intel|インテル|realtek|amd|qualcomm|snapdragon|conexant|synaptics|cirrus|smart ?sound|スマート・?サウンド|high ?definition|ハイ ?デフィニション)/i;
  const EXTERNAL_HINT_RE = /(usb|bluetooth|webcam|camera|カメラ|kinect|jabra|logitech|yealink|poly|anker|speak|conference|会議)/i;
  function isInternal(d) {
    if (!d || isVirtual(d)) return false;
    if (d.bus === "usb" || d.bus === "bluetooth") return false; // Windowsの情報で、外付け（USB・Bluetooth）と分かっている
    // 判定の前に、連続する空白を1つにまとめ、長さを切る（極端に長い・空白だらけの名前で、判定に時間がかからないように）
    const name = String(d.name || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (EXPLICIT_INTERNAL_RE.test(name)) return true;
    const m = ARRAY_NAME_RE.exec(name);
    if (!m) return false;
    const adapter = m[2]; // 括弧の中（ドライバ名）。m[1] は「マイク配列」の部分
    if (adapter === undefined || adapter.trim() === "") return d.machine !== false; // 「マイク配列」だけ（容器IDが本体のものではないと分かっているときは、内蔵にしない）
    return INTERNAL_ADAPTER_RE.test(adapter) && !EXTERNAL_HINT_RE.test(adapter);
  }
  // 画面に出す名前（元の名前が空のときは「（名前なし）」）
  function displayName(d) {
    if (!d) return "（名前なし）";
    if (isInternal(d)) return "内蔵マイク";
    return cleanName(d.name) || "（名前なし）";
  }

  function isSafeDeviceId(id) {
    if (typeof id !== "string") return false;
    if (id.length < 1 || id.length > MAX_ID_LEN) return false;
    // 制御文字・引用符・改行などを含むものは受け付けない（Windowsのエンドポイントは {0.0.1.00000000}.{GUID} の形）
    return /^[\x21-\x7E]+$/.test(id) && !/["'`<>|]/.test(id);
  }
  function cleanName(n) {
    return String(n == null ? "" : n).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LEN);
  }
  function isActive(d) { return !!d && d.state === STATE.ACTIVE; }
  function isVirtual(d) { return !!d && VIRTUAL_NAME_RE.test(String(d.name || "")); }
  function isDigital(d) { return !!d && (d.formFactor === FF.PASSTHRU || d.formFactor === FF.SPDIF || d.formFactor === FF.HDMI); }
  // 「マイクとして見せてよいもの」（設定の一覧の既定の表示）。
  // 仮想・ミキサー・デジタル入力・ライン入力だけを外す。種類が読み取れなかった（不明の）ものは、本物のマイクを一覧から消してしまわないよう、出す側に倒す。
  function isMicLike(d) {
    if (!d || isVirtual(d) || isDigital(d)) return false;
    return d.formFactor !== FF.LINE && d.formFactor !== FF.SPEAKERS && d.formFactor !== FF.HEADPHONES;
  }
  // 設定の一覧に添える「種類」
  function kindLabel(d) {
    if (!d) return "種類不明";
    if (isVirtual(d)) return "仮想・ミキサー";
    if (isInternal(d)) return "内蔵";
    const name = String(d.name || "");
    if (BLUETOOTH_CALL_RE.test(name)) return "Bluetooth・通話用";
    if (d.formFactor === FF.HEADSET || d.formFactor === FF.HANDSET) return "ヘッドセット";
    if (d.formFactor === FF.MICROPHONE) return "マイク";
    if (d.formFactor === FF.LINE) return "ライン入力";
    if (isDigital(d)) return "デジタル入力";
    if (d.formFactor === FF.REMOTE) return "リモート";
    return "種類不明";
  }
  function stateLabel(state) {
    if (state === STATE.ACTIVE) return "接続中";
    if (state === STATE.DISABLED) return "Windowsで無効";
    if (state === STATE.UNPLUGGED) return "未接続";
    return "未接続";
  }

  // 「全マイクまとめて」の対象：接続中の録音デバイスのうち、除外リストにあるもの・仮想/ミキサー・デジタル入力を除いたもの。
  // ライン入力・種類不明は「対象に入れる」（オーディオインターフェースのマイクが、そう申告されることがあるため。開いたまま残る事故を避ける）
  function allMicTargets(devices, excludeIds) {
    const ex = new Set(Array.isArray(excludeIds) ? excludeIds : []);
    return (Array.isArray(devices) ? devices : []).filter((d) => isActive(d) && !ex.has(d.id) && !isVirtual(d) && !isDigital(d));
  }

  // 対象のまとめの状態。none=対象なし（未接続）/ muted=全部ミュート中と確認できた / open=全部開いている / partial=混在・不明あり
  function aggregate(targets) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return { state: "none", total: 0, muted: 0, open: 0, unknown: 0 };
    let muted = 0, open = 0, unknown = 0;
    for (const d of list) {
      if (d.muted === true) muted += 1; else if (d.muted === false) open += 1; else unknown += 1;
    }
    let state = "partial";
    if (muted === list.length) state = "muted";
    else if (open === list.length) state = "open";
    return { state, total: list.length, muted, open, unknown };
  }

  // 押したときにすること。1台でも「ミュートと確認できていない」ものがあれば、ミュートする。全部ミュート済みのときだけ解除する。
  function planToggle(targets) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return null;
    return list.some((d) => d.muted !== true) ? "mute" : "unmute";
  }

  // タイルの保存前の検査・整形（メインプロセスの tiles:save で必ず通す＝画面の外から来た値も、ここで止める）
  //  ・micdev：デバイスIDの形を検査／別のボタンと同じデバイスを選んでいたら、後のほうの紐付けを外す（全画面を通して1デバイス＝1ボタン）
  //  ・mic：まとめてミュートから外すデバイスのIDリストを検査
  // 戻り値：{ tiles, changed, cleared:[{id, reason}] }
  function sanitizeMicTiles(tiles) {
    if (!Array.isArray(tiles)) return { tiles: [], changed: false, cleared: [] };
    const used = new Set();
    const cleared = [];
    let changed = false;
    const out = tiles.map((t) => {
      if (!t || typeof t !== "object") return t;
      if (t.type === "micdev") {
        const next = Object.assign({}, t);
        let touched = false;
        const rawId = t.micDeviceId;
        if (rawId !== undefined && rawId !== "" && !isSafeDeviceId(rawId)) { next.micDeviceId = ""; touched = true; cleared.push({ id: t.id, reason: "bad-id" }); }
        else if (typeof rawId === "string" && rawId) {
          if (used.has(rawId)) { next.micDeviceId = ""; touched = true; cleared.push({ id: t.id, reason: "duplicate" }); }
          else used.add(rawId);
        } else if (rawId !== undefined && rawId !== "") { next.micDeviceId = ""; touched = true; }
        const nm = cleanName(t.micDeviceName);
        if (t.micDeviceName !== undefined && nm !== t.micDeviceName) { next.micDeviceName = nm; touched = true; }
        const am = t.autoMute === true;
        if (t.autoMute !== undefined && t.autoMute !== am) { next.autoMute = am; touched = true; }
        if (touched) { changed = true; return next; }
        return t;
      }
      // マルチ操作の中に「1台ずつ」のマイク動作は入れられない（ボタンごとの重複禁止を迂回できてしまうため）
      if (t.type === "multi" && Array.isArray(t.subActions) && t.subActions.some((x) => x && x.type === "micdev")) {
        changed = true;
        return Object.assign({}, t, { subActions: t.subActions.filter((x) => !(x && x.type === "micdev")) });
      }
      if (t.type === "mic" && t.micExcludeIds !== undefined) {
        const list = Array.isArray(t.micExcludeIds) ? t.micExcludeIds : [];
        const seen = new Set();
        const clean = [];
        for (const x of list) { if (isSafeDeviceId(x) && !seen.has(x) && clean.length < MAX_EXCLUDE) { seen.add(x); clean.push(x); } }
        const same = Array.isArray(t.micExcludeIds) && clean.length === t.micExcludeIds.length && clean.every((x, i) => x === t.micExcludeIds[i]);
        if (!same) { changed = true; return Object.assign({}, t, { micExcludeIds: clean }); }
      }
      return t;
    });
    return { tiles: out, changed, cleared };
  }

  // 設定画面で、別のボタンが使用中のデバイスID → そのボタンの名前
  function usedByOthers(tiles, selfTileId) {
    const map = new Map();
    for (const t of Array.isArray(tiles) ? tiles : []) {
      if (t && t.type === "micdev" && t.id !== selfTileId && typeof t.micDeviceId === "string" && t.micDeviceId && !map.has(t.micDeviceId)) map.set(t.micDeviceId, String(t.name || "")); // 先に登録したボタンを優先（sanitizeMicTiles と同じ）
    }
    return map;
  }

  // 「名前での再照合」：IDが見つからないとき、同じ名前の候補がちょうど1台なら、その1台を返す（確認のうえで紐付けるための候補）
  function rematchByName(devices, name, takenIds) {
    const nm = cleanName(name);
    if (!nm) return null;
    const taken = new Set(takenIds || []);
    const hits = (Array.isArray(devices) ? devices : []).filter((d) => isActive(d) && d.name === nm && !taken.has(d.id));
    return hits.length === 1 ? hits[0] : null;
  }

  return { STATE, FF, MAX_ID_LEN, MAX_NAME_LEN, isSafeDeviceId, cleanName, isInternal, displayName, isActive, isVirtual, isDigital, isMicLike, kindLabel, stateLabel, allMicTargets, aggregate, planToggle, sanitizeMicTiles, usedByOthers, rematchByName };
});
