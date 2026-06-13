'use strict';

(function () {
  const ds = window.dsAgent;
  if (!ds || !ds.prompt) {
    document.body.innerText = 'preload bridge missing';
    return;
  }

  if (ds.platform) {
    document.body.classList.add('platform-' + ds.platform);
  }

  const editor = document.getElementById('editor');
  const info = document.getElementById('info');
  const badge = document.getElementById('status-badge');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');
  const btnCancel = document.getElementById('btn-cancel');

  let initialValue = '';
  let isCustom = false;

  function setBadge(custom) {
    isCustom = !!custom;
    badge.textContent = isCustom ? '使用自定义' : '使用默认';
    badge.classList.toggle('default', !isCustom);
  }

  function setInfo(text) { info.textContent = text || ''; }

  async function refreshFromMain() {
    const [current, custom] = await Promise.all([
      ds.prompt.getCurrent(),
      ds.prompt.isCustom(),
    ]);
    initialValue = current || '';
    editor.value = initialValue;
    setBadge(custom);
    setInfo('字符数：' + initialValue.length);
  }

  editor.addEventListener('input', () => {
    setInfo('字符数：' + editor.value.length + (editor.value === initialValue ? '' : '（未保存）'));
  });

  // Ctrl/Cmd+S to save without leaving the field.
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      btnSave.click();
    }
  });

  btnSave.addEventListener('click', async () => {
    btnSave.disabled = true;
    try {
      await ds.prompt.set(editor.value);
      await refreshFromMain();
      setInfo('已保存。下一次请求即生效。');
    } catch (e) {
      setInfo('保存失败：' + (e && e.message || e));
    } finally {
      btnSave.disabled = false;
    }
  });

  btnReset.addEventListener('click', async () => {
    if (!confirm('重置为内置默认提示词？当前自定义内容将被丢弃。')) return;
    btnReset.disabled = true;
    try {
      await ds.prompt.reset();
      await refreshFromMain();
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
