"use strict";
// ============================================================================
// tailscale.js — Tailscale（VPN）との連携（メインプロセス）
//
// やること
//  ・Tailscaleの状態を調べる（入っているか／動いているか／このPCのTailscale用IPアドレス）
//  ・接続してきた端末が「このPCと同じTailscaleアカウントの端末」かを確かめる
//    （他の人のアカウントの端末・タグ付きの端末・共有されただけの端末は、すべて断る）
//  ・接続の経路（direct＝直接 / relay＝中継サーバー経由）を調べる
//
// 方針
//  ・Tailscale公式のコマンド（tailscale status --json）の出力だけを使う。パスワードや鍵には一切触れない。
//  ・実行するのは、Tailscaleの既定の場所にある実行ファイルだけ（PATH任せにしない。現在のフォルダにある偽物を
//    実行してしまう事故を避けるため）。引数は固定で、外から受け取った文字列をコマンドに渡さない。
// ============================================================================
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const CLI_TIMEOUT_MS = 4000;
const STATUS_CACHE_MS = 2500;

// ---- Tailscaleの実行ファイルの場所 ----
function candidateCliPaths() {
  const list = [];
  if (process.platform === "win32") {
    for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = process.env[key];
      if (base) list.push(path.join(base, "Tailscale", "tailscale.exe"));
    }
  } else if (process.platform === "darwin") {
    list.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  } else {
    list.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return list;
}
function findCli() {
  for (const p of candidateCliPaths()) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 次の候補へ */ }
  }
  return "";
}

// ---- コマンドの実行（引数は固定。シェルは通さない） ----
function defaultRun(args) {
  return new Promise((resolve) => {
    const bin = findCli();
    if (!bin) return resolve({ ok: false, notInstalled: true });
    execFile(bin, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String((stderr && stderr.toString()) || error.message || "").slice(0, 300) });
      resolve({ ok: true, stdout: String(stdout || "") });
    });
  });
}

// ---- 解析（テストしやすいよう、純粋な関数にしてある） ----
function isTailnetV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10（Tailscaleが使う番号帯）
}
function baseName(dns, suffix) {
  let n = String(dns || "").replace(/\.$/, "");
  const sfx = String(suffix || "").replace(/^\./, "").replace(/\.$/, "");
  if (sfx && n.endsWith("." + sfx)) n = n.slice(0, -(sfx.length + 1));
  return n.split(".")[0] || n;
}
function normPeer(p, suffix) {
  const ips = Array.isArray(p && p.TailscaleIPs) ? p.TailscaleIPs.map(String) : [];
  return {
    ips,
    userId: p && p.UserID !== undefined && p.UserID !== null ? String(p.UserID) : "",
    key: String((p && (p.PublicKey || p.ID)) || ""), // 端末の識別（接続中に別の端末にすり替わっていないかの確認に使う）
    tags: Array.isArray(p && p.Tags) ? p.Tags.map(String) : [],
    dns: String((p && p.DNSName) || ""),
    host: String((p && p.HostName) || "") || baseName(p && p.DNSName, suffix),
    os: String((p && p.OS) || ""),
    online: !!(p && p.Online),
    active: !!(p && p.Active),
    curAddr: String((p && p.CurAddr) || ""),
    relay: String((p && p.Relay) || ""),
    peerRelay: String((p && p.PeerRelay) || ""),
    sharee: !!(p && p.ShareeNode),
    altSharer: !!(p && p.AltSharerUserID),
  };
}
// tailscale status --json → 使いやすい形に
function parseStatus(json) {
  if (!json || typeof json !== "object") return { ok: false, reason: "error" };
  const backend = String(json.BackendState || "");
  const self = json.Self && typeof json.Self === "object" ? json.Self : null;
  const suffix = String(json.MagicDNSSuffix || (json.CurrentTailnet && json.CurrentTailnet.MagicDNSSuffix) || "");
  const ips = (Array.isArray(json.TailscaleIPs) ? json.TailscaleIPs : (self && self.TailscaleIPs) || []).map(String);
  const selfIp = ips.find(isTailnetV4) || "";
  const users = json.User && typeof json.User === "object" ? json.User : {};
  const selfUserId = self && self.UserID !== undefined && self.UserID !== null ? String(self.UserID) : "";
  const prof = users[selfUserId] || {};
  const peers = Object.values(json.Peer && typeof json.Peer === "object" ? json.Peer : {}).map((p) => normPeer(p, suffix));
  const out = {
    backend, selfIp, selfUserId,
    selfName: self ? (String(self.HostName || "") || baseName(self.DNSName, suffix)) : "",
    login: String(prof.LoginName || ""),
    display: String(prof.DisplayName || ""),
    tailnet: String((json.CurrentTailnet && json.CurrentTailnet.Name) || suffix || ""),
    peers,
    users,
  };
  if (backend === "Running" && self && selfIp && selfUserId) return Object.assign({ ok: true }, out);
  let reason = "error";
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") reason = "needs-login";
  else if (backend === "Stopped") reason = "stopped";
  else if (backend === "Starting" || backend === "NoState") reason = "starting";
  else if (backend === "Running" && !selfIp) reason = "no-ip";
  return Object.assign({ ok: false, reason }, out);
}
// 経路：CurAddrがあれば direct、なければ PeerRelay / Relay（中継）。Tailscale公式のstatus表示と同じ判定。
function classifyPath(p) {
  if (!p) return { kind: "unknown", detail: "" };
  if (p.curAddr) return { kind: "direct", detail: "" };
  if (p.peerRelay) return { kind: "peer-relay", detail: "" };
  if (p.relay) return { kind: "relay", detail: p.relay }; // DERPの地域コード（例: tok）
  return { kind: "unknown", detail: "" };
}
// 接続してきた相手（IPアドレス）が、このPCと同じアカウントの端末か
function judgePeer(st, ip) {
  if (!st || !st.ok) return { ok: false, reason: "tailscale-down" };
  if (!isTailnetV4(ip)) return { ok: false, reason: "not-tailnet" };
  const p = st.peers.find((x) => x.ips.indexOf(ip) !== -1);
  if (!p) return { ok: false, reason: "unknown-peer" };
  if (p.tags.length) return { ok: false, reason: "tagged" };
  if (p.sharee || p.altSharer) return { ok: false, reason: "shared" };
  if (!p.userId || p.userId !== st.selfUserId) return { ok: false, reason: "other-user" };
  return { ok: true, name: p.host, os: p.os, online: p.online, login: st.login, display: st.display, key: p.key, path: classifyPath(p) };
}

// ---- クライアント（状態を少しだけキャッシュする） ----
function createClient(opts) {
  const run = (opts && opts.run) || defaultRun;
  let cache = null;
  let cacheAt = 0;
  let inflight = null;
  async function load(force) {
    const now = Date.now();
    if (!force && cache && now - cacheAt < STATUS_CACHE_MS) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await run(["status", "--json"]);
      let out;
      if (!r.ok) out = { ok: false, reason: r.notInstalled ? "not-installed" : "not-running" };
      else {
        let j = null;
        try { j = JSON.parse(r.stdout); } catch (e) { j = null; }
        out = j ? parseStatus(j) : { ok: false, reason: "error" };
      }
      cache = out;
      cacheAt = Date.now();
      return out;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return {
    // いまの状態（毎回、最新を取る）
    status: () => load(true),
    // 接続してきた相手の確認（短いキャッシュを使う）
    async peerFor(ip) { return judgePeer(await load(false), ip); },
    // 接続の経路の確認（最新を取る）
    async routeFor(ip) { return judgePeer(await load(true), ip); },
  };
}

module.exports = { createClient, parseStatus, judgePeer, classifyPath, isTailnetV4, findCli, candidateCliPaths };
