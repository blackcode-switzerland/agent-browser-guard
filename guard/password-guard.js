// Runs in every page and frame of an AGENT session, before the page's own scripts.
// Secret fields (passwords, one-time codes) take no input at all in these sessions: the human signs in
// in a separate window that does not load this script. Agents have no tool that runs script in the page,
// so they cannot switch this off.
(() => {
  if (window.__agentSecretGuard) return;
  Object.defineProperty(window, '__agentSecretGuard', { value: true });
  const secretAutocomplete = /current-password|new-password|one-time-code|cc-csc/i;
  const isSecret = el => el instanceof HTMLInputElement &&
    (el.type === 'password' || secretAutocomplete.test(el.getAttribute('autocomplete') || '') || el.dataset.agentSecret === '1');
  const lock = el => {
    if (!isSecret(el)) return;
    el.dataset.agentSecret = '1';          // a field that was a password field stays locked if a page flips its type to "text"
    el.readOnly = true;
    el.title = 'Typed by the person, not by an agent';
  };
  const sweep = root => { if (root.querySelectorAll) root.querySelectorAll('input').forEach(lock); };
  const stop = event => {
    const el = event.target;
    if (!isSecret(el)) return;
    lock(el);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'drop', 'compositionstart'])
    window.addEventListener(type, stop, true);
  window.addEventListener('focusin', event => lock(event.target), true);
  const watch = () => {
    sweep(document);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') lock(record.target);
        record.addedNodes && record.addedNodes.forEach(node => { if (node.nodeType === 1) { lock(node); sweep(node); } });
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'autocomplete', 'readonly'] });
  };
  if (document.documentElement) watch(); else document.addEventListener('readystatechange', watch, { once: true });
})();
