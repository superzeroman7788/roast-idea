# ROAST · Mac 桌面版(Tauri 2 瘦壳)

把已部署在 Render 的 Web 版包成一个原生 Mac App。**核心思路:壳薄、内容在云端。**

## 架构:为什么"改了程序几乎不用更新 App"

```
┌─────────────────────────────┐
│  ROAST.app(Tauri 原生壳)    │   ← 很少变,变了才出新版 + updater 自动推
│  ┌───────────────────────┐  │
│  │  WebView              │  │
│  │  载入 https://…onrender │──┼──→ Render(前端 + /api + 议会引擎 + DB)
│  └───────────────────────┘  │      ← 你 push → 部署 → App 下次打开即最新
└─────────────────────────────┘
```

- `src-tauri/tauri.conf.json` 的 `build.frontendDist` = **线上 URL**(不打包本地前端)。WebView 直接载线上 Web 版。
- **改 prompt / 加功能 / 修 bug / 调议会 → 照常 `git push` → Render 自动部署 → Mac App 下次打开就是新的,不用重打包、不用重签名、不用重分发。**
- 只有改**原生壳本身**(窗口、菜单、Keychain、updater 逻辑、升级 Tauri)时,才需要出一个新 App 版本 —— 这时走下面的「原生壳自动更新」。

## 改线上地址

`src-tauri/tauri.conf.json` → `build.frontendDist`。当前填的是 `https://roast-idea.onrender.com`(按服务名猜的)。
**部署后到 Render 控制台看真实域名,把这里改成你的真域名,再重建一次。** 自定义域名也填这里。

## 本地开发 / 构建

```bash
# 开发(热载,连本地 5173 或线上都行;改 devUrl/frontendDist 控制)
npm run mac:dev

# 构建出 .app + .dmg(当前机器架构)
npm run mac:build
# 产物:src-tauri/target/release/bundle/macos/ROAST.app
#       src-tauri/target/release/bundle/dmg/ROAST_<ver>_<arch>.dmg
```

通用二进制(同时支持 Intel + Apple Silicon):
```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run mac:build -- --target universal-apple-darwin
```

## 原生壳的自动更新(updater 插件)

已接好 `tauri-plugin-updater`:App 启动时静默检查 → 有新版就下载 + 验签 + 安装 + 重启;无网/无更新都不打扰(见 `src-tauri/src/lib.rs`)。

- **签名密钥**(minisign,校验更新包完整性,**与苹果签名无关**):
  - 私钥:`~/.tauri/roast.key`(**已生成,绝不进 git**;丢了就没法再发更新,务必备份)。
  - 公钥:已写进 `tauri.conf.json` 的 `plugins.updater.pubkey`。
- **更新源**:`plugins.updater.endpoints` 指向
  `https://github.com/superzeroman7788/roast-idea/releases/latest/download/latest.json`。

### 发一个原生壳新版的流程

1. 改 `src-tauri/tauri.conf.json` 的 `version`(和根 `package.json` 对齐)。
2. 带签名密钥构建:
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/roast.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run mac:build -- --target universal-apple-darwin
   ```
   产物里会多出 **`ROAST.app.tar.gz`** 和 **`ROAST.app.tar.gz.sig`**(updater 用)。
3. 在 GitHub 建一个 Release(tag = 版本号),上传 `ROAST.app.tar.gz`、`.dmg`,以及一份 **`latest.json`**:
   ```json
   {
     "version": "0.1.1",
     "notes": "更新说明",
     "pub_date": "2026-06-26T00:00:00Z",
     "platforms": {
       "darwin-aarch64": { "signature": "<.sig 文件内容>", "url": "https://github.com/superzeroman7788/roast-idea/releases/download/v0.1.1/ROAST.app.tar.gz" },
       "darwin-x86_64":  { "signature": "<.sig 文件内容>", "url": "https://github.com/superzeroman7788/roast-idea/releases/download/v0.1.1/ROAST.app.tar.gz" }
     }
   }
   ```
   (通用二进制 aarch64/x86_64 可指同一个 tar.gz。)
4. 用户下次开 App → 自动拉到、装上、重启。

> 大多数迭代根本走不到这一步 —— 改 Web 逻辑只需 push 到 Render。只有动原生壳才发版。

## 苹果签名 / 公证(站长已有付费开发者账号)

> 现状(`security find-identity -v -p codesigning` 查的):本机已装 **Apple Development** 证书(本地调试用),
> **还没装 Developer ID Application** 证书 —— 分发 + 公证 + 自动更新必须用后者。先补这张证书。

**一次性准备:**

1. **建 Developer ID Application 证书**:Xcode → Settings → Accounts → 选你的 Apple ID(`ln5423696@gmail.com`)→ Manage Certificates → 左下 `+` → **Developer ID Application**。装好后 `security find-identity -v -p codesigning` 会多出一行 `Developer ID Application: <名字> (<TeamID>)`。
2. **App 专用密码**(公证用):appleid.apple.com → 登录与安全 → App 专用密码 → 新建一个,记下来。
3. **Team ID**:developer.apple.com → Membership 里看,或就是上面证书括号里的那串。

**发版(一条命令,签名 + 公证 + 出 updater 包 + latest.json):**

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <你的名字> (<TeamID>)"
export APPLE_ID="ln5423696@gmail.com"
export APPLE_PASSWORD="<上一步的 App 专用密码>"
export APPLE_TEAM_ID="<Team ID>"
# 证书:已装进登录 Keychain 即可;CI 上则用 APPLE_CERTIFICATE(.p12 base64)+ APPLE_CERTIFICATE_PASSWORD
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/roast.key)"   # updater 私钥
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

bash scripts/mac-release.sh
```

脚本会:跑 `tauri build --target universal-apple-darwin`(Tauri 打包时自动签名 + 提交公证)→ 生成 `latest.json` → 打印 `gh release create` 命令。把 `ROAST.app.tar.gz` + `latest.json` + `.dmg` 传到对应 tag 的 GitHub Release,用户下次开 App 即自动更新。

> 两套签名相互独立:**minisign**(`~/.tauri/roast.key`)保更新包完整性;**Apple Developer ID 签名 + 公证**满足 Gatekeeper。发版要两者都有。

## 还没做 / 可加

- **Keychain 存 API Key**:若以后让 App 直连各家 LLM(BYO key),用 `tauri-plugin-keychain` / `keyring` 存密钥,不落明文。当前瘦壳所有调用都走 Render 后端,key 在 Render env,Mac 端不持有。
- **原生菜单 / Dock / 通知 / 开机音**:可在 `lib.rs` 加。
- **CI 出包**:GitHub Actions 跑 `tauri-action`,push tag 自动构建 + 签名 + 建 Release + 生成 latest.json(把上面手动流程自动化)。
