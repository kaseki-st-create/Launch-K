// ============================================================
// マイク／スピーカーのミュート操作を、koffiでWindowsのCore Audio（COM）を直接呼び出して行う実装。
// main.js の CORE_AUDIO_CS（C#・PowerShell経由）と同じ操作を、PowerShellの起動や
// Add-Type（C#のコンパイル）を挟まずに行うので、押してすぐ反応する。
//
// 使うAPI（Windows SDKの定義どおり）
//   CoCreateInstance(CLSID_MMDeviceEnumerator) → IMMDeviceEnumerator
//   → GetDefaultAudioEndpoint(flow, role) → IMMDevice
//   → Activate(IID_IAudioEndpointVolume) → IAudioEndpointVolume
//   → GetMute / SetMute
//
// koffiは native-snap.js（画面分割）と同じモジュール（package.json で固定したバージョン）を使う。
// 新しい依存は増えない。
//
// 重要な安全設計：
//  ・想定外のことが起きたら、必ず例外を投げる。呼び出し側（main.js）は例外を捕まえて、
//    従来のPowerShell方式にそのままフォールバックする。つまりこの実装が一部の環境で
//    動かなくても、ミュート機能そのものは今まで通り動く。
//  ・COMのオブジェクトは、使い終わったら必ず Release する（失敗しても finally で解放）。
//  ・値を書き換えるのは SetMute だけ（ミュートのオン／オフ）。音量・設定・レジストリには触れない。
// ============================================================
"use strict";

const CLSCTX_ALL = 23; // INPROC_SERVER | INPROC_HANDLER | LOCAL_SERVER | REMOTE_SERVER（従来のC#版と同じ）
const COINIT_APARTMENTTHREADED = 2;

// IMMDeviceEnumerator / IMMDevice / IAudioEndpointVolume の、vtable上の位置（IUnknownの3つの後ろから数える）
const VT_RELEASE = 2;
const VT_ENUM_GET_DEFAULT_ENDPOINT = 4; // IMMDeviceEnumerator::GetDefaultAudioEndpoint
const VT_DEVICE_ACTIVATE = 3;           // IMMDevice::Activate
const VT_VOL_SET_MUTE = 14;             // IAudioEndpointVolume::SetMute
const VT_VOL_GET_MUTE = 15;             // IAudioEndpointVolume::GetMute

function parseGuid(text) {
  const m = /^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})-([0-9A-Fa-f]{12})$/.exec(text);
  if (!m) throw new Error("bad guid " + text);
  const tail = m[4] + m[5] + m[6];
  const d4 = [];
  for (let i = 0; i < 8; i++) d4.push(parseInt(tail.substr(i * 2, 2), 16));
  return { Data1: parseInt(m[1], 16) >>> 0, Data2: parseInt(m[2], 16), Data3: parseInt(m[3], 16), Data4: d4 };
}

function hrText(hr) { return "0x" + (hr >>> 0).toString(16).toUpperCase().padStart(8, "0"); }
function checkHr(hr, what) {
  if (typeof hr !== "number" || hr < 0) throw new Error(what + " failed (" + (typeof hr === "number" ? hrText(hr) : "?") + ")");
}

// koffi と、ole32 のライブラリを受け取って、操作の関数を作る（テストで差し替えられるよう分けてある）
function createBackend(koffi, lib) {
  const GUID = koffi.struct("AudioGUID", {
    Data1: "uint32",
    Data2: "uint16",
    Data3: "uint16",
    Data4: koffi.array("uint8", 8),
  });
  const CLSID_MMDeviceEnumerator = parseGuid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  const IID_IMMDeviceEnumerator = parseGuid("A95664D2-9614-4F35-A746-DE8DB63617E6");
  const IID_IAudioEndpointVolume = parseGuid("5CDF2C82-841E-4546-9722-0CF74078229A");

  const CoInitializeEx = lib.func("int32 __stdcall CoInitializeEx(void *reserved, uint32 coInit)");
  const CoCreateInstance = lib.func(
    "int32 __stdcall CoCreateInstance(AudioGUID *rclsid, void *outer, uint32 clsCtx, AudioGUID *riid, _Out_ void **ppv)"
  );

  const P_GetDefaultEndpoint = koffi.proto("int32 __stdcall AudioGetDefaultEndpoint(void *self, int32 flow, int32 role, _Out_ void **dev)");
  const P_Activate = koffi.proto("int32 __stdcall AudioActivate(void *self, AudioGUID *iid, uint32 clsCtx, void *params, _Out_ void **out)");
  const P_GetMute = koffi.proto("int32 __stdcall AudioGetMute(void *self, _Out_ int32 *mute)");
  const P_SetMute = koffi.proto("int32 __stdcall AudioSetMute(void *self, int32 mute, void *eventContext)");
  const P_Release = koffi.proto("uint32 __stdcall AudioRelease(void *self)");

  const PTR = koffi.sizeof("void *");

  // COMオブジェクトの vtable から、index番目のメソッドのアドレスを取り出す
  function method(obj, index) {
    const table = koffi.decode(obj, "void *");
    if (!table) throw new Error("null vtable");
    const fnPtr = koffi.decode(table, index * PTR, "void *");
    if (!fnPtr) throw new Error("null method " + index);
    return fnPtr;
  }
  function release(obj) {
    if (!obj) return;
    try { koffi.call(method(obj, VT_RELEASE), P_Release, obj); } catch (e) { /* 解放の失敗は無視（ここで例外を出すと、本来の結果を隠してしまう） */ }
  }

  let comReady = false;
  function ensureCom() {
    if (comReady) return;
    // Electronのメインスレッドはすでに初期化済みのことが多い（S_FALSE／RPC_E_CHANGED_MODEも正常）。
    // ここでの失敗は無視し、本当に初期化できていなければ、次の CoCreateInstance が失敗する（→ 例外 → フォールバック）。
    try { CoInitializeEx(null, COINIT_APARTMENTTHREADED); } catch (e) { /* 無視 */ }
    comReady = true;
  }

  // flow: 0=再生（スピーカー）, 1=録音（マイク）／ role: 0=eConsole, 1=eMultimedia, 2=eCommunications
  function withVolume(flow, role, fn) {
    ensureCom();
    const f = Number(flow) | 0, r = Number(role) | 0;
    if (f < 0 || f > 1 || r < 0 || r > 2) throw new Error("bad flow/role");
    const eo = [null];
    checkHr(CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, eo), "CoCreateInstance");
    const enumerator = eo[0];
    if (!enumerator) throw new Error("no enumerator");
    try {
      const dout = [null];
      checkHr(koffi.call(method(enumerator, VT_ENUM_GET_DEFAULT_ENDPOINT), P_GetDefaultEndpoint, enumerator, f, r, dout), "GetDefaultAudioEndpoint");
      const device = dout[0];
      if (!device) throw new Error("no device");
      try {
        const vout = [null];
        checkHr(koffi.call(method(device, VT_DEVICE_ACTIVATE), P_Activate, device, IID_IAudioEndpointVolume, CLSCTX_ALL, null, vout), "Activate");
        const vol = vout[0];
        if (!vol) throw new Error("no endpoint volume");
        try {
          return fn(vol);
        } finally {
          release(vol);
        }
      } finally {
        release(device);
      }
    } finally {
      release(enumerator);
    }
  }

  function getMuteOn(vol) {
    const out = [0];
    checkHr(koffi.call(method(vol, VT_VOL_GET_MUTE), P_GetMute, vol, out), "GetMute");
    return out[0] !== 0;
  }
  function setMuteOn(vol, on) {
    checkHr(koffi.call(method(vol, VT_VOL_SET_MUTE), P_SetMute, vol, on ? 1 : 0, null), "SetMute");
  }

  return {
    // true=ミュート中 / false=ミュートなし。取得できなければ例外
    getMute(flow, role) { return withVolume(flow, role, getMuteOn); },
    // ミュートを反転して、反転後の状態（true=ミュート中）を返す。書き込み後にもう一度読んで、実際の状態を返す
    toggleMute(flow, role) {
      return withVolume(flow, role, (vol) => {
        const now = getMuteOn(vol);
        setMuteOn(vol, !now);
        return getMuteOn(vol);
      });
    },
  };
}

let available = false;
let backend = null;
if (process.platform === "win32") {
  try {
    const koffi = require("koffi");
    backend = createBackend(koffi, koffi.load("ole32.dll"));
    available = true;
  } catch (e) {
    backend = null;
    available = false;
  }
}

function requireBackend() {
  if (!backend) throw new Error("native audio unavailable");
  return backend;
}

// マイク（録音・eMultimedia）のミュートを反転する。反転後に「ミュート中」ならtrue。
function toggleMicMute() { return requireBackend().toggleMute(1, 1); }

// いまの実際のミュート状態を返す。分からないものは null（従来のPowerShell版と同じ role：スピーカー=0、マイク=1）
function readStates() {
  const b = requireBackend();
  const one = (flow, role) => { try { return b.getMute(flow, role); } catch (e) { return null; } };
  const speaker = one(0, 0);
  const mic = one(1, 1);
  // 両方とも取れなかったときは「動かなかった」とみなして例外にする（→ 呼び出し側がPowerShell方式で再確認する）
  if (speaker === null && mic === null) throw new Error("could not read mute states");
  return { speaker, mic };
}

module.exports = { available, toggleMicMute, readStates, createBackend };
