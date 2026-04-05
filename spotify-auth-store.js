import fs from 'fs';

const STORE_FILE = './spotify-tokens.json';

function readStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function writeStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Token store write failed:', e.message);
  }
}

export function saveTokens(sessionId, tokens) {
  const store = readStore();
  store[sessionId] = { ...tokens, savedAt: Date.now() };
  writeStore(store);
}

export function getTokens(sessionId) {
  return readStore()[sessionId] || null;
}

export function isTokenExpired(tokens) {
  return Date.now() > (tokens.expiresAt - 5 * 60 * 1000);
}

export function clearTokens(sessionId) {
  const store = readStore();
  delete store[sessionId];
  writeStore(store);
}