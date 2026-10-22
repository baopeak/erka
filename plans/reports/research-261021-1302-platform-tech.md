# Erka platform tech research: browser pane, SSH, mobile LAN, offline dictation

Date 2026-10-21. Build machine: Win10, rustc/cargo 1.97.0 MSVC, no cmake/clang/NASM/Docker/WSL.
Method: crates.io API versions, vendored crate source in `~/.cargo/registry`, docs.rs/MS/Tauri docs, plus **empirical probe builds** in scratchpad (not in repo, repo untouched). Items marked [VERIFIED-HERE] were compiled/run on this machine; [DOCS] = read in docs/source only; [UNVERIFIED] = needs spike.

## 0. Headline findings

| # | Finding | Evidence |
|---|---|---|
| 1 | **aws-lc-rs/aws-lc-sys 0.46.0 FAILS here: needs NASM (not cmake).** russh default features, rustls default, axum-server `tls-rustls` all pull it. Use `ring` everywhere. | [VERIFIED-HERE] `NASM command not found! Build cannot continue.` Docs: "CMake is never required" for non-FIPS; NASM required on Windows x86-64 unless `prebuilt-nasm` |
| 2 | `ring` 0.17.14 builds clean (crates.io tarball ships prebuilt asm; only needs MSVC). Already in `Cargo.lock`. | [VERIFIED-HERE] + ring BUILDING.md |
| 3 | **whisper-rs 0.16.0 FAILS here**: whisper-rs-sys 0.15.0 build-deps = `cmake ^0.1` + `bindgen ^0.72` -> `Unable to find libclang`. | [VERIFIED-HERE] |
| 4 | **sherpa-onnx 1.13.8 builds, links, and transcribes here** (downloads prebuilt 123 MB static lib at build time). | [VERIFIED-HERE] ran SAPI WAV + Vietnamese WAVs |
| 5 | `ort 2.0.0-rc.15`, `candle-* 0.11.0`+`tokenizers`+`hf-hub 1.0.0`, `cpal 0.18.2`+`rubato 5.0.1`, `russh 0.64.1 (ring)`+`russh-sftp 3.0.1`+`russh-config 0.58.0`, `axum 0.8.9`+`rcgen 0.14.10`+`rustls 0.23.46 (ring)`+`tokio-rustls 0.26.6`+`qrcode 0.14.1` all compile. | [VERIFIED-HERE] (`cargo check`/build) |
| 6 | **C: is 100% full** (35 MB free at one point; 1.4 GB now). sherpa debug artifacts = 2.4 GB. Put `CARGO_TARGET_DIR` on D: for probes/spikes; keep sherpa behind an optional cargo feature. | `df -h` |
| 7 | Tauri 2.12.4 + wry 0.57.0 + webview2-com 0.39.1 + windows 0.62.2 already locked. Match these exactly in any new dep (no duplicate `windows`). | `Cargo.lock` |

---

## 1. Embedded browser pane + design mode

### Recommendation (ranked)
1. **Tauri child webview** (`Window::add_child` + `WebviewBuilder`, cargo feature `unstable`) - tauri 2.12.4. Only option giving real navigation events, devtools, init-script injection, screenshot, no X-Frame-Options limits.
2. **Separate `WebviewWindow`** (stable API, no `unstable`) - fallback if multiwebview breaks on upgrade; kills z-order problem, worse UX (floating window).
3. **iframe** - reject for general URLs: XFO/CSP `frame-ancestors` blocks, app CSP (`default-src 'self'`) blocks frames, no nav events/devtools/screenshot, cross-origin DOM unreachable. Only OK for localhost dev servers that send no frame headers.

| Dim | child webview | separate window | iframe |
|---|---|---|---|
| Nav events/back/fwd/reload | yes (`on_navigation`, `on_page_load`, `reload()`, `navigate()`, eval `history.back()`) | same | none |
| Picker injection | `initialization_script` | same | `_for_all_frames` hits app webview too |
| Screenshot | CDP / WKWebView snapshot | same | no |
| DOM menu overlap | **broken** (native HWND above DOM) | n/a | works |
| API stability | `unstable` | stable | stable |

### Verified API surface (tauri 2.12.4 source) [DOCS/source]
- `Window::add_child(builder, pos, size)` is `#[cfg(all(desktop, feature="unstable"))]`; JS-side `create_webview` is gated by the same feature. Do creation from a Rust command, not JS.
- `WebviewBuilder`: `on_navigation(Fn(&Url)->bool)`, `on_page_load`, `on_new_window` (Allow/Create/Deny), `on_document_title_changed`, `on_download`, `initialization_script` (main frame only) / `initialization_script_for_all_frames`, `auto_resize`, `user_agent`, `data_directory`, `incognito`, `proxy_url`, `additional_browser_args` (Windows only), `on_permission_request`.
- `Webview`: `navigate(Url)`, `reload()`, `eval`, `set_bounds/set_position/set_size`, `hide/show`, `set_focus`, `open_devtools/close_devtools/is_devtools_open`, `set_zoom`, `clear_all_browsing_data`, `print`, `with_webview`.
- Devtools: works in debug; release needs tauri cargo feature `devtools`.
- Known issue (doc comment in `WebviewBuilder::new`): on Windows building a webview in a **synchronous** command/event handler deadlocks (WebView2 issue wry#583). Use `async` commands.
- Cargo: `tauri = { version = "2.12", features = ["unstable", "devtools"] }`.

### Page -> app messaging from arbitrary http(s) page
Option A, Tauri `remote` capability [DOCS + source-verified]: `capability.remote.urls` uses URLPattern; `webviews:["browser"]`. Source (`webview/mod.rs` ~2080) proves remote origins are **always** ACL-checked, "remote content can never reach custom commands unless an explicit `remote` capability has been configured". Catch for Erka: custom app commands only get `allow-<cmd>` permissions if you define an `AppManifest` in `build.rs`, and once an app manifest exists **all 54 existing `#[tauri::command]`s need listing/permissions too** (`has_app_acl_manifest` forces ACL for local origin as well). Alternative: tiny inline plugin crate (plugin commands are always ACL-gated, permissions via `tauri_plugin::Builder`). Both = real work + permanent remote-IPC attack surface on arbitrary pages. Also: never put `windows:["main"]` in the remote capability (a matching window label grants all its webviews, child included). CVE-2026-42184 (`is_local_url` origin confusion on Windows) fixed <=2.10.3/2.11.1; we are on 2.12.4 - OK, but it shows this surface has had bugs.

Option B (recommended), **navigation sentinel**, no IPC exposure [UNVERIFIED, needs 1-day spike]: init script captures pristine `location.assign` in a closure, per-session nonce baked in (not on `window`). Picker does `assign("http://erka-pick.invalid/#"+nonce+"."+b64(json))`; Rust `on_navigation` sees host, validates nonce, emits Tauri event, returns `false` (cancel). Works the same on WebView2 (`NavigationStarting`) and WKWebView (`decidePolicyForNavigationAction`). Payload limit ~ URL length; fine for selector+rect+outerHTML snippet. Spike must confirm: cancelled nav doesn't flash/stop page loads, CSP `navigate-to` absent, `beforeunload` dialogs.

Option C, platform-native: WebView2 `chrome.webview.postMessage` is already consumed by wry's own handler (Tauri IPC parser would reject foreign messages), so you'd go CDP `Runtime.addBinding` + `GetDevToolsProtocolEventReceiver("Runtime.bindingCalled")` on Windows and a `WKScriptMessageHandler` via objc2 on macOS. Two code paths + unsafe; only if B fails.

Fallback channel needing zero plumbing: `on_document_title_changed` (picker writes `document.title="__erka:..."`). Ugly, flickers tab title; last resort.

### Screenshot
- Windows: use **CDP `Page.captureScreenshot`** via `ICoreWebView2::CallDevToolsProtocolMethod` (webview2-com-sys 0.39.1 has it; `CallDevToolsProtocolMethodCompletedHandler` exists). Returns JSON `{"data":"<base64 png>"}`, supports `clip` (use picked element rect) and `captureBeyondViewport`. `CapturePreview(format, IStream, handler)` also exists but needs `SHCreateMemStream` + `windows` feature plumbing and captures viewport only (MS Q&A: full page needs CDP). Call after content loaded.
- macOS: `PlatformWebview::inner()` -> `*mut c_void` WKWebView; call `takeSnapshotWithConfiguration:completionHandler:` via `objc2-web-kit` (NSImage -> PNG). [DOCS only]
- Access: `webview.with_webview(|pv| ...)`; Windows `pv.controller()` returns `ICoreWebView2Controller` (verified in tauri src), `.CoreWebView2()` for the webview. Add `webview2-com = "0.39"`, `windows = "0.62"` to match lock.

### Z-order / layout pitfalls
- Native child always paints over DOM; z-index/clip-path ineffective. Mitigations: (a) `hide()` child (or shrink) whenever a menu/modal/toast overlaps, swap in the last screenshot as an `<img>` placeholder; (b) layout so overlays never intersect pane rect; (c) overlay UI in a second transparent child webview created later (wry 0.40 puts new child at top of z-order on Windows) [UNVERIFIED].
- Bounds sync: ResizeObserver + `getBoundingClientRect` -> `set_bounds` via async command each frame during drag/resize; logical vs physical px; throttle.
- Focus: child steals keyboard; host shortcuts/Escape won't fire while it has focus (recent commit b88d554 already fights this for terminals). Forward via init script `keydown` -> sentinel, or `set_focus` back.
- Window `dragDropEnabled: true` on main window may interact with child on Windows [UNVERIFIED].
- Shares WebView2 environment/profile with app (cookies, storage) unless `data_directory`/`incognito`; different env cannot be mixed in same window.
- Minimal sketch (uncompiled):
```rust
#[tauri::command]
async fn browser_open(app: tauri::AppHandle, url: String, r: [f64; 4]) -> Result<(), String> {
    use tauri::{webview::{WebviewBuilder, NewWindowResponse}, WebviewUrl, LogicalPosition, LogicalSize, Manager, Emitter};
    let win = app.get_window("main").ok_or("no main window")?;
    let ev = app.clone();
    let b = WebviewBuilder::new("browser", WebviewUrl::External(url.parse().map_err(|e| format!("{e}"))?))
        .initialization_script(PICKER_JS.replace("__NONCE__", &nonce()))
        .on_navigation(move |u| {
            if u.host_str() == Some("erka-pick.invalid") { /* verify nonce, decode u.fragment() */ ev.emit("browser:pick", u.fragment()).ok(); return false; }
            ev.emit("browser:nav", u.as_str()).ok(); true })
        .on_new_window(|_, _| NewWindowResponse::Deny);
    win.add_child(b, LogicalPosition::new(r[0], r[1]), LogicalSize::new(r[2], r[3])).map_err(|e| e.to_string())?;
    Ok(())
}
```
Remote capability JSON (only if Option A): `{"identifier":"browser-remote","webviews":["browser"],"remote":{"urls":["http://localhost:*/*","http://127.0.0.1:*/*","http://[::1]:*/*"]},"permissions":["allow-browser-pick"]}`.

Adoption risk: `unstable` flag = API may change between minors; multiwebview open bugs historically on resize/focus (tauri-runtime-wry 2.2.0 notes fixed child-bounds regressions). Pin tauri minor, wrap behind one module.

---

## 2. SSH remote projects

### Verified facts
- russh **0.64.1** (2026-10-05); features `default=[flate2, aws-lc-rs, rsa]`, alt `ring`. **Use `default-features=false, features=["ring","flate2","rsa"]`** -> compiles here (3m57s). Default fails (NASM). [VERIFIED-HERE]
- russh pulls `ssh-key 0.7.0-rc.11` (a **release candidate** crypto dependency) and `pageant 0.2.4` on Windows. Adoption risk: pre-1.0, frequent minor bumps (0.5x -> 0.64 within a year), RC transitive dep.
- Agent (source-verified, `src/keys/agent/client.rs`): `AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")` (cfg windows), `AgentClient::connect_pageant()` (cfg windows), `connect_env()`/`connect_uds()` (unix). `authenticate_publickey_with(user, pubkey, hash_alg, &mut agent)` signs via agent. Handles agent certs.
- Known hosts: `russh::keys::known_hosts::{check_known_hosts, check_known_hosts_path, learn_known_hosts[_path]}`; supports hashed `|1|` entries. Unknown host -> `Ok(false)` -> app must TOFU-prompt then `learn_known_hosts`.
- Channels: `channel_open_session`, `exec`, `request_pty`, `window_change`, `channel_open_direct_tcpip` (port forwarding for remote dev server -> browser pane), `connect_stream(config, any AsyncRead+AsyncWrite, handler)` (custom transport).
- russh-sftp **3.0.1**: `SftpSession::new(stream)`, `read_dir`, `open/create`, `read`, `metadata`, `canonicalize`, `remove_file`...
- russh-config **0.58.0** limits (source-read): parses Host/User/HostName/Port/IdentityFile/ProxyCommand/ProxyJump fields, `stream()` honours **ProxyCommand only** (ProxyJump parsed but never dialed), **no Include, no Match**, splits on single space (no `Key=Value`). Don't depend on it.
- Win32-OpenSSH 9.5p1 at `C:\Windows\System32\OpenSSH\ssh.exe`; **no ControlMaster/ControlPath** (Win32-OpenSSH issues #1328 "Support for Control Master" and #405 both "0 - Backlog"). `ssh -G localhost` on Git ssh printed `controlmaster false`. The Git-for-Windows `/usr/bin/ssh` 10.3 is an MSYS build: it uses `SSH_AUTH_SOCK`, not the Windows `openssh-ssh-agent` pipe [DOCS/knowledge, not run: no agent on this box]. No sshd locally, so no live SSH test was possible.
- Prior art: Zed remote dev uses system `ssh`, ControlMaster, uploads a headless server binary to `~/.zed_server` (zed.dev docs).

### Recommended design (ranked)
1. **Phase 1: system ssh for everything behind one `RemoteHost` trait.** Terminals/agents: spawn `%SystemRoot%\System32\OpenSSH\ssh.exe -tt -o ServerAliveInterval=15 host [cmd]` inside the existing portable-pty path (zero new deps, full ssh_config/Include/Match/ProxyJump/FIDO/agent fidelity; prompts appear in terminal). Prefer the System32 binary (Windows agent pipe) and fall back to PATH `ssh`; do not pick whichever `ssh` PATH resolves first. File/git ops: `ssh -o BatchMode=yes -o ConnectTimeout=8 host -- <cmd>`. Cost: full handshake per op on Windows (no ControlMaster). Mitigate: batch ops (one `sh -c` returning combined output), cache, debounce git status.
2. **Phase 2 (trigger: measured op latency complaints): russh exec/SFTP "ops plane" in erkad**, terminals still on ssh.exe. One persistent connection per host, N concurrent exec channels, SFTP for file tree, `direct_tcpip` for dev-server forwards. Config resolution via `ssh -G <alias>` (system OpenSSH resolves Include/Match/ProxyJump correctly; parse `key value` lines) rather than russh-config; ProxyJump/ProxyCommand hosts: spawn `ssh -W %h:%p jump` and feed its stdio to `client::connect_stream`. Auth order: agent pipe -> Pageant -> IdentityFile (+ passphrase via UI) ; host key via `known_hosts` + TOFU dialog.
3. **Full russh incl. terminals** (shell channel bytes feed the existing alacritty_terminal emulator instead of a PTY child). One auth, one connection, best perf, but loses ssh.exe fidelity (FIDO sk keys, jump, Include) and puts all remote-terminal reliability on a pre-1.0 stack. Only if Phase 2 proves solid.
4. Remote helper binary (Zed/VS Code model): best at scale, but needs cross-compiled Linux/macOS binaries from a Windows box with no Docker/WSL. Out of scope now.

Pitfalls: `-tt` with Windows ConPTY resize propagation (test `SIGWINCH`); remote login-shell banners/rc noise corrupt command output (use `sh -c`, delimiters, `2>&1` discipline); quote/escape for cmd vs bash (pass argv, not shell string, to ssh.exe; remote side still needs POSIX quoting); `StrictHostKeyChecking` prompts hang BatchMode (use `accept-new` opt-in); path separators (remote always `/`); keepalives; reconnect/tmux for long agent runs.

russh snippet (compiles with ring features, [VERIFIED-HERE] `cargo check`):
```rust
let mut s = client::connect(Arc::new(client::Config::default()), (host, port), H{..}).await?;
#[cfg(windows)] let mut agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await?;
for id in agent.request_identities().await? {
    if s.authenticate_publickey_with(user, id.public_key().into_owned(), None, &mut agent).await?.success() { break; }
}
let mut ch = s.channel_open_session().await?;  ch.exec(true, "git -C /srv/app status --porcelain").await?;
while let Some(m) = ch.wait().await { if let ChannelMsg::Data{data} = m { /* collect */ } }
```
(`H::check_server_key` takes `&PublicKeyOrCertificate::PublicKey{key,..}` and calls `known_hosts::check_known_hosts(host, port, key)`.)
Cargo: `russh = { version="0.64.1", default-features=false, features=["ring","flate2","rsa"] }`, `russh-sftp = "3.0.1"`.

---

## 3. Mobile companion (LAN web/PWA served by erkad)

### Verified facts
- axum **0.8.9** `ws` feature; pins `tokio-tungstenite 0.29.0` (standalone latest is 0.30.0) -> use axum's `WebSocketUpgrade`, do not add tokio-tungstenite separately (version split). `Message::Text(Utf8Bytes)`.
- qrcode **0.14.1** (last release 2024-07; stable, tiny): `QrCode::new(url)?.render::<svg::Color>().min_dimensions(256,256).build()` -> SVG string; features `default=[image,svg]`, use `default-features=false, features=["svg"]`.
- rcgen **0.14.10** `generate_simple_self_signed(vec![ip])` with `default-features=false, features=["ring","pem"]` OK. rustls **0.23.46** with `default-features=false, features=["ring","std","tls12"]`; `ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))` compiled here. tokio-rustls **0.26.6** `features=["ring"]`.
- axum-server **0.8.0**: `tls-rustls` = rustls+**aws-lc-rs** (fails here); `tls-rustls-no-provider` = no provider, you add ring. Prefer axum + tokio-rustls `TlsAcceptor` + hyper-util manual accept loop, or axum-server with `tls-rustls-no-provider` + `rustls` ring.
- PWA install (MDN): needs `https` or localhost; manifest with 192+512 icons, `start_url`, `display`; service worker **not** required to install. `beforeinstallprompt` not on iOS. So **plain http://LAN-IP is not installable and not a secure context** (no service worker, no `getUserMedia`, no clipboard API, no WebCrypto). iOS "Add to Home Screen" over http [UNVERIFIED].
- Self-signed cert: browser interstitial per device; Chrome treats cert errors as blocking service worker/install; WebSocket works after manual accept. Low value.
- Tailscale present on this machine: `tailscale cert` gives real Let's Encrypt cert for `<machine>.<tailnet>.ts.net` (90-day renewal, name is logged in public CT logs; MagicDNS+HTTPS must be enabled). Gives secure context for free, off-LAN reach too.
- Helper versions: if-addrs 0.15.0 / local-ip-address 0.6.13 (pick LAN IP), getrandom 0.4.3 (token), subtle 2.6.1 (const-time compare), rust-embed 8.13.0 (embed PWA assets).

### Recommended minimal secure design
Threat model first: this UI is a **remote shell on the dev machine**. Token theft = RCE. Treat accordingly.
1. **Off by default.** Explicit "Enable mobile access" toggle in app; server lives in erkad (survives UI), listens only when enabled.
2. Bind to the selected private IPv4 (RFC1918) + fixed port, **not 0.0.0.0**; deterministic port (e.g. 4817) to avoid duplicate-process drift. Windows Firewall will prompt on first non-loopback bind; scope to Private profile; document.
3. **Pairing**: server mints 256-bit one-time pairing code (TTL 2 min, single use). QR encodes `http(s)://IP:PORT/#p=<code>` - **fragment**, so it never hits server logs/Referer. Page JS POSTs code to `/pair`; **desktop shows "Approve device X?"**; server returns per-device 256-bit token (store only its hash; listable/revocable; idle expiry). Token sent as first WS message or `Sec-WebSocket-Protocol`, never in query string (my compile sketch used `?t=` for brevity only).
4. WS hardening: Origin == Host check (CSWSH), const-time compare (`subtle`), rate-limit failed pairs, max frame size, ping/idle timeout, per-device scopes (read-only default; input/write needs second toggle).
5. **Transport**: plain HTTP is only acceptable on a trusted home LAN with a visible warning; token + terminal output are sniffable. Recommended secure path = optional `tls_cert`/`tls_key` config (user runs `tailscale cert`), served via rustls **ring** provider. Don't build self-signed UX. Mobile mic dictation needs the secure path; otherwise use the phone keyboard's built-in dictation.
6. Assets: embed a small static SPA (rust-embed) + `manifest.webmanifest`; skip service worker unless HTTPS is on.
Cargo (daemon): `axum = { version="0.8.9", features=["ws"] }`, `qrcode = { version="0.14.1", default-features=false, features=["svg"] }`, `rustls`/`tokio-rustls`/`rcgen` only if TLS is built in (all `ring`). Do **not** enable any default `aws-lc-rs` feature.
Pitfalls: multiple NICs/VPN adapters (let user pick IP; re-render QR on change); IP changes via DHCP break paired URL (token survives, URL doesn't - consider reachable-host list); `--features` unification: one stray crate enabling `rustls/aws_lc_rs` re-breaks the build here - add a CI `cargo tree -i aws-lc-sys` guard.

---

## 4. Local/offline dictation

### Candidate matrix (this machine)
| Option | Builds w/o cmake/clang? | Offline | vi+en | Verdict |
|---|---|---|---|---|
| **sherpa-onnx 1.13.8** (k2-fsa, `sherpa-onnx-sys` downloads prebuilt) | **Yes** [VERIFIED-HERE] | yes | vi zipformer + Whisper multi | **Pick** |
| whisper-rs 0.16.0 | **No** (cmake + libclang) [VERIFIED-HERE] | yes | Whisper | Reject here |
| ort 2.0.0-rc.15 + Whisper ONNX | compiles (`download-binaries`) [VERIFIED-HERE] | yes | Whisper | Reject: you hand-write mel/KV-cache decode/tokenizer; ort still RC 16 months (rc.10 2025-06 -> rc.15 2026-10) |
| candle-transformers 0.11.0 Whisper | compiles (pure Rust) [VERIFIED-HERE] | yes | Whisper | Fallback only. CPU speed not benchmarked here; no MKL/BLAS on stock Windows -> expect slow for base/small [UNVERIFIED]. hf-hub 1.0.0 drags `hf-xet`/xet-* stack |
| Windows.Media.SpeechRecognition (`windows` 0.62.2) | yes | **No for dictation**: predefined dictation/web-search grammars are "performed by a remote web service", need Online speech recognition privacy setting (MS docs). Offline only list/SRGS constraints | vi support depends on installed lang | Reject. Also member list has no file/stream input -> **cannot transcribe a WAV**, so not testable by SAPI WAV |
| Web Speech `webkitSpeechRecognition` | n/a | cloud-backed | - | Reject. WebView2: no official support found, Edge reports spotty/"language not supported"; WKWebView: WebKit bug 239816 (prompt never appears). Feature detection lies. [anecdotal; not run] |

### sherpa-onnx facts [VERIFIED-HERE unless noted]
- crate `sherpa-onnx = "1.13.8"` (2026-09-11; releases ~every 1-4 weeks, 31 versions; 632k downloads). Features: `default=["static"]`, `shared`. build.rs downloads `sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib.tar.bz2` (123,206,268 B) from GitHub releases (needs network at build; env `SHERPA_ONNX_LIB_DIR`/`SHERPA_ONNX_ARCHIVE_DIR` for offline/CI cache). Build deps pure-Rust-ish (`ureq 2`, `tar`, `bzip2`, `zip`).
- Static lib is **/MT**; Rust defaults to /MD -> `LNK4098 defaultlib 'LIBCMT' conflicts` warning; link succeeded and ran. Alternative `shared` feature copies DLLs next to exe (must be bundled in Tauri `resources`). Not evaluated further.
- Artifacts: 2.4 GB in dev target (C: is full -> use D:). Release exe size [UNVERIFIED]; isolate behind optional feature/crate (`erka-stt`) so normal dev loop skips it.
- API (source-read): `OfflineRecognizerConfig::default()`, fill `model_config.whisper.{encoder,decoder,language,task}` or `.transducer.{encoder,decoder,joiner}` + `tokens`, `num_threads`; `OfflineRecognizer::create(&cfg)`; `create_stream()`, `accept_waveform(sr, &[f32])`, `decode(&s)`, `s.get_result().text`; `Wave::read(path)`; resampler/VAD (silero/ten) included.
- Measured (4 threads, Windows 10 dev box, Rust debug profile but C++ release lib; one run each, no warm-up - indicative only):

| Model | Audio | Load | Decode | Text |
|---|---|---|---|---|
| whisper-tiny int8, lang=en, SAPI Zira WAV "Please open the project and run the unit tests for the terminal daemon." | 4.4 s | 5.6 s | 2.2 s | "Please open the project and run the unit tests for the terminal damen." |
| zipformer-vi-30M-int8, test_wavs/1 | 2.4 s | 6.4 s | 0.16 s | "NHỮNG NƠI ĐÃ KHỐNG CHẾ ĐƯỢC CĂN BỆNH" (plausible) |
| zipformer-vi test_wavs/2 | 1.5 s | 12.5 s | 0.50 s | "ÂM LƯỢNG TV GIẢM" |
| zipformer-vi test_wavs/0 | 3.7 s | 9.9 s | 0.61 s | "RỒI CŨNG HỖ TRỢ CHO LÂU LÂU CŨNG CHO GẠO CHO NÀY KIA" |
| zipformer-vi on **English** SAPI WAV | 4.4 s | 9.7 s | 1.06 s | "FESTIR ANNI UNITED DAYMOND" (garbage: vi-only model) |
Load 5-12 s is high (model files on D:, possibly AV scanning / ORT init); load once, keep resident in a worker. Vietnamese output is uppercase, no diacritic-free issues but **no punctuation/casing** (sherpa has an offline punctuation module, unevaluated). Correctness of vi transcripts not checked against references beyond eyeballing.

### Models, sizes, hosting [verified via HEAD/HF API]
- Vietnamese: `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2` **26,442,384 B**, `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2`; source model `hynt/Zipformer-30M-RNNT-6000h` (README). Older `...-vi-int8-2025-04-20` 60.2 MB. Third-party (phostt docs) cite ~7.7% WER on GigaSpeech2-vi - secondary, unverified.
- English/multilingual Whisper ONNX (HF `csukuangfj/sherpa-onnx-whisper-{tiny,base,small}`, individual files so no tar.bz2): tiny int8 = enc 12.9 + dec 89.9 + tokens 0.8 = **~103 MB**; base int8 = 29.1 + 130.7 + 0.8 = **~161 MB**; small int8 = 112.4 + 262.2 + 0.8 = **~376 MB**. Release tarballs (fp32+int8 both): tiny 116 MB, base 208 MB, small 639 MB, turbo 564 MB. SenseVoice (zh/en/ja/ko/yue, **no vi**) 166 MB.
- ggml (only if whisper.cpp later; HF `ggerganov/whisper.cpp`): tiny 77.7 MB (q5_1 32.2), base 148 MB (q5_1 59.7), small 488 MB (q5_1 190), medium 1.53 GB (q5_0 539), large-v3-turbo-q5_0 574 MB. Not usable here (no cmake/clang).
- Hosting: download on first use into app data dir from GitHub releases / HF (both 200 OK, no auth), show progress, pin SHA-256 in code (compute at integration; not done), resume support. Do not bundle in installer.
- Vietnamese gap: sherpa catalog has no Whisper-vi; PhoWhisper (VinAI, BSD-3, fine-tuned on 844 h) exists on HF but no ONNX/ggml conversion found - skip unless vi accuracy of zipformer disappoints.

### Mic capture
- **Recommend `cpal 0.18.2` + `rubato 5.0.1`** (compile-verified; WASAPI on Windows via `windows` crate, CoreAudio on macOS; do NOT enable `asio` feature - needs clang/bindgen). Capture device-native f32 -> downmix -> resample 16 kHz mono -> push into sherpa stream. Keeps audio in Rust/erkad/worker, no webview-focus or permission-UI divergence, enables push-to-talk while the child browser webview has focus. Needs Windows Settings > Privacy > Microphone > "desktop apps" on; macOS needs `NSMicrophoneUsageDescription` in Info.plist (also in dev, prompt attaches to the launching terminal).
- Fallback `getUserMedia` in Tauri webview: Tauri 2.12 has `WebviewBuilder::on_permission_request` / `Builder::on_permission_request` returning `PermissionResponse::Allow` (source: Windows = WebView2 `PermissionRequested`, macOS = `requestMediaCapturePermission`). AudioContext/AudioWorklet gives 16 kHz mono for free and browser AGC/noise-suppression. Required for the mobile PWA too (needs HTTPS, see 3). Apple forum reports of silent hangs in WKWebView even with plist keys [anecdotal].

### Recommendation
Engine: **sherpa-onnx 1.13.8** (static). Models: Vietnamese -> zipformer-vi-30M-int8 (26 MB); English/other -> Whisper **base int8** (161 MB; step up to small int8 376 MB for accuracy). User picks dictation language (setting/hotkey); no auto language-ID (KISS). Capture with cpal+rubato, record-then-transcribe first (push-to-talk), add Silero VAD chunking later. Run recognizer in a dedicated worker thread/crate with model resident.
Test (reproduces here, ~1 min): synth with SAPI then transcribe:
```powershell
Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop')
$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('sapi-en.wav',$f); $s.Speak('Please open the project and run the unit tests'); $s.Dispose()
```
Assert normalized transcript contains key words (tiny misses "daemon" -> use base for the real gate). Only en-US voices (David, Zira) are installed; **no Vietnamese SAPI voice** -> vi regression test must use the model's bundled `test_wavs` or recorded fixtures. Probe code/models left at `D:\erka-research-tmp\{models,wav}` (132 MB, safe to delete); probe crates in the session scratchpad.

---

## Limitations / not covered
- No live SSH, WebView2, or macOS testing (no sshd/WSL, no Mac, no Tauri GUI spike). Sections 1 and 2 Windows-agent behaviour are source/docs-based.
- Candle/ort speed on CPU not benchmarked; sherpa timings are single-run, debug Rust profile.
- Vietnamese accuracy judged by eyeballing 3 bundled clips; Whisper tiny/base/small WER on Vietnamese not measured (published FLEURS numbers not retrieved).
- Release-build exe size and installer impact of static sherpa/onnxruntime not measured.
- macOS Apple Silicon behaviour of sherpa prebuilt libs (aarch64/arm64 archives exist in build.rs) not tested.

## Unresolved questions
1. Does a cancelled `on_navigation` to a sentinel `http://erka-pick.invalid/...` fire reliably on WebView2 and WKWebView without side effects? (1-day spike; decides Option B vs plugin-ACL).
2. Is a transparent second child webview viable as a DOM-overlay layer above the browser pane on Windows?
3. Does `dragDropEnabled:true` on the main window break file drop or mouse events around a child webview?
4. Is `webkitSpeechRecognition` actually defined/functional in Tauri's WebView2 (we recommend not relying on it; quick runtime probe would close it)?
5. Does Git-for-Windows `/usr/bin/ssh` ever see the Windows `openssh-ssh-agent` pipe? (Affects which binary to spawn; test on a box with agent running.)
6. Do users' real ssh configs use ProxyJump/Include/FIDO keys? If yes, Phase 1 (system ssh) stays primary longer.
7. iOS Safari "Add to Home Screen" over plain http: standalone mode or just a bookmark?
8. Static sherpa /MT vs Rust /MD: any runtime risk beyond LNK4098 (allocator crossing)? `shared` feature as safer alternative?
9. Release exe size delta and whether to ship STT as a separate helper exe to keep the main binary lean.
10. Is the repo's C: disk exhaustion (user's, not ours) a CI/dev concern worth a `.cargo/config.toml` target-dir on D:?
