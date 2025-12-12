let token = null;
let user = null;

const socket = io({ auth: { token } }); // after login, we set token and reconnect
let roomId = null;

const peers = new Map();
let localStream = null;

const messagesEl = document.getElementById('messages');
const videoGrid = document.getElementById('videoGrid');

const joinBtn = document.getElementById('joinBtn');
const startCallBtn = document.getElementById('startCallBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');

// --- Auth ---
document.getElementById('signupBtn').onclick = async () => {
  const email = val('email'), name = val('name'), password = val('password');
  const res = await fetch('/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password })
  });
  const data = await res.json();
  if (!res.ok) return setAuthStatus(data.error || 'Signup failed');
  ({ token, user } = data);
  setAuthStatus(`Signed up as ${user.name}`);
  afterLogin();
};

document.getElementById('loginBtn').onclick = async () => {
  const email = val('email'), password = val('password');
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) return setAuthStatus(data.error || 'Login failed');
  ({ token, user } = data);
  setAuthStatus(`Logged in as ${user.name}`);
  afterLogin();
};

function afterLogin() {
  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
  joinBtn.disabled = false;
  document.getElementById('createRoomBtn').disabled = false;
  document.getElementById('sendInvitesBtn').disabled = false;
}

// --- Rooms & invites ---
document.getElementById('createRoomBtn').onclick = async () => {
  const id = val('roomId') || `room-${Math.random().toString(36).slice(2,8)}`;
  const name = val('roomName') || 'My Room';
  const res = await fetch('/api/rooms', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id, name }) });
  const data = await res.json();
  if (!res.ok) return setInviteStatus(data.error || 'Failed to create room');
  setInviteStatus(`Room created: ${data.id}`);
  setVal('roomId', data.id);
};

document.getElementById('sendInvitesBtn').onclick = async () => {
  const id = val('roomId');
  const emails = val('inviteEmails').split(',').map(e => e.trim()).filter(Boolean);
  if (!id) return setInviteStatus('Set a Room ID first');
  const res = await fetch(`/api/rooms/${id}/invites`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ emails }) });
  const data = await res.json();
  if (!res.ok) return setInviteStatus(data.error || 'Failed to invite');
  setInviteStatus(`Invites sent to ${emails.join(', ')}`);
};

// --- Join room ---
joinBtn.onclick = () => {
  roomId = val('roomId');
  if (!roomId || !token) return alert('Login and set Room ID');
  socket.emit('join', { roomId });
};

socket.on('error-msg', msg => alert(msg));

socket.on('peers', async (peerIds) => {
  log(`Joined room ${roomId}. Peers: ${peerIds.length}`);
  startCallBtn.disabled = false;
});

socket.on('peer-joined', ({ id, name }) => log(`${name} joined`));
socket.on('peer-left', ({ id, name }) => {
  log(`${name || 'Peer'} left`);
  const pc = peers.get(id);
  if (pc) { pc.close(); peers.delete(id); removeVideo(id); }
});

// --- Chat & files ---
document.getElementById('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const msg = val('msgInput').trim();
  if (!msg || !roomId) return;
  socket.emit('chat-message', { roomId, message: msg });
  appendMessage('You', msg, true);
  setVal('msgInput', '');
};

socket.on('chat-message', ({ name, message, id }) => {
  if (id === socket.id) return;
  appendMessage(name, message);
  msgCount++;
});

document.getElementById('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !roomId) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/upload', { method: 'POST', headers: authHeaders(), body: form });
  const data = await res.json();
  socket.emit('file-shared', { roomId, fileUrl: data.fileUrl, originalName: data.originalName });
  appendFile('You', data.originalName, data.fileUrl, true);
  e.target.value = '';
};

socket.on('file-shared', ({ name, fileUrl, originalName, id }) => {
  if (id === socket.id) return;
  appendFile(name, originalName, fileUrl);
});

// --- WebRTC controls ---
startCallBtn.onclick = async () => {
  if (!roomId) return;
  await ensureLocalStream();
  shareScreenBtn.disabled = false;
  toggleMicBtn.disabled = false;
  toggleCamBtn.disabled = false;
};

shareScreenBtn.onclick = async () => {
  if (!localStream) return;
  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const screenTrack = screenStream.getVideoTracks()[0];
  peers.forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(screenTrack);
  });
  replaceLocalVideoTrack(screenTrack);
  screenTrack.onended = async () => {
    const camTrack = localStream.getVideoTracks()[0];
    peers.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(camTrack);
    });
    replaceLocalVideoTrack(camTrack);
  };
};

toggleMicBtn.onclick = () => {
  const t = localStream?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  toggleMicBtn.textContent = t.enabled ? 'Mute' : 'Unmute';
};

toggleCamBtn.onclick = () => {
  const t = localStream?.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  toggleCamBtn.textContent = t.enabled ? 'Stop video' : 'Start video';
};

// --- Signaling ---
socket.on('peers', async (peerIds) => {
  await ensureLocalStream();
  for (const id of peerIds) await createConnection(id, true);
});

socket.on('signal', async ({ fromId, data }) => {
  let pc = peers.get(fromId);
  if (!pc) pc = await createConnection(fromId, false);

  if (data.type === 'offer') {
    await pc.setRemoteDescription(data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { roomId, targetId: fromId, data: answer });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(data);
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data); } catch (e) { console.warn('ICE error', e); }
  }
});

async function ensureLocalStream() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addLocalVideo(socket.id, localStream, user?.name || 'You');
  }
}

// --- Polls UI ---
document.getElementById('addPollOptBtn').onclick = () => {
  const input = document.createElement('input');
  input.className = 'pollOpt';
  input.placeholder = `Option ${document.querySelectorAll('.pollOpt').length + 1}`;
  document.querySelector('.poll-create').insertBefore(input, document.getElementById('createPollBtn'));
};

document.getElementById('createPollBtn').onclick = () => {
  const question = val('pollQuestion');
  const options = [...document.querySelectorAll('.pollOpt')].map(i => i.value.trim()).filter(Boolean);
  if (!roomId) return alert('Join a room first');
  if (!question || options.length < 2) return alert('Provide a question and at least 2 options');
  socket.emit('poll-create', { roomId, question, options });
};

socket.on('poll-created', (poll) => {
  renderPoll(poll);
});

socket.on('poll-results', ({ pollId, counts }) => {
  updatePollChart(pollId, counts);
});

// --- Charts setup ---
const charts = new Map(); // pollId -> chart
const activityChart = new Chart(document.getElementById('activityChart'), {
  type: 'line',
  data: { labels: [], datasets: [{ label: 'Messages/min', data: [], borderColor: '#3b82f6' }] },
  options: { animation: false, scales: { y: { beginAtZero: true, precision: 0 } } }
});
let msgCount = 0;
setInterval(() => {
  const now = new Date().toLocaleTimeString();
  activityChart.data.labels.push(now);
  activityChart.data.datasets[0].data.push(msgCount);
  activityChart.update();
  msgCount = 0;
}, 60000);

function renderPoll(poll) {
  const wrap = document.createElement('div');
  wrap.className = 'poll';
  wrap.id = `poll-${poll.id}`;
  wrap.innerHTML = `
    <h4>${escapeHtml(poll.question)}</h4>
    <div class="options">
      ${poll.options.map((opt, i) => `<button data-poll="${poll.id}" data-index="${i}">${escapeHtml(opt)}</button>`).join('')}
    </div>
    <canvas id="chart-${poll.id}" height="120"></canvas>
  `;
  document.getElementById('polls').prepend(wrap);

  wrap.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const optionIndex = Number(btn.dataset.index);
      socket.emit('poll-vote', { roomId, pollId: poll.id, optionIndex });
    };
  });

  const ctx = document.getElementById(`chart-${poll.id}`);
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: poll.options,
      datasets: [{ label: 'Votes', data: poll.options.map(() => 0), backgroundColor: '#10b981' }]
    },
    options: { animation: false, scales: { y: { beginAtZero: true, precision: 0 } } }
  });
  charts.set(poll.id, chart);
}

function updatePollChart(pollId, counts) {
  const chart = charts.get(pollId);
  if (!chart) return;
  chart.data.datasets[0].data = chart.data.labels.map((_, i) => {
    const found = counts.find(x => Number(x.option_index) === i);
    return found ? Number(found.c) : 0;
  });
  chart.update();
}

// --- WebRTC helpers ---
async function createConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peers.set(peerId, pc);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.ontrack = (e) => addRemoteVideo(peerId, e.streams[0]);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { roomId, targetId: peerId, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) removeVideo(peerId);
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId, targetId: peerId, data: offer });
  }
  return pc;
}

// --- UI helpers ---
function appendMessage(name, message, isSelf = false) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div class="meta">${isSelf ? 'You' : name}</div>
    <div class="bubble">${escapeHtml(message)}</div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendFile(name, originalName, url, isSelf = false) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div class="meta">${isSelf ? 'You' : name}</div>
    <div class="bubble"><a href="${url}" target="_blank" download="${originalName}">Download: ${escapeHtml(originalName)}</a></div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addLocalVideo(id, stream, name) { addVideoTile(id, stream, name || 'You', true); }
function addRemoteVideo(id, stream) { addVideoTile(id, stream, 'Peer'); }

function addVideoTile(id, stream, name, isLocal = false) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `<video autoplay playsinline ${isLocal ? 'muted' : ''}></video><div class="video-name">${name}</div>`;
    videoGrid.appendChild(tile);
  }
  const video = tile.querySelector('video');
  video.srcObject = stream;
}

function replaceLocalVideoTrack(newTrack) {
  const tile = document.getElementById(`tile-${socket.id}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  const stream = video.srcObject || new MediaStream();
  const oldTrack = stream.getVideoTracks()[0];
  if (oldTrack) stream.removeTrack(oldTrack);
  stream.addTrack(newTrack);
  video.srcObject = stream;
}

function removeVideo(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

function val(id) { return document.getElementById(id).value; }
function setVal(id, v) { document.getElementById(id).value = v; }
function setAuthStatus(msg) { document.getElementById('authStatus').textContent = msg; }
function setInviteStatus(msg) { document.getElementById('inviteStatus').textContent = msg; }
function log(msg) { appendMessage('System', msg); }
function escapeHtml(str) { return str.replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s])); }
