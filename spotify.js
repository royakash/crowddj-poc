import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI;

// Scopes we need from the user
// - playlist-read-private    → read their playlists
// - playlist-modify-public   → create/edit public playlists
// - playlist-modify-private  → create/edit private playlists
// - user-read-playback-state → see what's playing
// - user-modify-playback-state → skip, pause, transfer playback
// - streaming                → Web Playback SDK (Premium only)
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private'
].join(' ');

// ── AUTH ──────────────────────────────────────────────────

// Step 1: Build the URL that sends user to Spotify login page
export function getAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    scope:         SCOPES,
    redirect_uri:  REDIRECT_URI,
    state:         state,
    show_dialog:   'true'
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// Step 2: Exchange the auth code for access + refresh tokens
export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    },
    body
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const data = await res.json();
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresIn:    data.expires_in,       // seconds (usually 3600)
    expiresAt:    Date.now() + (data.expires_in * 1000)
  };
}

// Step 3: Refresh the access token when it expires
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    },
    body
  });

  if (!res.ok) throw new Error('Token refresh failed');
  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresAt:   Date.now() + (data.expires_in * 1000)
  };
}

// ── API HELPER ────────────────────────────────────────────
// Central fetch wrapper with automatic token refresh
export async function spotifyFetch(endpoint, accessToken, options = {}) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.spotify.com/v1${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
      ...options.headers
    }
  });

  // 204 = success but no body (e.g. add tracks returns nothing)
  if (res.status === 204) return null;

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${err}`);
  }

  return res.json();
}

// ── USER ──────────────────────────────────────────────────
export async function getSpotifyUser(accessToken) {
  return spotifyFetch('/me', accessToken);
}

// ── PLAYLISTS ─────────────────────────────────────────────
export async function getUserPlaylists(accessToken, limit = 20) {
  const data = await spotifyFetch(`/me/playlists?limit=${limit}`, accessToken);
  return data.items.map(p => ({
    id:          p.id,
    name:        p.name,
    description: p.description,
    trackCount:  p.tracks.total,
    imageUrl:    p.images?.[0]?.url || null,
    owner:       p.owner.display_name
  }));
}

export async function getPlaylistTracks(accessToken, playlistId) {
  const data = await spotifyFetch(
    `/playlists/${playlistId}/tracks?limit=50&fields=items(track(id,name,artists,album,duration_ms,uri))`,
    accessToken
  );
  return data.items
    .filter(item => item.track)
    .map(item => ({
      id:       item.track.id,
      uri:      item.track.uri,
      title:    item.track.name,
      artist:   item.track.artists.map(a => a.name).join(', '),
      album:    item.track.album.name,
      imageUrl: item.track.album.images?.[0]?.url || null,
      duration: Math.round(item.track.duration_ms / 1000)
    }));
}

// Create a new playlist in the user's Spotify account
export async function createPlaylist(accessToken, userId, name, description = '') {
  return spotifyFetch(`/users/${userId}/playlists`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      public: false
    })
  });
}

// Add tracks to a playlist (max 100 at a time)
export async function addTracksToPlaylist(accessToken, playlistId, trackUris) {
  const chunks = [];
  for (let i = 0; i < trackUris.length; i += 100) {
    chunks.push(trackUris.slice(i, i + 100));
  }
  for (const chunk of chunks) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ uris: chunk })
    });
  }
}

// Remove tracks from a playlist
export async function removeTracksFromPlaylist(accessToken, playlistId, trackUris) {
  return spotifyFetch(`/playlists/${playlistId}/tracks`, accessToken, {
    method: 'DELETE',
    body: JSON.stringify({
      tracks: trackUris.map(uri => ({ uri }))
    })
  });
}

// Replace ALL tracks in a playlist (used when crowd mix changes)
export async function replacePlaylistTracks(accessToken, playlistId, trackUris) {
  // First clear the playlist
  await spotifyFetch(`/playlists/${playlistId}/tracks`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ uris: [] })
  });
  // Then add new tracks
  if (trackUris.length > 0) {
    await addTracksToPlaylist(accessToken, playlistId, trackUris);
  }
}

// ── SEARCH ────────────────────────────────────────────────
export async function searchTracks(accessToken, query, limit = 10) {
  const params = new URLSearchParams({ q: query, type: 'track', limit });
  const data = await spotifyFetch(`/search?${params}`, accessToken);
  return data.tracks.items.map(t => ({
    id:       t.id,
    uri:      t.uri,
    title:    t.name,
    artist:   t.artists.map(a => a.name).join(', '),
    album:    t.album.name,
    imageUrl: t.album.images?.[0]?.url || null,
    duration: Math.round(t.duration_ms / 1000)
  }));
}

// ── RECOMMENDATIONS ───────────────────────────────────────
// This is the KEY endpoint — generates tracks based on genres + crowd mix
// genreMix = [{ name: 'pop', pct: 45 }, { name: 'hip-hop', pct: 35 }, ...]
// Spotify genre seeds: https://api.spotify.com/v1/recommendations/available-genre-seeds
export async function getRecommendations(accessToken, genreMix, totalTracks = 30) {
  const results = [];

  for (const genre of genreMix.slice(0, 3)) {
    // How many tracks proportional to this genre's crowd percentage
    const trackCount = Math.max(2, Math.round((genre.pct / 100) * totalTracks));

    // Map CrowdDJ genre names to Spotify seed genres
    const spotifyGenre = mapToSpotifyGenre(genre.name);

    try {
      const params = new URLSearchParams({
        seed_genres: spotifyGenre,
        limit:       Math.min(trackCount, 20), // Spotify max per call is 100 but 20 is enough
        market:      'US'
      });

      const data = await spotifyFetch(`/recommendations?${params}`, accessToken);
      const tracks = data.tracks.map(t => ({
        id:          t.id,
        uri:         t.uri,
        title:       t.name,
        artist:      t.artists.map(a => a.name).join(', '),
        album:       t.album.name,
        imageUrl:    t.album.images?.[0]?.url || null,
        duration:    Math.round(t.duration_ms / 1000),
        genreSource: genre.name
      }));

      results.push(...tracks);
    } catch (e) {
      console.error(`Recommendations failed for genre ${spotifyGenre}:`, e.message);
    }
  }

  // Shuffle so genres are interleaved
  return results.sort(() => Math.random() - 0.5);
}

// Maps our genre labels to Spotify's seed genre format
// Full list: https://api.spotify.com/v1/recommendations/available-genre-seeds
function mapToSpotifyGenre(crowdDJGenre) {
  const map = {
    'Pop':        'pop',
    'Hip Hop':    'hip-hop',
    'Rock':       'rock',
    'Jazz':       'jazz',
    'Electronic': 'electronic',
    'Indie':      'indie',
    'R&B':        'r-n-b',
    'Country':    'country',
    '90s':        'rock',         // Spotify doesn't have a "90s" seed — rock is closest
    '2000s':      'pop',          // Similarly mapped
    'Classical':  'classical',
    'Reggae':     'reggae'
  };
  return map[crowdDJGenre] || 'pop';
}

// ── PLAYBACK CONTROL ──────────────────────────────────────
// All playback requires Spotify Premium on the user's account

// Get currently playing track + playback state
export async function getPlaybackState(accessToken) {
  return spotifyFetch('/me/player', accessToken);
}

// Get available devices (speakers, phones, computers)
export async function getDevices(accessToken) {
  const data = await spotifyFetch('/me/player/devices', accessToken);
  return data?.devices || [];
}

// Transfer playback to a specific device
export async function transferPlayback(accessToken, deviceId, play = true) {
  return spotifyFetch('/me/player', accessToken, {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play })
  });
}

// Start playing a playlist or list of tracks
export async function startPlayback(accessToken, deviceId, contextUri = null, trackUris = null) {
  const body = {};
  if (contextUri) body.context_uri = contextUri;   // e.g. spotify:playlist:xxx
  if (trackUris)  body.uris = trackUris;            // array of spotify:track:xxx
  if (deviceId)   body.device_id = deviceId;

  return spotifyFetch('/me/player/play', accessToken, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

// Skip to next track
export async function skipToNext(accessToken, deviceId) {
  const params = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(`/me/player/next${params}`, accessToken, { method: 'POST' });
}

// Pause playback
export async function pausePlayback(accessToken, deviceId) {
  const params = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(`/me/player/pause${params}`, accessToken, { method: 'PUT' });
}

// Add track to queue
export async function addToQueue(accessToken, trackUri, deviceId) {
  const params = new URLSearchParams({ uri: trackUri });
  if (deviceId) params.set('device_id', deviceId);
  return spotifyFetch(`/me/player/queue?${params}`, accessToken, { method: 'POST' });
}