import http from "node:http";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const env = process.env;

const CONFIG = {
  PORT: Number(env.PORT || env.KOYEB_PORT || 8000),

  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID: env.TELEGRAM_CHANNEL_ID,
  TELEGRAM_CHANNEL_URL: env.TELEGRAM_CHANNEL_URL || "",

  POLAR_SUPABASE_URL: env.POLAR_SUPABASE_URL || "https://xcxciixqhmghitmyigbj.supabase.co",
  POLAR_SUPABASE_ANON: env.POLAR_SUPABASE_ANON,

  BOT_SUPABASE_URL: env.BOT_SUPABASE_URL,
  // Accept both old env name and newer Supabase Secret key env name.
  BOT_SUPABASE_SERVICE_ROLE: env.BOT_SUPABASE_SERVICE_ROLE || env.BOT_SUPABASE_SECRET_KEY,

  REST_FALLBACK_ENABLED: env.REST_FALLBACK_ENABLED !== "0",
  REST_FALLBACK_DELAY_SECONDS: Number(env.REST_FALLBACK_DELAY_SECONDS || 30),
  FALLBACK_EXTRA_RETRY_SECONDS: (env.FALLBACK_EXTRA_RETRY_SECONDS || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0),

  SEND_INITIAL_TO_CHANNEL: env.SEND_INITIAL_TO_CHANNEL === "1",
  PRIVATE_MATCH_HEADER: env.PRIVATE_MATCH_HEADER === "1",
  NOTIFY_DELAY_MS: Number(env.NOTIFY_DELAY_MS || 80),

  BOT_BRAND: env.BOT_BRAND || "GAG2 Stock Bot",
  KNOWN_ITEMS: env.KNOWN_ITEMS || "",
};

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function validateSupabaseBotKey() {
  const key = CONFIG.BOT_SUPABASE_SERVICE_ROLE;
  const polarKey = CONFIG.POLAR_SUPABASE_ANON;

  if (key === polarKey) {
    throw new Error(
      "BOT_SUPABASE_SERVICE_ROLE is identical to POLAR_SUPABASE_ANON. " +
      "This is wrong. Use your OWN Supabase project service_role key or new sb_secret_ key for BOT_SUPABASE_SERVICE_ROLE."
    );
  }

  if (String(key).startsWith("sb_publishable_")) {
    throw new Error(
      "BOT_SUPABASE_SERVICE_ROLE contains a publishable key. " +
      "Use a Secret key (sb_secret_...) or legacy service_role key instead."
    );
  }

  const payload = decodeJwtPayload(key);
  if (payload?.role === "anon") {
    throw new Error(
      "BOT_SUPABASE_SERVICE_ROLE contains an anon/public key. " +
      "Anon keys cannot bypass RLS, so tg_users inserts will fail. " +
      "Use the legacy service_role key or the new Supabase Secret key in Koyeb env."
    );
  }

  if (payload?.role && payload.role !== "service_role") {
    log(`Warning: BOT_SUPABASE_SERVICE_ROLE JWT role is ${payload.role}, expected service_role.`);
  }
}

for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "POLAR_SUPABASE_ANON",
  "BOT_SUPABASE_URL",
  "BOT_SUPABASE_SERVICE_ROLE",
]) {
  if (!CONFIG[key]) throw new Error(`Missing required env: ${key}`);
}

validateSupabaseBotKey();

const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

const polar = createClient(CONFIG.POLAR_SUPABASE_URL, CONFIG.POLAR_SUPABASE_ANON, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  realtime: {
    transport: WebSocket,
    params: {
      eventsPerSecond: 2,
    },
  },
});

const db = createClient(CONFIG.BOT_SUPABASE_URL, CONFIG.BOT_SUPABASE_SERVICE_ROLE, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  // Supabase JS still initializes a Realtime client internally.
  // Node.js 20 needs an explicit WebSocket transport; harmless on Node 22+.
  realtime: {
    transport: WebSocket,
  },
});

let latestStock = null;
let latestItems = [];
let latestChannelMessageId = null;
let realtimeStatus = "not-started";
let lastProcessedAt = null;
let appStartedAt = new Date().toISOString();
let lastDbError = null;
let lastChannelError = null;
let lastChannelOkAt = null;
let nextFallbackAt = null;

function healthHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/" || url.pathname === "/healthz") {
    const payload =
      url.pathname === "/"
        ? `${CONFIG.BOT_BRAND} is running.\n`
        : JSON.stringify(
            {
              ok: true,
              started_at: appStartedAt,
              realtime_status: realtimeStatus,
              last_processed_at: lastProcessedAt,
              latest_updated_at: latestStock?.updated_at || null,
              latest_channel_message_id: latestChannelMessageId,
              latest_items_count: latestItems.length,
              last_db_error: lastDbError,
              last_channel_error: lastChannelError,
              last_channel_ok_at: lastChannelOkAt,
              listening_ports: Array.from(listeningPorts),
              next_fallback_at: nextFallbackAt,
            },
            null,
            2
          );

    res.writeHead(200, {
      "content-type": url.pathname === "/" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(payload);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
}

const listeningPorts = new Set();
const healthServers = [];

function startHealthServer(port) {
  if (!Number.isInteger(port) || port <= 0 || listeningPorts.has(port)) return;

  const server = http.createServer(healthHandler);

  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      log(`Health port ${port} already in use, skipping.`);
      return;
    }
    console.error(`Health server error on port ${port}:`, err);
  });

  server.listen(port, "0.0.0.0", () => {
    listeningPorts.add(port);
    log(`Health server listening on port ${port}`);
  });

  healthServers.push(server);
}

// Koyeb often checks port 8000 by default. Some previous configs used 3000.
// Listen on all likely ports so deployment does not fail only because of port mismatch.
const healthPorts = [CONFIG.PORT, 8000, 3000];
for (const port of healthPorts) startHealthServer(port);

bot.start(async (ctx) => {
  await upsertTelegramUser(ctx);

  const lines = [
    `🌱 <b>${escapeHtml(CONFIG.BOT_BRAND)}</b>`,
    "",
    "Bot ini memantau stock Grow A Garden 2 dari source Polar.",
    "",
    "Perintah:",
    "• /watch - pilih item dari stock yang sedang terlihat",
    "• /add nama item - tambah item manual, contoh: <code>/add dragon fruit</code>",
    "• /remove - hapus item dari watchlist",
    "• /list - lihat watchlist kamu",
    "• /clear - kosongkan watchlist",
    "• /now - lihat stock sekarang",
  ];

  if (CONFIG.TELEGRAM_CHANNEL_URL) {
    lines.push("", `Channel full stock: ${escapeHtml(CONFIG.TELEGRAM_CHANNEL_URL)}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("help", async (ctx) => bot.telegram.sendMessage(ctx.chat.id, helpText(), { parse_mode: "HTML" }));

bot.command("now", async (ctx) => {
  await upsertTelegramUser(ctx);
  const row = await fetchPolarStock();
  latestStock = row;
  latestItems = normalizeItems(row);

  await ctx.reply(formatStockMessage(row, "manual /now"), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});

bot.command("watch", async (ctx) => {
  await upsertTelegramUser(ctx);

  if (!latestStock) {
    try {
      const row = await fetchPolarStock();
      latestStock = row;
      latestItems = normalizeItems(row);
    } catch (err) {
      return ctx.reply(`❌ Gagal fetch stock: ${err.message}`);
    }
  }

  await sendWatchMenu(ctx, 0, false);
});

bot.command("add", async (ctx) => {
  await upsertTelegramUser(ctx);

  const text = ctx.message?.text || "";
  const keyword = text.replace(/^\/add(@\w+)?\s*/i, "").trim();

  if (!keyword) {
    return ctx.reply("Format: /add nama item\nContoh: /add dragon fruit");
  }

  const watch = await getWatchlist(getCtxChatId(ctx));
  const key = `keyword:${slugify(keyword)}`;
  const exists = watch.some((x) => x.key === key);

  if (exists) {
    return ctx.reply(`ℹ️ ${titleCase(keyword)} sudah ada di watchlist.`);
  }

  const next = [
    ...watch,
    {
      key,
      mode: "keyword",
      value: keyword.toLowerCase(),
      label: titleCase(keyword),
    },
  ];

  await setWatchlist(getCtxChatId(ctx), next);
  await ctx.reply(`✅ Ditambahkan ke watchlist: ${titleCase(keyword)}`);
});

bot.command("remove", async (ctx) => {
  await upsertTelegramUser(ctx);
  await sendRemoveMenu(ctx, false);
});

bot.command("list", async (ctx) => {
  await upsertTelegramUser(ctx);

  const watch = await getWatchlist(getCtxChatId(ctx));
  if (!watch.length) {
    return ctx.reply("Watchlist kamu masih kosong. Pakai /watch atau /add nama item.");
  }

  const lines = watch.map((x, i) => `${i + 1}. ${escapeHtml(x.label || x.value || x.key)}`);
  await ctx.reply(`📌 <b>Watchlist kamu</b>\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
  });
});

bot.command("clear", async (ctx) => {
  await upsertTelegramUser(ctx);
  await setWatchlist(getCtxChatId(ctx), []);
  await ctx.reply("✅ Watchlist sudah dikosongkan.");
});

bot.command("stats", async (ctx) => {
  await upsertTelegramUser(ctx);

  const userCount = await countUsers();
  await ctx.reply(
    [
      `📊 <b>${escapeHtml(CONFIG.BOT_BRAND)} Stats</b>`,
      `Realtime: <code>${escapeHtml(realtimeStatus)}</code>`,
      `Latest stock: <code>${escapeHtml(latestStock?.updated_at || "-")}</code>`,
      `Latest items: <code>${latestItems.length}</code>`,
      `Users: <code>${userCount}</code>`,
      `Last processed: <code>${escapeHtml(lastProcessedAt || "-")}</code>`,
      `Next fallback: <code>${escapeHtml(nextFallbackAt || "-")}</code>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

bot.command("diag", async (ctx) => {
  await upsertTelegramUser(ctx);

  const dbOk = await testDbRoundtrip(getCtxChatId(ctx)).then(() => true).catch(() => false);
  const channelOk = await testChannelAccess(false).then(() => true).catch(() => false);

  await ctx.reply(
    [
      `🧪 <b>Diagnostic</b>`,
      `DB: <code>${dbOk ? "OK" : "ERROR"}</code>`,
      `Channel: <code>${channelOk ? "OK" : "ERROR"}</code>`,
      `Channel ID: <code>${escapeHtml(CONFIG.TELEGRAM_CHANNEL_ID)}</code>`,
      `Realtime: <code>${escapeHtml(realtimeStatus)}</code>`,
      `Latest stock: <code>${escapeHtml(latestStock?.updated_at || "-")}</code>`,
      `Next fallback: <code>${escapeHtml(nextFallbackAt || "-")}</code>`,
      `Last DB error: <code>${escapeHtml(lastDbError || "-")}</code>`,
      `Last Channel error: <code>${escapeHtml(lastChannelError || "-")}</code>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
});

bot.command("testdb", async (ctx) => {
  await upsertTelegramUser(ctx);
  try {
    await testDbRoundtrip(getCtxChatId(ctx));
    await ctx.reply("✅ DB Supabase bot OK. Row user berhasil dibuat/diupdate.");
  } catch (err) {
    await ctx.reply(`❌ DB error: ${err.message}`);
  }
});

bot.command("testchannel", async (ctx) => {
  await upsertTelegramUser(ctx);
  try {
    const sent = await testChannelAccess(true);
    await ctx.reply(`✅ Channel OK. Test message_id: ${sent.message_id}`);
  } catch (err) {
    await ctx.reply(`❌ Channel error: ${err.message}

Pastikan bot jadi admin channel dan TELEGRAM_CHANNEL_ID benar.`);
  }
});

bot.command("forcechannel", async (ctx) => {
  await upsertTelegramUser(ctx);
  try {
    const row = await fetchPolarStock();
    await processStockUpdate(row, "manual-force", { force: true });
    await ctx.reply("✅ Stock sekarang dipaksa kirim ke channel.");
  } catch (err) {
    await ctx.reply(`❌ Force channel error: ${err.message}`);
  }
});

bot.command("resetstate", async (ctx) => {
  await upsertTelegramUser(ctx);
  try {
    await setState("last_stock_hash", null);
    await setState("last_stock_updated_at", null);
    await ctx.reply("✅ State hash direset. Update berikutnya akan dianggap baru.");
  } catch (err) {
    await ctx.reply(`❌ Reset state error: ${err.message}`);
  }
});


bot.action(/^watch_page:(\d+)$/, async (ctx) => {
  await upsertTelegramUser(ctx);
  const page = Number(ctx.match[1] || 0);
  await ctx.answerCbQuery();
  await sendWatchMenu(ctx, page, true);
});

bot.action(/^toggle:(.+)$/, async (ctx) => {
  try {
    await upsertTelegramUser(ctx);

    const chatId = getCtxChatId(ctx);
    const key = ctx.match[1];
    const item = getSelectableItems().find((x) => x.key === key);

    if (!item) {
      await ctx.answerCbQuery("Item tidak ditemukan.", { show_alert: true });
      return;
    }

    const watch = await getWatchlist(chatId);
    const exists = watch.some((x) => x.key === item.key);
    const next = exists ? watch.filter((x) => x.key !== item.key) : [...watch, itemToWatchEntry(item)];

    await setWatchlist(chatId, next, ctx);
    await ctx.answerCbQuery(exists ? `Dihapus: ${item.label}` : `Ditambahkan: ${item.label}`);

    const page = Number(ctx.callbackQuery?.message?.reply_markup?.inline_keyboard?.at(-1)?.[0]?.callback_data?.match(/watch_page:(\d+)/)?.[1] || 0);
    await sendWatchMenu(ctx, page, true);
  } catch (err) {
    console.error("toggle action error:", err);
    try { await ctx.answerCbQuery(`Error: ${String(err.message || err).slice(0, 180)}`, { show_alert: true }); } catch {}
  }
});

bot.action(/^remove:(.+)$/, async (ctx) => {
  try {
    await upsertTelegramUser(ctx);

    const chatId = getCtxChatId(ctx);
    const key = ctx.match[1];
    const watch = await getWatchlist(chatId);
    const removed = watch.find((x) => x.key === key);
    const next = watch.filter((x) => x.key !== key);

    await setWatchlist(chatId, next, ctx);
    await ctx.answerCbQuery(removed ? `Dihapus: ${removed.label}` : "Dihapus");
    await sendRemoveMenu(ctx, true);
  } catch (err) {
    console.error("remove action error:", err);
    try { await ctx.answerCbQuery(`Error: ${String(err.message || err).slice(0, 180)}`, { show_alert: true }); } catch {}
  }
});

bot.action("noop", async (ctx) => ctx.answerCbQuery());

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

async function main() {
  log("Starting bot...");

  await bot.launch({ dropPendingUpdates: false });
  log("Telegram bot launched");

  await initializeStockState();
  subscribePolarRealtime();

  if (CONFIG.REST_FALLBACK_ENABLED) {
    scheduleSmartFallback();
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function initializeStockState() {
  const row = await fetchPolarStock();
  latestStock = row;
  latestItems = normalizeItems(row);

  const hash = makeStockHash(row);
  const savedHash = await getState("last_stock_hash");

  if (!savedHash) {
    await setState("last_stock_hash", hash);
    await setState("last_stock_updated_at", row.updated_at || null);

    if (CONFIG.SEND_INITIAL_TO_CHANNEL) {
      await processStockUpdate(row, "startup-initial");
    } else {
      log(`Initial hash saved silently. updated_at=${row.updated_at}`);
    }

    return;
  }

  if (savedHash !== hash) {
    await processStockUpdate(row, "startup-changed-while-offline");
  } else {
    log(`Startup stock unchanged. updated_at=${row.updated_at}`);
  }
}

function subscribePolarRealtime() {
  log("Subscribing to Polar Supabase Realtime...");

  const channel = polar
    .channel(`gag2-stock-${Date.now()}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "gag2_stock",
        filter: "id=eq.1",
      },
      async (payload) => {
        log("Realtime UPDATE received");
        try {
          const row = payload?.new || (await fetchPolarStock());
          await processStockUpdate(row, "realtime");
        } catch (err) {
          console.error("Realtime process error:", err);
        }
      }
    )
    .subscribe((status, err) => {
      realtimeStatus = status;
      log(`Realtime status: ${status}${err ? ` ${err.message || err}` : ""}`);
    });

  return channel;
}

function scheduleSmartFallback() {
  const target = nextFiveMinutePlusDelayDate(CONFIG.REST_FALLBACK_DELAY_SECONDS);
  const baseMs = Math.max(1000, target.getTime() - Date.now());
  nextFallbackAt = target.toISOString();
  log(`Next fallback REST at ${nextFallbackAt} in ${Math.round(baseMs / 1000)}s`);

  setTimeout(async () => {
    await runFallbackFetch("smart-fallback");

    for (const retryDelay of CONFIG.FALLBACK_EXTRA_RETRY_SECONDS) {
      setTimeout(() => {
        runFallbackFetch(`smart-fallback-extra-${retryDelay}s`).catch((err) => {
          console.error("Extra fallback error:", err);
        });
      }, retryDelay * 1000);
    }

    scheduleSmartFallback();
  }, baseMs);
}

async function runFallbackFetch(reason) {
  try {
    const row = await fetchPolarStock();
    await processStockUpdate(row, reason);
  } catch (err) {
    console.error(`${reason} error:`, err.message);
  }
}

async function fetchPolarStock() {
  const { data, error } = await polar
    .from("gag2_stock")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) throw new Error(`Polar REST error: ${error.message}`);
  if (!data) throw new Error("Polar REST returned empty data");

  return data;
}

async function processStockUpdate(row, reason, options = {}) {
  latestStock = row;
  latestItems = normalizeItems(row);

  const hash = makeStockHash(row);
  const savedHash = await getState("last_stock_hash");

  if (!options.force && savedHash === hash) {
    log(`No change. reason=${reason}, updated_at=${row.updated_at}`);
    return false;
  }

  await setState("last_stock_hash", hash);
  await setState("last_stock_updated_at", row.updated_at || null);
  lastProcessedAt = new Date().toISOString();

  const text = formatStockMessage(row, reason);

  let sent;
  try {
    sent = await bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    lastChannelError = null;
    lastChannelOkAt = new Date().toISOString();
  } catch (err) {
    lastChannelError = `${err?.description || err?.message || err}`;
    console.error("Channel send error:", err);
    throw new Error(`Channel send failed: ${lastChannelError}`);
  }

  latestChannelMessageId = sent.message_id;
  log(`Sent channel update. message_id=${sent.message_id}, reason=${reason}`);

  await notifyMatchingUsers(row, latestItems, sent.message_id, text);
  return true;
}

async function notifyMatchingUsers(row, currentItems, channelMessageId, fallbackText) {
  const { data: users, error } = await db.from("tg_users").select("chat_id, watchlist");

  if (error) {
    console.error("Load users error:", error.message);
    return;
  }

  const activeUsers = users || [];
  let notified = 0;

  for (const user of activeUsers) {
    const watch = Array.isArray(user.watchlist) ? user.watchlist : [];
    if (!watch.length) continue;

    const matches = findMatches(watch, currentItems);
    if (!matches.length) continue;

    try {
      if (CONFIG.PRIVATE_MATCH_HEADER) {
        await bot.telegram.sendMessage(
          user.chat_id,
          `🔔 <b>Watchlist match</b>\n${matches.map((x) => `• ${escapeHtml(x.label)}`).join("\n")}`,
          { parse_mode: "HTML" }
        );
      }

      await bot.telegram.copyMessage(user.chat_id, CONFIG.TELEGRAM_CHANNEL_ID, channelMessageId);
      notified++;
      await sleep(CONFIG.NOTIFY_DELAY_MS);
    } catch (err) {
      console.error(`Notify failed chat_id=${user.chat_id}:`, err.message);

      try {
        await bot.telegram.sendMessage(user.chat_id, fallbackText, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } catch {}
    }
  }

  log(`Private notifications sent: ${notified}`);
}

function findMatches(watchlist, currentItems) {
  const matches = [];

  for (const watch of watchlist) {
    const found = currentItems.find((item) => {
      if (watch.mode === "keyword") {
        const needle = String(watch.value || watch.label || "").toLowerCase().trim();
        return needle && item.name.toLowerCase().includes(needle);
      }
      return item.key === watch.key;
    });

    if (found) {
      matches.push({ key: watch.key, label: found.label || watch.label });
    }
  }

  const seen = new Set();
  return matches.filter((x) => {
    if (seen.has(x.key)) return false;
    seen.add(x.key);
    return true;
  });
}

async function sendWatchMenu(ctx, page = 0, edit = false) {
  const chatId = getCtxChatId(ctx);
  const watch = await getWatchlist(chatId);
  const selected = new Set(watch.map((x) => x.key));

  const items = getSelectableItems();
  if (!items.length) {
    return ctx.reply("Belum ada item terbaca. Coba /now dulu atau tunggu stock update.");
  }

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = items.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const rows = slice.map((item) => [
    Markup.button.callback(`${selected.has(item.key) ? "✅ " : ""}${item.label}`, `toggle:${item.key}`),
  ]);

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback("⬅️ Prev", `watch_page:${safePage - 1}`));
  nav.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, "noop"));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback("Next ➡️", `watch_page:${safePage + 1}`));
  rows.push(nav);

  const text = [
    "📌 <b>Pilih item untuk watchlist</b>",
    "Klik tombol untuk tambah/hapus.",
    "",
    "Tips: kalau item rare belum muncul di tombol, pakai:",
    "<code>/add dragon fruit</code>",
  ].join("\n");

  const payload = {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(rows),
  };

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, payload);
      return;
    } catch (err) {
      // Telegram can reject edits if content is unchanged. Fallback to reply.
    }
  }

  await ctx.reply(text, payload);
}

async function sendRemoveMenu(ctx, edit = false) {
  const chatId = getCtxChatId(ctx);
  const watch = await getWatchlist(chatId);

  if (!watch.length) {
    return ctx.reply("Watchlist kamu sudah kosong.");
  }

  const rows = watch.map((item) => [
    Markup.button.callback(`❌ ${item.label || item.value || item.key}`, `remove:${item.key}`),
  ]);

  const text = "🗑 <b>Hapus item dari watchlist</b>";
  const payload = { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) };

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, payload);
      return;
    } catch {}
  }

  await ctx.reply(text, payload);
}

function getSelectableItems() {
  const dynamic = latestItems.map((x) => ({ ...x, source: "current" }));
  const known = parseKnownItems(CONFIG.KNOWN_ITEMS);
  const map = new Map();

  for (const item of [...dynamic, ...known]) {
    if (!map.has(item.key)) map.set(item.key, item);
  }

  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function parseKnownItems(raw) {
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => {
      const clean = name.replace(/^[^a-zA-Z0-9]+\s*/, "");
      return {
        type: "known",
        name: clean,
        qty: 0,
        emoji: "🔔",
        key: `keyword:${slugify(clean)}`,
        label: `🔔 ${titleCase(clean)}`,
      };
    });
}

function itemToWatchEntry(item) {
  if (item.key.startsWith("keyword:")) {
    return {
      key: item.key,
      mode: "keyword",
      value: item.name.toLowerCase(),
      label: item.label.replace(/^🔔\s*/, ""),
    };
  }

  return {
    key: item.key,
    mode: "exact",
    value: item.name.toLowerCase(),
    label: item.label,
  };
}

function normalizeItems(row) {
  const out = [];

  for (const s of row?.seeds || []) {
    out.push({ type: "seed", emoji: s.emoji || "🌱", name: String(s.name || "").trim(), qty: Number(s.qty ?? s.quantity ?? 0) });
  }

  for (const g of row?.gear || []) {
    out.push({ type: "gear", emoji: g.emoji || "⚙️", name: String(g.name || "").trim(), qty: Number(g.qty ?? g.quantity ?? 0) });
  }

  return out
    .filter((x) => x.name)
    .map((x) => ({
      ...x,
      key: `${x.type}:${slugify(x.name)}`,
      label: `${x.emoji} ${titleCase(x.name)}`,
    }));
}

function formatStockMessage(row, reason) {
  const seeds = row?.seeds || [];
  const gear = row?.gear || [];
  const weather = row?.weather || {};
  const updated = formatWib(row?.updated_at);
  const weatherUpdated = weather?.updatedAt ? formatWib(weather.updatedAt) : null;

  const lines = [];
  lines.push("🌱 <b>Grow A Garden 2 Stock Update</b>");
  lines.push(`🕒 <b>Updated:</b> ${escapeHtml(updated)}`);
  lines.push(`📡 <b>Source:</b> ${escapeHtml(reason)}`);

  if (weather?.title || weather?.body) {
    lines.push("");
    lines.push("🌤️ <b>Weather</b>");
    if (weather.title) lines.push(escapeHtml(weather.title));
    if (weather.body) lines.push(escapeHtml(cleanWeatherBody(weather.body)));
    if (weatherUpdated) lines.push(`Weather updated: ${escapeHtml(weatherUpdated)}`);
  }

  lines.push("");
  lines.push("🌱 <b>Seeds</b>");
  if (seeds.length) {
    for (const s of seeds) lines.push(`${escapeHtml(s.emoji || "🌱")} ${escapeHtml(titleCase(s.name))} ×${escapeHtml(s.qty ?? s.quantity ?? 0)}`);
  } else {
    lines.push("- Tidak ada seeds");
  }

  lines.push("");
  lines.push("⚙️ <b>Gear</b>");
  if (gear.length) {
    for (const g of gear) lines.push(`${escapeHtml(g.emoji || "⚙️")} ${escapeHtml(titleCase(g.name))} ×${escapeHtml(g.qty ?? g.quantity ?? 0)}`);
  } else {
    lines.push("- Tidak ada gear");
  }

  lines.push("");
  lines.push(`<i>${escapeHtml(CONFIG.BOT_BRAND)}</i>`);

  return lines.join("\n").slice(0, 4096);
}

function makeStockHash(row) {
  return sha256(
    JSON.stringify({
      seeds: row?.seeds || [],
      gear: row?.gear || [],
      weather: row?.weather || {},
      updated_at: row?.updated_at || null,
    })
  );
}

async function upsertTelegramUser(ctx) {
  const from = ctx.from;
  const chatId = getCtxChatId(ctx);
  if (!from || !chatId) return null;

  const payload = {
    chat_id: String(chatId),
    username: from.username || null,
    first_name: from.first_name || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("tg_users")
    .upsert(payload, { onConflict: "chat_id" })
    .select("chat_id, watchlist")
    .single();

  if (error) {
    lastDbError = `upsert user: ${error.message}`;
    console.error("upsert user error:", error);
    return null;
  }

  lastDbError = null;
  return data;
}

async function getWatchlist(chatId) {
  const { data, error } = await db
    .from("tg_users")
    .select("watchlist")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error) {
    lastDbError = `getWatchlist: ${error.message}`;
    console.error("getWatchlist error:", error);
    return [];
  }

  lastDbError = null;
  return Array.isArray(data?.watchlist) ? data.watchlist : [];
}

async function setWatchlist(chatId, watchlist, ctx = null) {
  const payload = {
    chat_id: String(chatId),
    watchlist: Array.isArray(watchlist) ? watchlist : [],
    updated_at: new Date().toISOString(),
  };

  if (ctx?.from) {
    payload.username = ctx.from.username || null;
    payload.first_name = ctx.from.first_name || null;
  }

  const { data, error } = await db
    .from("tg_users")
    .upsert(payload, { onConflict: "chat_id" })
    .select("chat_id, watchlist")
    .single();

  if (error) {
    lastDbError = `setWatchlist: ${error.message}`;
    console.error("setWatchlist error:", error);
    throw new Error(`setWatchlist error: ${error.message}`);
  }

  lastDbError = null;
  return data;
}

async function countUsers() {
  const { count, error } = await db.from("tg_users").select("chat_id", { count: "exact", head: true });
  if (error) {
    lastDbError = `countUsers: ${error.message}`;
    console.error("countUsers error:", error);
    return 0;
  }
  return count || 0;
}

async function getState(key) {
  const { data, error } = await db.from("bot_state").select("value").eq("key", key).maybeSingle();
  if (error || !data) return null;
  return data.value;
}

async function setState(key, value) {
  const { error } = await db.from("bot_state").upsert(
    {
      key,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) {
    lastDbError = `setState: ${error.message}`;
    throw new Error(`setState error: ${error.message}`);
  }
}

function nextFiveMinutePlusDelayDate(delaySeconds) {
  const now = new Date();
  const delay = Math.max(0, Math.min(240, Number(delaySeconds) || 30));

  // Build candidates for the current 5-minute block and following blocks.
  // This prevents skipping the current cycle when the bot starts at e.g. 20:10:12
  // and the target 20:10:30 has not passed yet.
  const currentBlockMinute = Math.floor(now.getMinutes() / 5) * 5;

  for (let i = 0; i < 24; i++) {
    const candidate = new Date(now);
    candidate.setMilliseconds(0);
    candidate.setSeconds(delay);
    candidate.setMinutes(currentBlockMinute + i * 5);

    if (candidate > now) return candidate;
  }

  const fallback = new Date(now.getTime() + 5 * 60 * 1000);
  fallback.setMilliseconds(0);
  fallback.setSeconds(delay);
  fallback.setMinutes(Math.ceil(fallback.getMinutes() / 5) * 5);
  return fallback;
}

async function testDbRoundtrip(chatId) {
  const testEntry = {
    key: "diagnostic:test",
    mode: "keyword",
    value: "diagnostic-test",
    label: "Diagnostic Test",
    hidden: true,
  };

  const current = await getWatchlist(chatId);
  const withoutTest = current.filter((x) => x.key !== testEntry.key);
  await setWatchlist(chatId, [...withoutTest, testEntry]);
  await setWatchlist(chatId, withoutTest);
  return true;
}

async function testChannelAccess(sendMessage = false) {
  if (!sendMessage) {
    await bot.telegram.getChat(CONFIG.TELEGRAM_CHANNEL_ID);
    lastChannelError = null;
    return true;
  }

  const sent = await bot.telegram.sendMessage(
    CONFIG.TELEGRAM_CHANNEL_ID,
    `✅ ${escapeHtml(CONFIG.BOT_BRAND)} channel test\n${escapeHtml(new Date().toISOString())}`,
    { parse_mode: "HTML" }
  );
  lastChannelError = null;
  lastChannelOkAt = new Date().toISOString();
  return sent;
}

function getCtxChatId(ctx) {
  return String(ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id || ctx?.from?.id || "");
}

function helpText() {
  return [
    `🌱 <b>${escapeHtml(CONFIG.BOT_BRAND)}</b>`,
    "",
    "Perintah:",
    "• /watch - pilih item dari tombol",
    "• /add nama item - tambah item manual",
    "• /remove - hapus item dari watchlist",
    "• /list - lihat watchlist",
    "• /clear - hapus semua watchlist",
    "• /now - cek stock sekarang",
    "• /stats - status bot",
    "• /diag - cek DB dan channel",
    "• /testdb - test simpan watchlist",
    "• /testchannel - test kirim ke channel",
    "• /forcechannel - paksa kirim stock sekarang",
  ].join("\n");
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(text = "") {
  return String(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join(" ");
}

function cleanWeatherBody(text) {
  return String(text)
    .replace(/<t:\d+:[^>]+>/g, "")
    .replace(/\*/g, "")
    .trim();
}

function formatWib(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return String(dateValue);

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date) + " WIB";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  try {
    await bot.stop(signal);
  } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
