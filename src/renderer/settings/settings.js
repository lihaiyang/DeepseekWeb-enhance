'use strict';

(function () {
  const ds = window.dsAgent;
  if (!ds || !ds.settings || !ds.settings.retry) {
    document.body.innerText = 'preload bridge missing';
    return;
  }

  if (ds.platform) {
    document.body.classList.add('platform-' + ds.platform);
  }

  const badge = document.getElementById('status-badge');
  const info = document.getElementById('info');
  const retryEnabled = document.getElementById('retry-enabled');
  const maxRetries = document.getElementById('max-retries');
  const delayMs = document.getElementById('delay-ms');
  const retryPrompt = document.getElementById('retry-prompt');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');
  const btnCancel = document.getElementById('btn-cancel');

  let defaultConfig = { maxRetries: 1, delayMs: 800, prompt: '继续' };
  let initialSignature = '';
  let isCustom = false;

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function normalizeConfig(cfg) {
    const source = cfg || {};
    return {
      maxRetries: clampInt(source.maxRetries, defaultConfig.maxRetries, 0, 5),
      delayMs: clampInt(source.delayMs, defaultConfig.delayMs, 0, 10000),
      prompt: (typeof source.prompt === 'string' && source.prompt.trim())
        ? source.prompt.trim()
        : defaultConfig.prompt,
    };
  }

  function formConfig() {
    const enabled = retryEnabled.checked;
    return normalizeConfig({
      maxRetries: enabled ? maxRetries.value : 0,
      delayMs: delayMs.value,
      prompt: retryPrompt.value,
    });
  }

  function signature(cfg) {
    const normalized = normalizeConfig(cfg);
    return JSON.stringify(normalized);
  }

  function setBadge(custom) {
    isCustom = !!custom;
    badge.textContent = isCustom ? '使用自定义' : '使用默认';
    badge.classList.toggle('default', !isCustom);
  }

  function setInfo(text) {
    info.textContent = text || '';
  }

  function syncEnabledState() {
    maxRetries.disabled = !retryEnabled.checked;
    if (retryEnabled.checked && clampInt(maxRetries.value, 1, 1, 5) < 1) {
      maxRetries.value = '1';
    }
  }

  function setDirtyInfo() {
    const dirty = signature(formConfig()) !== initialSignature;
    const cfg = formConfig();
    const state = cfg.maxRetries > 0
      ? '已启用，最多重试 ' + cfg.maxRetries + ' 次'
      : '已关闭自动重试';
    setInfo(state + '。' + (dirty ? '（未保存）' : ''));
  }

  function applyConfig(cfg) {
    const normalized = normalizeConfig(cfg);
    retryEnabled.checked = normalized.maxRetries > 0;
    maxRetries.value = String(normalized.maxRetries > 0 ? normalized.maxRetries : Math.max(1, defaultConfig.maxRetries));
    delayMs.value = String(normalized.delayMs);
    retryPrompt.value = normalized.prompt;
    syncEnabledState();
  }

  async function refreshFromMain(message) {
    const [defaults, current, custom] = await Promise.all([
      ds.settings.retry.getDefault(),
      ds.settings.retry.get(),
      ds.settings.retry.isCustom(),
    ]);
    defaultConfig = normalizeConfig(defaults);
    applyConfig(current);
    initialSignature = signature(formConfig());
    setBadge(custom);
    setInfo(message || (formConfig().maxRetries > 0
      ? '已启用，最多重试 ' + formConfig().maxRetries + ' 次。'
      : '已关闭自动重试。'));
  }

  [retryEnabled, maxRetries, delayMs, retryPrompt].forEach((el) => {
    el.addEventListener('input', () => {
      syncEnabledState();
      setDirtyInfo();
    });
    el.addEventListener('change', () => {
      syncEnabledState();
      setDirtyInfo();
    });
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      btnSave.click();
    }
  });

  btnSave.addEventListener('click', async () => {
    btnSave.disabled = true;
    try {
      const saved = await ds.settings.retry.set(formConfig());
      applyConfig(saved);
      initialSignature = signature(formConfig());
      setBadge(true);
      setDirtyInfo();
      setInfo('已保存。下一次请求即生效。');
    } catch (e) {
      setInfo('保存失败：' + (e && e.message || e));
    } finally {
      btnSave.disabled = false;
    }
  });

  btnReset.addEventListener('click', async () => {
    if (!confirm('重置为内置默认设置？当前自定义设置将被丢弃。')) return;
    btnReset.disabled = true;
    try {
      const reset = await ds.settings.retry.reset();
      applyConfig(reset);
      initialSignature = signature(formConfig());
      setBadge(false);
      setInfo('已重置为内置默认。');
    } catch (e) {
      setInfo('重置失败：' + (e && e.message || e));
    } finally {
      btnReset.disabled = false;
    }
  });

  btnCancel.addEventListener('click', () => ds.window.close());

  refreshFromMain().catch((e) => setInfo('加载失败：' + (e && e.message || e)));
})();
