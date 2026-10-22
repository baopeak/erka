# Nhiều phiên SSH trong một project — nghiên cứu & đề xuất giao diện

Ngày: 2026-10-22 · Nhánh: `rebrand/kelpie` · Loại: research/design (chưa code)

## 1. Mục tiêu

- Mở 1 thư mục local làm project, rồi trong project đó mở **nhiều phiên SSH** (một hoặc nhiều host).
- Phiên SSH là **pane hạng nhất**, giống pane agent/shell: split, grid, tab, broadcast, ngủ/đánh thức, resume, inbox.
- Chạy **Claude Code trên server** trong các pane đó (giữ trong tmux).

Ngoài phạm vi: biến git/file panel của project thành remote (đó là "Mở thành project" đã có).

## 2. Hiện trạng code (đã kiểm tra)

| Điểm | Bằng chứng | Ý nghĩa |
|---|---|---|
| Daemon đã nhận `remote` **theo từng session** | `SessionInfo.remote` ([types.ts:33](../../app/src/lib/types.ts#L33)), `RemoteSpec` ([session.rs:69](../../crates/kelpied/src/session.rs#L69)), `build_remote_launch` ([agents.rs:201](../../crates/kelpied/src/agents.rs#L201)) | Backend gần như đủ: `ssh -t`, tmux `new-session -A` theo id session, login shell, prompt đầu |
| Frontend buộc remote vào **project** | `startSession` dùng `sessionRemote(project)` / `sessionEnv(project)` và `cwd = project.remote.path` ([store.ts:586-595](../../app/src/lib/store.ts#L586-L595)) | Đây là nút thắt duy nhất |
| Nút Terminal ở trang SSH host luôn nhảy sang project riêng của host | `connectHost` → `hostProject` ([ssh-hosts.ts:159-176](../../app/src/lib/ssh-hosts.ts#L159-L176)) | Lý do không mở được trong project đang đứng |
| Resume dùng `session.restart` của daemon (giữ nguyên spec) | [store.ts:1060](../../app/src/lib/store.ts#L1060) | Pane SSH resume được, tmux tự re-attach |
| Chat view đã tắt theo **session** remote | [pane-view.tsx:55](../../app/src/components/pane-view.tsx#L55) | Không cần sửa |
| Agent remote không có hook → trạng thái theo output | comment [agents.rs:197-200](../../crates/kelpied/src/agents.rs#L197-L200) | Giữ nguyên, chỉ cần nói rõ trên UI |

Kết luận: tính năng chủ yếu là **frontend + một ít data model**, không cần đổi giao thức daemon.

## 3. Các sản phẩm khác làm thế nào

| Sản phẩm | Mô hình | Bài học cho Kelpie |
|---|---|---|
| **WezTerm** — SSH/mux domains | Mỗi pane thuộc một *domain* (local hoặc ssh). Tạo tab/split theo domain mặc định, domain của pane hiện tại (`CurrentPaneDomain`) hoặc domain chỉ định | **Đích chạy gắn với pane**; split **thừa kế** host của pane đang focus |
| **Windows Terminal** | Tự sinh profile SSH từ `~/.ssh/config`, xuất hiện trong dropdown "+" tab mới | Host đã lưu = một "loại phiên" ngay trong launcher, 1 click |
| **VS Code / Visual Studio** | Dropdown profile cạnh nút "+ terminal"; Visual Studio liệt kê kết nối SSH trong dropdown, mở terminal docked cạnh terminal hiện có | Chọn đích ở **cùng chỗ** chọn loại terminal, không tách sang trang khác |
| **Termius** — Workspaces | Gom nhiều phiên vào một workspace; Split view / Focus mode; broadcast; lưu workspace thành template (host, tên tab, layout, thư mục, lệnh) | Layout đã lưu nên nhớ **host của từng ô** |
| **Orca** (đối thủ parity) | Đích SSH chọn **theo worktree** ("choose an SSH target instead of Local"); chip trạng thái xanh/vàng/đỏ; agent sống trên server, tự reconnect | Chip trạng thái kết nối; nhưng gắn theo worktree thì nặng (git/file remote) — Kelpie đã có tương đương là "Mở thành project" |
| **iTerm2** | Badge (chữ mờ góc phải, vd hostname), đổi profile/màu khi ssh | Badge host + màu theo host trên pane |
| **Warp** | Chưa có; nhiều issue xin màu tab theo host/ssh vì **nhầm tab gây sự cố** | Phân biệt trực quan local/remote là yêu cầu an toàn, không phải trang trí |
| Cộng đồng Claude Code | tmux + ssh, mỗi agent một tmux session, reattach từ máy khác | Kelpie đã làm đúng việc này ở daemon |

## 4. Các phương án

### A. "Chạy trên" theo từng pane (kiểu WezTerm domain) — **đề xuất**

Mỗi lần tạo phiên chọn **đích**: `Máy này` hoặc một host đã lưu. Project giữ nguyên là local.

- **Launcher pane trống** (split/grid cell): thêm hàng chip host phía trên các loại agent.
- **Hộp thoại "Phiên mới"**: thêm hàng `Chạy trên` + ô `Thư mục trên host`.
- **Split thừa kế host** của pane đang focus (như `CurrentPaneDomain`).
- **Grid**: cả grid chạy trên host đã chọn → 4 Claude trên 1 server chỉ 1 thao tác.

Ưu: dùng lại toàn bộ layout/grid/broadcast/inbox/resume; thay đổi nhỏ; khớp mô hình daemon.
Nhược: mỗi lần phải chọn host + thư mục (giải bằng phương án B).

### B. Host gắn với project (bổ sung cho A) — **đề xuất làm cùng A**

Project lưu danh sách `host + thư mục trên host` (vd `prod-api → /srv/app`, `gpu-box → ~/work/app`).
Launcher/hộp thoại chỉ hiện các host này đầu tiên, thư mục điền sẵn. Đây là chỗ thay thế "phải nhớ ssh vào đâu, cd vào đâu".

### C. Gắn đích theo worktree (kiểu Orca)

Worktree tạo trên server, git/file/diff chạy remote. Nặng, trùng với "Mở thành project" sẵn có. **Không đề xuất** cho nhu cầu này.

### D. Giữ nguyên: gõ `ssh` trong shell local

Không tmux tự động, không resume, không dùng mật khẩu đã lưu, agent không có trạng thái. Chỉ là phương án tạm.

## 5. Thiết kế chi tiết (A + B)

### 5.1 Launcher pane trống

```
┌──────────────────────────────────────────────────────────┐
│  Chạy trên:  [● Máy này]  [● prod-api]  [● gpu-box]  [+] │  ← Tab / ←→ đổi đích
│              thư mục: /srv/app                 (sửa)     │  ← chỉ hiện khi là host
│                                                          │
│   [1 Claude]  [2 Codex]  [3 OMP]  [4 Shell]  [+ More…]   │  ← agent có trên host đó
│                                                          │
│   1–9 để chạy · Tab đổi máy · Esc đóng                   │
└──────────────────────────────────────────────────────────┘
```

- Mặc định = host của pane vừa split ra; ô grid mới = host của ô đầu.
- Agent hiển thị = agent tìm thấy trên host (`checkHost().agents`, cache theo host), agent thiếu thì mờ + gợi ý "Cài Claude Code".
- `[+]` mở trang SSH host để thêm/gắn host vào project.

### 5.2 Hộp thoại "Phiên mới"

Thêm 2 hàng, đặt ngay dưới danh sách loại phiên:

```
Chạy trên      [Máy này] [prod-api] [gpu-box] [Host khác…]
Thư mục        /srv/app                      (Chọn…)   ← remoteFolders()
☑ Giữ trong tmux   (mặc định theo host)
```

`Interface: Chat view` tự ẩn khi chọn host (đã có quy tắc này).

### 5.3 Nhận diện pane remote (bắt buộc — tránh gõ nhầm máy)

```
┌─ ● prod-api · /srv/app · Claude Code ───────────── ⋯ ┐   ← header luôn hiện với pane remote
│▌                                                     │   ← viền trái màu host
│▌ > fix the failing migration                         │
│▌                                      prod-api       │   ← badge mờ góc phải (kiểu iTerm2)
└──────────────────────────────────────────────────────┘
```

- Màu = `host.color` (đã có trong vault). Tên tab có tiền tố `● prod-api`.
- Chip trạng thái phiên: xanh = đang chạy; đỏ = ssh đã thoát (mất mạng/sai mật khẩu) + nút **Kết nối lại** (= resume, tmux tự re-attach).
- Sidebar/danh sách session và Inbox hiện `@prod-api` sau tên phiên.

### 5.4 Menu chuột phải trên pane remote

- **Tách cùng host** (phải/dưới) — dùng lại host + thư mục.
- **Mở file trên host** — mở file browser của trang SSH host ở thư mục pane.
- **Mở thành project** — chuyển sang project remote của host (đã có).
- **Port forward…** — mở form forward của host.

### 5.5 Cài đặt project → "Host của project"

```
Host của project
  ● prod-api   /srv/app        [tmux ✓]   [Xoá]
  ● gpu-box    ~/work/app      [tmux ✓]   [Xoá]
  [+ Gắn host đã lưu]
```

Trang SSH host: thêm nút **Mở trong project hiện tại** cạnh "Terminal" / "Claude Code tại đây".

### 5.6 Layout đã lưu

Lưu kèm host + thư mục của từng ô → mở lại layout = dựng lại cả cụm pane trên các server (kiểu workspace template của Termius). Có thể làm ở bước sau.

## 6. Thay đổi data model / code (phác thảo)

| File | Thay đổi |
|---|---|
| [types.ts](../../app/src/lib/types.ts) | `Project.hosts?: { hostId: string; path: string; tmux?: boolean }[]` |
| [remote.ts](../../app/src/lib/remote.ts) | `sessionRemote` / `sessionEnv` nhận `{ dest, port, tmux }` thay vì cả project (project remote gọi qua cùng hàm) |
| [store.ts](../../app/src/lib/store.ts) | `StartOpts.target?: { hostId: string; path: string; tmux: boolean }`; `startSession` ưu tiên target; `launchGrid` truyền target; `splitPicker` ghi host nguồn vào pane trống |
| [ssh-hosts.ts](../../app/src/lib/ssh-hosts.ts) | `connectHost(host, kind, { projectId })`: mở trong project chỉ định thay vì `hostProject`; cache `HostCheck` theo host |
| [pane-view.tsx](../../app/src/components/pane-view.tsx) | `EmptyPane`: hàng chip "Chạy trên"; header + viền màu + badge cho pane remote |
| [new-session-menu.tsx](../../app/src/components/new-session-menu.tsx) | hàng "Chạy trên" / "Thư mục" / tmux |
| [hosts-page.tsx](../../app/src/components/hosts-page.tsx) | nút "Mở trong project hiện tại" |
| locales `en`/`vi` | chuỗi mới (chạy `i18n-check`) |
| e2e `scripts/e2e/ssh_hosts.py` | ca: local project + 2 pane trên test host, split thừa kế, resume sau khi kill daemon |

Daemon: **không đổi**.

## 7. Rủi ro & lưu ý

- **Host key lần đầu**: phải chạy `checkHost` (và hộp Tin cậy) trước khi tạo pane, nếu không ssh hỏi fingerprint trong PTY. Dùng lại `isHostKeyError` + `TrustPanel`.
- **Mật khẩu/askpass**: `sessionEnv` hiện lấy alias từ project → phải lấy từ host đích, nếu không pane remote trong project local không đăng nhập được.
- **Nhầm file**: git panel/diff/search vẫn là **local**; agent remote sửa file trên server. Header pane phải ghi rõ thư mục trên host; cân nhắc tooltip cảnh báo lần đầu.
- **Resume agent**: `findConversation` đọc transcript local — với pane remote phải bỏ qua bước này (dựa vào tmux re-attach), tránh gán nhầm conversation local.
- **Status agent remote** chỉ theo output (không hook) — giữ như project remote.
- **Hai agent cùng thư mục trên host** dễ giẫm chân nhau (Orca cũng cảnh báo) — gợi ý worktree trên host là việc sau.

## 8. Đề xuất triển khai

1. **Giai đoạn 1 (A)**: target theo pane, launcher + hộp thoại, split thừa kế, header/màu/badge, sửa `sessionEnv`, bỏ `findConversation` cho remote, e2e.
2. **Giai đoạn 2 (B)**: host gắn với project + nút "Mở trong project hiện tại" ở trang SSH host.
3. **Giai đoạn 3**: layout đã lưu nhớ host; chip trạng thái + Kết nối lại.

## 9. Nhiều project ↔ nhiều host (quan hệ n–n)

Nguyên tắc: **host là tài nguyên chung** (vault, như hiện tại), **project chỉ giữ liên kết** tới host. Không project nào "sở hữu" host.

```
Vault (chung):     prod-api   gpu-box   staging
                     │  ╲        │        │
Project A ──────── /srv/app   ~/a       ─
Project B ──────── /srv/b      ─      /srv/b
```

- `Project.hosts = [{ hostId, path }]` là **tham chiếu**: một host gắn được vào nhiều project, mỗi project một thư mục riêng; một project gắn được nhiều host.
- Cái gì thuộc host (địa chỉ, đăng nhập, mật khẩu, màu, theme, tmux mặc định, port forward) sửa **một chỗ**, mọi project thấy ngay. Project chỉ giữ thư mục (+ tuỳ chọn ghi đè tmux).
- Project A cần host "của" project B: launcher có `Host khác…` → ô tìm toàn bộ vault (giống thanh quick connect của Termius). Chạy được ngay, không cần gắn trước; có ô `☐ Gắn vào project này` để lần sau hiện sẵn.
- Gỡ liên kết ≠ xoá host. Xoá host trong vault → các project liên kết hiện "host đã xoá" và pane cũ vẫn resume được nếu `RemoteSpec` còn hợp lệ.
- tmux đặt tên theo id phiên (`kelpie-<id>`) → hai project dùng chung host không đụng nhau.
- **Cảnh báo giẫm chân**: Kelpie biết mọi phiên của mọi project → khi mở agent ở `prod-api:/srv/app` mà project khác đang có agent ở đúng thư mục đó, launcher hiện "1 agent của project B đang chạy ở đây".
- Trang SSH host: thêm cột "Dùng trong project: A, B" để thấy quan hệ ngược.

## 10. Học từ Termius (ảnh chụp + docs)

| Termius có | Kelpie hiện tại | Đề xuất |
|---|---|---|
| Thanh **"Find a host or ssh user@hostname… Connect"**: tìm host và kết nối nhanh chung một ô | Chỉ có "Tìm host" | Gộp: gõ tên → lọc; gõ `user@host[:port]` + Enter → kết nối tạm, kèm nút "Lưu host". Dùng lại ô này cho `Host khác…` trong launcher. **Nên làm** |
| **Icon OS tự nhận** (logo Ubuntu trên thẻ host) | `checkHost` đã trả về `os` nhưng không hiển thị | Lưu `os` sau lần kiểm tra, hiện icon distro trên thẻ/pane header. **Rẻ, nên làm** |
| **Tab mang tên + màu host** (tab xanh "BAOPEAK SGN") | Tab theo project/phiên | Trùng với đề xuất 5.3: tiền tố `● host` + màu host trên tab và pane |
| **Theme theo host** (bảng Themes ở side panel, "phân biệt nhanh các host") | Chỉ có `terminalTheme` toàn cục ([types.ts:175](../../app/src/lib/types.ts#L175)) | `SshHost.terminalTheme`: pane chạy trên host dùng theme của host → prod đỏ, staging xanh. Chống gõ nhầm máy mạnh nhất. **Nên làm** |
| **Snippets** ({}), chạy từ side panel hoặc trên nhiều host | Có Lệnh nhanh (theo project) + "Chạy lệnh trên N host" (gõ tay) | Cho "Chạy lệnh trên host đã chọn" chọn từ Lệnh nhanh; Lệnh nhanh thêm phạm vi theo host |
| **Side panel trong terminal** (Ctrl+.): autocomplete, snippets, history, themes | Không có | Chỉ cần nhóm Lệnh nhanh + Theme cho pane đang focus; autocomplete/history cần shell integration trên server → **bỏ qua** |
| **Logs** kết nối | Chỉ `lastConnected` | Nhật ký kết nối (giờ, host, project, thành công/lỗi) ở trang SSH host. Ưu tiên thấp |
| Lưới thẻ / danh sách | Danh sách | Ưu tiên thấp |
| Vault đồng bộ cloud / team, Serial, AI command | — | **Không làm**: trái nguyên tắc dữ liệu ở local, ngoài phạm vi |

Kelpie đã hơn Termius ở: Claude Code trên host 1 click, tmux giữ phiên, grid nhiều agent, inbox trạng thái agent.

## Nguồn

- WezTerm SSH & multiplexing: https://wezterm.org/multiplexing.html · https://wezfurlong.org/wezterm/config/lua/SshDomain.html · https://www.mintlify.com/wezterm/wezterm/config/launch
- Windows Terminal dynamic SSH profiles: https://learn.microsoft.com/windows/terminal/dynamic-profiles · https://learn.microsoft.com:443/en-us/windows/terminal/tutorials/ssh
- VS Code terminal profiles: https://code.visualstudio.com/docs/terminal/basics.md · Visual Studio SSH terminal: https://devblogs.microsoft.com/cppblog/integrated-terminal-in-visual-studio-new-ssh-integration-for-linux-targeting/
- Termius Workspaces: https://docs.termius.com/terminal/workspaces
- Orca SSH: https://onorca.dev/docs/ssh
- iTerm2 badge/profile switching: https://github.com/izeau/iterm.nvim · https://dev.classmethod.jp/articles/do-ssh-and-change-bg-color-iterm2/
- Warp issues (màu theo host/ssh): https://upd.dev/warpdotdev/warp/issues/7709 · https://upd.dev/warpdotdev/warp/issues/4243
- Claude Code + tmux remote: https://github.com/anthropics/claude-code/issues/13613 · https://gist.github.com/alxpck/d1e86d9a62e3fc5cf6c1ce52d0a02b10
- Termius docs: https://docs.termius.com/terminal · https://docs.termius.com/terminal/snippets · https://docs.termius.com/terminal/autocomplete-and-shell-integration · https://docs.termius.com/getting-started/quickstart · review: https://www.podfeet.com/blog/2024/08/termius/
- So sánh công cụ đa agent: https://superset.sh/compare/manage-multiple-coding-agent-sessions · https://abralo.com/alternatives

## Câu hỏi chưa giải quyết

1. Làm A trước rồi B, hay làm A+B cùng lúc?
2. Pane remote mặc định có bật tmux không (đề xuất: theo cài đặt của host)?
3. Có cần "Mở trong project hiện tại" trên trang SSH host ở giai đoạn 1 không?
