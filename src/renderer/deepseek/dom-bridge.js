/**
 * DeepSeek DOM Bridge
 *
 * Injected into the MAIN WORLD by preload.
 * Provides DOM manipulation helpers for interacting with the DeepSeek chat page.
 * All functions are pure DOM utilities with no business logic.
 */

(function () {
  'use strict';

  var dom = {

    /**
     * Find the chat input element on the DeepSeek page.
     * Tries textarea first, then contenteditable elements.
     * @returns {HTMLElement|null}
     */
    findInputElement: function () {
      // Try visible textareas first
      var textareas = document.querySelectorAll('textarea');
      for (var i = 0; i < textareas.length; i++) {
        if (dom.isVisible(textareas[i])) return textareas[i];
      }
      // Try contenteditable with placeholder
      var editables = document.querySelectorAll('[contenteditable="true"]');
      for (var j = 0; j < editables.length; j++) {
        if (dom.isVisible(editables[j]) && editables[j].getAttribute('placeholder')) return editables[j];
      }
      // Try any visible contenteditable
      for (var k = 0; k < editables.length; k++) {
        if (dom.isVisible(editables[k])) return editables[k];
      }
      return null;
    },

    /**
     * Find the send button on the DeepSeek page.
     * @returns {HTMLElement|null}
     */
    findSendButton: function () {
      var selectors = [
        'button[aria-label*="send"]', 'button[aria-label*="Send"]',
        'button[aria-label*="发送"]', 'button[aria-label*="Submit"]',
        'button[type="submit"]',
      ];
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn && dom.isVisible(btn)) return btn;
      }
      return null;
    },

    /**
     * Check if an element is visible in the DOM.
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    isVisible: function (el) {
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    },

    /**
     * Check whether an element is DeepSeek's "stopped" status indicator.
     * This intentionally avoids scanning arbitrary assistant text: a real
     * status indicator is a short standalone node with icon/SVG siblings.
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    isStoppedIndicator: function (el) {
      if (!el || !el.isConnected || !dom.isVisible(el)) return false;

      var text = (el.textContent || '').trim();
      if (!/^已停止(?:生成)?$/.test(text)) return false;

      // User/model content should never count as a UI status.
      if (el.closest && el.closest('pre, code, textarea, [contenteditable="true"]')) {
        return false;
      }

      var parent = el.parentElement;
      if (!parent || !dom.isVisible(parent)) return false;

      var parentText = (parent.textContent || '').trim();
      if (!/^已停止(?:生成)?$/.test(parentText)) return false;

      // The observed DeepSeek status control wraps the label with icon SVGs.
      if (parent.querySelectorAll('svg').length < 1 &&
          parent.querySelectorAll('.ds-icon').length < 1) {
        return false;
      }

      return true;
    },

    /**
     * Return all currently visible stopped indicators. Callers compare the
     * count against a baseline captured before sending a message so old
     * stopped turns do not poison later requests.
     * @returns {HTMLElement[]}
     */
    findStoppedIndicators: function () {
      var nodes = document.querySelectorAll('span, div, button');
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        if (dom.isStoppedIndicator(nodes[i])) out.push(nodes[i]);
      }
      return out;
    },

    getStoppedIndicatorCount: function () {
      return dom.findStoppedIndicators().length;
    },

    hasNewStoppedIndicator: function (baseline) {
      var current = dom.findStoppedIndicators();
      if (Array.isArray(baseline)) {
        for (var i = 0; i < current.length; i++) {
          if (baseline.indexOf(current[i]) === -1) return true;
        }
        return false;
      }
      var baselineCount = Number.isFinite(baseline) ? baseline : 0;
      return current.length > baselineCount;
    },

    /**
     * Set the value of an input element and trigger React/Vue change events.
     * Handles both <textarea> and contenteditable elements.
     * @param {HTMLElement} element
     * @param {string} value
     */
    setInputValue: function (element, value) {
      var isCE = element.contentEditable === 'true';

      if (isCE) {
        element.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(element);
        sel.removeAllRanges();
        sel.addRange(range);

        try { document.execCommand('insertText', false, value); }
        catch (e) { element.textContent = value; }

        range.selectNodeContents(element);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(element, value);
        } else {
          element.value = value;
        }
      }

      element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },

    /**
     * Promise-based sleep.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    sleep: function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },

  };

  window.__dsAgentDOM = dom;
  console.log('[DS Agent] DOM bridge loaded');
})();
