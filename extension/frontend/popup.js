import { buildJoinUrl, normalizeServiceUrl } from '../backend/app-api.js';

const form = document.getElementById('connect-form');
const codeInput = document.getElementById('code');
const addressInput = document.getElementById('app-url');
const status = document.getElementById('status');
const showQrButton = document.getElementById('show-qr');
let appUrl = 'http://localhost:3000';

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

chrome.storage.local.get({ appUrl }, (values) => {
  if (values.appUrl) appUrl = values.appUrl;
  addressInput.value = appUrl;
});

showQrButton.addEventListener('click', () => {
  try {
    chrome.tabs.create({ url: `${normalizeServiceUrl(appUrl)}/#qr=1` });
    setStatus('Opening your LinkDrop QR code…');
    window.close();
  } catch (error) {
    setStatus(error.message || 'Save a valid sharing service address first.', true);
  }
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  setStatus('Your phone’s code works for 24 hours.');
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setStatus('Enter all six digits from the phone app.', true);
    codeInput.focus();
    return;
  }
  chrome.tabs.create({ url: buildJoinUrl(appUrl, code) });
  setStatus('Opening LinkDrop and joining your phone…');
  window.close();
});

document.getElementById('save-url').addEventListener('click', () => {
  try {
    const normalized = normalizeServiceUrl(addressInput.value);
    chrome.storage.local.set({ appUrl: normalized }, () => {
      appUrl = normalized;
      addressInput.value = normalized;
      setStatus('Address saved for this extension.');
    });
  } catch (error) {
    setStatus(error.message || 'Enter a valid service address.', true);
  }
});
