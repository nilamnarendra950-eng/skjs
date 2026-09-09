const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── Global state ───────────────────────────────────────────────────────
let spamRunning = false;
let spamLogs = [];
let config = {};
let stopRequested = false;

// ─── Load config from file (if exists) ──────────────────────────────────
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch {
  config = {};
}

// ─── Save config to file ────────────────────────────────────────────────
function saveConfig() {
  fs.writeFileSync("config.json", JSON.stringify(config, null, 2), "utf8");
}

// ─── Log helper ─────────────────────────────────────────────────────────
function addLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  spamLogs.push(line);
  if (spamLogs.length > 200) spamLogs.shift(); // keep last 200 lines
  console.log(line);
}

// ─── Instagram API helper ───────────────────────────────────────────────
async function apiCall(endpoint, params, sessionId, csrfToken, groupUrl) {
  const url = `https://www.instagram.com${endpoint}`;
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "X-CSRFToken": csrfToken,
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-IG-WWW-Claim": "0",
    "X-Instagram-AJAX": "1",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "*/*",
    "Origin": "https://www.instagram.com",
    "Referer": groupUrl,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Cookie": `sessionid=${sessionId}; csrftoken=${csrfToken};`,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
    return res.status;
  } catch (err) {
    addLog(`Network error: ${err.message}`);
    return 0;
  }
}

// ─── Send message (API) ─────────────────────────────────────────────────
async function sendMessage(threadId, text, sessionId, csrfToken, groupUrl) {
  const status = await apiCall(
    "/api/v1/direct_v2/threads/broadcast/text/",
    { thread_ids: threadId, text: text },
    sessionId,
    csrfToken,
    groupUrl
  );
  return status === 200;
}

// ─── Rename group (API) ─────────────────────────────────────────────────
async function renameGroup(threadId, newName, sessionId, csrfToken, groupUrl) {
  const status = await apiCall(
    `/api/v1/direct_v2/threads/${threadId}/update_title/`,
    { title: newName },
    sessionId,
    csrfToken,
    groupUrl
  );
  return status === 200;
}

// ─── Spam loop (background) ─────────────────────────────────────────────
async function spamLoop(settings) {
  const { sessionId, csrfToken, groupUrl, messages, ncNames, delayMs, cycles } = settings;

  const threadMatch = groupUrl.match(/\/direct\/t\/(\d+)/);
  if (!threadMatch) {
    addLog("❌ Invalid group URL");
    return;
  }
  const threadId = threadMatch[1];

  spamRunning = true;
  stopRequested = false;
  addLog("🚀 Spam started");
  addLog(`📩 Messages: ${messages.length}, Delay: ${delayMs}ms, Cycles: ${cycles === 0 ? "infinite" : cycles}`);

  let cycle = 0;
  while (!stopRequested && (cycles === 0 || cycle < cycles)) {
    cycle++;
    addLog(`🔄 Cycle ${cycle} started`);

    let sent = 0;
    for (const msg of messages) {
      if (stopRequested) break;
      const success = await sendMessage(threadId, msg, sessionId, csrfToken, groupUrl);
      if (success) {
        sent++;
        addLog(`   ✅ ${msg.slice(0, 40)}...`);
      } else {
        addLog(`   ❌ Failed: ${msg.slice(0, 40)}... waiting 5s`);
        await new Promise(r => setTimeout(r, 5000));
      }
      await new Promise(r => setTimeout(r, delayMs));
    }

    if (!stopRequested && ncNames.length > 0) {
      const name = ncNames[(cycle - 1) % ncNames.length];
      const renamed = await renameGroup(threadId, name, sessionId, csrfToken, groupUrl);
      addLog(`   ${renamed ? "✅" : "❌"} Group renamed to: ${name}`);
    }

    addLog(`✅ Cycle ${cycle} finished: ${sent}/${messages.length} messages sent`);

    if (cycles !== 0 && cycle >= cycles) break;
    if (!stopRequested) await new Promise(r => setTimeout(r, 2000));
  }

  spamRunning = false;
  addLog(stopRequested ? "⏹️ Spam stopped by user" : "🎉 Bot finished all cycles");
}

// ─── API Routes ─────────────────────────────────────────────────────────
// Start spam
app.post("/api/start", (req, res) => {
  if (spamRunning) {
    return res.status(400).json({ error: "Spam already running" });
  }

  const {
    sessionId,
    csrfToken,
    groupUrl,
    messages,
    ncNames,
    delayMs,
    cycles
  } = req.body;

  if (!sessionId || !csrfToken || !groupUrl || !messages || messages.length === 0) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Save to config for persistence
  config = { ...config, sessionId, csrfToken, groupUrl, delayMs, cycles };
  saveConfig();

  // Start spam loop in background
  spamLoop({ sessionId, csrfToken, groupUrl, messages, ncNames: ncNames || [], delayMs, cycles })
    .catch(err => {
      addLog(`❌ Fatal error: ${err.message}`);
      spamRunning = false;
    });

  res.json({ success: true });
});

// Stop spam
app.post("/api/stop", (req, res) => {
  stopRequested = true;
  res.json({ success: true });
});

// Get status/logs
app.get("/api/status", (req, res) => {
  res.json({
    running: spamRunning,
    logs: spamLogs
  });
});

// Get current config (without sensitive data)
app.get("/api/config", (req, res) => {
  res.json({
    sessionId: config.sessionId ? "***" : "",
    csrfToken: config.csrfToken ? "***" : "",
    groupUrl: config.groupUrl || "",
    delayMs: config.delayMs || 500,
    cycles: config.cycles || 0
  });
});

// ─── Start server ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
