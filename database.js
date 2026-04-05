import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
    await this.db.exec('PRAGMA foreign_keys = ON');
    await this.createTables();
    await this.seedData();
  }

  async createTables() {
    // Genres master list
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS genres (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        is_allowed BOOLEAN DEFAULT 1
      )
    `);

    // Songs tagged with a genre
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        duration INTEGER DEFAULT 180,
        genre_id TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY(genre_id) REFERENCES genres(id)
      )
    `);

    // Sessions (one active session per business at a time)
    await this.db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    allow_explicit BOOLEAN DEFAULT 0,
    blocked_genres TEXT DEFAULT '[]',
    current_song_id TEXT,
    spotify_client_id TEXT,
    spotify_client_secret TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

    // Genre votes (one row per session_id + genre — upserted on re-vote)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS genre_votes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        voter_uuid TEXT NOT NULL,
        genre_id TEXT NOT NULL,
        voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(genre_id) REFERENCES genres(id),
        UNIQUE(voter_uuid, genre_id, session_id)
      )
    `);

    // Song skip votes
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS skip_votes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        voter_uuid TEXT NOT NULL,
        song_id TEXT NOT NULL,
        voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        UNIQUE(voter_uuid, session_id)
      )
    `);

    // Song requests (unchanged)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS song_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        voter_uuid TEXT NOT NULL,
        song_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async seedData() {
    const gc = await this.db.get('SELECT COUNT(*) as c FROM genres');
    if (gc.c === 0) {
      const genres = ['Pop','Hip Hop','Rock','Jazz','Electronic','Indie','R&B','Country','90s','2000s','Classical','Reggae'];
      for (const name of genres) {
        await this.db.run('INSERT INTO genres (id, name) VALUES (?, ?)', [crypto.randomUUID(), name]);
      }
    }

    const sc = await this.db.get('SELECT COUNT(*) as c FROM songs');
    if (sc.c === 0) {
      // fetch all genre ids once
      const genreRows = await this.db.all('SELECT id, name FROM genres');
      const gMap = Object.fromEntries(genreRows.map(g => [g.name, g.id]));

      const songs = [
        { title: 'Blinding Lights', artist: 'The Weeknd', genre: 'Pop', duration: 200 },
        { title: 'Levitating', artist: 'Dua Lipa', genre: 'Pop', duration: 203 },
        { title: 'As It Was', artist: 'Harry Styles', genre: 'Pop', duration: 167 },
        { title: 'Stay With Me', artist: 'Sam Smith', genre: 'Pop', duration: 172 },
        { title: 'HUMBLE.', artist: 'Kendrick Lamar', genre: 'Hip Hop', duration: 177 },
        { title: 'God\'s Plan', artist: 'Drake', genre: 'Hip Hop', duration: 198 },
        { title: 'Sicko Mode', artist: 'Travis Scott', genre: 'Hip Hop', duration: 312 },
        { title: 'Bad Guy', artist: 'Billie Eilish', genre: 'Indie', duration: 194 },
        { title: 'Mr. Brightside', artist: 'The Killers', genre: 'Rock', duration: 222 },
        { title: 'Smells Like Teen Spirit', artist: 'Nirvana', genre: 'Rock', duration: 301 },
        { title: 'Seven Nation Army', artist: 'The White Stripes', genre: 'Rock', duration: 231 },
        { title: 'Bohemian Rhapsody', artist: 'Queen', genre: '90s', duration: 354 },
        { title: 'Wonderwall', artist: 'Oasis', genre: '90s', duration: 258 },
        { title: 'Smooth Criminal', artist: 'Michael Jackson', genre: '90s', duration: 257 },
        { title: 'Crazy In Love', artist: 'Beyoncé', genre: '2000s', duration: 234 },
        { title: 'Yeah!', artist: 'Usher', genre: '2000s', duration: 250 },
        { title: 'Take Five', artist: 'Dave Brubeck', genre: 'Jazz', duration: 324 },
        { title: 'So What', artist: 'Miles Davis', genre: 'Jazz', duration: 562 },
        { title: 'One More Time', artist: 'Daft Punk', genre: 'Electronic', duration: 320 },
        { title: 'Sandstorm', artist: 'Darude', genre: 'Electronic', duration: 229 },
        { title: 'No Woman No Cry', artist: 'Bob Marley', genre: 'Reggae', duration: 279 },
        { title: 'Creep', artist: 'Radiohead', genre: 'Indie', duration: 238 },
        { title: 'No Scrubs', artist: 'TLC', genre: 'R&B', duration: 213 },
        { title: 'Waterfalls', artist: 'TLC', genre: 'R&B', duration: 256 },
        { title: 'Country Roads', artist: 'John Denver', genre: 'Country', duration: 191 },
      ];

      for (const s of songs) {
        await this.db.run(
          'INSERT INTO songs (id, title, artist, duration, genre_id) VALUES (?, ?, ?, ?, ?)',
          [crypto.randomUUID(), s.title, s.artist, s.duration, gMap[s.genre]]
        );
      }
    }

    // Ensure a default session exists
    const sess = await this.db.get('SELECT id FROM sessions WHERE is_active = 1 LIMIT 1');
    if (!sess) {
      await this.db.run(
        'INSERT INTO sessions (id, name, is_active) VALUES (?, ?, 1)',
        [crypto.randomUUID(), 'Main Session']
      );
    }
  }

  // ── SESSIONS ──────────────────────────────────────────────
  async getActiveSession() {
    return this.db.get('SELECT * FROM sessions WHERE is_active = 1 LIMIT 1');
  }

  async createSession(name, blockedGenres = [], allowExplicit = false) {
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT INTO sessions (id, name, blocked_genres, allow_explicit) VALUES (?, ?, ?, ?)',
      [id, name, JSON.stringify(blockedGenres), allowExplicit ? 1 : 0]
    );
    await this.db.run('UPDATE sessions SET is_active = 0 WHERE id != ?', [id]);
    await this.db.run('UPDATE sessions SET is_active = 1 WHERE id = ?', [id]);
    return id;
  }

  async updateSessionSong(sessionId, songId) {
    return this.db.run('UPDATE sessions SET current_song_id = ? WHERE id = ?', [songId, sessionId]);
  }

  // ── GENRES ────────────────────────────────────────────────
  async getAllGenres() {
    return this.db.all('SELECT * FROM genres ORDER BY name');
  }

  // ── GENRE VOTING ──────────────────────────────────────────
  // voter selects up to 3 genres; we upsert all three atomically
  async submitGenreVotes(sessionId, voterUuid, genreIds) {
    // First remove previous votes by this voter in this session
    await this.db.run(
      'DELETE FROM genre_votes WHERE voter_uuid = ? AND session_id = ?',
      [voterUuid, sessionId]
    );
    for (const gid of genreIds.slice(0, 3)) {
      await this.db.run(
        'INSERT OR IGNORE INTO genre_votes (id, session_id, voter_uuid, genre_id) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), sessionId, voterUuid, gid]
      );
    }
  }

  async hasVoterVoted(sessionId, voterUuid) {
    const row = await this.db.get(
      'SELECT COUNT(*) as c FROM genre_votes WHERE voter_uuid = ? AND session_id = ?',
      [voterUuid, sessionId]
    );
    return row.c > 0;
  }

  // ── CROWD ALGORITHM ───────────────────────────────────────
  // Returns { ranked, mix, outliers } considering time-decay and anti-troll
  async computeCrowdMix(sessionId) {
    const session = await this.getActiveSession();
    const blockedGenres = JSON.parse(session?.blocked_genres || '[]');
    const decayCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // Count unique voters total for anti-troll (max 5% influence)
    const voterCount = await this.db.get(
      'SELECT COUNT(DISTINCT voter_uuid) as c FROM genre_votes WHERE session_id = ?',
      [sessionId]
    );
    const totalVoters = Math.max(voterCount.c, 1);
    const maxInfluence = Math.ceil(totalVoters * 0.05) + 1; // at least 1

    // Weighted votes: recent (last 30 min) = weight 1.0, older = weight 0.5
    const rows = await this.db.all(`
      SELECT
        g.id,
        g.name,
        SUM(CASE WHEN gv.voted_at >= ? THEN 1.0 ELSE 0.5 END) as weighted_votes,
        COUNT(DISTINCT gv.voter_uuid) as unique_voters
      FROM genre_votes gv
      JOIN genres g ON g.id = gv.genre_id
      WHERE gv.session_id = ?
      GROUP BY g.id, g.name
      ORDER BY weighted_votes DESC
    `, [decayCutoff, sessionId]);

    // Filter blocked genres
    const filtered = rows.filter(r => !blockedGenres.includes(r.id));

    if (filtered.length === 0) return { ranked: [], mix: [], outliers: [] };

    const topVotes = filtered[0].weighted_votes;
    const threshold = topVotes * 0.20; // outlier rule: < 20% of top

    const kept = [];
    const outliers = [];

    for (const row of filtered) {
      // Anti-troll cap: if unique voters for this genre > maxInfluence, cap the weighted votes
      const cappedVotes = Math.min(row.weighted_votes, row.unique_voters * maxInfluence);
      if (cappedVotes < threshold) {
        outliers.push(row.name);
      } else {
        kept.push({ ...row, capped: cappedVotes });
      }
    }

    const totalKept = kept.reduce((s, r) => s + r.capped, 0);
    const mix = kept.map(r => ({
      genreId: r.id,
      name: r.name,
      votes: Math.round(r.weighted_votes),
      pct: Math.round((r.capped / totalKept) * 100)
    }));

    return {
      ranked: mix,
      mix: mix.slice(0, 3),   // top 3 for display
      outliers
    };
  }

  // Pick next song based on crowd mix proportionally
  async getNextSong(sessionId) {
    const { mix } = await this.computeCrowdMix(sessionId);
    if (!mix || mix.length === 0) {
      // fallback: random song
      return this.db.get('SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE s.is_active = 1 ORDER BY RANDOM() LIMIT 1');
    }

    // Weighted random selection
    const totalPct = mix.reduce((s, m) => s + m.pct, 0);
    let rand = Math.random() * totalPct;
    let chosen = mix[0];
    for (const m of mix) {
      rand -= m.pct;
      if (rand <= 0) { chosen = m; break; }
    }

    const song = await this.db.get(
      'SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE g.id = ? AND s.is_active = 1 ORDER BY RANDOM() LIMIT 1',
      [chosen.genreId]
    );

    return song || this.db.get('SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE s.is_active = 1 ORDER BY RANDOM() LIMIT 1');
  }

  // ── SKIP VOTING ───────────────────────────────────────────
  async submitSkipVote(sessionId, voterUuid, songId) {
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT OR IGNORE INTO skip_votes (id, session_id, voter_uuid, song_id) VALUES (?, ?, ?, ?)',
      [id, sessionId, voterUuid, songId]
    );

    const skipCount = await this.db.get(
      'SELECT COUNT(*) as c FROM skip_votes WHERE session_id = ? AND song_id = ?',
      [sessionId, songId]
    );
    const voterTotal = await this.db.get(
      'SELECT COUNT(DISTINCT voter_uuid) as c FROM genre_votes WHERE session_id = ?',
      [sessionId]
    );

    const total = Math.max(voterTotal.c, 1);
    const skipPct = (skipCount.c / total) * 100;
    return { shouldSkip: skipPct >= 40, skipPct: Math.round(skipPct), skipCount: skipCount.c };
  }

  // ── SONG REQUESTS ─────────────────────────────────────────
  async addSongRequest(sessionId, voterUuid, title, artist, reason) {
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT INTO song_requests (id, session_id, voter_uuid, song_title, artist_name, reason) VALUES (?, ?, ?, ?, ?, ?)',
      [id, sessionId, voterUuid, title, artist, reason]
    );
    return id;
  }

  async getAllSongRequests(sessionId) {
    return this.db.all(
      'SELECT * FROM song_requests WHERE session_id = ? ORDER BY created_at DESC',
      [sessionId]
    );
  }

  async updateRequestStatus(requestId, status) {
    return this.db.run('UPDATE song_requests SET status = ? WHERE id = ?', [status, requestId]);
  }

  // ── ADMIN ANALYTICS ───────────────────────────────────────
  async getSessionAnalytics(sessionId) {
    const session = await this.db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    const totalVoters = await this.db.get(
      'SELECT COUNT(DISTINCT voter_uuid) as c FROM genre_votes WHERE session_id = ?',
      [sessionId]
    );
    const totalVotes = await this.db.get(
      'SELECT COUNT(*) as c FROM genre_votes WHERE session_id = ?',
      [sessionId]
    );
    const requests = await this.db.all(
      'SELECT * FROM song_requests WHERE session_id = ? ORDER BY created_at DESC',
      [sessionId]
    );
    const { ranked, mix, outliers } = await this.computeCrowdMix(sessionId);
    const genres = await this.getAllGenres();

    return {
      session,
      totalVoters: totalVoters.c,
      totalVotes: totalVotes.c,
      ranked,
      mix,
      outliers,
      requests,
      genres
    };
  }

  async getAllSongs() {
    return this.db.all(
      'SELECT s.*, g.name as genre_name FROM songs s LEFT JOIN genres g ON g.id = s.genre_id WHERE s.is_active = 1 ORDER BY g.name, s.title'
    );
  }

  async addSong(title, artist, duration, genreId) {
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT INTO songs (id, title, artist, duration, genre_id) VALUES (?, ?, ?, ?, ?)',
      [id, title, artist, duration, genreId]
    );
    return id;
  }

  async removeSong(songId) {
    return this.db.run('UPDATE songs SET is_active = 0 WHERE id = ?', [songId]);
  }

  async updateBlockedGenres(sessionId, blockedGenres) {
    return this.db.run(
      'UPDATE sessions SET blocked_genres = ? WHERE id = ?',
      [JSON.stringify(blockedGenres), sessionId]
    );
  }

  async saveSpotifyCredentials(sessionId, clientId, clientSecret) {
  return this.db.run(
    'UPDATE sessions SET spotify_client_id = ?, spotify_client_secret = ? WHERE id = ?',
    [clientId, clientSecret, sessionId]
  );
}

async getSpotifyCredentials(sessionId) {
  const row = await this.db.get(
    'SELECT spotify_client_id, spotify_client_secret FROM sessions WHERE id = ?',
    [sessionId]
  );
  return {
    clientId:     row?.spotify_client_id     || process.env.SPOTIFY_CLIENT_ID,
    clientSecret: row?.spotify_client_secret || process.env.SPOTIFY_CLIENT_SECRET
  };
}
}

export default Database;