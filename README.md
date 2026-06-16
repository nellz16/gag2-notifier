# GAG2 Telegram Stock Bot v7

Fix utama v7:

- Stock pipeline (initial fetch, Supabase Realtime, smart fallback) sekarang dimulai **tanpa menunggu** `bot.launch()` selesai.
- Ini memperbaiki kondisi `/diag` menampilkan `Realtime: not-started` dan `Next fallback: -`.
- Menambah `/pollnow` untuk test: fetch Polar dan kirim ke channel hanya kalau hash berubah.
- `/diag` dan `/stats` menampilkan status launch Telegram, Realtime, latest stock, dan next fallback.

## Commands

- `/start` - bantuan
- `/watch` - pilih watchlist dari tombol
- `/add item` - tambah keyword manual
- `/remove` - hapus watchlist
- `/list` - lihat watchlist
- `/now` - lihat stock sekarang tanpa mengirim ke channel
- `/pollnow` - fetch Polar dan proses update jika hash berubah
- `/forcechannel` - paksa kirim stock sekarang ke channel
- `/resetstate` - reset hash agar update berikutnya dianggap baru
- `/diag` - diagnostics
- `/testdb` - test Supabase bot DB
- `/testchannel` - test channel

## Koyeb

Gunakan Dockerfile, exposed port 8000, health path `/healthz`.

## Important env

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `POLAR_SUPABASE_ANON`
- `BOT_SUPABASE_URL`
- `BOT_SUPABASE_SERVICE_ROLE` or `BOT_SUPABASE_SECRET_KEY`
- `REST_FALLBACK_ENABLED=1`
- `REST_FALLBACK_DELAY_SECONDS=30`
