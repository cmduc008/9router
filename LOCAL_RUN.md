# Chuyển từ package sang bản local — giữ account Codex

## Trạng thái đã chuẩn bị

- Repo: `/Users/minhphuongeec/9router`, branch `fix/claude-stream-reliability`.
- Build production đã hoàn tất. Bộ test mock liên quan: **85/85 pass**; guard launcher sau bổ sung: **4/4 pass**; lượt kiểm tra bàn giao cuối: **23/23 pass**.
- Kho package giữ nguyên: `/Users/minhphuongeec/.9router`.
- Theo yêu cầu mới, đã sao chép dữ liệu local vào **`/Users/minhphuongeec/9router/data/production`**, được `.gitignore` loại khỏi Git; thư mục0700/database0600. Snapshot integrity_check=ok,7account/2APIkey/1settings. **Không commit/push dữ liệu này, kể cả khi repo được chuyển private.**
- Backup nhất quán (SQLite backup API, có dữ liệu committed trong WAL): `/Users/minhphuongeec/.9router-local-backups/20261012-110033/`.
- Backup `integrity_check=ok`, có **7 account Codex, 5 bật**, **2 API key**, schemaVersion1/appVersion0.5.99. Không có token/account database trong Git.
- **Chưa thay bản package, chưa chạy bản local với account thật, chưa sửa `.zshrc`.**

Không cần xuất/import lại từng account. Package có thể tiếp tục refresh token sau khi snapshot được tạo, nên **sau khi package dừng phải refresh snapshot một lần** bằng script ở bước3. Đây là chuyển kho dữ liệu một chiều, **không phải đồng bộ hai router chạy song song**. Snapshot có marker `snapshot-pending-refresh`; launcher chặn sử dụng trước khi hoàn tất bước này. Sau khi chạy local, kho `data/production` là nguồn credential mới nhất.

## Sửa đúng luồng nào?

Nhiều account Codex -> endpoint/API key 9router -> biến môi trường `.zshrc` -> Claude Code.

Đã tái hiện và sửa:
1. Forced Codex SSE -> JSON trả `chat.completion` cho Claude khi client retry không streaming. Đã đổi thành Anthropic `type:"message"` bằng utility dùng chung.
2. Stream rỗng, failed/incomplete hoặc EOF trước terminal không còn bị coi là thành công.
3. Ping SSE downstream khi Claude đang chờ; ping không reset watchdog upstream.
4. Output text/tool chỉ có trong terminal snapshot được giữ, không replay delta/tool arguments; đã test trường hợp correlator thiếu/khác nhau.
5. Lỗi upstream status/content-type và cancellation có xử lý rõ ràng.

**Chưa thể xác nhận hết sự cố production** trước khi chạy account thật. Quota, model unsupported, upstream downtime và lỗi mạng vẫn có thể xảy ra; patch không thay logic quota hoặc cam kết bỏ mọi API error.

## Bước 1 — kết thúc Claude trước, giữ terminal khác sẵn

Đọc hết hướng dẫn hoặc mở file này trong editor trước khi dừng package. Thoát session Claude hiện tại bằng `/exit`. Chưa dừng package khi session vẫn đang cần nó.

Không uninstall package. Không chạy cả package và local với cùng database/OAuth accounts.

## Bước 2 — dừng package từ nơi đã mở nó

- Nếu package đang chạy trong terminal: quay về terminal đó và `Ctrl+C`, chờ thoát.
- Nếu chạy qua tray/launcher: dùng chức năng **Quit/Exit** của launcher để nó không tự khởi động server lại.
- Nếu service tự khởi động lại: dừng đúng service/launcher trước; không dùng `killall node`.

Kiểm tra trong terminal:

```sh
lsof -nP -iTCP:20128 -sTCP:LISTEN
lsof "$HOME/.9router/db/data.sqlite"
```

Cả hai cần không còn router giữ cổng/database. `lsof` không có kết quả có thể trả exit1, đây là bình thường. Nếu vẫn có kết quả, **chưa chạy local**; tìm và dừng đúng launcher. Không dùng PID ghi trong cuộc trò chuyện vì PID có thể thay đổi.

## Bước 3 — refresh account rồi chạy local từ kho trong repo (không tracked Git)

Trong terminal dành riêng cho router:

```sh
cd "$HOME/9router"
python3 -I scripts/sync-local-data.py && \
DATA_DIR="$HOME/9router/data/production" PORT=20128 ROUTER_HOST=127.0.0.1 \
  npm run start:local -- --production
```

Lệnh chạy **foreground**: giữ terminal này mở. Không dùng `npm start` mặc định vì script upstream đặt cổng20127. Không chạy lại lệnh `9router` package trong lúc local đang dùng dữ liệu.

Launcher sẽ từ chối nếu production database chưa có, đang được tiến trình khác mở, hoặc cổng đã dùng. Nó không tự dừng package, không tự restore backup, không tạo API key mới.

Log cần thấy:
- `Starting local router at http://127.0.0.1:20128`
- Driver database với đường dẫn `/Users/minhphuongeec/9router/data/production/db/data.sqlite`.

`sync-local-data.py` từ chối khi package còn chạy; chỉ refresh trước lần chạy local đầu tiên. Sau khi hoàn tất nó không cho import lại để tránh ghi đè token đã rotate. Nếu script lỗi, **dừng ở đó**, không tiếp tục lệnh start. Không xóa marker để lách chốt.

Nếu hiện kho `.9router-local-test`, **dừng local**, sửa lại `DATA_DIR`; đó không phải kho production. Nếu launcher báo busy, xử lý bản package còn chạy; không đổi cổng để lách rồi dùng chung dữ liệu.

Không cần rebuild nếu chưa chỉnh code. Khi rebuild sau này:

```sh
DATA_DIR="$HOME/.9router-local-test" NEXT_TELEMETRY_DISABLED=1 npm run build
```

Build không có nghĩa là khởi động production. Không `git pull/reset/clean` làm mất patch chưa commit.

## Các lần chạy sau — KHÔNG sync lại

Bạn đã import một lần. Từ lần sau chỉ chạy:

```sh
cd "$HOME/9router"
DATA_DIR="$HOME/9router/data/production" PORT=20128 ROUTER_HOST=127.0.0.1 \
  npm run start:local -- --production
```

Giữ terminal router mở; mở terminal khác để chạy `claude` hoặc resume. Không chạy lại `sync-local-data.py`, không xóa marker/import lại, không chạy package cũ. Khi muốn dừng, thoát Claude trước rồi Ctrl+C trong terminal router. Nếu cổng đang dùng, đừng mở bản thứ hai.

Kiểm tra thật ngày2026-10-12 sau cutover: listener127.0.0.1:20128, cwd`.next/standalone`, DB`data/production/db/data.sqlite`,7Codex/5bật/2keys; package DB không mở. Request thật non-stream200 trả `type:message`, streaming200 kết thúc `message_stop` không error. Chưa kiểm tra report dài/concurrency hoặc mọi account riêng lẻ.

Cảnh báo `MODULE_TYPELESS_PACKAGE_JSON` là cảnh báo Node reparsing ESM, không phải API error; không tự thêm `type:module` vào standalone package vì có thể ảnh hưởng server CommonJS. Log startup từng tự resume tunnel từ settings cũ; giá trị DB đọc lúc kiểm tra là `tunnelEnabled=false`, không thấy process`cloudflared`. Không coi riêng `public URL healthy` là bằng chứng endpoint Claude đã kiểm thử. Nếu chỉ dùng localhost, giữ Tunnel tắt ở dashboard, không cần công khai URL.

## Bước 4 — dashboard, account, API key

Mở `http://localhost:20128/dashboard`.

1. Đăng nhập bằng tài khoản/mật khẩu dashboard trước đó. Cùng data directory giữ settings và session secret.
2. Kiểm tra danh sách provider/account Codex. Backup ghi nhận7 account,5bật; quota/trạng thái có thể thay đổi.
3. Mở trang quản lý API key/endpoint, tạo key mới nếu muốn. **Key cũ được giữ lại**, không bắt buộc tạo mới để chạy bản clone.
4. Copy key tại dashboard, không gửi nó vào chat hoặc commit vào repo.
5. Giữ authentication bật. Local chỉ bind loopback; không tạo tunnel mới để test. Nếu cần remote/tunnel, cấu hình đó phải được kiểm tra riêng.

## Bước 5 — `.zshrc` cho Claude Code

Mở terminal khác (giữ router terminal chạy). Sao lưu shell config trước khi sửa:

```sh
cp -p "$HOME/.zshrc" "$HOME/.zshrc.before-9router-local.$(date +%Y%m%d-%H%M%S)"
chmod 600 "$HOME/.zshrc"
nano "$HOME/.zshrc"
```

**Sửa block cũ thay vì thêm nhiều block trùng nhau**. Dùng router API key, không dùng access/refresh token Codex:

```sh
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_AUTH_TOKEN="DAN_API_KEY_9ROUTER_TAI_DAY"
export ANTHROPIC_MODEL="cx/gpt-6.1-sol"
export CLAUDE_CODE_SUBAGENT_MODEL="cx/gpt-6.1-sol"
export ANTHROPIC_DEFAULT_OPUS_MODEL="cx/gpt-6.1-sol"
export ANTHROPIC_DEFAULT_SONNET_MODEL="cx/gpt-6.1-sol"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="cx/gpt-6.1-sol"
export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1
```

`cx/gpt-6.1-sol` là mapping bạn đang dùng. Xác minh model đó còn khả dụng ở dashboard; nếu không, chọn đúng model Codex được router/account hỗ trợ, không tự đổi sang model không được cấp quyền. Patch streaming không sửa lỗi unsupported model của upstream.

Cấu hình hiện có còn wrapper `claude-9router` ép `cc-free` cho main, khác model subagent. **Dùng lệnh `claude` trực tiếp** theo hướng dẫn dưới để không đi qua wrapper cũ. Nếu muốn tiếp tục wrapper, cần đổi toàn bộ model override trong wrapper cho khớp model đã xác minh.

Không để `ANTHROPIC_API_KEY` cũ từ dịch vụ khác xung đột với router auth. Trong terminal dành riêng để thử router:

```sh
source "$HOME/.zshrc"
unset ANTHROPIC_API_KEY
```

Không in `env`, `echo $ANTHROPIC_AUTH_TOKEN`, không paste key vào chat. `.zshrc` không đặt trong repo.

## Bước 6 — test thật rồi resume

Thử session ngắn trước:

```sh
cd "$HOME"
claude --model "$ANTHROPIC_MODEL"
```

Gửi yêu cầu đơn giản, ví dụ “Trả lời OK”. Sau đó thử tool-use có kiểm soát và response dài; chưa fan-out nhiều subagent ngay từ đầu. Kiểm tra terminal router nếu gặp lỗi; che token/email/prompt nhạy cảm trước khi chia sẻ log.

Thoát session thử bằng `/exit`, rồi resume cuộc trò chuyện này:

```sh
cd "$HOME"
claude --resume bd98dc10-42b3-44a3-af61-01bddfcf6254
```

Hoặc dùng `claude --resume` và chọn đúng hội thoại. Không dùng `--continue` nếu vừa tạo session thử vì nó có thể tiếp tục nhầm session đó.

Sau resume, nhắn: “Đã chạy bản local ở20128, dùng ~/9router/data/production và đã thay API key. Kiểm tra giúp luồng thật.” Không gửi key.

## Nếu cần quay về package

1. Dừng local bằng `Ctrl+C` trong terminal router.
2. Kiểm tra cổng/database không còn mở.
3. Không chạy package mặc định trên `~/.9router` sau khi local đã refresh token: kho package cũ có thể không còn credential hợp lệ. Trước rollback cần kiểm tra package có thực sự hỗ trợ trỏ `DATA_DIR` sang kho local mới nhất hay chuyển dữ liệu nhất quán về; hỏi trợ giúp thay vì copy đè hoặc chạy thử hai bản.
4. API key tạo mới nằm trong kho `data/production`; package mặc định không tự nhìn thấy thay đổi đó. Không restore backup chỉ để lấy lại key cũ.

**Không chép đè backup cũ khi rollback nếu token đã refresh**, vì refresh token trong backup có thể mất hiệu lực. Nếu có lỗi schema/database, dừng cả hai và dùng hướng dẫn sửa dữ liệu riêng. Không delete WAL/SHM của database đang mở.

## Kiểm thử offline khi cần

```sh
DATA_DIR="$HOME/.9router-local-test" npm --prefix tests test -- \
  unit/codex-claude-stream-errors.test.js \
  unit/codex-claude-nonstream.test.js \
  unit/claude-stream-lifecycle.test.js \
  unit/start-local-guard.test.js \
  translator/codex-terminal-snapshot.test.js
```

Chạy từ `~/9router`. Các test này mock upstream/persistence, không cần key thật. Toàn repo có lỗi test có sẵn; không chạy các test live/provider chỉ để chứng minh patch này.
