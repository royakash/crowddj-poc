const API = '';
let voterUuid = localStorage.getItem('crowddj_uuid');
if (!voterUuid) { voterUuid = crypto.randomUUID(); localStorage.setItem('crowddj_uuid', voterUuid); }

let adminToken = null;
let selectedGenres = [];
let allGenres = [];
let blockedGenreIds = [];
let pollTimer = null;

// ── TOAST ─────────────────────────────────────────────────
function toast(msg, duration = 2800) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// ── MODE SWITCH ───────────────────────────────────────────
function switchMode(mode) {
  document.querySelectorAll('.mode').forEach(m => m.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(mode === 'customer' ? 'customerMode' : 'adminMode').classList.add('active');
  document.getElementById(mode === 'customer' ? 'tabCustomer' : 'tabAdmin').classList.add('active');

  clearInterval(pollTimer);
  if (mode === 'customer') initCustomer();
  else initAdmin();
}

// ═══════════════════════════════════════════════════════════
// CUSTOMER
// ═══════════════════════════════════════════════════════════
async function initCustomer() {
  try {
    const data = await apiFetch('/api/session');
    allGenres = data.availableGenres || [];
    blockedGenreIds = [];

    // Check if already voted
    const vs = await apiFetch('/api/vote-status', 'GET', null, { 'x-voter-uuid': voterUuid });
    if (vs.hasVoted) {
      showScreen('customer', 'screenNowPlaying');
      renderCrowdMix(data.mix || []);
      renderCurrentSong(data.currentSong);
      startCustomerPoll();
    } else {
      showScreen('customer', 'screenVote');
      renderGenreGrid(allGenres);
    }
  } catch (e) {
    console.error(e);
    toast('Could not reach server');
  }
}

function renderGenreGrid(genres) {
  selectedGenres = [];
  const grid = document.getElementById('genreGrid');
  grid.innerHTML = genres.map(g => `
    <div class="genre-pill" data-id="${g.id}" onclick="toggleGenre('${g.id}', this)">
      ${g.name}
    </div>
  `).join('');
  updateSelectedCount();
}

function toggleGenre(id, el) {
  if (selectedGenres.includes(id)) {
    selectedGenres = selectedGenres.filter(x => x !== id);
    el.classList.remove('selected');
  } else {
    if (selectedGenres.length >= 3) { toast('Max 3 genres — deselect one first'); return; }
    selectedGenres.push(id);
    el.classList.add('selected');
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  document.getElementById('selectedCount').textContent = `${selectedGenres.length} / 3 selected`;
  document.getElementById('submitVoteBtn').disabled = selectedGenres.length === 0;
}

async function submitVote() {
  if (selectedGenres.length === 0) return;
  try {
    const res = await apiFetch('/api/vote', 'POST', { genreIds: selectedGenres }, { 'x-voter-uuid': voterUuid });
    if (res.success) {
      toast('🎵 Vote submitted!');
      showScreen('customer', 'screenNowPlaying');
      renderCrowdMix(res.mix || []);

      // Load current song
      const sess = await apiFetch('/api/session');
      renderCurrentSong(sess.currentSong);
      startCustomerPoll();
    }
  } catch (e) { toast('Failed to submit vote'); }
}

async function submitSkip() {
  try {
    const res = await apiFetch('/api/skip', 'POST', {}, { 'x-voter-uuid': voterUuid });
    if (res.skipped) {
      toast('⏭ Song skipped by crowd!');
      renderCurrentSong(res.nextSong);
    } else {
      document.getElementById('skipInfo').textContent = `${res.skipCount} skips so far — needs 40% of voters`;
      toast(`Skip recorded (${res.skipPct}%)`);
    }
  } catch (e) { toast('Skip failed'); }
}

async function submitRequest(e) {
  e.preventDefault();
  const title = document.getElementById('reqTitle').value;
  const artist = document.getElementById('reqArtist').value;
  const reason = document.getElementById('reqReason').value;
  try {
    await apiFetch('/api/request-song', 'POST', { songTitle: title, artistName: artist, reason }, { 'x-voter-uuid': voterUuid });
    toast('🎵 Request submitted!');
    document.getElementById('requestForm').reset();
  } catch (e) { toast('Request failed'); }
}

function renderCurrentSong(song) {
  if (!song) {
    document.getElementById('npTitle').textContent = 'Waiting for song...';
    document.getElementById('npArtist').textContent = '';
    document.getElementById('npGenre').textContent = '';
    return;
  }
  document.getElementById('npTitle').textContent = song.title;
  document.getElementById('npArtist').textContent = song.artist;
  document.getElementById('npGenre').textContent = song.genre_name || '';
}

function renderCrowdMix(mix) {
  const el = document.getElementById('crowdMixBars');
  if (!mix || mix.length === 0) {
    el.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px">Waiting for votes…</div>';
    return;
  }
  el.innerHTML = mix.map(m => `
    <div class="mix-bar-row">
      <span class="mix-bar-label">${m.name}</span>
      <div class="mix-bar-track">
        <div class="mix-bar-fill" style="width:${m.pct}%"></div>
      </div>
      <span class="mix-bar-pct">${m.pct}%</span>
    </div>
  `).join('');
}

function startCustomerPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const data = await apiFetch('/api/crowd');
      renderCrowdMix(data.mix || []);
      renderCurrentSong(data.currentSong);
    } catch (_) {}
  }, 8000);
}

// ═══════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════
// function initAdmin() {
//   if (adminToken) {
//     showScreen('admin', 'screenAdminDash');
//     loadAdminData();
//      loadSpotifyPanel(); 
//     pollTimer = setInterval(loadAdminData, 10000);
//   } else {
//     showScreen('admin', 'screenAdminLogin');
//   }
// }
function initAdmin() {
  const stored = localStorage.getItem('crowddj_admin_token');
  if (stored) adminToken = stored;

  if (adminToken) {
    showScreen('admin', 'screenAdminDash');
    loadAdminData();
    loadSpotifyPanel();
    pollTimer = setInterval(loadAdminData, 10000);
  } else {
    showScreen('admin', 'screenAdminLogin');
  }
}

// async function adminLogin(e) {
//   e.preventDefault();
//   const pass = document.getElementById('adminPass').value;
//   try {
//     const res = await apiFetch('/api/admin/login', 'POST', { password: pass });
//     if (res.token) {
//       adminToken = res.token;
//       showScreen('admin', 'screenAdminDash');
//       loadAdminData();
//       pollTimer = setInterval(loadAdminData, 10000);
//     }
//   } catch (_) {
//     document.getElementById('loginErr').textContent = 'Invalid password';
//   }
// }

async function adminLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('adminPass').value;
  try {
    const res = await apiFetch('/api/admin/login', 'POST', { password: pass });
    if (res.token) {
      adminToken = res.token;
      localStorage.setItem('crowddj_admin_token', res.token);
      showScreen('admin', 'screenAdminDash');
      loadAdminData();
      loadSpotifyPanel();
      pollTimer = setInterval(loadAdminData, 10000);
    }
  } catch (_) {
    document.getElementById('loginErr').textContent = 'Invalid password';
  }
}

// function adminLogout() {
//   adminToken = null;
//   clearInterval(pollTimer);
//   showScreen('admin', 'screenAdminLogin');
// }

function adminLogout() {
  adminToken = null;
  localStorage.removeItem('crowddj_admin_token');
  clearInterval(pollTimer);
  showScreen('admin', 'screenAdminLogin');
}

async function loadAdminData() {
  try {
    const data = await apiFetch('/api/admin/analytics', 'GET', null, {}, true);

    // Stats
    document.getElementById('statVoters').textContent = data.totalVoters;
    document.getElementById('statVotes').textContent = data.totalVotes;
    document.getElementById('statSession').textContent = data.session?.name?.slice(0, 14) || '—';

    // Now playing
    let song = null;
    if (data.session?.current_song_id) {
      const crowd = await apiFetch('/api/crowd');
      song = crowd.currentSong;
    }
    document.getElementById('adminNpTitle').textContent = song?.title || 'No song set';
    document.getElementById('adminNpArtist').textContent = song?.artist || '—';
    document.getElementById('adminNpGenre').textContent = song?.genre_name || '';

    // Crowd mix
    renderAdminMix(data.ranked || [], data.outliers || []);

    // Genre toggles
    allGenres = data.genres || [];
    const blocked = JSON.parse(data.session?.blocked_genres || '[]');
    renderGenreToggles(allGenres, blocked);
    populateGenreSelect(allGenres);

    // Requests
    renderRequests(data.requests || []);

  } catch (e) { console.error(e); }
}

function renderAdminMix(ranked, outliers) {
  const el = document.getElementById('adminCrowdMix');
  if (ranked.length === 0) {
    el.innerHTML = '<div class="empty-state">No votes yet — waiting for crowd</div>';
  } else {
    el.innerHTML = ranked.map((m, i) => `
      <div class="admin-mix-item">
        <span class="mix-rank">${i + 1}</span>
        <span class="mix-name">${m.name}</span>
        <span class="mix-votes">${m.votes} votes</span>
        <span class="mix-pct-pill">${m.pct}%</span>
      </div>
    `).join('');
  }

  const outlierEl = document.getElementById('adminOutliers');
  if (outliers.length > 0) {
    outlierEl.innerHTML = 'Outliers removed: ' + outliers.map(o => `<span class="outlier-tag">${o}</span>`).join('');
  } else {
    outlierEl.innerHTML = '';
  }
}

function renderGenreToggles(genres, blocked) {
  blockedGenreIds = [...blocked];
  const el = document.getElementById('genreToggles');
  el.innerHTML = genres.map(g => {
    const isBlocked = blocked.includes(g.id);
    return `
      <div class="genre-toggle ${isBlocked ? 'blocked' : 'active'}" data-id="${g.id}" onclick="toggleBlockGenre(this, '${g.id}')">
        <span class="toggle-dot"></span>
        ${g.name}
      </div>
    `;
  }).join('');
}

function toggleBlockGenre(el, id) {
  if (blockedGenreIds.includes(id)) {
    blockedGenreIds = blockedGenreIds.filter(x => x !== id);
    el.classList.remove('blocked');
    el.classList.add('active');
  } else {
    blockedGenreIds.push(id);
    el.classList.remove('active');
    el.classList.add('blocked');
  }
  el.querySelector('.toggle-dot').style.background = blockedGenreIds.includes(id) ? 'var(--text3)' : 'var(--green)';
}

async function saveBlockedGenres() {
  try {
    await apiFetch('/api/admin/blocked-genres', 'POST', { blockedGenres: blockedGenreIds }, {}, true);
    toast('Genre settings saved');
  } catch (e) { toast('Save failed'); }
}

async function adminNextSong() {
  try {
    const res = await apiFetch('/api/admin/next-song', 'POST', {}, {}, true);
    if (res.song) {
      document.getElementById('adminNpTitle').textContent = res.song.title;
      document.getElementById('adminNpArtist').textContent = res.song.artist;
      document.getElementById('adminNpGenre').textContent = res.song.genre_name || '';
      toast('⏭ Advanced to next song');
    }
  } catch (e) { toast('Failed to advance song'); }
}

async function startSession(e) {
  e.preventDefault();
  const name = document.getElementById('sessionName').value;
  try {
    await apiFetch('/api/admin/session', 'POST', { name }, {}, true);
    toast('New session started!');
    document.getElementById('sessionName').value = '';
    loadAdminData();
  } catch (e) { toast('Failed to start session'); }
}

function renderRequests(requests) {
  const pending = requests.filter(r => r.status === 'pending');
  document.getElementById('requestBadge').textContent = pending.length;
  const el = document.getElementById('requestsList');
  if (pending.length === 0) {
    el.innerHTML = '<div class="empty-state">No pending requests</div>';
    return;
  }
  el.innerHTML = pending.map(r => `
    <div class="request-card">
      <div class="req-title">${r.song_title}</div>
      <div class="req-artist">by ${r.artist_name}</div>
      ${r.reason ? `<div class="req-reason">"${r.reason}"</div>` : ''}
      <div class="req-actions">
        <button class="btn-approve" onclick="handleRequest('${r.id}', 'approve')">✓ Approve</button>
        <button class="btn-reject" onclick="handleRequest('${r.id}', 'reject')">✗ Reject</button>
      </div>
    </div>
  `).join('');
}

async function handleRequest(id, action) {
  try {
    await apiFetch(`/api/admin/request/${id}`, 'POST', { action }, {}, true);
    toast(action === 'approve' ? 'Request approved' : 'Request rejected');
    loadAdminData();
  } catch (e) { toast('Action failed'); }
}

function populateGenreSelect(genres) {
  const sel = document.getElementById('newGenre');
  if (sel.options.length > 1) return;
  genres.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  });
}

async function addSong() {
  const title = document.getElementById('newTitle').value;
  const artist = document.getElementById('newArtist').value;
  const duration = document.getElementById('newDuration').value;
  const genreId = document.getElementById('newGenre').value;
  if (!title || !artist || !genreId) { toast('Fill in all song fields'); return; }
  try {
    await apiFetch('/api/admin/songs', 'POST', { title, artist, duration, genreId }, {}, true);
    toast('Song added!');
    document.getElementById('newTitle').value = '';
    document.getElementById('newArtist').value = '';
    loadSongList();
  } catch (e) { toast('Failed to add song'); }
}

async function loadSongList() {
  try {
    const songs = await apiFetch('/api/admin/songs', 'GET', null, {}, true);
    const el = document.getElementById('songList');
    el.innerHTML = songs.map(s => `
      <div class="song-row">
        <div class="song-row-info">
          <div class="song-row-title">${s.title}</div>
          <div class="song-row-meta">${s.artist} · ${s.genre_name || 'No genre'}</div>
        </div>
        <button class="btn-remove" onclick="removeSong('${s.id}')">Remove</button>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

async function removeSong(id) {
  try {
    await apiFetch(`/api/admin/songs/${id}`, 'DELETE', null, {}, true);
    toast('Song removed');
    loadSongList();
  } catch (e) { toast('Remove failed'); }
}

function toggleSongList() {
  const el = document.getElementById('songListContainer');
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  if (!visible) loadSongList();
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function showScreen(mode, screenId) {
  const modeEl = document.getElementById(mode === 'customer' ? 'customerMode' : 'adminMode');
  modeEl.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

async function apiFetch(path, method = 'GET', body = null, extraHeaders = {}, useAuth = false) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (useAuth && adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── BOOT ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const mode = new URLSearchParams(window.location.search).get('mode') || 'customer';
  switchMode(mode);
});


// ═══════════════════════════════════════════════════════════
// SPOTIFY INTEGRATION (admin only)
// ═══════════════════════════════════════════════════════════

let spotifyDeviceId = null;
let spotifyPlaylistId = null;

// async function loadSpotifyPanel() {
//   try {
//     const status = await apiFetch('/api/spotify/status', 'GET', null, {}, true);
//     renderSpotifyPanel(status);
//   } catch (e) {
//     console.error('Spotify panel load failed', e);
//   }
// }

async function loadSpotifyPanel() {
  const el = document.getElementById('spotifyPanel');
  if (!el) return;

  if (!adminToken) {
    el.innerHTML = '<div class="empty-state">Login as admin first</div>';
    return;
  }

  try {
    const status = await apiFetch('/api/spotify/status', 'GET', null, {}, true);
    renderSpotifyPanel(status);
  } catch (e) {
    el.innerHTML = `
      <div style="background:#2a1010;border:1px solid #ff5c6a;border-radius:10px;padding:16px;">
        <div style="color:#ff5c6a;font-size:13px;font-weight:600;margin-bottom:8px">Spotify error</div>
        <div style="color:#aaa;font-size:12px;font-family:monospace">${e.message}</div>
        <div style="color:#666;font-size:11px;margin-top:8px">
          Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set in Render environment variables
        </div>
      </div>
    `;
  }
}

function connectSpotify() {
  // Pass token as query param so server can verify before redirecting to Spotify
  window.location.href = `/auth/spotify?token=${encodeURIComponent(adminToken)}`;
}

function renderSpotifyPanel(status) {
  const el = document.getElementById('spotifyPanel');
  if (!el) return;

  if (!status.connected) {
    el.innerHTML = `
      <div class="spotify-connect-box">
        <div class="spotify-logo">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="#1DB954">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
          </svg>
          Spotify
        </div>
        <p style="font-size:13px;color:#888;margin:8px 0 16px;">Connect your Spotify account to fetch real playlists and control playback</p>
        <button onclick="connectSpotify()" class="btn-spotify">Connect Spotify Account</button>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="spotify-connected-box">
        <div class="spotify-user-row">
          <div class="spotify-dot"></div>
          <span style="font-size:14px;font-weight:600;">Connected: ${status.userName}</span>
          <button onclick="disconnectSpotify()" class="btn-sm" style="margin-left:auto">Disconnect</button>
        </div>

        <div class="spotify-actions">
          <button onclick="loadSpotifyPlaylists()" class="btn-secondary" style="margin-bottom:10px">
            📋 Load My Playlists
          </button>
          <button onclick="generateCrowdPlaylist()" class="btn-spotify-action">
            🎯 Generate Crowd Playlist from Votes
          </button>
        </div>

        <div id="spotifyPlaylists" class="spotify-playlists"></div>
        <div id="spotifyDevices" class="spotify-devices"></div>
        <div id="spotifyPlayback" class="spotify-playback"></div>
        <div id="spotifySearch" class="spotify-search-area">
          <input type="text" id="spotifySearchInput" placeholder="Search Spotify catalog..." 
                 style="background:#1a1a24;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px 14px;font-size:13px;color:#f0eeff;width:100%;margin-top:12px">
          <button onclick="searchSpotify()" class="btn-secondary" style="margin-top:8px">Search</button>
          <div id="spotifySearchResults" class="search-results"></div>
        </div>
      </div>
    `;
    loadSpotifyDevices();
  }
}

async function loadSpotifyPlaylists() {
  try {
    const playlists = await apiFetch('/api/spotify/playlists', 'GET', null, {}, true);
    const el = document.getElementById('spotifyPlaylists');
    if (playlists.length === 0) {
      el.innerHTML = '<div class="empty-state">No playlists found</div>';
      return;
    }
    el.innerHTML = `
      <h4 style="font-size:13px;color:#888;margin:16px 0 10px;text-transform:uppercase;letter-spacing:0.5px">Your Playlists</h4>
      ${playlists.map(p => `
        <div class="spotify-playlist-row">
          ${p.imageUrl ? `<img src="${p.imageUrl}" style="width:40px;height:40px;border-radius:4px;object-fit:cover">` : '<div style="width:40px;height:40px;border-radius:4px;background:#2a2a3a"></div>'}
          <div style="flex:1;margin-left:10px">
            <div style="font-size:13px;font-weight:600">${p.name}</div>
            <div style="font-size:11px;color:#666">${p.trackCount} tracks</div>
          </div>
          <button onclick="loadPlaylistTracks('${p.id}', '${p.name.replace(/'/g, '')}')" class="btn-sm">View</button>
          <button onclick="playSpotifyPlaylist('spotify:playlist:${p.id}')" class="btn-sm" style="margin-left:6px">▶ Play</button>
        </div>
      `).join('')}
    `;
  } catch (e) {
    toast('Failed to load playlists');
  }
}

async function loadPlaylistTracks(playlistId, playlistName) {
  try {
    const tracks = await apiFetch(`/api/spotify/playlists/${playlistId}/tracks`, 'GET', null, {}, true);
    const el = document.getElementById('spotifyPlaylists');
    const tracksHtml = tracks.map(t => `
      <div class="spotify-track-row">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600">${t.title}</div>
          <div style="font-size:11px;color:#666">${t.artist}</div>
        </div>
        <button onclick="addToSpotifyQueue('${t.uri}')" class="btn-sm">+ Queue</button>
      </div>
    `).join('');

    el.innerHTML += `
      <h4 style="font-size:13px;color:#888;margin:16px 0 10px">${playlistName}</h4>
      <div style="max-height:300px;overflow-y:auto">${tracksHtml}</div>
    `;
  } catch (e) {
    toast('Failed to load tracks');
  }
}

async function generateCrowdPlaylist() {
  toast('Generating crowd playlist from votes...');
  try {
    const res = await apiFetch('/api/spotify/generate-crowd-playlist', 'POST', {}, {}, true);
    if (res.success) {
      spotifyPlaylistId = res.playlist.id;
      toast(`✅ Playlist created: ${res.trackCount} tracks`);

      const el = document.getElementById('spotifyPlayback');
      el.innerHTML = `
        <div class="crowd-playlist-card">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Crowd Playlist Ready</div>
          <div style="font-size:11px;color:#888;margin-bottom:12px">${res.trackCount} tracks · Mix: ${res.mix.map(m => m.name + ' ' + m.pct + '%').join(' · ')}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${res.tracks.slice(0, 5).map(t => `
              <div style="font-size:11px;background:#1a1a2a;padding:4px 8px;border-radius:4px;color:#888">${t.title}</div>
            `).join('')}
          </div>
          <button onclick="playSpotifyPlaylist('${res.playlist.uri}')" class="btn-spotify-action" style="margin-top:12px">
            ▶ Play This Playlist Now
          </button>
        </div>
      `;
    }
  } catch (e) {
    toast('Failed to generate playlist — do you have crowd votes yet?');
  }
}

async function loadSpotifyDevices() {
  try {
    const devices = await apiFetch('/api/spotify/devices', 'GET', null, {}, true);
    const el = document.getElementById('spotifyDevices');
    if (!devices || devices.length === 0) {
      el.innerHTML = '<div style="font-size:12px;color:#555;margin-top:12px">No Spotify devices found — open Spotify on your phone or computer first</div>';
      return;
    }
    el.innerHTML = `
      <h4 style="font-size:13px;color:#888;margin:16px 0 10px;text-transform:uppercase;letter-spacing:0.5px">Devices</h4>
      ${devices.map(d => `
        <div class="spotify-device-row ${d.is_active ? 'active-device' : ''}" onclick="selectDevice('${d.id}', this)">
          <span style="font-size:12px">${d.type === 'Computer' ? '💻' : d.type === 'Smartphone' ? '📱' : '🔊'}</span>
          <span style="font-size:13px;font-weight:${d.is_active ? '600' : '400'}">${d.name}</span>
          ${d.is_active ? '<span style="font-size:11px;color:#1DB954;margin-left:auto">Active</span>' : ''}
        </div>
      `).join('')}
    `;
    // Auto-select active device
    const active = devices.find(d => d.is_active);
    if (active) spotifyDeviceId = active.id;
  } catch (e) {
    console.error('Device load failed', e);
  }
}

function selectDevice(deviceId, el) {
  spotifyDeviceId = deviceId;
  document.querySelectorAll('.spotify-device-row').forEach(r => r.classList.remove('active-device'));
  el.classList.add('active-device');
  toast('Device selected');
}

async function playSpotifyPlaylist(playlistUri) {
  try {
    await apiFetch('/api/spotify/play', 'POST', { deviceId: spotifyDeviceId, playlistUri }, {}, true);
    toast('▶ Playing on Spotify!');
  } catch (e) {
    toast('Playback failed — ensure Spotify Premium and a device is active');
  }
}

async function addToSpotifyQueue(trackUri) {
  try {
    await apiFetch('/api/spotify/next', 'POST', { deviceId: spotifyDeviceId, trackUri }, {}, true);
    toast('Added to queue');
  } catch (e) {
    toast('Queue failed');
  }
}

async function searchSpotify() {
  const q = document.getElementById('spotifySearchInput').value;
  if (!q) return;
  try {
    const results = await apiFetch(`/api/spotify/search?q=${encodeURIComponent(q)}&limit=8`, 'GET', null, {}, true);
    const el = document.getElementById('spotifySearchResults');
    el.innerHTML = results.map(t => `
      <div class="spotify-track-row">
        ${t.imageUrl ? `<img src="${t.imageUrl}" style="width:36px;height:36px;border-radius:4px;object-fit:cover">` : ''}
        <div style="flex:1;margin-left:8px">
          <div style="font-size:12px;font-weight:600">${t.title}</div>
          <div style="font-size:11px;color:#666">${t.artist}</div>
        </div>
        <button onclick="addToSpotifyQueue('${t.uri}')" class="btn-sm">+ Queue</button>
      </div>
    `).join('');
  } catch (e) {
    toast('Search failed');
  }
}

async function disconnectSpotify() {
  await apiFetch('/api/spotify/disconnect', 'POST', {}, {}, true);
  toast('Spotify disconnected');
  loadSpotifyPanel();
}

// Check URL for spotify callback result
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('spotify') === 'connected') {
  toast('✅ Spotify connected!');
  history.replaceState({}, '', '/?mode=admin');
} else if (urlParams.get('spotify') === 'denied') {
  toast('Spotify connection cancelled');
}