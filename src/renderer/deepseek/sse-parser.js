/**
 * DeepSeek SSE Protocol Parser
 *
 * Injected early into the MAIN WORLD by preload, before network hooks.
 * Parses DeepSeek's SSE stream format and fires callbacks registered
 * by the DeepSeekAdapter.
 *
 * DeepSeek SSE format has two modes:
 *   (a) Legacy: {choices:[{delta:{content,reasoning_content}}], thinking:"..."}
 *   (b) Fragments: {v:"...", p:"response/fragments/-1/content"} with snapshots
 */

(function () {
  'use strict';

  // Guard against double-injection (e.g. from MutationObserver fallback).
  // If already loaded, don't reset __dsAgentSSECallbacks — the adapter's
  // registered callbacks would be lost.
  if (window.__dsAgentSSEParserLoaded) return;
  window.__dsAgentSSEParserLoaded = true;

  // ─── Callback Registry ──────────────────────────────────────
  // DeepSeekAdapter registers itself here when created.
  window.__dsAgentSSECallbacks = {
    onThinking: null,
    onContent: null,
    onEnd: null,
    onError: null,
  };

  // ─── Process a single SSE line ──────────────────────────────

  window.__dsAgentProcessLine = function (line, thinkingAcc, responseAcc, pTracker) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('data:') === -1) return;
    var jsonStr = trimmed.slice(trimmed.indexOf('data:') + 5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;
    try {
      var obj = JSON.parse(jsonStr);
      // Track p-values for debugging
      if (obj.p !== undefined && pTracker) { pTracker[obj.p] = (pTracker[obj.p] || 0) + 1; }
      // Legacy thinking field
      if (typeof obj.thinking === 'string' && obj.thinking.length > 0) { thinkingAcc.val += obj.thinking; }
      // New-style thinking type
      if (obj.type === 'thinking' && typeof obj.content === 'string' && obj.content.length > 0) { thinkingAcc.val += obj.content; }
      // Legacy choices format
      if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
        var d = obj.choices[0].delta;
        if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) { thinkingAcc.val += d.reasoning_content; }
        if (typeof d.content === 'string' && d.content.length > 0) { responseAcc.val += d.content; }
      }
      // Fragment-based incremental updates
      if (typeof obj.v === 'string' && obj.v.length > 0) {
        var p = (obj.p || '').toLowerCase();
        if (p.indexOf('status') !== -1) return;
        if (p.indexOf('think') !== -1 || p.indexOf('reason') !== -1) {
          thinkingAcc.val += obj.v;
        } else if (p === 'response/fragments/-1/content' || p === '' || p === 'response/fragments/-1') {
          var fragType = (pTracker && pTracker._currentFragType) || 'THINK';
          if (fragType === 'RESPONSE') { responseAcc.val += obj.v; }
          else { thinkingAcc.val += obj.v; }
        } else {
          responseAcc.val += obj.v;
        }
      }
      // Snapshot frames (fragment type switch)
      if (obj.v !== null && typeof obj.v === 'object') {
        var frags = null;
        if (Array.isArray(obj.v)) {
          frags = obj.v;
        } else if (obj.v.response && Array.isArray(obj.v.response.fragments)) {
          frags = obj.v.response.fragments;
        }
        if (frags && frags.length > 0) {
          var snapText = '';
          var snapThink = '';
          for (var fi = 0; fi < frags.length; fi++) {
            if (typeof frags[fi].content !== 'string') continue;
            if (frags[fi].type === 'RESPONSE') { snapText += frags[fi].content; }
            else if (frags[fi].type === 'THINK') { snapThink += frags[fi].content; }
          }
          var lastFrag = frags[frags.length - 1];
          if (pTracker) {
            pTracker._currentFragType = lastFrag.type;
            if (snapThink && snapThink !== thinkingAcc.val) { pTracker._resetThinkingLen = 0; }
            if (snapText && snapText !== responseAcc.val) { pTracker._resetResponseLen = 0; }
          }
          if (snapThink) { thinkingAcc.val = snapThink; }
          if (snapText) { responseAcc.val = snapText; }
        }
      }
    } catch (e) { /* ignore malformed JSON */ }
  };

  // ─── Fire callbacks with accumulated deltas ─────────────────

  window.__dsAgentFireCallbacks = function (thinkingAcc, responseAcc, isFinal, lastThinkingLen, lastResponseLen, pTracker) {
    lastThinkingLen = lastThinkingLen || 0;
    lastResponseLen = lastResponseLen || 0;
    // Honour snapshot reset signals
    if (pTracker) {
      if (pTracker._resetThinkingLen !== undefined) { lastThinkingLen = pTracker._resetThinkingLen; delete pTracker._resetThinkingLen; }
      if (pTracker._resetResponseLen !== undefined) { lastResponseLen = pTracker._resetResponseLen; delete pTracker._resetResponseLen; }
    }
    var thinkingDelta = thinkingAcc.val.substring(lastThinkingLen);
    var responseDelta = responseAcc.val.substring(lastResponseLen);

    var cb = window.__dsAgentSSECallbacks;
    if (!cb) {
      console.error('[DS Agent] __dsAgentSSECallbacks is undefined — SSE parser may not be loaded');
      return { thinkingLen: thinkingAcc.val.length, responseLen: responseAcc.val.length };
    }
    if (thinkingDelta && typeof cb.onThinking === 'function') { cb.onThinking(thinkingDelta); }
    if (responseDelta && typeof cb.onContent === 'function') { cb.onContent(responseDelta); }

    // Always fire onEnd when stream completes, even if response is empty.
    // (DeepSeek may respond with only thinking content and no visible text.)
    if (isFinal) {
      if (responseAcc.val) {
        window.__dsAgentFinalResponse = responseAcc.val;
      }
      if (typeof cb.onEnd === 'function') { cb.onEnd(responseAcc.val); }
    }

    return { thinkingLen: thinkingAcc.val.length, responseLen: responseAcc.val.length };
  };

  console.log('[DS Agent] SSE parser loaded');
})();
