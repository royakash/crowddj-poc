// In-memory token store for the POC
// Maps sessionId → { accessToken, refreshToken, expiresAt, spotifyUserId }
const tokenStore = new Map();

export function saveTokens(sessionId, tokens) {
  tokenStore.set(sessionId, { ...tokens, savedAt: Date.now() });
}

export function getTokens(sessionId) {
  return tokenStore.get(sessionId) || null;
}

export function isTokenExpired(tokens) {
  // Refresh if less than 5 minutes remaining
  return Date.now() > (tokens.expiresAt - 5 * 60 * 1000);
}

export function clearTokens(sessionId) {
  tokenStore.delete(sessionId);
}