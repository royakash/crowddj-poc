import fetch from 'node-fetch';

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

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

export function getAuthUrl(clientId, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    scope:         SCOPES,
    redirect_uri:  REDIRECT_URI,
    state:         state,
    show_dialog:   'true'
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
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
    expiresIn:    data.expires_in,
    expiresAt:    Date.now() + (data.expires_in * 1000)
  };
}

export async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
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

export async function createPlaylist(accessToken, userId, name, description = '') {
  return spotifyFetch(`/users/${userId}/playlists`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false })
  });
}

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

export async function removeTracksFromPlaylist(accessToken, playlistId, trackUris) {
  return spotifyFetch(`/playlists/${playlistId}/tracks`, accessToken, {
    method: 'DELETE',
    body: JSON.stringify({ tracks: trackUris.map(uri => ({ uri })) })
  });
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
export async function getRecommendations(accessToken, genreMix, totalTracks = 30) {
  const results = [];

  for (const genre of genreMix.slice(0, 3)) {
    const trackCount  = Math.max(2, Math.round((genre.pct / 100) * totalTracks));
    const spotifyGenre = mapToSpotifyGenre(genre.name);

    try {
      const params = new URLSearchParams({
        seed_genres: spotifyGenre,
        limit:       Math.min(trackCount, 20),
        market:      'US'
      });
      const data   = await spotifyFetch(`/recommendations?${params}`, accessToken);
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
      console.error(`Recommendations failed for ${spotifyGenre}:`, e.message);
    }
  }

  return results.sort(() => Math.random() - 0.5);
}

function mapToSpotifyGenre(name) {
  const map = {
    'Pop': 'pop', 'Hip Hop': 'hip-hop', 'Rock': 'rock',
    'Jazz': 'jazz', 'Electronic': 'electronic', 'Indie': 'indie',
    'R&B': 'r-n-b', 'Country': 'country', '90s': 'rock',
    '2000s': 'pop', 'Classical': 'classical', 'Reggae': 'reggae'
  };
  return map[name] || 'pop';
}

// ── PLAYBACK ──────────────────────────────────────────────
export async function getPlaybackState(accessToken) {
  return spotifyFetch('/me/player', accessToken);
}

export async function getDevices(accessToken) {
  const data = await spotifyFetch('/me/player/devices', accessToken);
  return data?.devices || [];
}

export async function transferPlayback(accessToken, deviceId, play = true) {
  return spotifyFetch('/me/player', accessToken, {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play })
  });
}

export async function startPlayback(accessToken, deviceId, contextUri = null, trackUris = null) {
  const body = {};
  if (contextUri) body.context_uri = contextUri;
  if (trackUris)  body.uris        = trackUris;
  if (deviceId)   body.device_id   = deviceId;
  return spotifyFetch('/me/player/play', accessToken, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

export async function skipToNext(accessToken, deviceId) {
  const params = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(`/me/player/next${params}`, accessToken, { method: 'POST' });
}

export async function pausePlayback(accessToken, deviceId) {
  const params = deviceId ? `?device_id=${deviceId}` : '';
  return spotifyFetch(`/me/player/pause${params}`, accessToken, { method: 'PUT' });
}

export async function addToQueue(accessToken, trackUri, deviceId) {
  const params = new URLSearchParams({ uri: trackUri });
  if (deviceId) params.set('device_id', deviceId);
  return spotifyFetch(`/me/player/queue?${params}`, accessToken, { method: 'POST' });
}