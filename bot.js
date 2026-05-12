const { Client, GatewayIntentBits, Events } = require('discord.js');
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
  ],
});

// ── Paths ────────────────────────────────────────────────────────────────────
const BASE_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const ZIPS_DIR = path.join(BASE_DIR, 'image_archives');

function ensureDirs() {
  [BASE_DIR, ZIPS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── RTF helpers ──────────────────────────────────────────────────────────────
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

// ── File paths ───────────────────────────────────────────────────────────────
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

// ── Bootstrap RTF file if it doesn't exist ───────────────────────────────────
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

// ── Append one message block to the RTF ──────────────────────────────────────
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

  // NOTE: Images and attachments are explicitly skipped here as per requirements.

  const updated = raw + block.join('\n') + '\n' + rtfFooter();
  fs.writeFileSync(filePath, updated, 'utf8');
}

// ── Download helper for zipping ──────────────────────────────────────────────
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

// ── Zip helper ───────────────────────────────────────────────────────────────
function appendToZip(zipPath, buffer, fileName) {
  const zip = fs.existsSync(zipPath) ? new AdmZip(zipPath) : new AdmZip();
  zip.addFile(fileName, buffer);
  zip.writeZip(zipPath);
}

// ── Image MIME types we'll save ───────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff']);

function isImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

// ── Handle an incoming message ────────────────────────────────────────────────
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
          console.log(`[image] Archived to zip: ${zipPath}`);
        } catch (err) {
          console.error(`[image] Failed to archive ${att.url}:`, err.message);
        }
      }
    }
  }

  // Log text content to RTF
  appendMessageToRtf(rtfPath, message);
  console.log(`[log] ${guildName}/#${chanName} — ${message.author.username}: ${(message.content || '').slice(0, 60)}`);
}

// ── Events ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  ensureDirs();
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`📁  Logs directory : ${BASE_DIR}`);
  console.log(`📦  Image archives : ${ZIPS_DIR}`);
});

client.on(Events.MessageCreate, async message => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error('[error] handleMessage:', err);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌  DISCORD_TOKEN environment variable is not set.');
  process.exit(1);
}

client.login(token);
