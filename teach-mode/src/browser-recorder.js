(() => {
  if (window !== window.top || window.__memmyTeach) return;
  let picking = false, enabled = true, timer, pending, scrollTimer;
  const selector = element => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id)); break;
      }
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const heading = element => {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      for (let previous = node.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (/^H[1-6]$/.test(previous.tagName)) return previous.innerText.trim().slice(0, 240);
      }
    }
    return '';
  };
  const locator = element => ({selector: selector(element), tag: element.tagName.toLowerCase(),
    name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || '').trim().slice(0, 240), heading: heading(element)});
  const send = async (type, element, value) => {
    if (!enabled) return;
    try { await window.__memmyTeachSend({type, url: location.href, locator: element ? locator(element) : null,
      ...(value === undefined ? {} : {value})}); } catch { /* The host seals the segment before disconnecting. */ }
  };
  const flush = async () => {
    clearTimeout(timer);
    const element = pending; pending = null;
    if (element) await send('fill', element, element.isContentEditable ? element.innerText : element.value);
  };
  document.addEventListener('click', event => {
    if (!enabled || !(event.target instanceof Element)) return;
    if (picking) {
      event.preventDefault(); event.stopImmediatePropagation(); picking = false;
      document.documentElement.style.removeProperty('cursor');
      const output = event.target.closest('li,article,p,td,pre,blockquote') || event.target;
      if (output.closest('input,textarea,[contenteditable="true"]')) { void send('unsupported', null, 'editable_output_refused'); return; }
      void flush().then(() => send('output', output)); return;
    }
    const element = event.target.closest('a,button,input,textarea,select,[role="button"],[contenteditable="true"]') || event.target;
    if (element instanceof HTMLInputElement && ['password', 'file'].includes(element.type)) return;
    void flush().then(() => send('click', element));
  }, true);
  document.addEventListener('input', event => {
    if (!enabled || !(event.target instanceof Element)) return;
    const element = event.target;
    if (element instanceof HTMLInputElement && ['password', 'file'].includes(element.type)) {
      void send('unsupported', null, 'secret_or_file_input_withheld'); return;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return;
    if (pending && pending !== element) void flush();
    pending = element; clearTimeout(timer); timer = setTimeout(() => void flush(), 180);
  }, true);
  document.addEventListener('keydown', event => {
    if (!enabled) return;
    if (picking && event.key === 'Escape') { picking = false; document.documentElement.style.removeProperty('cursor'); return; }
    if (!(event.target instanceof Element) || !['Enter', 'Tab'].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && event.target.type === 'password') return;
    void flush().then(() => send('press', event.target, (event.ctrlKey ? 'Control+' : '') + (event.shiftKey ? 'Shift+' : '') + event.key));
  }, true);
  document.addEventListener('scroll', () => {
    if (!enabled) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => void send('scroll', null, Math.round(scrollX) + ',' + Math.round(scrollY)), 150);
  }, true);
  window.__memmyTeach = {
    pick: () => { picking = true; document.documentElement.style.cursor = 'crosshair'; },
    flush,
    disable: async () => { clearTimeout(scrollTimer); await flush(); enabled = false; picking = false; document.documentElement.style.removeProperty('cursor'); },
    heading,
  };
})();
