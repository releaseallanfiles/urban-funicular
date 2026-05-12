const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ── Paths ─────────────────────────────────────────────────────────────────────
const BASE_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const ZIPS_DIR = path.join(BASE_DIR, 'image_archives');

function ensureDirs() {
  [BASE_DIR, ZIPS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── RTF helpers ───────────────────────────────────────────────────────────────
function sanitizeRtf(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\line\n')
    .replace(/[^\x00-\x7F]/g, c => `\\u${c.codePointAt(0)}?`);
}

function rtfHeader() {
  return [
    '{\\rtf1\\ansi\\deff0',
    '{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fmodern\\fcharset0 Courier New;}}',
    '{\\colortbl;\\red0\\green0\\blue0;\\red80\\green80\\blue80;\\red0\\green100\\blue180;\\red150\\green0\\blue0;}',
    '\\f0\\fs22\\sa120',
  ].join('\n');
}

function rtfFooter() {
  return '}';
}

// ── File paths ─────────────────────────────────────────────────────────────────
function rtfPathForChannel(channel) {
  const guild  = channel.guild ? channel.guild.name.replace(/[^a-z0-9]/gi, '_') : 'DM';
  const chName = channel.name  ? channel.name.replace(/[^a-z0-9]/gi, '_')  : channel.id;
  return path.join(BASE_DIR, `${guild}__${chName}__${channel.id}.rtf`);
}

function zipPathForChannel(channel) {
  const guild  = channel.guild ? channel.guild.name.replace(/[^a-z0-9]/gi, '_') : 'DM';
  const chName = channel.name  ? channel.name.replace(/[^a-z0-9]/gi, '_')  : channel.id;
  return path.join(ZIPS_DIR, `${guild}__${chName}__${channel.id}.images.zip`);
}

// ── Bootstrap RTF file if it doesn't exist ────────────────────────────────────
function initRtfFile(filePath, channelName, guildName) {
  if (!fs.existsSync(filePath)) {
    const title = sanitizeRtf(`Discord Channel Log — ${guildName} / #${channelName}`);
    const created = sanitizeRtf(new Date().toUTCString());
    const content = [
      rtfHeader(),
      `{\\b\\fs32 ${title}}\\line`,
      `{\\i\\cf2 Log started: ${created}}\\line`,
      '\\line',
      rtfFooter(),
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

// ── Append one message block to the RTF ────────────────────────────────────────
function appendMessageToRtf(filePath, message) {
  let raw = fs.readFileSync(filePath, 'utf8');

  // Strip the closing brace so we can append
  raw = raw.trimEnd();
  if (raw.endsWith('}')) raw = raw.slice(0, -1);

  const ts      = sanitizeRtf(message.createdAt.toUTCString());
  const user    = sanitizeRtf(`${message.author.username}`);
  const content = sanitizeRtf(message.content || '');

  let block = [
    '',
    '\\line',
    `{\\cf3\\b ${user}} {\\cf2\\i [${ts}]}\\line`,
  ];

  if (content) {
    block.push(`${content}\\line`);
  }

  // Log attachment references
  if (message.attachments.size > 0) {
    const attachmentList = Array.from(message.attachments.values())
      .map(att => sanitizeRtf(att.name))
      .join(', ');
    block.push(`{\\cf2\\i [Attachments: ${attachmentList}]}\\line`);
  }

  const updated = raw + block.join('\n') + '\n' + rtfFooter();
  fs.writeFileSync(filePath, updated, 'utf8');
}

// ── Download helper for zipping ────────────────────────────────────────────────
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    }).on('error', err => reject(err));
  });
}

// ── Zip helper ────────────────────────────────────────────────────────────────
function appendToZip(zipPath, buffer, fileName) {
  const zip = fs.existsSync(zipPath) ? new AdmZip(zipPath) : new AdmZip();
  zip.addFile(fileName, buffer);
  zip.writeZip(zipPath);
}

// ── Image MIME types we'll save ────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff']);

function isImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

// ── Handle an incoming message ─────────────────────────────────────────────────
async function handleMessage(message) {
  if (message.author.bot) return; // skip bots

  const channel  = message.channel;
  const rtfPath  = rtfPathForChannel(channel);
  const guildName = channel.guild ? channel.guild.name : 'Direct Message';
  const chanName  = channel.name  || channel.id;

  initRtfFile(rtfPath, chanName, guildName);

  // Handle images by zipping them
  if (message.attachments.size > 0) {
    const zipPath = zipPathForChannel(channel);
    for (const [, att] of message.attachments) {
      if (isImage(att.name)) {
        try {
          const buffer = await fetchImageBuffer(att.url);
          const safeName = `${Date.now()}_${att.name.replace(/[^a-z0-9._-]/gi, '_')}`;
          appendToZip(zipPath, buffer, safeName);
          console.log(`[image] Archived to zip: ${safeName} → ${zipPath}`);
        } catch (err) {
          console.error(`[image] Failed to archive ${att.url}:`, err.message);
        }
      }
    }
  }

  // Log text content to RTF (including attachment references)
  appendMessageToRtf(rtfPath, message);
  console.log(`[log] ${guildName}/#${chanName} — ${message.author.username}: ${(message.content || '').slice(0, 60)}`);
}

// ── Slash Commands ─────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and logs directory'),
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Show log and archive statistics'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help and what this bot does'),
  new SlashCommandBuilder()
    .setName('log-current-channel')
    .setDescription('Manually log the current channel (retro-log messages)'),
  new SlashCommandBuilder()
    .setName('export-channel')
    .setDescription('Export current channel logs as text file'),
  new SlashCommandBuilder()
    .setName('export-images')
    .setDescription('Get info about archived images for this channel'),
].map(command => command.toJSON());

async function registerSlashCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!clientId) {
    console.warn('⚠️  CLIENT_ID not set. Skipping command registration.');
    return;
  }

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('🔄 Registering slash commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
}

async function handleSlashCommand(interaction) {
  try {
    const command = interaction.commandName;

    if (command === 'status') {
      await interaction.reply({
        content: `✅ **Bot Status**\n📁 Logs directory: \`${BASE_DIR}\`\n🤖 Logged in as: ${client.user.tag}`,
        ephemeral: true,
      });
    } 
    else if (command === 'logs') {
      const rtfFiles = fs.existsSync(BASE_DIR) 
        ? fs.readdirSync(BASE_DIR).filter(f => f.endsWith('.rtf')).length 
        : 0;
      const zipFiles = fs.existsSync(ZIPS_DIR) 
        ? fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.zip')).length 
        : 0;

      await interaction.reply({
        content: `📊 **Log Statistics**\n📄 RTF files: ${rtfFiles}\n🖼️  Image archives: ${zipFiles}`,
        ephemeral: true,
      });
    } 
    else if (command === 'help') {
      await interaction.reply({
        content: `ℹ️ **Discord Logger Bot**\n\n**What I do:**\n• Log all text messages to RTF files\n• Archive images to ZIP files\n• Organize by server and channel\n\n**Commands:**\n• \`/status\` - Show bot status\n• \`/logs\` - View log statistics\n• \`/log-current-channel\` - Manually trigger logging for current channel\n• \`/export-channel\` - View current channel RTF file info\n• \`/export-images\` - View archived images info\n• \`/help\` - Show this help message\n\n**Privacy:** All command responses are ephemeral (visible only to you).`,
        ephemeral: true,
      });
    }
    else if (command === 'log-current-channel') {
      const channel = interaction.channel;
      const rtfPath = rtfPathForChannel(channel);
      const guildName = channel.guild ? channel.guild.name : 'Direct Message';
      const chanName = channel.name || channel.id;

      try {
        initRtfFile(rtfPath, chanName, guildName);
        await interaction.reply({
          content: `✅ Channel log initialized!\n📄 File: \`${path.basename(rtfPath)}\`\n📍 Location: \`${rtfPath}\``,
          ephemeral: true,
        });
      } catch (err) {
        await interaction.reply({
          content: `❌ Failed to initialize log: ${err.message}`,
          ephemeral: true,
        });
      }
    }
    else if (command === 'export-channel') {
      const channel = interaction.channel;
      const rtfPath = rtfPathForChannel(channel);

      if (!fs.existsSync(rtfPath)) {
        await interaction.reply({
          content: `❌ No log file exists for this channel yet.\n📝 File would be: \`${path.basename(rtfPath)}\``,
          ephemeral: true,
        });
        return;
      }

      const fileSize = fs.statSync(rtfPath).size;
      const fileLines = fs.readFileSync(rtfPath, 'utf8').split('\n').length;

      await interaction.reply({
        content: `📄 **Channel Log Info**\n` +
                 `📁 File: \`${path.basename(rtfPath)}\`\n` +
                 `📊 Size: ${(fileSize / 1024).toFixed(2)} KB\n` +
                 `📝 Lines: ${fileLines}\n` +
                 `📍 Full path: \`${rtfPath}\``,
        ephemeral: true,
      });
    }
    else if (command === 'export-images') {
      const channel = interaction.channel;
      const zipPath = zipPathForChannel(channel);

      if (!fs.existsSync(zipPath)) {
        await interaction.reply({
          content: `❌ No image archive exists for this channel yet.\n📦 Archive would be: \`${path.basename(zipPath)}\``,
          ephemeral: true,
        });
        return;
      }

      try {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        const fileSize = fs.statSync(zipPath).size;

        await interaction.reply({
          content: `🖼️ **Channel Image Archive**\n` +
                   `📦 Archive: \`${path.basename(zipPath)}\`\n` +
                   `📊 Images: ${entries.length}\n` +
                   `💾 Size: ${(fileSize / 1024).toFixed(2)} KB\n` +
                   `📍 Path: \`${zipPath}\``,
          ephemeral: true,
        });
      } catch (err) {
        await interaction.reply({
          content: `❌ Failed to read image archive: ${err.message}`,
          ephemeral: true,
        });
      }
    }
    else {
      await interaction.reply({
        content: '❌ Unknown command.',
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('[error] handleSlashCommand:', err);
    if (!interaction.replied) {
      await interaction.reply({
        content: '❌ An error occurred processing your command.',
        ephemeral: true,
      });
    }
  }
}

// ── Events ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  ensureDirs();
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📁 Logs directory : ${BASE_DIR}`);
  console.log(`📦 Image archives : ${ZIPS_DIR}`);
  await registerSlashCommands();
});

client.on(Events.MessageCreate, async message => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error('[error] handleMessage:', err);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isCommand()) {
    await handleSlashCommand(interaction);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN environment variable is not set.');
  process.exit(1);
}

const clientId = process.env.CLIENT_ID;
if (!clientId) {
  console.warn('⚠️  CLIENT_ID not set. Commands may not register properly.');
}

client.login(token);
