import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import Database from './database.js';
import cookieParser from 'cookie-parser'; // Add this

import {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getSpotifyUser,
  getUserPlaylists,
  getPlaylistTracks,
  createPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  searchTracks,
  getRecommendations,
  getPlaybackState,
  getDevices,
  startPlayback,
  skipToNext,
  pausePlayback,
  addToQueue
} from './spotify.js';

import {
  saveTokens,
  getTokens,
  isTokenExpired,
  clearTokens
} from './spotify-auth-store.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-secret-key-change-in-prod';

app.use(cookieParser()); // Add this before your other middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const db = new Database('./cafe-playlist.db');
await db.initialize();

// ── Anonymous voter UUID via header (set by frontend) ──────
const getVoterUuid = (req) => {
  return req.headers['x-voter-uuid'] || uuidv4();
};

// ── Admin auth middleware ──────────────────────────────────
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token === ADMIN_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ── Get valid Spotify token, refresh if needed ────────────
async function getValidToken(sessionId) {
  const stored = getTokens(sessionId);
  if (!stored) throw new Error('Not connected to Spotify');

  if (isTokenExpired(stored)) {
    const { clientId, clientSecret } = await db.getSpotifyCredentials(sessionId);
    const refreshed = await refreshAccessToken(
      stored.refreshToken,
      clientId,
      clientSecret
    );
    const updated = { ...stored, ...refreshed };
    saveTokens(sessionId, updated);
    return updated.accessToken;
  }

  return stored.accessToken;
}

// ═══════════════════════════════════════════════════════════
// CUSTOMER ROUTES
// ═══════════════════════════════════════════════════════════

// Session info + genres + current song
app.get('/api/session', async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });

    const genres         = await db.getAllGenres();
    const blockedGenres  = JSON.parse(session.blocked_genres || '[]');
    const availableGenres = genres.filter(g => !blockedGenres.includes(g.id));
    const { mix, outliers } = await db.computeCrowdMix(session.id);

    let currentSong = null;
    if (session.current_song_id) {
      currentSong = await db.db.get(
        'SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE s.id = ?',
        [session.current_song_id]
      );
    }

    res.json({ session, availableGenres, mix, outliers, currentSong });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check if voter has already voted
app.get('/api/vote-status', async (req, res) => {
  try {
    const voterUuid = req.headers['x-voter-uuid'];
    if (!voterUuid) return res.json({ hasVoted: false });
    const session = await db.getActiveSession();
    if (!session)  return res.json({ hasVoted: false });
    const hasVoted = await db.hasVoterVoted(session.id, voterUuid);
    res.json({ hasVoted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Submit genre votes (customer picks up to 3 genres)
app.post('/api/vote', async (req, res) => {
  try {
    const voterUuid = getVoterUuid(req);
    const { genreIds } = req.body;

    if (!Array.isArray(genreIds) || genreIds.length < 1 || genreIds.length > 3) {
      return res.status(400).json({ error: 'Select 1–3 genres' });
    }

    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });

    await db.submitGenreVotes(session.id, voterUuid, genreIds);
    const { mix, outliers } = await db.computeCrowdMix(session.id);

    res.json({ success: true, voterUuid, mix, outliers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Skip vote on current song
app.post('/api/skip', async (req, res) => {
  try {
    const voterUuid = getVoterUuid(req);
    const session   = await db.getActiveSession();
    if (!session || !session.current_song_id) {
      return res.status(404).json({ error: 'No active song' });
    }

    const result = await db.submitSkipVote(session.id, voterUuid, session.current_song_id);

    if (result.shouldSkip) {
      const nextSong = await db.getNextSong(session.id);
      if (nextSong) await db.updateSessionSong(session.id, nextSong.id);
      return res.json({ ...result, skipped: true, nextSong });
    }

    res.json({ ...result, skipped: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live crowd mix polling endpoint
app.get('/api/crowd', async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });

    const { ranked, mix, outliers } = await db.computeCrowdMix(session.id);

    let currentSong = null;
    if (session.current_song_id) {
      currentSong = await db.db.get(
        'SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE s.id = ?',
        [session.current_song_id]
      );
    }

    res.json({ ranked, mix, outliers, currentSong });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Submit song request
app.post('/api/request-song', async (req, res) => {
  try {
    const voterUuid = getVoterUuid(req);
    const { songTitle, artistName, reason } = req.body;

    if (!songTitle || !artistName) {
      return res.status(400).json({ error: 'Title and artist required' });
    }

    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });

    const id = await db.addSongRequest(session.id, voterUuid, songTitle, artistName, reason);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_SECRET) return res.json({ token: ADMIN_SECRET });
  res.status(401).json({ error: 'Invalid password' });
});

// Full session analytics
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const analytics = await db.getSessionAnalytics(session.id);
    res.json(analytics);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start a new session
app.post('/api/admin/session', adminAuth, async (req, res) => {
  try {
    const { name, blockedGenres, allowExplicit } = req.body;
    if (!name) return res.status(400).json({ error: 'Session name required' });
    const id = await db.createSession(name, blockedGenres || [], allowExplicit || false);
    res.json({ success: true, sessionId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Advance to next song manually
app.post('/api/admin/next-song', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const song = await db.getNextSong(session.id);
    if (song) await db.updateSessionSong(session.id, song.id);
    res.json({ success: true, song });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update blocked genres
app.post('/api/admin/blocked-genres', adminAuth, async (req, res) => {
  try {
    const { blockedGenres } = req.body;
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await db.updateBlockedGenres(session.id, blockedGenres || []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all song requests
app.get('/api/admin/requests', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const requests = await db.getAllSongRequests(session.id);
    res.json(requests);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve or reject a song request
app.post('/api/admin/request/:id', adminAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    await db.updateRequestStatus(req.params.id, action);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all songs
app.get('/api/admin/songs', adminAuth, async (req, res) => {
  try {
    res.json(await db.getAllSongs());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a song
app.post('/api/admin/songs', adminAuth, async (req, res) => {
  try {
    const { title, artist, duration, genreId } = req.body;
    if (!title || !artist || !genreId) {
      return res.status(400).json({ error: 'Title, artist and genre required' });
    }
    const id = await db.addSong(title, artist, parseInt(duration) || 180, genreId);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a song
app.delete('/api/admin/songs/:id', adminAuth, async (req, res) => {
  try {
    await db.removeSong(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SPOTIFY CREDENTIALS ROUTES
// ═══════════════════════════════════════════════════════════

// Save Spotify credentials entered by admin in the UI
app.post('/api/admin/spotify-credentials', adminAuth, async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body;
    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Client ID and Client Secret are required' });
    }
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    await db.saveSpotifyCredentials(session.id, clientId.trim(), clientSecret.trim());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get saved credentials (masked for display)
app.get('/api/admin/spotify-credentials', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const creds = await db.getSpotifyCredentials(session.id);
    res.json({
      hasClientId:     !!creds.clientId,
      hasClientSecret: !!creds.clientSecret,
      clientIdPreview: creds.clientId
        ? creds.clientId.substring(0, 8) + '••••••••••••••••••••••••'
        : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SPOTIFY AUTH ROUTES
// ═══════════════════════════════════════════════════════════

// Step 1 — Redirect to Spotify login using session's own credentials
app.get('/auth/spotify', async (req, res) => {
  const token = req.query.token;
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const session = await db.getActiveSession();
    if (!session) return res.redirect('/?mode=admin&spotify=no-session');

    const { clientId } = await db.getSpotifyCredentials(session.id);
    if (!clientId) return res.redirect('/?mode=admin&spotify=no-credentials');

    const state = crypto.randomUUID();
    const url   = getAuthUrl(clientId, state);
    res.redirect(url);
  } catch (e) {
    console.error('Auth init error:', e.message);
    res.redirect('/?mode=admin&spotify=error');
  }
});

// Step 2 — Spotify redirects back here with auth code
app.get('/auth/spotify/callback', async (req, res) => {
  const { code, error } = req.query;

  console.log('Spotify callback received:', { hasCode: !!code, error });

  if (error || !code) {
    console.log('OAuth denied or no code:', error);
    return res.redirect('/?mode=admin&spotify=denied');
  }

  try {
    const session = await db.getActiveSession();
    if (!session) return res.redirect('/?mode=admin&spotify=no-session');

    const { clientId, clientSecret } = await db.getSpotifyCredentials(session.id);
    if (!clientId || !clientSecret) {
      return res.redirect('/?mode=admin&spotify=no-credentials');
    }

    console.log('Exchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

    console.log('Fetching Spotify user profile...');
    const user = await getSpotifyUser(tokens.accessToken);

    console.log(`Connected: ${user.display_name} | Product: ${user.product}`);

    saveTokens(session.id, {
      ...tokens,
      clientId,
      clientSecret,
      spotifyUserId:   user.id,
      spotifyUserName: user.display_name,
      spotifyEmail:    user.email,
      isPremium:       user.product === 'premium'
    });

    res.redirect('/?mode=admin&spotify=connected');
  } catch (e) {
    console.error('Spotify callback error:', e.message, e.stack);
    res.redirect(`/?mode=admin&spotify=error&reason=${encodeURIComponent(e.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════
// SPOTIFY STATUS & MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════════

// Connection status + credential info
app.get('/api/spotify/status', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    const creds   = await db.getSpotifyCredentials(session?.id);
    const tokens  = getTokens(session?.id);

    res.json({
      connected:       !!tokens,
      hasCredentials:  !!(creds.clientId && creds.clientSecret),
      clientIdPreview: creds.clientId
        ? creds.clientId.substring(0, 8) + '••••••••••••••••••••••••'
        : null,
      userName:     tokens?.spotifyUserName || null,
      email:        tokens?.spotifyEmail    || null,
      isPremium:    tokens?.isPremium       || false,
      tokenExpired: tokens ? isTokenExpired(tokens) : false
    });
  } catch (e) {
    res.json({ connected: false, hasCredentials: false });
  }
});

// Disconnect Spotify (clear tokens, keep credentials)
app.post('/api/spotify/disconnect', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (session) clearTokens(session.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SPOTIFY PLAYLIST ROUTES
// ═══════════════════════════════════════════════════════════

// Get user's Spotify playlists
app.get('/api/spotify/playlists', adminAuth, async (req, res) => {
  try {
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const playlists   = await getUserPlaylists(accessToken);
    res.json(playlists);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get tracks in a specific playlist
app.get('/api/spotify/playlists/:playlistId/tracks', adminAuth, async (req, res) => {
  try {
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const tracks      = await getPlaylistTracks(accessToken, req.params.playlistId);
    res.json(tracks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a new playlist in Spotify
app.post('/api/spotify/playlists', adminAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const session     = await db.getActiveSession();
    const tokens      = getTokens(session.id);
    const accessToken = await getValidToken(session.id);
    const playlist    = await createPlaylist(
      accessToken,
      tokens.spotifyUserId,
      name || 'CrowdDJ Mix',
      description || 'Generated by CrowdDJ'
    );
    res.json({ success: true, playlist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add tracks to a playlist
app.post('/api/spotify/playlists/:playlistId/tracks', adminAuth, async (req, res) => {
  try {
    const { trackUris } = req.body;
    const session       = await db.getActiveSession();
    const accessToken   = await getValidToken(session.id);
    await addTracksToPlaylist(accessToken, req.params.playlistId, trackUris);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove tracks from a playlist
app.delete('/api/spotify/playlists/:playlistId/tracks', adminAuth, async (req, res) => {
  try {
    const { trackUris } = req.body;
    const session       = await db.getActiveSession();
    const accessToken   = await getValidToken(session.id);
    await removeTracksFromPlaylist(accessToken, req.params.playlistId, trackUris);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search Spotify catalog
app.get('/api/spotify/search', adminAuth, async (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const results     = await searchTracks(accessToken, q, parseInt(limit) || 10);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate crowd-driven playlist from genre votes
app.post('/api/spotify/generate-crowd-playlist', adminAuth, async (req, res) => {
  try {
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const tokens      = getTokens(session.id);

    const { mix } = await db.computeCrowdMix(session.id);
    if (!mix || mix.length === 0) {
      return res.status(400).json({ error: 'No crowd votes yet — wait for customers to vote' });
    }

    const tracks = await getRecommendations(accessToken, mix, 30);
    if (tracks.length === 0) {
      return res.status(500).json({ error: 'Could not get Spotify recommendations' });
    }

    const playlistName = `CrowdDJ — ${session.name}`;
    const playlist = await createPlaylist(
      accessToken,
      tokens.spotifyUserId,
      playlistName,
      `Generated by CrowdDJ. Top genres: ${mix.map(m => m.name).join(', ')}`
    );

    await addTracksToPlaylist(accessToken, playlist.id, tracks.map(t => t.uri));

    res.json({
      success:    true,
      playlist:   { id: playlist.id, name: playlistName, uri: playlist.uri },
      trackCount: tracks.length,
      mix,
      tracks:     tracks.slice(0, 10)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SPOTIFY PLAYBACK ROUTES (Spotify Premium required)
// ═══════════════════════════════════════════════════════════

// Get available devices
app.get('/api/spotify/devices', adminAuth, async (req, res) => {
  try {
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const devices     = await getDevices(accessToken);
    res.json(devices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get current playback state
app.get('/api/spotify/playback', adminAuth, async (req, res) => {
  try {
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    const state       = await getPlaybackState(accessToken);
    res.json(state || { is_playing: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start playback
app.post('/api/spotify/play', adminAuth, async (req, res) => {
  try {
    const { deviceId, playlistUri, trackUris } = req.body;
    const session     = await db.getActiveSession();
    const accessToken = await getValidToken(session.id);
    await startPlayback(accessToken, deviceId, playlistUri, trackUris);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Skip to next track
app.post('/api/spotify/next', adminAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const session      = await db.getActiveSession();
    const accessToken  = await getValidToken(session.id);
    await skipToNext(accessToken, deviceId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pause playback
app.post('/api/spotify/pause', adminAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const session      = await db.getActiveSession();
    const accessToken  = await getValidToken(session.id);
    await pausePlayback(accessToken, deviceId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 CrowdDJ running     → http://localhost:${PORT}`);
  console.log(`📊 Admin dashboard     → http://localhost:${PORT}?mode=admin`);
  console.log(`🎧 Customer portal     → http://localhost:${PORT}`);
  console.log(`🔑 Admin password      → ${ADMIN_SECRET}\n`);
});