const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ComponentType } = require("discord.js");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const { randomUUID } = require("crypto");

const app = express();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

app.use(cors());
app.use(express.json());

// ─── RATE LIMITING ─────────────────────────────────────────────────────────
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: "Too many submissions from this IP. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: "Too many messages from this IP. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: process.env.OWNER_ID || "776208075009818636",
  PORT: process.env.PORT || 3000,
  PREFIX: "!",
  CONFIG_FILE: "./config.json",
  ORDERS_FILE: "./orders.json",
};

// ─── PERSISTENT CONFIG ─────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, "utf8")); }
  catch { return { inquiryChannelId: process.env.INQUIRY_CHANNEL_ID || null }; }
}
function saveConfig(data) {
  fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(data, null, 2));
}
let botConfig = loadConfig();

// ─── ORDERS STORE ──────────────────────────────────────────────────────────
// Each order: { uuid, status, payment, clientDiscordId, discordUsername,
//               serverName, serviceType, budget, paymentMethod, projectDetails,
//               createdAt, paidAt, notes }
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(CONFIG.ORDERS_FILE, "utf8")); }
  catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(CONFIG.ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ─── STATUS STATE ──────────────────────────────────────────────────────────
let currentStatus = "open";
const STATUS_DISPLAY = {
  open:   { label: "Open for orders",        emoji: "🟢", color: 0x00e5c4 },
  slow:   { label: "Slow — may take longer", emoji: "🟡", color: 0xf5a623 },
  closed: { label: "Closed for orders",      emoji: "🔴", color: 0xff4444 },
};

const IS_COMPONENTS_V2 = 1 << 15;

// ─── BOT READY ─────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Echo Services bot online as ${client.user.tag}`);
  client.user.setActivity("echo services | !help", { type: 3 });
});

// ─── COMMANDS ──────────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CONFIG.PREFIX)) return;
  if (msg.author.id !== CONFIG.OWNER_ID) {
    return msg.reply("❌ You don't have permission to use these commands.");
  }

  const args = msg.content.slice(CONFIG.PREFIX.length).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // ── !setchannel ──────────────────────────────────────────────────────────
  if (cmd === "setchannel") {
    const mentioned = msg.mentions.channels.first();
    const rawId = args[1];
    const channelId = mentioned?.id || rawId;
    if (!channelId) return msg.reply("❌ Usage: `!setchannel #channel` or `!setchannel <id>`");
    try {
      const ch = await client.channels.fetch(channelId);
      botConfig.inquiryChannelId = ch.id;
      saveConfig(botConfig);
      const embed = new EmbedBuilder()
        .setColor(0x00e5c4).setTitle("✅ Inquiry Channel Set")
        .setDescription(`New inquiries will now post to <#${ch.id}>.`).setTimestamp();
      return msg.reply({ embeds: [embed] });
    } catch {
      return msg.reply("❌ Couldn't find that channel. Make sure the bot has access.");
    }
  }

  // ── !open / !slow / !close ───────────────────────────────────────────────
  if (["open", "slow", "close"].includes(cmd)) {
    const key = cmd === "close" ? "closed" : cmd;
    currentStatus = key;
    const s = STATUS_DISPLAY[key];
    const embed = new EmbedBuilder().setColor(s.color)
      .setTitle(`${s.emoji} Status Updated`)
      .setDescription(`Echo Services is now **${s.label}**.\nWebsite updates within 30 seconds.`).setTimestamp();
    return msg.reply({ embeds: [embed] });
  }

  // ── !status ──────────────────────────────────────────────────────────────
  if (cmd === "status") {
    const s = STATUS_DISPLAY[currentStatus];
    const chText = botConfig.inquiryChannelId ? `<#${botConfig.inquiryChannelId}>` : "⚠️ Not set — use `!setchannel`";
    const embed = new EmbedBuilder().setColor(s.color).setTitle("📡 Echo Services — Status")
      .addFields(
        { name: "Order Status",    value: `${s.emoji} ${s.label}`, inline: true },
        { name: "Inquiry Channel", value: chText,                  inline: true }
      ).setTimestamp();
    return msg.reply({ embeds: [embed] });
  }

  // ── !orders ───────────────────────────────────────────────────────────────
  if (cmd === "orders") {
    const orders = loadOrders();
    if (orders.length === 0) return msg.reply("📭 No orders yet.");

    const filter = args[1]; // optional: active / complete / pending
    const filtered = filter
      ? orders.filter(o => o.status?.toLowerCase() === filter.toLowerCase())
      : orders;

    if (filtered.length === 0) return msg.reply(`📭 No orders with status **${filter}**.`);

    const lines = filtered.slice(-10).map(o =>
      `\`${o.uuid.slice(0,8)}\` | **${o.discordUsername}** | ${o.serviceType} | ${o.budget} | Status: **${o.status}** | Payment: **${o.payment}**`
    ).join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x00e5c4)
      .setTitle(`📋 Orders${filter ? ` — ${filter}` : ""} (showing last ${filtered.slice(-10).length})`)
      .setDescription(lines)
      .setFooter({ text: `Total: ${filtered.length} order(s)` })
      .setTimestamp();
    return msg.reply({ embeds: [embed] });
  }

  // ── !order <uuid> ─────────────────────────────────────────────────────────
  if (cmd === "order") {
    const id = args[1];
    if (!id) return msg.reply("❌ Usage: `!order <uuid>`");
    const orders = loadOrders();
    const order = orders.find(o => o.uuid.startsWith(id));
    if (!order) return msg.reply(`❌ No order found matching \`${id}\``);

    const embed = new EmbedBuilder()
      .setColor(0x7b6ff0)
      .setTitle(`🗂️ Order — ${order.uuid.slice(0,8)}`)
      .addFields(
        { name: "UUID",           value: `\`${order.uuid}\``,              inline: false },
        { name: "💬 Client",      value: order.discordUsername,             inline: true  },
        { name: "🪪 Discord ID",  value: `<@${order.clientDiscordId}>`,    inline: true  },
        { name: "🖥️ Server",      value: order.serverName,                  inline: true  },
        { name: "🔧 Service",     value: order.serviceType,                 inline: true  },
        { name: "💰 Budget",      value: order.budget,                      inline: true  },
        { name: "💳 Payment",     value: order.paymentMethod,               inline: true  },
        { name: "📊 Status",      value: order.status,                      inline: true  },
        { name: "💵 Payment Status", value: order.payment,                  inline: true  },
        { name: "📅 Created",     value: new Date(order.createdAt).toLocaleString(), inline: true },
        { name: "📝 Details",     value: order.projectDetails.slice(0,500), inline: false },
        { name: "🗒️ Notes",       value: order.notes || "None",             inline: false },
      )
      .setTimestamp();
    return msg.reply({ embeds: [embed] });
  }

  // ── !paid <uuid> ──────────────────────────────────────────────────────────
  if (cmd === "paid") {
    const id = args[1];
    if (!id) return msg.reply("❌ Usage: `!paid <uuid>`");
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found matching \`${id}\``);
    orders[idx].payment = "✅ Paid";
    orders[idx].paidAt = new Date().toISOString();
    saveOrders(orders);
    return msg.reply(`✅ Order \`${orders[idx].uuid.slice(0,8)}\` marked as **Paid**.`);
  }

  // ── !unpaid <uuid> ────────────────────────────────────────────────────────
  if (cmd === "unpaid") {
    const id = args[1];
    if (!id) return msg.reply("❌ Usage: `!unpaid <uuid>`");
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found matching \`${id}\``);
    orders[idx].payment = "⏳ Unpaid";
    orders[idx].paidAt = null;
    saveOrders(orders);
    return msg.reply(`⏳ Order \`${orders[idx].uuid.slice(0,8)}\` marked as **Unpaid**.`);
  }

  // ── !setstatus <uuid> <status> ────────────────────────────────────────────
  if (cmd === "setstatus") {
    const id = args[1];
    const newStatus = args.slice(2).join(" ");
    if (!id || !newStatus) return msg.reply("❌ Usage: `!setstatus <uuid> <status>` — e.g. `!setstatus abc123 In Progress`");
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found matching \`${id}\``);
    orders[idx].status = newStatus;
    saveOrders(orders);
    return msg.reply(`✅ Order \`${orders[idx].uuid.slice(0,8)}\` status set to **${newStatus}**.`);
  }

  // ── !note <uuid> <note> ───────────────────────────────────────────────────
  if (cmd === "note") {
    const id = args[1];
    const note = args.slice(2).join(" ");
    if (!id || !note) return msg.reply("❌ Usage: `!note <uuid> <text>`");
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.uuid.startsWith(id));
    if (idx === -1) return msg.reply(`❌ No order found matching \`${id}\``);
    orders[idx].notes = note;
    saveOrders(orders);
    return msg.reply(`🗒️ Note added to order \`${orders[idx].uuid.slice(0,8)}\`.`);
  }

  // ── !help ────────────────────────────────────────────────────────────────
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setColor(0x00e5c4)
      .setTitle("📖 Echo Services — Bot Commands")
      .setDescription("All commands are owner-only.")
      .addFields(
        { name: "**Status**", value: "\u200b", inline: false },
        { name: "`!open`",   value: "Set status Open 🟢",                   inline: true  },
        { name: "`!slow`",   value: "Set status Slow 🟡",                   inline: true  },
        { name: "`!close`",  value: "Set status Closed 🔴",                 inline: true  },
        { name: "`!status`", value: "Show status & inquiry channel",         inline: false },
        { name: "`!setchannel #ch`", value: "Set inquiry channel",           inline: false },
        { name: "**Orders**", value: "\u200b", inline: false },
        { name: "`!orders [filter]`",         value: "List orders (optional: active/complete/pending)", inline: false },
        { name: "`!order <uuid>`",            value: "View full order details",          inline: false },
        { name: "`!paid <uuid>`",             value: "Mark order as paid ✅",            inline: false },
        { name: "`!unpaid <uuid>`",           value: "Mark order as unpaid ⏳",          inline: false },
        { name: "`!setstatus <uuid> <text>`", value: "Set order status (e.g. In Progress)", inline: false },
        { name: "`!note <uuid> <text>`",      value: "Add a note to an order",           inline: false },
      )
      .setFooter({ text: "Echo Services Bot" })
      .setTimestamp();
    return msg.reply({ embeds: [embed] });
  }
});

// ─── BUTTON INTERACTIONS ───────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: "❌ Only the owner can use these buttons.", flags: MessageFlags.Ephemeral });
  }

  const [action, ...rest] = interaction.customId.split(":");
  const discordId = rest[0];

  if (action === "accept") {
    // Find the order by clientDiscordId and update status
    const orders = loadOrders();
    const idx = orders.findLastIndex(o => o.clientDiscordId === discordId && o.status === "Pending");
    if (idx !== -1) { orders[idx].status = "Accepted"; saveOrders(orders); }

    const updated = buildV2Buttons(discordId, { accepted: true });
    await interaction.update({ components: updated, flags: IS_COMPONENTS_V2 });
    await interaction.followUp({
      content: `✅ Marked as **Accepted**. DM <@${discordId}> to get started: https://discord.com/users/${discordId}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === "decline") {
    const orders = loadOrders();
    const idx = orders.findLastIndex(o => o.clientDiscordId === discordId && o.status === "Pending");
    if (idx !== -1) { orders[idx].status = "Declined"; saveOrders(orders); }

    const updated = buildV2Buttons(discordId, { declined: true });
    await interaction.update({ components: updated, flags: IS_COMPONENTS_V2 });
    await interaction.followUp({ content: `❌ Marked as **Declined**.`, flags: MessageFlags.Ephemeral });
  }

  if (action === "dm") {
    await interaction.reply({
      content: `💬 Open a DM with <@${discordId}>: https://discord.com/users/${discordId}`,
      flags: MessageFlags.Ephemeral,
    });
  }
});

// ─── COMPONENTS V2 BUTTON ROW BUILDER ─────────────────────────────────────
function buildV2Buttons(discordId, { accepted = false, declined = false, invite = null } = {}) {
  const done = accepted || declined;
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: accepted ? "✅ Accepted" : "✅ Accept", custom_id: `accept:${discordId}`, disabled: done },
      { type: 2, style: 4, label: declined ? "❌ Declined" : "❌ Decline", custom_id: `decline:${discordId}`, disabled: done },
      { type: 2, style: 2, label: "💬 DM Client", custom_id: `dm:${discordId}`, disabled: false },
      ...(invite ? [{ type: 2, style: 5, label: "🔗 Join Server", url: invite.startsWith("http") ? invite : `https://${invite}` }] : []),
    ],
  }];
}

// ─── EXPRESS ROUTES ────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Echo Services backend online", bot: client.user?.tag });
});

app.get("/status", (req, res) => {
  res.json({ status: currentStatus, label: STATUS_DISPLAY[currentStatus].label });
});

app.post("/inquiry", inquiryLimiter, async (req, res) => {
  try {
    const {
      discordUsername, clientDiscordId,
      serverName, serverInvite, serverType,
      budget, paymentMethod, projectDetails,
    } = req.body;

    if (!discordUsername || !clientDiscordId || !serverName || !serverInvite || !serverType || !budget || !paymentMethod || !projectDetails) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!botConfig.inquiryChannelId) {
      return res.status(500).json({ error: "Inquiry channel not configured. Owner must run !setchannel." });
    }

    const channel = await client.channels.fetch(botConfig.inquiryChannelId);
    if (!channel) return res.status(500).json({ error: "Channel not found" });

    // Generate UUID for this order
    const uuid = randomUUID();

    // Determine budget display
    const isCustomBudget = budget === "Custom — DM me";
    const budgetDisplay = isCustomBudget ? "Custom — will reach out shortly" : budget;

    // Save order
    const orders = loadOrders();
    orders.push({
      uuid,
      status: "Pending",
      payment: "⏳ Unpaid",
      discordUsername,
      clientDiscordId,
      serverName,
      serverInvite,
      serverType,
      budget: budgetDisplay,
      paymentMethod,
      projectDetails,
      createdAt: new Date().toISOString(),
      paidAt: null,
      notes: "",
    });
    saveOrders(orders);

    const hasInvite = serverInvite && serverInvite.trim().length > 0;
    const normalizedInvite = hasInvite
      ? (serverInvite.startsWith("http") ? serverInvite : `https://${serverInvite}`)
      : null;

    const truncatedDetails = projectDetails.length > 900
      ? projectDetails.slice(0, 897) + "..."
      : projectDetails;

    const [actionRow] = buildV2Buttons(clientDiscordId, { invite: normalizedInvite });

    const components = [
      {
        type: 17, // CONTAINER
        accent_color: 0x00e5c4,
        components: [
          {
            type: 10,
            content: `## 📨 New Inquiry — Echo Services\n-# Order ID: \`${uuid}\``,
          },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 10,
            content: [
              `**💬 Discord** — ${discordUsername}`,
              `**🪪 Discord ID** — <@${clientDiscordId}> (\`${clientDiscordId}\`)`,
            ].join("\n"),
          },
          { type: 14, divider: false, spacing: 1 },
          {
            type: 10,
            content: [
              `**🖥️ Server** — ${serverName}`,
              `**📂 Server Type** — ${serverType}`,
              `**🔗 Invite** — ${hasInvite ? serverInvite : "Not provided"}`,
            ].join("\n"),
          },
          { type: 14, divider: false, spacing: 1 },
          {
            type: 10,
            content: [
              `**💰 Budget** — ${budgetDisplay}`,
              `**💳 Payment** — ${paymentMethod}`,
              isCustomBudget ? `\n> 💡 *Custom budget — reach out to discuss pricing.*` : "",
            ].filter(Boolean).join("\n"),
          },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 10,
            content: `**📝 Bot Description & Requirements**\n${truncatedDetails}`,
          },
          { type: 14, divider: true, spacing: 1 },
          actionRow,
        ],
      },
    ];

    await channel.send({ components, flags: IS_COMPONENTS_V2 });

    // ── DM the client their order number ──────────────────
    try {
      const dmUser = await client.users.fetch(clientDiscordId);
      const dmMsg = isCustomBudget
        ? `Hey! Thanks for reaching out to **Echo Services**. 👋\n\nYour inquiry has been received. Since you selected a custom budget, I'll reach out shortly to discuss pricing before anything starts.\n\nReply to this message with any further information.\n\n> 🪪 **Your Order Number:** \`${uuid}\``
        : `Hey! Thanks for reaching out to **Echo Services**. 👋\n\nYour inquiry has been received and I'll get back to you as soon as possible with a quote and timeline.\n\nReply to this message with any further information.\n\n> 🪪 **Your Order Number:** \`${uuid}\``;
      await dmUser.send(dmMsg);
    } catch {
      // DMs may be closed — silently fail, we still have the inquiry
      console.warn(`Could not DM user ${clientDiscordId} — DMs may be closed.`);
    }

    res.json({
      success: true,
      message: isCustomBudget
        ? "Inquiry received! Since you selected a custom budget, I will reach out to you shortly to discuss pricing."
        : "Inquiry received! I'll reach out to you on Discord as soon as possible.",
      orderId: uuid,
      isCustomBudget,
    });

  } catch (err) {
    console.error("Error handling inquiry:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── CONTACT ROUTE ─────────────────────────────────────────────────────────
app.post("/contact", contactLimiter, async (req, res) => {
  try {
    const { discordUsername, clientDiscordId, message } = req.body;
    if (!discordUsername || !clientDiscordId || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!botConfig.inquiryChannelId) {
      return res.status(500).json({ error: "Channel not configured. Owner must run !setchannel." });
    }

    const channel = await client.channels.fetch(botConfig.inquiryChannelId);
    if (!channel) return res.status(500).json({ error: "Channel not found" });

    // Post to channel
    const components = [
      {
        type: 17,
        accent_color: 0x7b6ff0,
        components: [
          { type: 10, content: "## 💬 New Message — Echo Services" },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 10,
            content: [
              `**💬 Discord** — ${discordUsername}`,
              `**🪪 Discord ID** — <@${clientDiscordId}> (\`${clientDiscordId}\`)`,
            ].join("\n"),
          },
          { type: 14, divider: true, spacing: 1 },
          { type: 10, content: `**📝 Message**\n${message}` },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 1,
            components: [
              { type: 2, style: 2, label: "💬 DM Client", custom_id: `dm:${clientDiscordId}` },
            ],
          },
        ],
      },
    ];

    await channel.send({ components, flags: IS_COMPONENTS_V2 });

    // Try to DM them back
    try {
      const dmUser = await client.users.fetch(clientDiscordId);
      await dmUser.send(`Hey! Thanks for reaching out to **Echo Services**. 👋\n\nYour message has been received and I'll reply on Discord as soon as possible.`);
    } catch {
      console.warn(`Could not DM user ${clientDiscordId} — DMs may be closed.`);
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Error handling contact:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── START ─────────────────────────────────────────────────────────────────
client.login(CONFIG.BOT_TOKEN);
app.listen(CONFIG.PORT, () => {
  console.log(`🌐 Express server listening on port ${CONFIG.PORT}`);
});