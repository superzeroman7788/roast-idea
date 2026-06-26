#!/usr/bin/env bash
# ROAST Mac 发版:一条命令出「签名 + 公证」的 universal 包 + updater 产物 + latest.json。
# 所有 APPLE_* / TAURI_SIGNING_* 都从环境变量读,脚本不落盘、不外传。用法见 docs/mac-desktop.md。
set -euo pipefail
cd "$(dirname "$0")/.."

# ── 1) updater 签名私钥(原生壳更新包验签;与苹果签名无关)──
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$HOME/.tauri/roast.key" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/roast.key")"
fi
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "✖ 缺 TAURI_SIGNING_PRIVATE_KEY(updater 私钥,默认读 ~/.tauri/roast.key)"; exit 1; }

# ── 2) 苹果分发签名 + 公证(你的密钥,脚本只读环境变量)──
miss=0
for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!v:-}" ]; then echo "✖ 缺环境变量 $v"; miss=1; fi
done
if [ "$miss" != 0 ]; then
  echo "—— 先 export 上面缺的(见 docs/mac-desktop.md「苹果签名」一节),再跑本脚本。"
  exit 1
fi
# 证书:可用 APPLE_CERTIFICATE(.p12 的 base64)+ APPLE_CERTIFICATE_PASSWORD,或已装进登录 Keychain。

# ── 3) 确保两个 mac 架构目标都在 ──
rustup target add x86_64-apple-darwin aarch64-apple-darwin >/dev/null 2>&1 || true

echo "▶ 构建 signed + notarized universal(Intel + Apple Silicon)…"
npx tauri build --target universal-apple-darwin

# ── 4) 生成 updater 清单 latest.json ──
VER="$(node -p "require('./src-tauri/tauri.conf.json').version")"
BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle/macos"
SIG="$(cat "$BUNDLE/ROAST.app.tar.gz.sig")"
REPO="superzeroman7788/roast-idea"
URL="https://github.com/$REPO/releases/download/v$VER/ROAST.app.tar.gz"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$BUNDLE/latest.json" <<JSON
{
  "version": "$VER",
  "notes": "见 GitHub Release 说明",
  "pub_date": "$DATE",
  "platforms": {
    "darwin-aarch64": { "signature": "$SIG", "url": "$URL" },
    "darwin-x86_64":  { "signature": "$SIG", "url": "$URL" }
  }
}
JSON

echo ""
echo "✅ 完成。产物在 $BUNDLE/"
echo "   • ROAST.app(已签名+公证)"
echo "   • ROAST.app.tar.gz (+ .sig)  ← updater 包"
echo "   • latest.json                ← updater 清单"
echo ""
echo "下一步(发布到 GitHub Release,触发用户自动更新):"
echo "  gh release create v$VER --title \"v$VER\" --notes \"更新说明\" \\"
echo "    \"$BUNDLE/ROAST.app.tar.gz\" \"$BUNDLE/latest.json\" \\"
echo "    src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg"
