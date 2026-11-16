# Launch-K ビルド回避策（NSISの仮のexeを実行しない）

## 症状
`electron-builder` のビルドが、`NsisTarget.computeScriptAndSignUninstaller` → `execWine` → `spawn …` で毎回止まる。

## 何が起きているか（electron-builder のソースで確認）
1. makensis が、`dist\Launch-K Setup 1.2.7.exe` という「仮のexe」を作る（アンインストーラーを書き出すためだけのもの）。
2. その仮のexeを、`execFile` で**実行**する（`__COMPAT_LAYER=RunAsInvoker` つき）。
3. この「できたばかりの、署名のないexeの実行」を、Windowsの保護機能（ウイルス対策・ASR・Smart App Control など）が止めると、`spawn EPERM` / `spawn UNKNOWN` などで失敗する。

## 回避策（署名もSmartScreenのオフも不要）
仮のexeを実行せず、中身を読んでアンインストーラーを取り出す。electron-builder にもともと入っている方法（`UninstallerReader`。macOS Catalinaで実行できないときに使う）を、Windowsでも先に使う。失敗したときは、従来の方法に戻す。

### 入れ方
1. このzipの `scripts` フォルダを、プロジェクト（`C:\dev\Launch-K`）に入れる。
2. `package.json` の `"scripts"` の `"build"` を、次に変える。
   ```
   "build": "set CSC_IDENTITY_AUTO_DISCOVERY=false&&node scripts/build-win.js"
   ```
3. `package.json` の `build.files` に `"!scripts/**"` を足す（アプリの中に入れないため）。
4. `npm run build`。うまくいくと、`[build-win] NSISの仮のexeを実行しない方法を有効にしました` と、`NSIS: アンインストーラーを、仮のexeを実行せずに取り出しました` が出る。

### 元に戻す／止める
- `"build"` を `electron-builder` に戻す。または、環境変数 `LAUNCHK_NO_NSIS_PATCH=1`。

### 確認してほしいこと
- できた `dist\Launch-K Setup 1.2.7.exe` で、インストール → アンインストールが通るか（仮想マシンや別PCで）。
- `npm ls app-builder-lib` で、`app-builder-lib` が1つだけか（複数あるときは、electron-builder が使うほうを読むようにしてあります）。

## 自己テスト
`node scripts/build-win-selftest.js`（模擬の部品で、置き換えの動きを確かめます。本物の electron-builder・Windowsでは動かしていません）。
