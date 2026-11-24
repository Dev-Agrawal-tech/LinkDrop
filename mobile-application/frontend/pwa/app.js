const byId = (id) => document.getElementById(id);
const ui = {
  connectionDot: byId('connection-dot'), connectionLabel: byId('connection-label'),
  phoneTab: byId('role-phone'), laptopTab: byId('role-laptop'),
  phoneContent: byId('phone-content'), laptopContent: byId('laptop-content'),
  codeDisplay: byId('code-display'), phoneCaption: byId('phone-caption'), codeHelp: byId('code-help'),
  createCode: byId('create-code'), pairCode: byId('pair-code'), joinRoom: byId('join-room'),
  joinHelp: byId('join-help'), pairError: byId('pair-error'), pairedBanner: byId('paired-banner'),
  phoneQrCard: byId('phone-qr-card'), phoneQr: byId('phone-qr'), phoneQrHelp: byId('phone-qr-help'), phoneLink: byId('phone-link'),
  pairedTitle: byId('paired-title'), pairedDetail: byId('paired-detail'), disconnect: byId('disconnect'),
  transferBody: byId('transfer-body'), chooseFiles: byId('choose-files'), fileInput: byId('file-input'),
  dropHint: byId('drop-hint'), messageForm: byId('message-form'), messageInput: byId('message-input'),
  sendMessage: byId('send-message'), activity: byId('activity'), activityEmpty: byId('activity-empty'),
  transferCount: byId('transfer-count'), toast: byId('toast'),
};

const state = {
  role: window.matchMedia('(max-width: 700px)').matches ? 'phone' : 'laptop',
  socket: null,
  socketPromise: null,
  pendingAction: null,
  connected: false,
  code: null,
  expiresAt: null,
  outgoing: new Map(),
  incoming: new Map(),
  activityCount: 0,
  toastTimer: null,
  reconnectTimer: null,
  manualDisconnect: false,
  historyLoadedFor: null,
};

const PAIRING_STORAGE_KEY = 'linkdrop-pairing-v1';

function readStoredPairing() {
  try {
    const value = JSON.parse(localStorage.getItem(PAIRING_STORAGE_KEY) || 'null');
    if (!value || !/^\d{6}$/.test(value.code) || !['phone', 'laptop'].includes(value.role) || Number(value.expiresAt) <= Date.now()) return null;
    return value;
  } catch { return null; }
}

function saveStoredPairing(role, code, expiresAt) {
  try { localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify({ role, code, expiresAt: Number(expiresAt) || Date.now() + 24 * 60 * 60 * 1000 })); } catch { /* storage may be unavailable */ }
}

function forgetStoredPairing() {
  try { localStorage.removeItem(PAIRING_STORAGE_KEY); } catch { /* storage may be unavailable */ }
}

function historyStorageKey(code) { return `linkdrop-history-v1:${code}`; }

function rememberLocalActivity(code, item) {
  if (!code) return;
  try {
    const key = historyStorageKey(code);
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    history.push({ ...item, createdAt: new Date(item.createdAt || Date.now()).toISOString() });
    localStorage.setItem(key, JSON.stringify(history.slice(-100)));
  } catch { /* storage may be unavailable or full */ }
}

function restoreLocalActivity(code) {
  try {
    const history = JSON.parse(localStorage.getItem(historyStorageKey(code)) || '[]');
    for (const item of history) addActivity({ ...item, createdAt: new Date(item.createdAt), persist: false });
    return history.length > 0;
  } catch { return false; }
}

function setConnection(label, tone = 'ready') {
  ui.connectionLabel.textContent = label;
  ui.connectionDot.className = `status-dot ${tone}`;
}

function setRole(role) {
  if (state.connected) return;
  state.role = role;
  const isPhone = role === 'phone';
  ui.phoneTab.setAttribute('aria-selected', String(isPhone));
  ui.laptopTab.setAttribute('aria-selected', String(!isPhone));
  ui.phoneContent.hidden = !isPhone;
  ui.laptopContent.hidden = isPhone;
  if (!isPhone) void loadPhoneQr();
}

async function loadPhoneQr() {
  try {
    const response = await fetch('/api/connect-info', { cache: 'no-store' });
    if (!response.ok) throw new Error('LinkDrop could not find a local Wi-Fi address.');
    const info = await response.json();
    if (!info.url || !info.qr) {
      ui.phoneQr.hidden = true;
      ui.phoneQrHelp.textContent = 'No Wi-Fi address found. Connect the laptop to Wi-Fi and refresh this page.';
      return;
    }
    ui.phoneQr.src = info.qr;
    ui.phoneQr.hidden = false;
    ui.phoneLink.href = info.url;
    ui.phoneLink.textContent = info.url;
    ui.phoneLink.hidden = false;
    ui.phoneQrHelp.textContent = 'Scan on the same Wi-Fi network. Or open this address on your phone:';
  } catch {
    ui.phoneQr.hidden = true;
    ui.phoneQrHelp.textContent = 'Phone link is unavailable. Make sure LinkDrop is running, then refresh.';
  }
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 2800);
}

function showPairError(message) {
  ui.pairError.textContent = message;
  ui.pairError.hidden = false;
}

function clearPairError() {
  ui.pairError.hidden = true;
  ui.pairError.textContent = '';
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    showToast('Not connected to the sharing service yet. Try once more in a moment.');
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function connectSocket() {
  if (state.socket?.readyState === WebSocket.OPEN) {
    if (state.pendingAction) {
      const action = state.pendingAction;
      state.pendingAction = null;
      send(action);
    }
    return Promise.resolve(state.socket);
  }
  if (state.socketPromise) return state.socketPromise;
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${window.location.host}/relay`);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;
  setConnection('Connecting to LinkDrop…', 'waiting');
  state.socketPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.socketPromise = null;
      socket.close();
      reject(new Error('The sharing service did not respond.'));
    }, 8000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      setConnection('Ready when you are', 'ready');
      if (state.pendingAction) {
        const action = state.pendingAction;
        state.pendingAction = null;
        send(action);
      }
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      state.socketPromise = null;
      setConnection('Can’t reach the sharing service', 'offline');
      reject(new Error('Could not reach the sharing service. Check that it is running.'));
    }, { once: true });
  });
  socket.addEventListener('message', handleServerMessage);
  socket.addEventListener('close', () => {
    state.socketPromise = null;
    if (!state.manualDisconnect && readStoredPairing()) {
      state.connected = false;
      setConnection('Waiting for LinkDrop to reconnect…', 'waiting');
      scheduleResume();
    } else if (!state.connected) setConnection('Ready when you are', 'ready');
  });
  return state.socketPromise;
}

function updateCount() {
  if (!state.activityCount) ui.transferCount.textContent = 'Nothing yet';
  else ui.transferCount.textContent = `${state.activityCount} ${state.activityCount === 1 ? 'thing' : 'things'}`;
}

function formatBytes(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(value = Date.now()) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
}

function createUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function appendMessageBody(target, text) {
  const urlPattern = /https?:\/\/[^\s<>()]+/g;
  let cursor = 0;
  for (const match of text.matchAll(urlPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) target.append(document.createTextNode(text.slice(cursor, start)));
    const anchor = document.createElement('a');
    anchor.href = match[0];
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = match[0];
    target.append(anchor);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

async function copyMessageText(text, button) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Clipboard is unavailable.');
    }
    button.textContent = 'Copied';
    showToast('Text copied to clipboard.');
    setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1500);
  } catch {
    showToast('Could not copy. Select the text and copy it manually.');
  }
}

function addActivity({ kind, text, sender = 'You', name, size, status, id, incoming = false, createdAt = Date.now(), persist = true }) {
  if (ui.activityEmpty.isConnected) ui.activityEmpty.remove();
  state.activityCount += 1;
  updateCount();
  const item = document.createElement('article');
  item.className = `activity-item ${kind === 'file' ? 'file-activity' : 'message-activity'}`;
  if (id) item.dataset.transferId = id;
  const icon = document.createElement('span');
  icon.className = `activity-icon ${kind === 'file' ? 'file-icon' : 'note-icon'}`;
  icon.innerHTML = kind === 'file'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 3Z"/><path d="M13 3v7h7"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10m-10 4h7"/></svg>';
  const content = document.createElement('div');
  content.className = 'activity-content';
  const heading = document.createElement('div');
  heading.className = 'activity-line';
  const title = document.createElement('strong');
  title.className = 'activity-title';
  title.textContent = kind === 'file' ? name : `${sender} shared`;
  const time = document.createElement('time');
  time.textContent = formatTime(createdAt);
  heading.append(title, time);
  const detail = document.createElement('div');
  detail.className = 'activity-detail';
  if (kind === 'file') {
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = formatBytes(size || 0);
    const statusLabel = document.createElement('span');
    statusLabel.className = 'transfer-status';
    statusLabel.textContent = status || (incoming ? 'Incoming' : 'Sending');
    detail.append(sizeLabel, document.createTextNode(' · '), statusLabel);
  } else {
    detail.classList.add('message-copy');
    appendMessageBody(detail, text || '');
  }
  content.append(heading, detail);
  item.append(icon, content);
  if (kind !== 'file' && text) {
    const copyButton = document.createElement('button');
    copyButton.className = 'mini-button copy-button';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy';
    copyButton.setAttribute('aria-label', 'Copy shared note or link');
    copyButton.addEventListener('click', () => void copyMessageText(text, copyButton));
    item.append(copyButton);
  }
  if (kind === 'file' && incoming && status === 'Incoming') {
    const controls = document.createElement('div');
    controls.className = 'incoming-controls';
    const accept = document.createElement('button');
    accept.className = 'mini-button accept-file';
    accept.type = 'button';
    accept.textContent = 'Save file';
    accept.addEventListener('click', () => acceptFile(id));
    const reject = document.createElement('button');
    reject.className = 'mini-button quiet-button';
    reject.type = 'button';
    reject.textContent = 'Skip';
    reject.addEventListener('click', () => rejectFile(id));
    controls.append(accept, reject);
    item.append(controls);
  }
  if (kind === 'file' && status === 'Sending') {
    const progress = document.createElement('progress');
    progress.className = 'file-progress';
    progress.max = 100;
    progress.value = 0;
    item.append(progress);
  }
  ui.activity.prepend(item);
  if (persist && state.code) rememberLocalActivity(state.code, { kind, text, sender, name, size, status, createdAt });
  return item;
}

function updateActivity(id, status, progress) {
  const item = ui.activity.querySelector(`[data-transfer-id="${CSS.escape(id)}"]`);
  if (!item) return;
  const label = item.querySelector('.transfer-status');
  if (label) label.textContent = status;
  const bar = item.querySelector('progress');
  if (bar && typeof progress === 'number') bar.value = progress;
  if (status === 'Saved' || status === 'Sent' || status === 'Declined' || status === 'Stopped') {
    item.querySelector('.incoming-controls')?.remove();
    if (bar && status !== 'Sent') bar.remove();
  }
}

function updatePairUi({ code, peer, expiresAt }) {
  state.connected = true;
  state.code = code;
  if (expiresAt) state.expiresAt = expiresAt;
  saveStoredPairing(state.role, code, state.expiresAt || Date.now() + 24 * 60 * 60 * 1000);
  ui.phoneTab.setAttribute('aria-selected', String(state.role === 'phone'));
  ui.laptopTab.setAttribute('aria-selected', String(state.role === 'laptop'));
  ui.phoneContent.hidden = true;
  ui.laptopContent.hidden = true;
  ui.pairedBanner.hidden = false;
  ui.pairedTitle.textContent = `Your ${peer} is connected`;
  ui.pairedDetail.textContent = 'Choose a file, note or link below.';
  ui.transferBody.setAttribute('aria-disabled', 'false');
  ui.chooseFiles.disabled = false;
  ui.messageInput.disabled = false;
  ui.sendMessage.disabled = false;
  ui.pairError.hidden = true;
  ui.createCode.disabled = false;
  setConnection('Devices connected', 'connected');
  if (state.historyLoadedFor !== code) {
    state.historyLoadedFor = code;
    if (!restoreLocalActivity(code)) void loadActivityHistory(code);
  }
}

async function loadActivityHistory(code) {
  try {
    const response = await fetch('/api/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    if (!response.ok) return;
    const { events = [] } = await response.json();
    for (const event of events.reverse()) {
      const sender = event.senderRole === state.role ? 'You' : event.senderRole === 'phone' ? 'Your phone' : 'Your laptop';
      if (event.kind === 'file') {
        addActivity({ kind: 'file', name: 'File shared earlier', size: event.byteSize, status: 'Shared earlier', sender, createdAt: new Date(event.createdAt) });
      } else {
        addActivity({ kind: 'message', text: 'A note or link was shared earlier.', sender, createdAt: new Date(event.createdAt) });
      }
    }
  } catch {
    // Live sharing still works if activity history is temporarily unavailable.
  }
}

function resetPairing(message) {
  state.outgoing.forEach((transfer) => {
    clearTimeout(transfer.timeout);
    transfer.resolve();
  });
  state.connected = false;
  state.code = null;
  state.expiresAt = null;
  state.historyLoadedFor = null;
  state.outgoing.clear();
  state.incoming.clear();
  forgetStoredPairing();
  ui.pairedBanner.hidden = true;
  ui.chooseFiles.disabled = true;
  ui.messageInput.disabled = true;
  ui.sendMessage.disabled = true;
  ui.pairCode.disabled = false;
  ui.joinRoom.disabled = false;
  ui.createCode.disabled = false;
  ui.codeDisplay.innerHTML = '<span class="code-placeholder">— — — — — —</span>';
  ui.phoneCaption.textContent = 'Make a 24-hour code on this phone';
  ui.codeHelp.textContent = 'Enter this code in the LinkDrop laptop extension.';
  ui.transferBody.setAttribute('aria-disabled', 'true');
  setRole(state.role);
  setConnection('Ready when you are', 'ready');
  if (message) showToast(message);
}

function showCode(code, expiresAt) {
  state.code = code;
  state.expiresAt = expiresAt;
  saveStoredPairing('phone', code, expiresAt);
  ui.codeDisplay.replaceChildren(...[...code].map((digit, index) => {
    const span = document.createElement('span');
    span.className = `code-digit ${index === 2 ? 'code-gap' : ''}`;
    span.textContent = digit;
    return span;
  }));
  ui.phoneCaption.textContent = 'Your pairing code is ready';
  ui.codeHelp.textContent = 'Enter it in the LinkDrop laptop extension. This pairing stays active for 24 hours.';
  ui.createCode.querySelector('span').textContent = 'Make a new code';
  ui.createCode.disabled = false;
  setConnection('Waiting for your laptop…', 'waiting');
}

function scheduleResume() {
  if (state.reconnectTimer || state.manualDisconnect) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    const saved = readStoredPairing();
    if (!saved) return;
    state.role = saved.role;
    state.code = saved.code;
    state.expiresAt = saved.expiresAt;
    state.pendingAction = { type: 'room:resume', role: saved.role, code: saved.code };
    connectSocket().catch(() => scheduleResume());
  }, 2000);
}

function restoreSavedPairing() {
  const saved = readStoredPairing();
  if (!saved) return false;
  state.role = saved.role;
  state.code = saved.code;
  state.expiresAt = saved.expiresAt;
  setRole(saved.role);
  if (saved.role === 'phone') showCode(saved.code, saved.expiresAt);
  else {
    ui.pairCode.value = saved.code;
    setConnection('Restoring your laptop pairing…', 'waiting');
  }
  scheduleResume();
  return true;
}

function handleServerMessage(event) {
  if (typeof event.data !== 'string') {
    queueIncomingChunk(event.data);
    return;
  }
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'room:created') { showCode(message.code, message.expiresAt); return; }
  if (message.type === 'room:waiting') {
    state.code = message.code;
    saveStoredPairing(state.role, message.code, state.expiresAt || Date.now() + 24 * 60 * 60 * 1000);
    setConnection('Waiting for your other device…', 'waiting');
    return;
  }
  if (message.type === 'room:connected') { updatePairUi(message); return; }
  if (message.type === 'room:peer-offline') {
    state.connected = false;
    ui.chooseFiles.disabled = true;
    ui.messageInput.disabled = true;
    ui.sendMessage.disabled = true;
    ui.transferBody.setAttribute('aria-disabled', 'true');
    ui.pairedDetail.textContent = message.message || 'Waiting for your other device to reconnect…';
    setConnection('Other device offline', 'waiting');
    return;
  }
  if (message.type === 'room:error') {
    if (/expired|resum/i.test(message.message || '')) forgetStoredPairing();
    showPairError(message.message);
    showToast(message.message);
    ui.joinRoom.disabled = false;
    ui.createCode.disabled = false;
    setConnection('Ready when you are', 'ready');
    return;
  }
  if (message.type === 'room:peer-left') { resetPairing(message.message); return; }
  if (message.type === 'room:closed') { resetPairing(message.message); return; }
  if (message.type === 'message:receive' || message.type === 'message:sent') {
    addActivity({ kind: 'message', text: message.text, sender: message.type === 'message:sent' ? 'You' : (message.sender === 'phone' ? 'Your phone' : 'Your laptop') });
    return;
  }
  if (message.type === 'file:offer') {
    const card = addActivity({ kind: 'file', name: message.name, size: message.size, status: 'Incoming', id: message.id, incoming: true });
    state.incoming.set(message.id, { ...message, card, mode: null, chunks: [], received: 0 });
    return;
  }
  if (message.type === 'file:accepted') {
    const transfer = state.outgoing.get(message.id);
    if (transfer?.resolveAcceptance) transfer.resolveAcceptance(true);
    return;
  }
  if (message.type === 'file:rejected') {
    const transfer = state.outgoing.get(message.id);
    if (transfer?.resolveAcceptance) transfer.resolveAcceptance(false);
    updateActivity(message.id, 'Declined');
    return;
  }
  if (message.type === 'file:end') {
    state.receiveQueue = (state.receiveQueue || Promise.resolve()).then(() => finishIncomingFile(message.id));
    return;
  }
  if (message.type === 'file:completed') {
    updateActivity(message.id, 'Sent', 100);
    state.outgoing.get(message.id)?.resolve();
    state.outgoing.delete(message.id);
    return;
  }
  if (message.type === 'file:cancelled') {
    updateActivity(message.id, 'Stopped');
    const transfer = state.outgoing.get(message.id);
    if (transfer?.resolveAcceptance) transfer.resolveAcceptance(false);
    transfer?.resolve();
    state.outgoing.delete(message.id);
    state.incoming.delete(message.id);
    if (message.message) showToast(message.message);
  }
}

async function createCode() {
  clearPairError();
  state.manualDisconnect = false;
  setRole('phone');
  ui.createCode.disabled = true;
  state.pendingAction = { type: 'room:create', role: 'phone' };
  try {
    const socket = await connectSocket();
    if (socket.readyState === WebSocket.OPEN && state.pendingAction) {
      const action = state.pendingAction;
      state.pendingAction = null;
      send(action);
    }
  } catch (error) {
    ui.createCode.disabled = false;
    showPairError(error.message);
  }
}

async function joinRoom() {
  clearPairError();
  state.manualDisconnect = false;
  setRole('laptop');
  const code = ui.pairCode.value.replace(/\D/g, '').slice(0, 6);
  ui.pairCode.value = code;
  if (code.length !== 6) { showPairError('Enter all six digits from your phone.'); ui.pairCode.focus(); return; }
  ui.joinRoom.disabled = true;
  saveStoredPairing('laptop', code, Date.now() + 24 * 60 * 60 * 1000);
  state.pendingAction = { type: 'room:join', role: 'laptop', code };
  try {
    const socket = await connectSocket();
    if (socket.readyState === WebSocket.OPEN && state.pendingAction) {
      const action = state.pendingAction;
      state.pendingAction = null;
      send(action);
    }
  } catch (error) {
    ui.joinRoom.disabled = false;
    showPairError(error.message);
  }
}

function leaveRoom() {
  state.manualDisconnect = true;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  send({ type: 'room:leave' });
  resetPairing('This pairing has ended.');
  ui.joinRoom.disabled = false;
  ui.pairCode.value = '';
}

function sendMessage(event) {
  event.preventDefault();
  const text = ui.messageInput.value.trim();
  if (!text || !state.connected) return;
  if (send({ type: 'message:send', text })) ui.messageInput.value = '';
}

function updateStatusLater(id, status, progress) {
  updateActivity(id, status, progress);
}

async function sendFiles(fileList) {
  const files = [...fileList];
  if (!files.length || !state.connected) return;
  for (const file of files) await offerFile(file);
  ui.fileInput.value = '';
}

function offerFile(file) {
  const id = createUuid();
  const card = addActivity({ kind: 'file', name: file.name, size: file.size, status: 'Waiting for approval', id });
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const transfer = state.outgoing.get(id);
      if (transfer?.resolveAcceptance) transfer.resolveAcceptance(false);
      updateStatusLater(id, 'No response');
    }, 3 * 60 * 1000);
    state.outgoing.set(id, { file, card, resolve, resolveAcceptance: null, timeout });
    const started = send({ type: 'file:start', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
    if (!started) { clearTimeout(timeout); state.outgoing.delete(id); resolve(); return; }
    const transfer = state.outgoing.get(id);
    transfer.resolveAcceptance = (accepted) => { clearTimeout(timeout); transfer.resolveAcceptance = null; void beginFileSend(id, accepted); };
  });
}

async function beginFileSend(id, accepted) {
  const transfer = state.outgoing.get(id);
  if (!transfer) return;
  if (!accepted) {
    updateActivity(id, 'Declined');
    state.outgoing.delete(id);
    transfer.resolve();
    return;
  }
  const { file } = transfer;
  updateActivity(id, 'Sending', 0);
  const chunkSize = 192 * 1024;
  const idBytes = new TextEncoder().encode(id);
  let lastProgress = -1;
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) throw new Error('Connection ended.');
      while (state.socket.bufferedAmount > 700_000) await new Promise((resolve) => setTimeout(resolve, 30));
      const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
      const frame = new Uint8Array(idBytes.length + chunk.length);
      frame.set(idBytes, 0);
      frame.set(chunk, idBytes.length);
      state.socket.send(frame.buffer);
      const progress = file.size ? Math.round(Math.min(offset + chunk.length, file.size) / file.size * 100) : 100;
      if (progress !== lastProgress) {
        updateActivity(id, 'Sending', progress);
        lastProgress = progress;
      }
    }
    send({ type: 'file:end', id });
    updateActivity(id, 'Sent to device · saving');
  } catch (error) {
    send({ type: 'file:cancel', id });
    updateActivity(id, 'Stopped');
    showToast(error.message || 'The file could not be sent.');
    state.outgoing.delete(id);
    transfer.resolve();
  }
}

function rejectFile(id) {
  send({ type: 'file:reject', id });
  updateActivity(id, 'Declined');
  state.incoming.delete(id);
}

async function acceptFile(id) {
  const incoming = state.incoming.get(id);
  if (!incoming) return;
  const maxMemoryFallback = 250 * 1024 * 1024;
  try {
    if (window.LinkDropAndroid?.beginSave) {
      incoming.mode = 'android';
      window.LinkDropAndroid.beginSave(id, incoming.name, incoming.mime || 'application/octet-stream');
      updateActivity(id, 'Choose a save location');
      return;
    }
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: incoming.name });
      incoming.writer = await handle.createWritable();
      incoming.mode = 'stream';
    } else {
      if (incoming.size > maxMemoryFallback) {
        showToast('This browser cannot safely save files over 250 MB. Open LinkDrop in Chrome or the Android app.');
        rejectFile(id);
        return;
      }
      incoming.mode = 'memory';
    }
    updateActivity(id, 'Receiving · 0%');
    send({ type: 'file:accept', id });
  } catch (error) {
    if (error.name === 'AbortError') { rejectFile(id); return; }
    showToast('Could not open a save location for this file.');
    rejectFile(id);
  }
}

window.LinkDropCallbacks = window.LinkDropCallbacks || {};
window.LinkDropCallbacks.saveReady = (id, success) => {
  const incoming = state.incoming.get(id);
  if (!incoming) return;
  if (!success) { rejectFile(id); showToast('Choose a save location to receive the file.'); return; }
  updateActivity(id, 'Receiving · 0%');
  send({ type: 'file:accept', id });
};

function queueIncomingChunk(raw) {
  state.receiveQueue = (state.receiveQueue || Promise.resolve()).then(() => writeIncomingChunk(raw)).catch((error) => {
    const frame = new Uint8Array(raw);
    const id = frame.length >= 36 ? new TextDecoder().decode(frame.slice(0, 36)) : '';
    if (id) {
      send({ type: 'file:cancel', id });
      updateActivity(id, 'Could not save');
      state.incoming.delete(id);
    }
    showToast(error.message || 'This device could not save the incoming file.');
  });
}

async function writeIncomingChunk(raw) {
  const frame = new Uint8Array(raw);
  if (frame.length < 36) return;
  const id = new TextDecoder().decode(frame.slice(0, 36));
  const incoming = state.incoming.get(id);
  if (!incoming) return;
  const payload = frame.slice(36);
  if (incoming.mode === 'stream') await incoming.writer.write(payload);
  else if (incoming.mode === 'android') {
    const base64 = bytesToBase64(payload);
    if (!window.LinkDropAndroid.writeChunk(id, base64)) throw new Error('The phone could not write this file.');
  } else incoming.chunks.push(payload);
  incoming.received += payload.byteLength;
  const percent = incoming.size ? Math.round(incoming.received / incoming.size * 100) : 100;
  updateActivity(id, `Receiving · ${percent}%`);
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(binary);
}

async function finishIncomingFile(id) {
  const incoming = state.incoming.get(id);
  if (!incoming) return;
  try {
    if (incoming.mode === 'stream') await incoming.writer.close();
    else if (incoming.mode === 'android' && !window.LinkDropAndroid.finishSave(id)) throw new Error('The phone could not finish saving this file.');
    else {
      const blob = new Blob(incoming.chunks, { type: incoming.mime || 'application/octet-stream' });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = incoming.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
    }
    updateActivity(id, 'Saved', 100);
    send({ type: 'file:completed', id });
    showToast(`${incoming.name} is ready on this device.`);
  } catch {
    send({ type: 'file:cancel', id });
    updateActivity(id, 'Could not save');
    showToast('The file could not be saved on this device.');
  } finally {
    state.incoming.delete(id);
  }
}

function setupEvents() {
  ui.phoneTab.addEventListener('click', () => setRole('phone'));
  ui.laptopTab.addEventListener('click', () => setRole('laptop'));
  ui.createCode.addEventListener('click', createCode);
  ui.joinRoom.addEventListener('click', joinRoom);
  ui.pairCode.addEventListener('input', () => { ui.pairCode.value = ui.pairCode.value.replace(/\D/g, '').slice(0, 6); clearPairError(); });
  ui.pairCode.addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
  ui.disconnect.addEventListener('click', leaveRoom);
  ui.messageForm.addEventListener('submit', sendMessage);
  ui.chooseFiles.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => void sendFiles(ui.fileInput.files));
  ui.dropHint.addEventListener('dragover', (event) => { if (state.connected) { event.preventDefault(); ui.dropHint.classList.add('dragover'); } });
  ui.dropHint.addEventListener('dragleave', () => ui.dropHint.classList.remove('dragover'));
  ui.dropHint.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropHint.classList.remove('dragover');
    if (state.connected) void sendFiles(event.dataTransfer.files);
  });
  window.addEventListener('online', () => { setConnection('Ready when you are', 'ready'); void connectSocket().catch(() => {}); });
  window.addEventListener('offline', () => setConnection('You’re offline', 'offline'));
}

setupEvents();
setRole(state.role);
updateCount();
void connectSocket().catch(() => {});

const joinFromExtension = new URLSearchParams(window.location.hash.slice(1)).get('join');
const showQrFromExtension = new URLSearchParams(window.location.hash.slice(1)).get('qr');
if (showQrFromExtension) {
  setRole('laptop');
  window.history.replaceState(null, '', window.location.pathname);
} else if (joinFromExtension) {
  setRole('laptop');
  ui.pairCode.value = joinFromExtension.replace(/\D/g, '').slice(0, 6);
  window.history.replaceState(null, '', window.location.pathname);
  connectSocket().then(() => joinRoom()).catch((error) => showPairError(error.message));
} else restoreSavedPairing();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
