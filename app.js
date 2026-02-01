const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const si = require("systeminformation");

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.CORS_ORIGIN || "*";

// How often to sample + broadcast (ms)
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 1000);
// Rolling window size for line charts
const HISTORY_POINTS = Number(process.env.HISTORY_POINTS || 60);

// ---------- helpers ----------
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

function pushRolling(arr, item) {
  arr.push(item);
  if (arr.length > HISTORY_POINTS) arr.shift();
}

// Convert bytes -> MB
const bytesToMB = (b) => (typeof b === "number" ? b / (1024 * 1024) : 0);

// Format uptime seconds into "X Days, X Hours, X Minutes"
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${days} Days, ${hours} Hours, ${mins} Minutes`;
}

// ---------- app / server ----------
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
});

// ---------- in-memory cache + history ----------
const history = {
  // time-series points are objects: { t: epochMs, v: number }
  cpuLoad: [],
  cpuTempC: [],
  memUsedPercent: [],
  diskReadMBps: [],
  diskWriteMBps: [],
  netDownMBps: [],
  netUpMBps: [],
  cpuAvgGHz: [],
};

let lastPayload = null;

// For throughput deltas, we sample cumulative byte counters and compute per-second rates.
let prevDiskStats = null;
let prevNetStats = null;
let prevSampleAt = Date.now();

// ---------- data collection ----------
async function getTopProcesses() {
  // systeminformation.processes() can be heavy; keep it to top 5.
  const p = await si.processes();

  // Some platforms return lots of fields; normalize CPU% and MEM MB
  const list = (p.list || []).map((proc) => ({
    pid: proc.pid,
    name: proc.name || proc.command || `pid:${proc.pid}`,
    cpuPercent: clamp(Number(proc.cpu) || 0, 0, 100),
    ramMB: Math.max(0, Number(proc.mem_rss) ? bytesToMB(proc.mem_rss) : 0),
  }));

  // Sort by CPU desc, take top 5
  list.sort((a, b) => b.cpuPercent - a.cpuPercent);
  return list.slice(0, 5);
}

async function getDiskUsagePercent() {
  // Sum across mounted filesystems (skips weird/virtual mounts as best we can)
  const fsList = await si.fsSize();
  let used = 0;
  let size = 0;

  for (const d of fsList || []) {
    if (!d || typeof d.size !== "number" || typeof d.used !== "number") continue;
    // You can add filtering here if needed (e.g., skip tmpfs)
    used += d.used;
    size += d.size;
  }

  const usedPercent = size > 0 ? clamp((used / size) * 100, 0, 100) : 0;
  return {
    usedBytes: used,
    totalBytes: size,
    usedPercent,
  };
}

async function getDiskThroughputMBps(now, dtSec) {
  // diskIO() returns cumulative bytes read/written since boot (platform dependent)
  const ioStats = await si.disksIO(); // { rBytes, wBytes, ... }
  const rBytes = Number(ioStats.rBytes) || 0;
  const wBytes = Number(ioStats.wBytes) || 0;

  let readMBps = 0;
  let writeMBps = 0;

  if (prevDiskStats && dtSec > 0) {
    readMBps = bytesToMB(rBytes - prevDiskStats.rBytes) / dtSec;
    writeMBps = bytesToMB(wBytes - prevDiskStats.wBytes) / dtSec;
    readMBps = Math.max(0, readMBps);
    writeMBps = Math.max(0, writeMBps);
  }

  prevDiskStats = { rBytes, wBytes, at: now };
  return { readMBps, writeMBps };
}

async function getNetworkThroughputMBps(now, dtSec) {
  // networkStats() returns cumulative bytes for each interface; sum them
  const nets = await si.networkStats();
  let rxBytes = 0;
  let txBytes = 0;

  for (const n of nets || []) {
    rxBytes += Number(n.rx_bytes) || 0;
    txBytes += Number(n.tx_bytes) || 0;
  }

  let downMBps = 0;
  let upMBps = 0;

  if (prevNetStats && dtSec > 0) {
    downMBps = bytesToMB(rxBytes - prevNetStats.rxBytes) / dtSec;
    upMBps = bytesToMB(txBytes - prevNetStats.txBytes) / dtSec;
    downMBps = Math.max(0, downMBps);
    upMBps = Math.max(0, upMBps);
  }

  prevNetStats = { rxBytes, txBytes, at: now };
  return { downMBps, upMBps };
}

async function collectSnapshot() {
  const now = Date.now();
  const dtSec = Math.max(0.001, (now - prevSampleAt) / 1000);
  prevSampleAt = now;

  const [
    cpuLoad,
    cpuSpeed,
    cpuTemp,
    mem,
    diskUsage,
    diskThroughput,
    netThroughput,
    uptime,
    topProcs,
  ] = await Promise.all([
    si.currentLoad(),          // per-core load and overall
    si.cpuCurrentSpeed(),      // min/max/avg GHz
    si.cpuTemperature(),       // main + cores
    si.mem(),                  // used/free
    getDiskUsagePercent(),     // aggregated disk usage
    getDiskThroughputMBps(now, dtSec),
    getNetworkThroughputMBps(now, dtSec),
    si.time(),                 // uptime
    getTopProcesses(),         // top 5 by CPU
  ]);

  // ---- CPU Load ----
  const perCore = (cpuLoad.cpus || []).map((c) => clamp(Number(c.load) || 0, 0, 100));
  const overall = clamp(Number(cpuLoad.currentLoad) || 0, 0, 100);

  // ---- CPU Speed ----
  const minGHz = Math.max(0, Number(cpuSpeed.min) || 0);
  const avgGHz = Math.max(0, Number(cpuSpeed.avg) || 0);
  const maxGHz = Math.max(0, Number(cpuSpeed.max) || 0);

  // ---- CPU Temp ----
  // systeminformation returns: { main, cores: [] } (may be -1 or null if unavailable)
  const mainTemp = typeof cpuTemp.main === "number" && cpuTemp.main >= 0 ? cpuTemp.main : null;
  const coreTemps = Array.isArray(cpuTemp.cores)
    ? cpuTemp.cores
        .map((t) => (typeof t === "number" && t >= 0 ? t : null))
        .filter((t) => t !== null)
    : [];

  // ---- Memory ----
  const totalBytes = Number(mem.total) || 0;
  const usedBytes = Number(mem.used) || 0;
  const usedPercent = totalBytes > 0 ? clamp((usedBytes / totalBytes) * 100, 0, 100) : 0;

  // ---- Disk usage ----
  const diskUsedPercent = clamp(diskUsage.usedPercent || 0, 0, 100);

  // ---- Disk activity ----
  const readMBps = Math.max(0, Number(diskThroughput.readMBps) || 0);
  const writeMBps = Math.max(0, Number(diskThroughput.writeMBps) || 0);

  // ---- Net activity ----
  const downMBps = Math.max(0, Number(netThroughput.downMBps) || 0);
  const upMBps = Math.max(0, Number(netThroughput.upMBps) || 0);

  // ---- Uptime ----
  const uptimeSeconds = Number(uptime.uptime) || 0;

  // ---- Build history ----
  pushRolling(history.cpuLoad, { t: now, v: overall });
  if (mainTemp !== null) pushRolling(history.cpuTempC, { t: now, v: mainTemp });
  pushRolling(history.memUsedPercent, { t: now, v: usedPercent });
  pushRolling(history.diskReadMBps, { t: now, v: readMBps });
  pushRolling(history.diskWriteMBps, { t: now, v: writeMBps });
  pushRolling(history.netDownMBps, { t: now, v: downMBps });
  pushRolling(history.netUpMBps, { t: now, v: upMBps });
  pushRolling(history.cpuAvgGHz, { t: now, v: avgGHz });

  // ---- Final payload (single source of truth) ----
  const payload = {
    timestampMs: now,
    currentDateTimeISO: new Date(now).toISOString(),

    cpuLoad: {
      overallPercent: overall,
      perCorePercent: perCore, // Core 1..N
      history: history.cpuLoad,
    },

    cpuSpeed: {
      minGHz,
      avgGHz,
      maxGHz,
      historyAvgGHz: history.cpuAvgGHz,
    },

    cpuTemp: {
      mainC: mainTemp,             // may be null if unavailable
      coreTempsC: coreTemps,       // may be empty if unavailable
      historyMainC: history.cpuTempC,
      targetC: 80,                 // nice for frontend “target line”
    },

    memory: {
      totalGB: totalBytes / (1024 ** 3),
      usedGB: usedBytes / (1024 ** 3),
      usedPercent,
      freePercent: clamp(100 - usedPercent, 0, 100),
      historyUsedPercent: history.memUsedPercent,
    },

    diskUsage: {
      usedPercent: diskUsedPercent,
      freePercent: clamp(100 - diskUsedPercent, 0, 100),
      totalGB: (diskUsage.totalBytes || 0) / (1024 ** 3),
      usedGB: (diskUsage.usedBytes || 0) / (1024 ** 3),
    },

    diskActivity: {
      readMBps,
      writeMBps,
      historyReadMBps: history.diskReadMBps,
      historyWriteMBps: history.diskWriteMBps,
    },

    network: {
      downMBps,
      upMBps,
      historyDownMBps: history.netDownMBps,
      historyUpMBps: history.netUpMBps,
    },

    topProcesses: topProcs, // [{name, cpuPercent, ramMB, pid}, ...] top 5 by CPU

    uptime: {
      uptimeSeconds,
      uptimeHuman: formatUptime(uptimeSeconds),
    },

    meta: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      historyPoints: HISTORY_POINTS,
    },
  };

  lastPayload = payload;
  return payload;
}

setInterval(()=> {
 if (lastPayload) io.emit("health:update", lastPayload);
}, 1000)

// ---------- socket.io ----------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Send immediate snapshot if we have one
  if (lastPayload) socket.emit("health:update", lastPayload);

  // Allow client to request a snapshot on demand
  socket.on("health:request", () => {
    if (lastPayload) socket.emit("health:update", lastPayload);
    else socket.emit("health:error", { message: "No data yet." });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// ---------- REST (optional) ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/health/latest", (_req, res) => {
  if (!lastPayload) return res.status(503).json({ ok: false, message: "No data yet." });
  res.json(lastPayload);
});

// ---------- sampling loop ----------
async function startSampling() {
  // warm-up: take first sample immediately
  try {
    await collectSnapshot();
    io.emit("health:update", lastPayload);
  } catch (e) {
    console.error("Warm-up sampling failed:", e?.message || e);
  }

  setInterval(async () => {
    try {
      const payload = await collectSnapshot();

      // If data missing (ex: temps), payload fields already null/empty.
      // Frontend should show "No data" rather than rendering junk.
      io.emit("health:update", payload);
    } catch (e) {
      console.error("Sampling failed:", e?.message || e);
      io.emit("health:error", { message: "Sampling failed", detail: String(e?.message || e) });
    }
  }, SAMPLE_INTERVAL_MS);
}

server.listen(PORT, () => {
  console.log(`System monitor backend listening on http://localhost:${PORT}`);
  startSampling();
});
