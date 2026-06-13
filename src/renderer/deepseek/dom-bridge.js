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
