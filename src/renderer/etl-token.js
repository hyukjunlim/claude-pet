'use strict';

// The eTL token window's page. The token goes straight from the field to the main process and
// is never shown or kept here; the field is cleared once it has been accepted.

(() => {
  const form = document.getElementById('form');
  const input = document.getElementById('token');
  const status = document.getElementById('status');
  const ok = document.getElementById('ok');
  const cancel = document.getElementById('cancel');
  const guide = document.getElementById('guide');
  let busy = false;

  function show(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }

  function setBusy(on) {
    busy = on;
    ok.disabled = on;
    input.readOnly = on;
  }

  guide.addEventListener('click', (e) => {
    e.preventDefault();
    window.etlToken.openGuide();
  });

  cancel.addEventListener('click', () => window.etlToken.close());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.etlToken.close();
  });

  input.addEventListener('input', () => {
    if (!busy && status.className === 'error') show('', '');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!input.value.trim()) {
      show('토큰을 입력해 주세요.', 'error');
      input.focus();
      return;
    }
    setBusy(true);
    show('eTL에서 토큰을 확인하는 중…', 'pending');
    let reply;
    try {
      reply = await window.etlToken.submit(input.value);
    } catch {
      reply = { ok: false, error: '토큰을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    if (reply && reply.ok) {
      input.value = '';
      show(reply.user ? `${reply.user} 님으로 확인해 저장했습니다.` : '확인해 저장했습니다.', 'success');
      cancel.disabled = true;
      return;                               // the window closes itself shortly
    }
    setBusy(false);
    show((reply && reply.error) || '토큰을 확인하지 못했습니다.', 'error');
    input.focus();
    input.select();
  });

  input.focus();
})();
