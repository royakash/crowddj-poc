import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import Database from './database.js';
import cookieParser from 'cookie-parser'; // Add this

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

// ═══════════════════════════════════════════════════════════
// CUSTOMER ROUTES
// ═══════════════════════════════════════════════════════════

// Session info + genres + current song
app.get('/api/session', async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });

    const genres = await db.getAllGenres();
    const blockedGenres = JSON.parse(session.blocked_genres || '[]');
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
    if (!session) return res.json({ hasVoted: false });
    const hasVoted = await db.hasVoterVoted(session.id, voterUuid);
    res.json({ hasVoted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Submit genre votes (customer picks 3 genres)
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
    const session = await db.getActiveSession();
    if (!session || !session.current_song_id) return res.status(404).json({ error: 'No active song' });

    const result = await db.submitSkipVote(session.id, voterUuid, session.current_song_id);

    if (result.shouldSkip) {
      const nextSong = await db.getNextSong(session.id);
      if (nextSong) await db.updateSessionSong(session.id, nextSong.id);
      return res.json({ ...result, skipped: true, nextSong });
    }

    res.json({ ...result, skipped: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crowd mix (polling endpoint)
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
    if (!songTitle || !artistName) return res.status(400).json({ error: 'Title and artist required' });
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const id = await db.addSongRequest(session.id, voterUuid, songTitle, artistName, reason);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_SECRET) return res.json({ token: ADMIN_SECRET });
  res.status(401).json({ error: 'Invalid password' });
});

// Full analytics
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No active session' });
    const analytics = await db.getSessionAnalytics(session.id);
    res.json(analytics);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start new session
app.post('/api/admin/session', adminAuth, async (req, res) => {
  try {
    const { name, blockedGenres, allowExplicit } = req.body;
    if (!name) return res.status(400).json({ error: 'Session name required' });
    const id = await db.createSession(name, blockedGenres || [], allowExplicit || false);
    res.json({ success: true, sessionId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually advance to next song
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
    if (!session) return res.status(404).json({ error: 'No session' });
    await db.updateBlockedGenres(session.id, blockedGenres || []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Song requests
app.get('/api/admin/requests', adminAuth, async (req, res) => {
  try {
    const session = await db.getActiveSession();
    if (!session) return res.status(404).json({ error: 'No session' });
    const requests = await db.getAllSongRequests(session.id);
    res.json(requests);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/request/:id', adminAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    await db.updateRequestStatus(req.params.id, action);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All songs list (admin)
app.get('/api/admin/songs', adminAuth, async (req, res) => {
  try { res.json(await db.getAllSongs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/songs', adminAuth, async (req, res) => {
  try {
    const { title, artist, duration, genreId } = req.body;
    if (!title || !artist || !genreId) return res.status(400).json({ error: 'Title, artist and genre required' });
    const id = await db.addSong(title, artist, parseInt(duration) || 180, genreId);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/songs/:id', adminAuth, async (req, res) => {
  try {
    await db.removeSong(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n🎵 CrowdDJ running → http://localhost:${PORT}`);
  console.log(`📊 Admin dashboard → http://localhost:${PORT}?mode=admin`);
  console.log(`🎧 Customer portal → http://localhost:${PORT}\n`);
});