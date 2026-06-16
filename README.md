# GAG2 Telegram Stock Bot

Telegram bot for Grow A Garden 2 stock notifications using Polar Supabase as upstream.

## Features

- Sends every stock update to a Telegram channel.
- Users can subscribe privately to selected items.
- Private notifications copy the exact channel message via Telegram `copyMessage`.
- Supabase Realtime first, smart REST fallback at 5-minute mark + delay.
- Uses your own Supabase project for user watchlists and bot state.

## Files

- `src/index.js` - main bot code
- `package.json` - dependencies
- `Dockerfile` - Koyeb deployment (uses npm install without package-lock)
- `schema.sql` - tables for your own Supabase project
- `.env.example` - environment variable template

## Deploy summary

1. Create Telegram bot via BotFather.
2. Create Telegram channel and add bot as admin.
3. Create your own Supabase project and run `schema.sql`.
4. Push this repo to GitHub.
5. Deploy GitHub repo to Koyeb as a Web Service.
6. Add all environment variables from `.env.example`.

## Commands

- `/start` - register and show help
- `/watch` - choose item from buttons
- `/add dragon fruit` - add item manually
- `/remove` - remove item via buttons
- `/list` - show watchlist
- `/clear` - clear watchlist
- `/now` - show current stock
- `/stats` - bot status


## Fix notes

This version removes the `express` dependency and uses Node.js built-in `http` for `/` and `/healthz`. It also removes `package-lock.json` to avoid registry lock issues during Koyeb builds.


## Runtime note

This version pins Docker to Node.js 22 and also installs `ws` as an explicit Supabase Realtime transport, so it works on both Node 20 and Node 22+ runtimes.


## Koyeb port note

Versi v4 listen di port `8000`, `3000`, dan `process.env.PORT` sekaligus agar health check Koyeb tidak gagal karena mismatch port. Di Koyeb tetap disarankan set Exposed Port ke `8000` dan Health Check HTTP path `/healthz`.


## v6 fixes

- Fails fast if `BOT_SUPABASE_SERVICE_ROLE` is accidentally filled with an anon/public key.
- Accepts either legacy `service_role` or new `sb_secret_...` key for the bot database.
- Fixes smart fallback scheduling so it can still run in the current 5-minute block when the +delay target has not passed.
- `/diag`, `/stats`, and `/healthz` show the next fallback time.

## Fix RLS error on /testdb

If `/testdb` returns `new row violates row-level security policy`, your Koyeb env `BOT_SUPABASE_SERVICE_ROLE` is wrong.

Use ONE of these for `BOT_SUPABASE_SERVICE_ROLE`:

- Supabase `Legacy service_role` key from your own bot database project, OR
- Supabase new `Secret key` (`sb_secret_...`) from your own bot database project.

Do NOT use:

- Legacy `anon public` key
- New `sb_publishable_...` key
- Polar anon key

`POLAR_SUPABASE_ANON` and `BOT_SUPABASE_SERVICE_ROLE` are different keys for different projects.

After changing env, redeploy Koyeb and run `/testdb` again.
