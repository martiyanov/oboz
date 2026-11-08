// Форма обратной связи на странице «Как считается рейтинг».
// Защита: honeypot + время заполнения (проверяется и на сервере), лимиты на сервере.
(() => {
  'use strict';

  const form = document.getElementById('feedback-form');
  if (!form) return;

  const message = document.getElementById('feedback-message');
  const contact = document.getElementById('feedback-contact');
  const website = document.getElementById('feedback-website');
  const submit = document.getElementById('feedback-submit');
  const status = document.getElementById('feedback-status');

  // Время открытия формы: слишком быстрая отправка отбрасывается сервером.
  const startedAt = Date.now();
  form.dataset.startedAt = String(startedAt);

  function setStatus(text, isError) {
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(isError));
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Отправляю…' : 'Отправить';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    const text = String(message.value || '').trim();
    if (text.length < 10) {
      setStatus('Сообщение слишком короткое — минимум 10 символов.', true);
      message.focus();
      return;
    }
    if (text.length > 2000) {
      setStatus('Сообщение слишком длинное — максимум 2000 символов.', true);
      message.focus();
      return;
    }

    setBusy(true);
    setStatus('');

    try {
      const response = await fetch('api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          message: text,
          contact: String(contact.value || '').trim(),
          website: String(website.value || ''),
          startedAt: Number(form.dataset.startedAt || startedAt),
        }),
      });

      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const reason = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      form.reset();
      form.dataset.startedAt = String(Date.now());
      setStatus('Спасибо! Сообщение сохранено — оно помогает улучшить рейтинг.', false);
    } catch (error) {
      setStatus(`Не удалось отправить: ${error.message || 'ошибка сети'}. Попробуйте ещё раз.`, true);
    } finally {
      setBusy(false);
    }
  });
})();
