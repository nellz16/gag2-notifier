# GAG2 Telegram Stock Bot v5

Production bot for Grow A Garden 2 stock notifications using Polar Supabase as upstream.

## What changed in v5

- Watchlist is now saved with `upsert`, not `update`, so the row is created even if the first `/start` DB upsert silently failed.
- Callback button errors are shown as Telegram alert instead of being hidden in logs.
- Added diagnostic commands:
  - `/diag` checks DB + channel access.
  - `/testdb` creates/updates your user row and tests watchlist saving.
  - `/testchannel` sends a test message to the configured Telegram channel.
  - `/forcechannel` sends the current stock to the channel even if the hash did not change.
  - `/resetstate` resets saved stock hash.
- Health endpoint now exposes last DB/channel errors.
- Schema includes explicit grants for `service_role`.

## Required Koyeb env

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHANNEL_ID=@your_public_channel_or_-100xxxxxxxxxx
TELEGRAM_CHANNEL_URL=https://t.me/your_public_channel

POLAR_SUPABASE_URL=https://xcxciixqhmghitmyigbj.supabase.co
POLAR_SUPABASE_ANON=...

BOT_SUPABASE_URL=https://your-project.supabase.co
BOT_SUPABASE_SERVICE_ROLE=...

PORT=8000
REST_FALLBACK_ENABLED=1
REST_FALLBACK_DELAY_SECONDS=30
FALLBACK_EXTRA_RETRY_SECONDS=
SEND_INITIAL_TO_CHANNEL=0
PRIVATE_MATCH_HEADER=0
NOTIFY_DELAY_MS=80
BOT_BRAND=GAG2 Stock Bot
KNOWN_ITEMS=dragon fruit,mushroom,green bean,banana,grape,coconut,mango,sunflower,venus fly trap,pomegranate,poison apple,moon bloom,dragon's breath,thorn rose,glow mushroom,horned melon
```

## Supabase setup

Run `schema.sql` in your own Supabase project. Use the **service_role** key from this project for `BOT_SUPABASE_SERVICE_ROLE`. Do not use the anon key here.

## Telegram channel setup

- Public channel: `TELEGRAM_CHANNEL_ID=@channelusername`
- Private channel: `TELEGRAM_CHANNEL_ID=-100xxxxxxxxxx`
- Add the bot as channel admin with permission to post messages.

After deployment, test in private chat with the bot:

```txt
/testdb
/testchannel
/forcechannel
/watch
/list
/diag
```

## Koyeb

Use Dockerfile deployment. Exposed port should be `8000`, health path `/healthz`.
