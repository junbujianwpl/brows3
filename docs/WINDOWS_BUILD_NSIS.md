# Windows: Tauri Build Download Failures

When running `npx tauri build`, the bundler downloads tools from GitHub/Microsoft. If your network environment (proxy, MITM, corporate firewall) interferes with HTTPS, you'll see:

```
failed to bundle project `protocol: http response missing version`
```

This affects **both** NSIS and MSI bundlers.

## Root Cause: ureq + HTTP Proxy Incompatibility

Tauri bundler uses **ureq** as its HTTP client, which reads proxy from `ALL_PROXY` / `HTTPS_PROXY` env vars. **ureq only supports SOCKS5 proxies**, not HTTP CONNECT proxies. When your proxy env var uses `http://` scheme, ureq cannot parse the proxy's response.

### Clash Verge / Clash for Windows Specific

Clash Verge 的 `mixed-port`（如 1080 或 7890）同时支持 HTTP 和 SOCKS5 协议。但启用"系统代理"时，Clash 导出的环境变量默认使用 `http://` 前缀：

```
ALL_PROXY=http://127.0.0.1:1080     ← ureq 无法处理
```

虽然同一端口也接受 SOCKS5 连接，但 ureq 看到 `http://` 就按 HTTP CONNECT 协议发送请求，导致解析失败。

**修复方式（任选其一）：**

```bash
# 方案1: 改用 socks5 协议前缀（推荐，同一端口可能就支持）
export ALL_PROXY=socks5://127.0.0.1:1080

# 方案2: 仅在 build 时临时清除代理（文件已缓存时不需要网络）
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
pnpm tauri build --bundles nsis

# 方案3: 使用 GitHub 镜像（中国大陆网络）
export TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://ghfast.top/"
```

## Offline Build: Pre-Cached Files

当所有 bundler 工具已缓存在 `%LOCALAPPDATA%\tauri\` 下时，bundler **不会联网**，直接使用本地文件。但如果设置了不兼容的代理，ureq 仍然会尝试通过代理验证文件，导致失败。

确保缓存完整后，可以完全离线打包（需先 unset 代理或用 SOCKS5）。

## Quick Fix: Disable Problematic Downloads

In `src-tauri/tauri.conf.json`, set `webviewInstallMode` to `"skip"` (WebView2 is pre-installed on Windows 10/11):

```json
"windows": {
  "webviewInstallMode": { "type": "skip" }
}
```

This prevents the MSI/NSIS bundler from downloading the WebView2 offline installer (~160MB).

## Manual NSIS Setup

The NSIS bundler downloads two things. Pre-place them with `curl` (which handles proxies correctly):

### 1. Download NSIS 3.11

```bash
curl -L -o "$LOCALAPPDATA/tauri/nsis-3.11.zip" \
  "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
```

### 2. Extract and rename to `NSIS`

```bash
cd "$LOCALAPPDATA/tauri"
unzip -o nsis-3.11.zip -d .
mv nsis-3.11 NSIS
```

The resulting path should be: `%LOCALAPPDATA%\tauri\NSIS\makensis.exe`

### 3. Download nsis_tauri_utils plugin

**Important:** Match the version your `tauri-cli` expects. Check the build error output for the exact URL. Common versions:

```bash
mkdir -p "$LOCALAPPDATA/tauri/NSIS/Plugins/x86-unicode/additional"

# For tauri-cli that expects v0.5.2:
curl -L -o "$LOCALAPPDATA/tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll" \
  "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.2/nsis_tauri_utils.dll"

# For tauri-cli that expects v0.5.3:
# curl -L -o ... "https://...nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
```

If you download the wrong version, Tauri reports `NSIS directory contains mis-hashed files` and tries to re-download.

### 4. Verify

```bash
ls "$LOCALAPPDATA/tauri/NSIS/makensis.exe"
ls "$LOCALAPPDATA/tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
```

### 5. Retry build

```bash
npx tauri build
```

## Expected Directory Structure

```
%LOCALAPPDATA%\tauri\
├── NSIS\
│   ├── makensis.exe
│   ├── makensisw.exe
│   ├── Bin\
│   ├── Contrib\
│   ├── Include\
│   ├── Plugins\
│   │   └── x86-unicode\
│   │       └── additional\
│   │           └── nsis_tauri_utils.dll
│   └── Stubs\
├── WixTools314\
└── x64\
```

## Pitfalls & Key Points

### Pitfall 1: Version Mismatch → "mis-hashed files"

The most common mistake. Each `tauri-cli` version hardcodes a specific `nsis_tauri_utils` version+SHA1:

| tauri-cli | Expected plugin | SHA1 |
|-----------|----------------|------|
| 2.9.6 | `nsis_tauri_utils-v0.5.2` | `D0C502F45DF55C0465C9406088FF016C2E7E6817` |
| 2.10.x+ (dev) | `nsis_tauri_utils-v0.5.3` | `75197FEE3C6A814FE035788D1C34EAD39349B860` |

**How to find your version's expected URL:** Run the build once and let it fail — the error log shows the exact download URL with version number.

### Pitfall 2: SHA1, NOT SHA256

Tauri validates files using **SHA1** (`NSIS_SHA1`, `NSIS_TAURI_UTILS_SHA1`). If you're verifying manually:

```bash
sha1sum "$LOCALAPPDATA/tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
# Must match the SHA1 for your tauri-cli version (case insensitive)
```

### Pitfall 3: Directory must be named `NSIS` (not `nsis-3.11`)

The zip extracts to `nsis-3.11/`. The bundler looks for `%LOCALAPPDATA%\tauri\NSIS\`. You MUST rename:

```bash
mv nsis-3.11 NSIS  # Critical!
```

### Pitfall 4: WebView2 offlineInstaller also downloads

The MSI bundler with `"webviewInstallMode": { "type": "offlineInstaller" }` tries to download a ~160MB WebView2 installer from Microsoft — same proxy issue. Fix: set `"type": "skip"` (safe on Windows 10/11 where WebView2 is pre-installed via Edge).

### Pitfall 5: Clash Verge 代理协议导致 ureq 解析失败

Clash Verge 启用系统代理后导出 `ALL_PROXY=http://127.0.0.1:1080`。ureq 只支持 SOCKS5 代理，收到 HTTP 代理响应后报 `protocol: http response missing version`。

即使 bundler 工具已经全部缓存（哈希正确），ureq 仍会尝试通过代理进行网络验证。所以必须修改代理协议为 `socks5://` 或临时 unset 代理。

**验证方法：**

```bash
echo $ALL_PROXY
# 如果输出 http://... 就是这个问题
# 改成 socks5://... 或 unset ALL_PROXY
```

### Pitfall 6: Antivirus deletes nsis_tauri_utils.dll

Security software (WithSecure, Windows Defender, etc.) may flag `nsis_tauri_utils.dll` as `Trojan.TR/Hijacker.Gen`. This is a false positive ([tauri#14882](https://github.com/tauri-apps/tauri/issues/14882)). Add an exclusion for `%LOCALAPPDATA%\tauri\NSIS\`.

### Pitfall 7: cargo vendor + Next.js TypeScript 冲突

如果使用 `cargo vendor` 离线编译 Rust 依赖，vendor 目录中的 Tauri 插件包含 `guest-js/*.ts` 文件。Next.js 默认的 `tsconfig.json` 用 `**/*.ts` 匹配所有 TypeScript，会扫描到 `src-tauri/vendor/` 下的 TS 文件并报编译错误：

```
src-tauri/vendor/tauri-plugin-log/guest-js/index.ts
Type error: Named capturing groups are only available when targeting 'ES2018' or later.
```

**修复：** 在 `tsconfig.json` 的 `exclude` 中加入 `"src-tauri"`：

```json
"exclude": ["node_modules", "src-tauri"]
```

### Pitfall 8: Cargo lock contention

If a previous build was killed mid-way, `Blocking waiting for file lock on artifact directory` appears. Fix:

```bash
# Find and kill stale cargo processes
taskkill /F /IM cargo.exe 2>/dev/null
# Or delete the lock file
rm -f src-tauri/target/.cargo-lock
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `protocol: http response missing version` | ureq 通过 HTTP 代理发请求，无法解析响应 | 改 `ALL_PROXY` 为 `socks5://` 或 unset 代理 |
| `NSIS directory contains mis-hashed files` | Wrong plugin version (SHA1 mismatch) | Download the exact version from error log URL |
| `NSIS directory is missing some files` | Incomplete extraction or antivirus deletion | Re-extract zip, whitelist in antivirus |
| `Blocking waiting for file lock` | Stale cargo process | Kill cargo.exe or delete lock file |
| `The system cannot find the file specified (os error 2)` | Antivirus removed DLL after extraction | Add exclusion, re-download |
| `io: 远程主机强迫关闭了一个现有的连接 (os error 10054)` | GitHub 下载被 GFW 重置连接 | 用 SOCKS5 代理或 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` |

## How to determine the correct versions

```bash
# 1. Check your tauri-cli version
npx tauri --version

# 2. Look up source for that version (replace TAG):
# https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v{VERSION}/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs
# Find NSIS_TAURI_UTILS_URL and NSIS_TAURI_UTILS_SHA1

# 3. Or just run the build and read the failed download URL from stderr
```

## References

- [tauri-apps/binary-releases](https://github.com/tauri-apps/binary-releases/releases) — NSIS zip versions
- [tauri-apps/nsis-tauri-utils](https://github.com/tauri-apps/nsis-tauri-utils/releases) — Plugin DLL versions
- [tauri#14882](https://github.com/tauri-apps/tauri/issues/14882) — Antivirus false positive issue


[修复nsis下载失败的问题](https://github.com/tauri-apps/tauri/issues/7338)

上面还缺少一步，少插件的，还要再下载一个插件