// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD BACKEND ADDITIONS
// Add these to ~/discord-bot-backend/index.js
// ═══════════════════════════════════════════════════════════════════════
//
// STEP 1 — Install multer (one time):
//   cd ~/discord-bot-backend && npm install multer
//
// STEP 2 — At the TOP of index.js, with the other requires:
//
//   const { exec, spawn } = require('child_process');
//   const fs              = require('fs');
//   const multer          = require('multer');
//   const upload          = multer({ dest: '/tmp/bot-uploads/' });
//
// STEP 3 — Paste the routes below into index.js (anywhere before app.listen)
// ═══════════════════════════════════════════════════════════════════════

// ── CORS (allow dashboard HTML to call from port 80) ──────────────────
// If you don't have cors middleware already, add this near the top:
//
//   app.use((req, res, next) => {
//     res.setHeader('Access-Control-Allow-Origin', '*');
//     res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//     if (req.method === 'OPTIONS') return res.sendStatus(204);
//     next();
//   });


// ── 1. LIVE LOG STREAM (SSE) ──────────────────────────────────────────
// GET /dashboard/logs/:bot/stream
// Streams journalctl (systemd bots) or pm2 logs (node backend) live.

app.get('/dashboard/logs/:bot/stream', (req, res) => {
  const bot = req.params.bot;

  res.setHeader('Content-Type',                 'text/event-stream');
  res.setHeader('Cache-Control',                'no-cache');
  res.setHeader('Connection',                   'keep-alive');
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.flushHeaders();

  let proc;
  if (bot === 'discord-bot-backend') {
    // PM2-managed node process
    proc = spawn('pm2', ['logs', 'discord-bot', '--raw', '--lines', '80', '--nocolor']);
  } else {
    // systemd Python bots
    proc = spawn('journalctl', ['-u', bot, '-f', '--no-pager', '-n', '80', '-o', 'short']);
  }

  const send = (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    }
  };

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);

  // Keepalive ping every 20s so the connection doesn't drop
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(ping);
    try { proc.kill(); } catch {}
  });
});


// ── 2. SYSTEM STATS ───────────────────────────────────────────────────
// GET /dashboard/stats
// Returns CPU %, RAM (MB used/total), Disk usage.

app.get('/dashboard/stats', (req, res) => {
  exec("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'", (e1, cpuRaw) => {
    exec("free -m | awk 'NR==2{print $3\" \"$2}'", (e2, ramRaw) => {
      exec("df -h / | awk 'NR==2{print $3\" \"$2\" \"$5}'", (e3, diskRaw) => {
        const cpu                   = parseFloat(cpuRaw || '0').toFixed(1);
        const [memUsed, memTotal]   = (ramRaw  || '0 0').trim().split(' ');
        const [diskUsed, diskTotal, diskPct] = (diskRaw || '0 0 0%').trim().split(' ');
        res.json({ cpu, memUsed, memTotal, diskUsed, diskTotal, diskPct });
      });
    });
  });
});


// ── 3. QUICK COMMAND RUNNER ───────────────────────────────────────────
// POST /dashboard/command/:bot   { "cmd": "pip install requests" }
// Runs a shell command inside the bot's working directory.

const BOT_DIRS = {
  londonbot:           '/home/admin1/londonbot',
  bot2:                '/home/admin1/bot2',
  texasrp:             '/home/admin1/texasbot',
  'discord-bot-backend': '/home/admin1/discord-bot-backend',
};

// Basic blocklist — prevents obviously destructive commands
const BLOCKED_CMDS = ['rm -rf /', 'mkfs', 'dd if=', ':(){ :|:& };:', 'shutdown', 'reboot', 'poweroff'];

app.post('/dashboard/command/:bot', (req, res) => {
  const bot = req.params.bot;
  const cmd = (req.body && req.body.cmd) ? req.body.cmd.trim() : '';

  if (!cmd) return res.status(400).json({ error: 'No command provided' });

  if (BLOCKED_CMDS.some(b => cmd.includes(b))) {
    return res.status(403).json({ error: 'Command blocked for safety' });
  }

  const cwd = BOT_DIRS[bot] || `/home/admin1/${bot}`;

  exec(cmd, { cwd, timeout: 30000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
    res.json({
      stdout: stdout || '',
      stderr: stderr || '',
      code:   err ? (err.code || 1) : 0,
    });
  });
});


// ── 4. ONE-CLICK BOT DEPLOY ───────────────────────────────────────────
// POST /dashboard/setup  (multipart form)
// Fields: botname, entrypoint, deps, envContent
// File:   botfile (.py)
//
// What it does automatically:
//   1. Creates ~/botname directory
//   2. Copies uploaded .py file
//   3. Writes .env file (if provided)
//   4. Creates Python venv
//   5. pip installs discord.py + python-dotenv + any extras
//   6. Writes /etc/systemd/system/botname.service
//   7. daemon-reload → enable → start
//
// Requires: admin1 has NOPASSWD sudo for systemctl (already set in visudo)

app.post('/dashboard/setup', upload.single('botfile'), (req, res) => {
  const { botname, entrypoint, deps, envContent } = req.body;

  // Validate
  if (!botname || !/^[a-z0-9_-]+$/.test(botname)) {
    return res.status(400).json({ error: 'Invalid bot name. Use lowercase letters, numbers, hyphens.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No bot file uploaded.' });
  }

  const botDir  = `/home/admin1/${botname}`;
  const entry   = entrypoint || req.file.originalname || 'bot.py';
  const baseDeps = ['discord.py', 'python-dotenv'];
  const extraDeps = deps ? deps.split(',').map(d => d.trim()).filter(Boolean) : [];
  const allDeps  = [...new Set([...baseDeps, ...extraDeps])].join(' ');

  // Write the setup script to a temp file (avoids shell escaping hell)
  const scriptPath = `/tmp/deploy_${botname}_${Date.now()}.sh`;

  const serviceFile = `/etc/systemd/system/${botname}.service`;
  const serviceContent = `[Unit]
Description=${botname} Discord Bot
After=network.target

[Service]
User=admin1
WorkingDirectory=${botDir}
ExecStart=${botDir}/venv/bin/python3 ${entry}
Restart=always
RestartSec=10
EnvironmentFile=-${botDir}/.env

[Install]
WantedBy=multi-user.target`;

  // Build script lines
  const lines = [
    '#!/bin/bash',
    'set -e',
    `echo "[1/6] Creating directory: ${botDir}"`,
    `mkdir -p "${botDir}"`,
    `echo "[2/6] Copying bot file: ${entry}"`,
    `cp "${req.file.path}" "${botDir}/${entry}"`,
    `chmod 644 "${botDir}/${entry}"`,
  ];

  if (envContent && envContent.trim()) {
    lines.push(`echo "[2b] Writing .env file"`);
    // Write env via python to avoid heredoc escaping issues
    const envEscaped = JSON.stringify(envContent);
    lines.push(`python3 -c "import sys; open('${botDir}/.env','w').write(sys.argv[1])" ${envEscaped}`);
    lines.push(`chmod 600 "${botDir}/.env"`);
  }

  lines.push(
    `echo "[3/6] Creating virtual environment"`,
    `python3 -m venv "${botDir}/venv"`,
    `echo "[4/6] Installing: ${allDeps}"`,
    `"${botDir}/venv/bin/pip" install --quiet --upgrade pip`,
    `"${botDir}/venv/bin/pip" install --quiet ${allDeps}`,
    `echo "[5/6] Writing systemd service"`,
    // Write service file using python (safe for multiline)
    `python3 -c "open('${serviceFile}','w').write(open('/tmp/svc_${botname}.txt').read())"`,
    `echo "[6/6] Enabling and starting service"`,
    `sudo systemctl daemon-reload`,
    `sudo systemctl enable ${botname}`,
    `sudo systemctl start ${botname}`,
    `echo "STATUS: $(sudo systemctl is-active ${botname})"`,
    `echo "DEPLOY_OK"`,
  );

  try {
    // Write service content to a separate temp file
    fs.writeFileSync(`/tmp/svc_${botname}.txt`, serviceContent);
    fs.writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o755 });
  } catch (e) {
    return res.status(500).json({ error: `Failed to write setup script: ${e.message}` });
  }

  exec(`bash "${scriptPath}"`, { timeout: 180000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    // Cleanup temp files
    try { fs.unlinkSync(scriptPath); }          catch {}
    try { fs.unlinkSync(`/tmp/svc_${botname}.txt`); } catch {}
    try { fs.unlinkSync(req.file.path); }       catch {}

    const output = stdout || '';
    const ok     = output.includes('DEPLOY_OK');

    if (!ok) {
      return res.status(500).json({
        error: stderr || (err ? err.message : 'Unknown error'),
        stdout: output,
      });
    }

    res.json({
      success: true,
      stdout:  output.replace('DEPLOY_OK', '').trim(),
      message: `${botname} deployed and started successfully!`,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// END OF ADDITIONS
// ═══════════════════════════════════════════════════════════════════════