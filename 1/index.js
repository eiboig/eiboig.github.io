require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { randomUUID } = require("crypto");
const fs = require("fs").promises;

// ─── FIX 1: Only import what actually exists in discord.js v14 ─────────────
// REMOVED: LimitedCollection, Options — these caused a crash in Client constructor
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  MessageFlags,
} = require("discord.js");

// ─── FIX 2: Clean Client init — no broken sweep/cache options ──────────────
// REMOVED: sweepFilter, sweepInterval, LimitedCollection.filterByLifetime
// Those APIs were removed in discord.js v14 and crashed the Client constructor
// causing every API call to return 500 since the bot never started.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  BOT_TOKEN:         process.env.BOT_TOKEN,
  OWNER_ID:          process.env.OWNER_ID || "776208075009818636",
  PORT:              process.env.PORT || 3000,
  PREFIX:            "!",
  CONFIG_FILE:       "./config.json",
  ORDERS_FILE:       "./orders.json",
  MAX_ORDERS_MEMORY: 500,
};

// ─── FIX 5: Guard against missing BOT_TOKEN ────────────────────────────────
if (!CONFIG.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is not set in environment variables.");
  process.exit(1);
}

// ─── FILE HELPERS ──────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG.CONFIG_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return { inquiryChannelId: process.env.INQUIRY_CHANNEL_ID || null };
  }
}

async function saveConfig(data) {
  await fs.writeFile(CONFIG.CONFIG_FILE, JSON.stringify(data, null, 2));
}

let ordersCache    = null;
let lastOrdersLoad = 0;
const CACHE_TTL    = 30_000;

async function loadOrders() {
  const now = Date.now();
  if (ordersCache && now - lastOrdersLoad < CACHE_TTL) return ordersCache;
  try {
    const data   = await fs.readFile(CONFIG.ORDERS_FILE, "utf8");
    let orders   = JSON.parse(data);
    if (orders.length > CONFIG.MAX_ORDERS_MEMORY) orders = orders.slice(-CONFIG.MAX_ORDERS_MEMORY);
    ordersCache    = orders;
    lastOrdersLoad = now;
    return orders;
  } catch {
    ordersCache    = [];
    lastOrdersLoad = now;
    return [];
  }
}

async function saveOrders(orders) {
  ordersCache    = orders;
  lastOrdersLoad = Date.now();
  await fs.writeFile(CONFIG.ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ─── STATUS ────────────────────────────────────────────────────────────────
let currentStatus = "open";
const STATUS_DISPLAY = {
  open:   { label: "Open for orders",        emoji: "🟢", color: 0x00e5c4 },
  slow:   { label: "Slow — may take longer", emoji: "🟡", color: 0xf5a623 },
  closed: { label: "Closed for orders",      emoji: "🔴", color: 0xff4444 },
};

// ─── CATEGORY METADATA ─────────────────────────────────────────────────────
const CATEGORY_META = {
  "ERLC / Roblox Bot":  { color: 0xff7b3a, emoji: "🚔" },
  "Moderation Bot":     { color: 0x5865f2, emoji: "🛡️" },
  "Economy Bot":        { color: 0xf5c518, emoji: "🪙" },
  "Ticket System":      { color: 0x00c8e0, emoji: "🎟️" },
  "Music Bot":          { color: 0xff2d78, emoji: "🎵" },
  "Application Bot":    { color: 0x3dffa0, emoji: "📋" },
  "Leveling / XP Bot":  { color: 0xbf5fff, emoji: "⭐" },
  "Dashboard / Panel":  { color: 0x1a6fff, emoji: "📊" },
  "Full Custom Bot":    { color: 0x6ee7f7, emoji: "⚡" },
  "Other / Not Sure":   { color: 0x888888, emoji: "❓" },
};

// ─── UTILS ─────────────────────────────────────────────────────────────────
function isValidSnowflake(id) {
  return id && /^\d{17,20}$/.test(String(id));
}

// FIX 4: Lazy-load config inside each route — eliminates race condition
// where botConfig was null if a request arrived before the IIFE resolved.
async function getConfig() {
  return loadConfig();
}

async function getChannel() {
  const cfg = await getConfig();
  if (!cfg?.inquiryChannelId) {
    throw new Error("Inquiry channel not configured. Run !setchannel in your Discord server first.");
  }
  return client.channels.fetch(cfg.inquiryChannelId);
}

// ─── BOT READY ─────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Echo Services bot online as ${client.user.tag}`);
  client.user.setActivity("echo services | !help", { type: ActivityType.Watching });
  setInterval(() => {
    const u = process.memoryUsage();
    console.log(`[Memory] ${Math.round(u.heapUsed / 1024 / 1024)}MB / ${Math.round(u.heapTotal / 1024 / 1024)}MB`);
  }, 300_000);
});

// ─── BOT COMMANDS (owner only) ─────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CONFIG.PREFIX)) return;
  if (msg.author.id !== CONFIG.OWNER_ID) return msg.reply("❌ Owner only.");

  const args = msg.content.slice(CONFIG.PREFIX.length).trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();

  // !setchannel
  if (cmd === "setchannel") {
    const channelId = msg.mentions.channels.first()?.id || args[1];
    if (!channelId) return msg.reply("❌ Usage: `!setchannel #channel`");
    try {
      const ch  = await client.channels.fetch(channelId);
      const cfg = await getConfig();
      cfg.inquiryChannelId = ch.id;
      await saveConfig(cfg);
      return msg.reply({ embeds: [
        new EmbedBuilder().setColor(0x00e5c4).setTitle("✅ Channel Set")
          .setDescription(`Inquiries will post to <#${ch.id}>.`).setTimestamp()
      ]});
    } catch {
      return msg.reply("❌ Channel not found or bot lacks access.");
    }
  }

  // !open / !slow / !close
  if (["open", "slow", "close"].includes(cmd)) {
    currentStatus = cmd === "close" ? "closed" : cmd;
    const s = STATUS_DISPLAY[currentStatus];
    return msg.reply({ embeds: [
      new EmbedBuilder().setColor(s.color).setTitle(`${s.emoji} Status Updated`)
        .setDescription(`Echo Services is now **${s.label}**.`).setTimestamp()
    ]});
  }

  // !status
  if (cmd === "status") {
    const s   = STATUS_DISPLAY[currentStatus];
    const cfg = await getConfig();
    const ch  = cfg?.inquiryChannelId ? `<#${cfg.inquiryChannelId}>` : "⚠️ Not set — run `!setchannel`";
    return msg.reply({ embeds: [
      new EmbedBuilder().setColor(s.color).setTitle("📡 Echo Services — Status")
        .addFields(
          { name: "Order Status",    value: `${s.emoji} ${s.label}`, inline: true },
          { name: "Inquiry Channel", value: ch,                       inline: true },
        ).setTimestamp()
    ]});
  }

  // !orders [filter]
  if (cmd === "orders") {
    const orders   = await loadOrders();
    const filter   = args[1];
    const filtered = filter
      ? orders.filter(o => o.status?.toLowerCase() === filter.toLowerCase())
      : orders;
    if (!filtered.length) return msg.reply(`📭 No orders${filter ? ` with status **${filter}**` : ""}.`);
    const lines = filtered.slice(-10).map(o =>
      `\`${o.uuid.slice(0,8)}\` | **${o.discordUsername}** | ${o.serviceType} | ${o.budget} | **${o.status}** | ${o.payment}`
    ).join("\n");
    return msg.reply({ embeds: [
      new EmbedBuilder().setColor(0x00e5c4)
        .setTitle(`📋 Orders${filter ? ` — ${filter}` : ""} (last ${filtered.slice(-10).length})`)
        .setDescription(lines)
        .setFooter({ text: `Total: ${filtered.length}` }).setTimestamp()
    ]});
  }

  // !order <uuid>
  if (cmd === "order") {
    if (!args[1]) return msg.reply("❌ Usage: `!order <uuid>`");
    const orders = await loadOrders();
    const order  = orders.find(o => o.uuid.startsWith(args[1]));
    if (!order) return msg.reply(`❌ No order found for \`${args[1]}\``);
    return msg.reply({ embeds: [
      new EmbedBuilder().setColor(0x7b6ff0).setTitle(`🗂️ Order — ${order.uuid.slice(0,8)}`)
        .addFields(
          { name: "UUID",         value: `\`${order.uuid}\``,                      inline: false },
          { name: "💬 Client",    value: order.discordUsername,                     inline: true  },
          { name: "🖥️ Server",    value: order.serverName,                          inline: true  },
          { name: "🔧 Service",   value: order.serviceType || "N/A",                inline: true  },
          { name: "💰 Budget",    value: order.budget,                              inline: true  },
          { name: "💳 Payment",   value: order.paymentMethod,                       inline: true  },
          { name: "📊 Status",    value: order.status,                              inline: true  },
          { name: "💵 Paid",      value: order.payment,                             inline: true  },
          { name: "📅 Created",   value: new Date(order.createdAt).toLocaleString(),inline: true  },
          { name: "📝 Details",   value: order.projectDetails.slice(0, 500),        inline: false },
          { name: "🗒️ Notes",     value: order.notes || "None",                     inline: false },
        ).setTimestamp()
    ]});
  }

  // !paid / !unpaid
  if (cmd === "paid" || cmd === "unpaid") {
    if (!args[1]) return msg.reply(`❌ Usage: \`!${cmd} <uuid>\``);
    const orders = await loadOrders();
    const idx    = orders.findIndex(o => o.uuid.startsWith(args[1]));
    if (idx === -1) return msg.reply(`❌ No order found for \`${args[1]}\``);
    orders[idx].payment = cmd === "paid" ? "✅ Paid" : "⏳ Unpaid";
    orders[idx].paidAt  = cmd === "paid" ? new Date().toISOString() : null;
    await saveOrders(orders);
    return msg.reply(`${cmd === "paid" ? "✅" : "⏳"} Order \`${orders[idx].uuid.slice(0,8)}\` marked as **${cmd === "paid" ? "Paid" : "Unpaid"}**.`);
  }

  // !setstatus <uuid> <status>
  if (cmd === "setstatus") {
    const id     = args[1];
    const status = args.slice(2).join(" ");
    if (!id || !status) return msg.reply("❌ Usage: `!setstatus <uuid> <status>`");
    const orders = await loadOrders();
    const idx    = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found for \`${id}\``);
    orders[idx].status = status;
    await saveOrders(orders);
    return msg.reply(`✅ Order \`${orders[idx].uuid.slice(0,8)}\` status → **${status}**.`);
  }

  // !note <uuid> <text>
  if (cmd === "note") {
    const id   = args[1];
    const note = args.slice(2).join(" ");
    if (!id || !note) return msg.reply("❌ Usage: `!note <uuid> <text>`");
    const orders = await loadOrders();
    const idx    = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found for \`${id}\``);
    orders[idx].notes = note;
    await saveOrders(orders);
    return msg.reply(`🗒️ Note saved on \`${orders[idx].uuid.slice(0,8)}\`.`);
  }

  // !help
  if (cmd === "help") {
    return msg.reply({ embeds: [
      new EmbedBuilder().setColor(0x00e5c4).setTitle("📖 Echo Services — Bot Commands")
        .addFields(
          { name: "**Availability**",            value: "\u200b", inline: false },
          { name: "`!open`",                     value: "Set Open 🟢",                         inline: true  },
          { name: "`!slow`",                     value: "Set Slow 🟡",                         inline: true  },
          { name: "`!close`",                    value: "Set Closed 🔴",                       inline: true  },
          { name: "`!status`",                   value: "Show status + channel",               inline: false },
          { name: "`!setchannel #ch`",           value: "Set inquiry channel",                 inline: false },
          { name: "**Orders**",                  value: "\u200b", inline: false },
          { name: "`!orders [status]`",          value: "List orders (filter: pending/accepted/etc)", inline: false },
          { name: "`!order <id>`",               value: "Full order details",                  inline: false },
          { name: "`!paid <id>`",                value: "Mark order paid ✅",                  inline: false },
          { name: "`!unpaid <id>`",              value: "Mark order unpaid ⏳",                inline: false },
          { name: "`!setstatus <id> <text>`",    value: "Set order status",                    inline: false },
          { name: "`!note <id> <text>`",         value: "Add note to order",                   inline: false },
        ).setFooter({ text: "Echo Services Bot" }).setTimestamp()
    ]});
  }
});

// ─── BUTTON INTERACTIONS ───────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: "❌ Owner only.", flags: MessageFlags.Ephemeral });
  }

  const [action, discordId] = interaction.customId.split(":");

  try {
    if (action === "accept" || action === "decline") {
      const orders = await loadOrders();
      // Find most recent Pending order from this user
      let idx = -1;
      for (let i = orders.length - 1; i >= 0; i--) {
        if (orders[i].clientDiscordId === discordId && orders[i].status === "Pending") {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        orders[idx].status = action === "accept" ? "Accepted" : "Declined";
        await saveOrders(orders);
      }

      // Disable buttons on the message
      await interaction.update({
        components: [{
          type: 1,
          components: [
            { type: 2, style: action === "accept" ? 3 : 4, label: action === "accept" ? "✅ Accepted" : "❌ Declined", custom_id: "done", disabled: true },
            { type: 2, style: 2, label: "💬 DM Client", custom_id: `dm:${discordId}` },
          ],
        }],
      });

      await interaction.followUp({
        content: action === "accept"
          ? `✅ Accepted. DM <@${discordId}>: https://discord.com/users/${discordId}`
          : `❌ Marked as Declined.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === "dm") {
      await interaction.reply({
        content: `💬 DM <@${discordId}>: https://discord.com/users/${discordId}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error("Button error:", err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Error.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ─── EXPRESS APP ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.SITE_URL || "*", methods: ["GET", "POST", "OPTIONS"] }));

// FIX 1: Removed `store: new rateLimit.MemoryStore()` — MemoryStore is the
// default in express-rate-limit. rateLimit.MemoryStore doesn't exist as a
// property, calling `new` on it threw TypeError crashing the server on start.
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: "Too many submissions from this IP. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many messages from this IP. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET / — health check
app.get("/", (req, res) => {
  res.json({ status: "Echo Services online 🟢", bot: client.user?.tag || "starting..." });
});

// GET /status — website polls this to show the open/closed badge
app.get("/status", (req, res) => {
  const s = STATUS_DISPLAY[currentStatus];
  res.json({ status: currentStatus, label: s.label, emoji: s.emoji });
});

// POST /inquiry ─────────────────────────────────────────────────────────────
app.post("/inquiry", inquiryLimiter, async (req, res) => {
  try {
    const {
      discordUsername, clientDiscordId,
      serverName, serverInvite, serverType,
      budget, paymentMethod, projectDetails,
    } = req.body;

    if (!discordUsername || !clientDiscordId || !serverName || !serverType || !budget || !paymentMethod || !projectDetails) {
      return res.status(400).json({ error: "Missing required fields. Please fill in all required inputs." });
    }
    if (!isValidSnowflake(clientDiscordId)) {
      return res.status(400).json({ error: "Invalid Discord ID. Must be 17–20 digits. Enable Developer Mode in Discord Settings > Advanced to copy your ID." });
    }

    // FIX 4: Lazy config load — no race condition
    const channel = await getChannel();

    const uuid           = randomUUID();
    const isCustomBudget = budget === "Custom — DM me";
    const budgetDisplay  = isCustomBudget ? "Custom (to discuss)" : budget;
    const meta           = CATEGORY_META[serverType] || { color: 0x6ee7f7, emoji: "📥" };

    // Save order to file
    const orders = await loadOrders();
    orders.push({
      uuid,
      status:         "Pending",
      payment:        "⏳ Unpaid",
      discordUsername,
      clientDiscordId,
      serverName,
      serverInvite:   serverInvite || "Not provided",
      serviceType:    serverType,
      budget:         budgetDisplay,
      paymentMethod,
      projectDetails,
      createdAt:      new Date().toISOString(),
      paidAt:         null,
      notes:          "",
    });
    await saveOrders(orders);

    // FIX 3: Standard EmbedBuilder — no Components V2 / type:17 beta features
    // The original code used IS_COMPONENTS_V2 flag + type:17 containers which
    // requires Discord beta API opt-in. Without it Discord returns 400 → caught
    // as 500 here. Standard embeds work for every bot with no special access.
    const embed = new EmbedBuilder()
      .setTitle(`${meta.emoji}  New Inquiry — ${serverType}`)
      .setColor(meta.color)
      .setTimestamp()
      .setFooter({ text: `Echo Services  •  Order: ${uuid.slice(0,8)}` })
      .addFields(
        { name: "👤 Discord",      value: `${discordUsername}\n<@${clientDiscordId}>`,                inline: true  },
        { name: "🖥️ Server",       value: `${serverName}\n${serverInvite || "No invite provided"}`,  inline: true  },
        { name: "\u200b",          value: "\u200b",                                                    inline: true  },
        { name: "💰 Budget",       value: budgetDisplay,                                               inline: true  },
        { name: "💳 Payment",      value: paymentMethod,                                               inline: true  },
        { name: "📊 Status",       value: "⏳ Pending",                                               inline: true  },
        { name: "📝 Requirements", value: projectDetails.slice(0, 1024),                              inline: false },
        ...(isCustomBudget ? [{ name: "💡 Note", value: "Custom budget — reach out to discuss pricing first.", inline: false }] : []),
      );

    // Standard action buttons — no beta flag required
    const row = {
      type: 1,
      components: [
        { type: 2, style: 3, label: "✅ Accept",    custom_id: `accept:${clientDiscordId}`  },
        { type: 2, style: 4, label: "❌ Decline",   custom_id: `decline:${clientDiscordId}` },
        { type: 2, style: 2, label: "💬 DM Client", custom_id: `dm:${clientDiscordId}`      },
      ],
    };

    await channel.send({
      content: `<@${CONFIG.OWNER_ID}> — **new inquiry!**`,
      embeds: [embed],
      components: [row],
    });

    // Attempt to DM the client (non-fatal if DMs closed)
    try {
      const user = await client.users.fetch(clientDiscordId);
      await user.send(
        isCustomBudget
          ? `👋 Hey! Thanks for reaching out to **Echo Services**.\n\nYour inquiry has been received. You selected a custom budget — I'll DM you shortly to discuss pricing.\n\n> 🪪 **Order ID:** \`${uuid}\``
          : `👋 Hey! Thanks for reaching out to **Echo Services**.\n\nYour inquiry has been received and I'll get back to you as soon as possible.\n\n> 🪪 **Order ID:** \`${uuid}\``
      );
    } catch {
      console.warn(`Could not DM ${clientDiscordId} — DMs may be closed.`);
    }

    return res.json({
      success:         true,
      orderId:         uuid,
      isCustomBudget,
      message: isCustomBudget
        ? "Inquiry received! I'll DM you on Discord to discuss custom pricing."
        : "Inquiry received! I'll get back to you on Discord as soon as possible.",
    });

  } catch (err) {
    console.error("POST /inquiry error:", err.message);
    const msg = err.message.includes("configured") || err.message.includes("channel")
      ? err.message
      : "Something went wrong on our end. Please DM directly.";
    return res.status(500).json({ error: msg });
  }
});

// POST /contact ─────────────────────────────────────────────────────────────
app.post("/contact", contactLimiter, async (req, res) => {
  try {
    const { discordUsername, clientDiscordId, message } = req.body;

    if (!discordUsername || !clientDiscordId || !message) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (!isValidSnowflake(clientDiscordId)) {
      return res.status(400).json({ error: "Invalid Discord ID." });
    }

    const channel = await getChannel();

    const embed = new EmbedBuilder()
      .setTitle("💬 New Message — Echo Services")
      .setColor(0x7b6ff0)
      .setTimestamp()
      .addFields(
        { name: "👤 Discord", value: `${discordUsername}\n<@${clientDiscordId}>`, inline: true  },
        { name: "📝 Message", value: message.slice(0, 1024),                      inline: false },
      );

    const row = {
      type: 1,
      components: [{ type: 2, style: 2, label: "💬 DM Client", custom_id: `dm:${clientDiscordId}` }],
    };

    await channel.send({ content: `<@${CONFIG.OWNER_ID}>`, embeds: [embed], components: [row] });

    try {
      const user = await client.users.fetch(clientDiscordId);
      await user.send(`👋 Hey! Your message has been received by **Echo Services**. I'll reply on Discord soon.`);
    } catch {
      console.warn(`Could not DM ${clientDiscordId}`);
    }

    return res.json({ success: true });

  } catch (err) {
    console.error("POST /contact error:", err.message);
    const msg = err.message.includes("configured") || err.message.includes("channel")
      ? err.message
      : "Something went wrong. Please DM directly.";
    return res.status(500).json({ error: msg });
  }
});

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
process.on("SIGINT",  () => { client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });

// ─── BOOT ──────────────────────────────────────────────────────────────────
client.login(CONFIG.BOT_TOKEN)
  .then(() => app.listen(CONFIG.PORT, () => console.log(`🌐 Express listening on port ${CONFIG.PORT}`)))
  .catch(err => { console.error("❌ Login failed:", err.message); process.exit(1); });