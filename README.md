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
