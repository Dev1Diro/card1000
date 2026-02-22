/**
 * storage.js
 * - 책임: 데이터 로드/저장/백업/주기적 flush/종료 시 대기
 * - 환경변수: DATA_FILE (권장 절대경로). 기본: ./storage.json
 */

const fs = require('fs-extra');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, 'storage.json');
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : DEFAULT_PATH;
const BACKUP_DIR = `${DATA_FILE}.backups`;
const MAX_BACKUPS = 10;
const FLUSH_INTERVAL_MS = 60 * 1000; // 1분
const SAVE_RETRY_DELAY_MS = 200;
const SAVE_RETRY_COUNT = 2;

let inMemory = null;
let dirty = false;
let flushTimer = null;
let saveQueue = [];
let saving = false;
let initialized = false;

function formatNow() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function rotateBackups() {
  try {
    await fs.ensureDir(BACKUP_DIR);
    const files = await fs.readdir(BACKUP_DIR);
    if (files.length <= MAX_BACKUPS) return;
    const sorted = files.sort();
    const remove = sorted.slice(0, files.length - MAX_BACKUPS);
    await Promise.all(remove.map(f => fs.remove(path.join(BACKUP_DIR, f))));
  } catch (e) {
    console.error('backup rotation failed:', e);
  }
}

async function atomicWriteJson(filePath, data) {
  const resolved = path.resolve(filePath);
  await fs.ensureDir(path.dirname(resolved));
  const tmp = `${resolved}.tmp.${Date.now()}.${Math.random().toString(36).slice(2,8)}`;
  await fs.writeJson(tmp, data, { spaces: 2, encoding: 'utf8' });
  await fs.move(tmp, resolved, { overwrite: true });
}

async function safeWriteWithRetry(filePath, data) {
  let lastErr = null;
  for (let i = 0; i < SAVE_RETRY_COUNT; i++) {
    try {
      await atomicWriteJson(filePath, data);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`atomic write attempt ${i+1} failed:`, err);
      await new Promise(r => setTimeout(r, SAVE_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

async function backupCorruptFile(filePath) {
  try {
    await fs.ensureDir(BACKUP_DIR);
    const bakName = `corrupt-${formatNow()}.json`;
    await fs.copy(filePath, path.join(BACKUP_DIR, bakName));
    await rotateBackups();
    console.warn(`Backed up corrupt file to ${path.join(BACKUP_DIR, bakName)}`);
  } catch (e) {
    console.error('failed to backup corrupt file:', e);
  }
}

async function init() {
  if (initialized) return;
  try {
    await fs.ensureDir(path.dirname(DATA_FILE));
    await fs.ensureFile(DATA_FILE);
    try { fs.chmodSync(DATA_FILE, 0o600); } catch(e) { /* ignore */ }
  } catch (e) {
    console.error('ensure file/dir failed:', e);
  }

  try {
    const stats = await fs.stat(DATA_FILE);
    if (stats.size === 0) {
      inMemory = { cards: {}, payments: {} };
      await safeWriteWithRetry(DATA_FILE, inMemory);
      dirty = false;
      console.log('Initialized empty storage file.');
    } else {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        parsed.cards = parsed.cards || {};
        parsed.payments = parsed.payments || {};
        inMemory = parsed;
        dirty = false;
        console.log('Loaded storage from', DATA_FILE);
      } catch (parseErr) {
        console.error('parse error, backing up and reinitializing:', parseErr);
        await backupCorruptFile(DATA_FILE);
        inMemory = { cards: {}, payments: {} };
        await safeWriteWithRetry(DATA_FILE, inMemory);
        dirty = false;
      }
    }
  } catch (err) {
    console.error('init read error, attempting to create new storage:', err);
    inMemory = { cards: {}, payments: {} };
    try {
      await safeWriteWithRetry(DATA_FILE, inMemory);
      dirty = false;
    } catch (e) {
      console.error('failed to write new storage file during init:', e);
      throw e;
    }
  }

  flushTimer = setInterval(() => {
    if (dirty) {
      enqueueSave(inMemory).catch(e => console.error('periodic flush failed:', e));
    }
  }, FLUSH_INTERVAL_MS);

  const graceful = async () => {
    console.log('storage: graceful shutdown start, flushing...');
    clearInterval(flushTimer);
    try {
      await flushAll();
      console.log('storage: flush complete');
    } catch (e) {
      console.error('storage: flush failed during shutdown:', e);
    }
  };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);
  process.on('beforeExit', graceful);

  initialized = true;
}

function get() {
  if (!initialized) throw new Error('storage not initialized');
  return inMemory;
}

function markDirty() {
  dirty = true;
}

function enqueueSave(dataSnapshot) {
  return new Promise((resolve, reject) => {
    const payload = { data: JSON.parse(JSON.stringify(dataSnapshot)), resolve, reject };
    saveQueue.push(payload);
    processQueue().catch(err => console.error('processQueue error:', err));
  });
}

async function processQueue() {
  if (saving) return;
  saving = true;
  while (saveQueue.length > 0) {
    const { data, resolve, reject } = saveQueue.shift();
    try {
      await safeWriteWithRetry(DATA_FILE, data);
      resolve();
    } catch (err) {
      console.error('save failed, attempting backup and retry once:', err);
      try {
        await backupCorruptFile(DATA_FILE);
        await safeWriteWithRetry(DATA_FILE, data);
        resolve();
      } catch (err2) {
        console.error('save retry failed:', err2);
        reject(err2);
      }
    }
  }
  saving = false;
}

async function flushAll() {
  if (!initialized) return;
  if (dirty) {
    await enqueueSave(inMemory);
    while (saving || saveQueue.length > 0) {
      await new Promise(r => setTimeout(r, 50));
    }
    dirty = false;
  }
}

async function setData(mutator) {
  if (!initialized) throw new Error('storage not initialized');
  try {
    mutator(inMemory);
    markDirty();
    await enqueueSave(inMemory);
    dirty = false;
  } catch (e) {
    throw e;
  }
}

module.exports = {
  init,
  get,
  setData,
  enqueueSave,
  flushAll,
  DATA_FILE
};