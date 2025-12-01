const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Store processes and their info
const DATA_FILE = path.join(__dirname, 'data', 'processes.json');
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ processes: [] }, null, 2));
}

function loadProcesses() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data).processes || [];
  } catch (e) {
    return [];
  }
}

function saveProcesses(processes) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ processes }, null, 2));
}

// Track running process PIDs
const runningProcesses = new Map();

// System metrics cache
let systemMetrics = {
  cpu: 0,
  memory: { used: 0, total: 0, percent: 0 },
  temperature: null,
  uptime: 0,
  loadAvg: [0, 0, 0],
  processMetrics: {}
};

// Get CPU usage
function getCpuUsage() {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();
    setTimeout(() => {
      const cpus2 = os.cpus();
      let totalIdle = 0, totalTick = 0;
      
      for (let i = 0; i < cpus1.length; i++) {
        const cpu1 = cpus1[i].times;
        const cpu2 = cpus2[i].times;
        
        const idle = cpu2.idle - cpu1.idle;
        const total = (cpu2.user - cpu1.user) + (cpu2.nice - cpu1.nice) + 
                      (cpu2.sys - cpu1.sys) + (cpu2.idle - cpu1.idle) + 
                      (cpu2.irq - cpu1.irq);
        
        totalIdle += idle;
        totalTick += total;
      }
      
      const percent = totalTick > 0 ? ((1 - totalIdle / totalTick) * 100) : 0;
      resolve(Math.round(percent * 10) / 10);
    }, 100);
  });
}

// Get temperature (Linux)
function getTemperature() {
  return new Promise((resolve) => {
    // Try different temperature sources
    const tempFiles = [
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/hwmon/hwmon0/temp1_input',
      '/sys/class/hwmon/hwmon1/temp1_input',
      '/sys/class/hwmon/hwmon2/temp1_input'
    ];
    
    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) {
          const temp = parseInt(fs.readFileSync(file, 'utf8').trim());
          resolve(Math.round(temp / 1000));
          return;
        }
      } catch (e) {}
    }
    
    // Try sensors command
    exec('sensors 2>/dev/null | grep -oP "\\+\\d+\\.\\d+°C" | head -1 | grep -oP "\\d+\\.\\d+"', (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(Math.round(parseFloat(stdout.trim())));
      } else {
        resolve(null);
      }
    });
  });
}

// Get process-specific metrics
function getProcessMetrics(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve({ cpu: 0, memory: 0 });
      return;
    }
    
    exec(`ps -p ${pid} -o %cpu,%mem --no-headers 2>/dev/null`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve({ cpu: 0, memory: 0 });
        return;
      }
      
      const parts = stdout.trim().split(/\s+/);
      resolve({
        cpu: parseFloat(parts[0]) || 0,
        memory: parseFloat(parts[1]) || 0
      });
    });
  });
}

// Update system metrics
async function updateSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  systemMetrics = {
    cpu: await getCpuUsage(),
    memory: {
      used: Math.round(usedMem / 1024 / 1024 / 1024 * 100) / 100,
      total: Math.round(totalMem / 1024 / 1024 / 1024 * 100) / 100,
      percent: Math.round((usedMem / totalMem) * 100 * 10) / 10
    },
    temperature: await getTemperature(),
    uptime: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
    cores: os.cpus().length,
    processMetrics: {}
  };
  
  // Get metrics for running processes
  const processes = loadProcesses();
  for (const proc of processes) {
    if (proc.pid && isProcessRunning(proc.pid)) {
      systemMetrics.processMetrics[proc.id] = await getProcessMetrics(proc.pid);
    }
  }
}

// Start metrics update interval
setInterval(updateSystemMetrics, 2000);
updateSystemMetrics();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Check if a process is running by PID
function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Get process status
function getProcessStatus(proc) {
  if (proc.pid && isProcessRunning(proc.pid)) {
    return 'running';
  }
  return 'stopped';
}

// API Routes

// Get system metrics
app.get('/api/metrics', (req, res) => {
  res.json(systemMetrics);
});

// Get all processes
app.get('/api/processes', (req, res) => {
  const processes = loadProcesses().map(p => ({
    ...p,
    status: getProcessStatus(p)
  }));
  res.json(processes);
});

// Add a new process
app.post('/api/processes', (req, res) => {
  const { name, command, description } = req.body;
  if (!name || !command) {
    return res.status(400).json({ error: 'Name and command are required' });
  }

  const processes = loadProcesses();
  const newProcess = {
    id: uuidv4(),
    name,
    command,
    description: description || '',
    pid: null,
    logFile: path.join(__dirname, 'logs', `${uuidv4()}.log`),
    createdAt: new Date().toISOString()
  };

  // Ensure logs directory exists
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  processes.push(newProcess);
  saveProcesses(processes);

  res.json({ ...newProcess, status: 'stopped' });
});

// Delete a process
app.delete('/api/processes/:id', (req, res) => {
  const { id } = req.params;
  let processes = loadProcesses();
  const proc = processes.find(p => p.id === id);
  
  if (!proc) {
    return res.status(404).json({ error: 'Process not found' });
  }

  // Stop if running
  if (proc.pid && isProcessRunning(proc.pid)) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch (e) {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch (e2) {}
    }
  }

  // Delete log file
  if (proc.logFile && fs.existsSync(proc.logFile)) {
    fs.unlinkSync(proc.logFile);
  }

  processes = processes.filter(p => p.id !== id);
  saveProcesses(processes);

  res.json({ success: true });
});

// Start a process
app.post('/api/processes/:id/start', (req, res) => {
  const { id } = req.params;
  const processes = loadProcesses();
  const procIndex = processes.findIndex(p => p.id === id);
  
  if (procIndex === -1) {
    return res.status(404).json({ error: 'Process not found' });
  }

  const proc = processes[procIndex];

  // Check if already running
  if (proc.pid && isProcessRunning(proc.pid)) {
    return res.status(400).json({ error: 'Process is already running' });
  }

  // Create log file
  const logStream = fs.createWriteStream(proc.logFile, { flags: 'a' });
  logStream.write(`\n[${new Date().toISOString()}] Starting process...\n`);
  logStream.write(`[${new Date().toISOString()}] Command: ${proc.command}\n`);
  logStream.write('─'.repeat(50) + '\n');

  // Spawn the process using nohup style
  // Use bash -i -c to run as interactive shell (loads .bashrc for conda)
  // Or source conda.sh directly for non-interactive conda support
  const wrappedCommand = `
source ~/.bashrc 2>/dev/null || true
source ~/miniconda3/etc/profile.d/conda.sh 2>/dev/null || source ~/anaconda3/etc/profile.d/conda.sh 2>/dev/null || true
${proc.command}
`;
  const child = spawn('bash', ['-c', wrappedCommand], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: { ...process.env, BASH_ENV: process.env.HOME + '/.bashrc' }
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.unref();

  // Update process with PID
  processes[procIndex].pid = child.pid;
  saveProcesses(processes);

  // Track the process
  runningProcesses.set(id, child);

  child.on('exit', (code, signal) => {
    const procs = loadProcesses();
    const idx = procs.findIndex(p => p.id === id);
    if (idx !== -1) {
      procs[idx].pid = null;
      saveProcesses(procs);
    }
    runningProcesses.delete(id);
    
    logStream.write(`\n[${new Date().toISOString()}] Process exited with code: ${code}, signal: ${signal}\n`);
    logStream.end();

    // Notify all WebSocket clients
    broadcast({ type: 'process-stopped', id });
  });

  res.json({ 
    ...proc, 
    pid: child.pid,
    status: 'running' 
  });
});

// Stop a process
app.post('/api/processes/:id/stop', (req, res) => {
  const { id } = req.params;
  const processes = loadProcesses();
  const procIndex = processes.findIndex(p => p.id === id);
  
  if (procIndex === -1) {
    return res.status(404).json({ error: 'Process not found' });
  }

  const proc = processes[procIndex];

  if (!proc.pid || !isProcessRunning(proc.pid)) {
    return res.status(400).json({ error: 'Process is not running' });
  }

  try {
    // Try to kill the process group first
    process.kill(-proc.pid, 'SIGTERM');
  } catch (e) {
    try {
      // Fallback to killing just the process
      process.kill(proc.pid, 'SIGTERM');
    } catch (e2) {
      return res.status(500).json({ error: 'Failed to stop process' });
    }
  }

  // Append to log
  if (proc.logFile && fs.existsSync(proc.logFile)) {
    fs.appendFileSync(proc.logFile, `\n[${new Date().toISOString()}] Process stopped by user\n`);
  }

  processes[procIndex].pid = null;
  saveProcesses(processes);

  res.json({ ...proc, pid: null, status: 'stopped' });
});

// Get logs for a process
app.get('/api/processes/:id/logs', (req, res) => {
  const { id } = req.params;
  const { lines = 100 } = req.query;
  const processes = loadProcesses();
  const proc = processes.find(p => p.id === id);
  
  if (!proc) {
    return res.status(404).json({ error: 'Process not found' });
  }

  if (!proc.logFile || !fs.existsSync(proc.logFile)) {
    return res.json({ logs: '' });
  }

  // Read last N lines
  const content = fs.readFileSync(proc.logFile, 'utf8');
  const allLines = content.split('\n');
  const lastLines = allLines.slice(-parseInt(lines)).join('\n');

  res.json({ logs: lastLines });
});

// Clear logs for a process
app.delete('/api/processes/:id/logs', (req, res) => {
  const { id } = req.params;
  const processes = loadProcesses();
  const proc = processes.find(p => p.id === id);
  
  if (!proc) {
    return res.status(404).json({ error: 'Process not found' });
  }

  if (proc.logFile && fs.existsSync(proc.logFile)) {
    fs.writeFileSync(proc.logFile, '');
  }

  res.json({ success: true });
});

// Update process
app.put('/api/processes/:id', (req, res) => {
  const { id } = req.params;
  const { name, command, description } = req.body;
  const processes = loadProcesses();
  const procIndex = processes.findIndex(p => p.id === id);
  
  if (procIndex === -1) {
    return res.status(404).json({ error: 'Process not found' });
  }

  if (name) processes[procIndex].name = name;
  if (command) processes[procIndex].command = command;
  if (description !== undefined) processes[procIndex].description = description;

  saveProcesses(processes);

  res.json({ ...processes[procIndex], status: getProcessStatus(processes[procIndex]) });
});

// WebSocket for real-time logs
wss.on('connection', (ws) => {
  let logWatcher = null;
  let currentLogFile = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'watch-logs') {
        const processes = loadProcesses();
        const proc = processes.find(p => p.id === data.id);
        
        if (proc && proc.logFile) {
          // Stop watching previous file
          if (logWatcher) {
            logWatcher.close();
          }

          currentLogFile = proc.logFile;
          
          // Create file if it doesn't exist
          if (!fs.existsSync(currentLogFile)) {
            fs.writeFileSync(currentLogFile, '');
          }

          // Watch for changes
          logWatcher = fs.watch(currentLogFile, (eventType) => {
            if (eventType === 'change') {
              const content = fs.readFileSync(currentLogFile, 'utf8');
              const lines = content.split('\n').slice(-100).join('\n');
              ws.send(JSON.stringify({ type: 'logs', logs: lines }));
            }
          });

          // Send initial content
          const content = fs.readFileSync(currentLogFile, 'utf8');
          const lines = content.split('\n').slice(-100).join('\n');
          ws.send(JSON.stringify({ type: 'logs', logs: lines }));
        }
      }

      if (data.type === 'stop-watching') {
        if (logWatcher) {
          logWatcher.close();
          logWatcher = null;
        }
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    if (logWatcher) {
      logWatcher.close();
    }
  });
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server Activity Dashboard running at http://localhost:${PORT}\n`);
});
