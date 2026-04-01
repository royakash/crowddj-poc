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
function initAdmin() {
  if (adminToken) {
    showScreen('admin', 'screenAdminDash');
    loadAdminData();
    pollTimer = setInterval(loadAdminData, 10000);
  } else {
    showScreen('admin', 'screenAdminLogin');
  }
}

async function adminLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('adminPass').value;
  try {
    const res = await apiFetch('/api/admin/login', 'POST', { password: pass });
    if (res.token) {
      adminToken = res.token;
      showScreen('admin', 'screenAdminDash');
      loadAdminData();
      pollTimer = setInterval(loadAdminData, 10000);
    }
  } catch (_) {
    document.getElementById('loginErr').textContent = 'Invalid password';
  }
}

function adminLogout() {
  adminToken = null;
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