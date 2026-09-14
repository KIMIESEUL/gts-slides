(function() {
  'use strict';

  const selectedEls = new Set();
  let editingEl = null;
  let isDirty = false;
  let dragState = null;
  let editorPopup = null;
  let docked = true;
  let dockFrame = null;
  const DOCK_WIDTH = 340;

  // ── Undo / Redo ──
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 50;
  let lastUndoPush = 0;

  function getCurrentSlideSnapshot() {
    const idx = Reveal.getIndices();
    const sections = document.querySelectorAll('.reveal .slides > section');
    return { slideIndex: idx.h, html: sections[idx.h] ? sections[idx.h].innerHTML : '' };
  }

  function pushUndo(force) {
    const now = Date.now();
    if (!force && now - lastUndoPush < 300) return;
    lastUndoPush = now;
    undoStack.push(getCurrentSlideSnapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    sendToPopup({ type: 'undoState', canUndo: true, canRedo: false });
  }

  function doUndo() {
    if (undoStack.length === 0) { showToast('실행 취소 없음'); return; }
    if (editingEl) stopEditing();
    clearSelection();
    redoStack.push(getCurrentSlideSnapshot());
    const prev = undoStack.pop();
    const sections = document.querySelectorAll('.reveal .slides > section');
    if (sections[prev.slideIndex]) {
      if (Reveal.getIndices().h !== prev.slideIndex) Reveal.slide(prev.slideIndex);
      sections[prev.slideIndex].innerHTML = prev.html;
    }
    notifySelection();
    isDirty = true;
    sendToPopup({ type: 'undoState', canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
    showToast('실행 취소');
  }

  function doRedo() {
    if (redoStack.length === 0) { showToast('다시 실행 없음'); return; }
    if (editingEl) stopEditing();
    clearSelection();
    undoStack.push(getCurrentSlideSnapshot());
    const next = redoStack.pop();
    const sections = document.querySelectorAll('.reveal .slides > section');
    if (sections[next.slideIndex]) {
      if (Reveal.getIndices().h !== next.slideIndex) Reveal.slide(next.slideIndex);
      sections[next.slideIndex].innerHTML = next.html;
    }
    notifySelection();
    isDirty = true;
    sendToPopup({ type: 'undoState', canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
    showToast('다시 실행');
  }

  // ── Clipboard ──
  let clipboardData = [];

  function doCopy() {
    if (selectedEls.size === 0) { showToast('선택된 요소 없음'); return; }
    clipboardData = [...selectedEls].map(el => el.outerHTML);
    showToast(clipboardData.length + '개 복사됨');
  }

  function doPaste() {
    if (clipboardData.length === 0) { showToast('붙여넣을 항목 없음'); return; }
    pushUndo(true);
    const currentSlide = Reveal.getCurrentSlide();
    if (!currentSlide) return;
    clearSelection();
    clipboardData.forEach(html => {
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const clone = temp.firstElementChild;
      if (clone) {
        clone.classList.remove('le-selected', 'le-editing', 'le-editable-hover', 'le-dragging');
        clone.removeAttribute('contenteditable');
        const left = parseFloat(clone.style.left) || 0;
        const top = parseFloat(clone.style.top) || 0;
        clone.style.left = (left + 20) + 'px';
        clone.style.top = (top + 20) + 'px';
        if (!clone.style.position || clone.style.position === 'static') clone.style.position = 'relative';
        currentSlide.appendChild(clone);
        addToSelection(clone);
      }
    });
    notifySelection();
    isDirty = true;
    showToast(clipboardData.length + '개 붙여넣기');
  }

  // ── Selection Frame (handles + size label) ──
  let selFrame = null;
  let resizeState = null;

  function createSelFrame() {
    const f = document.createElement('div');
    f.id = 'le-sel-frame';
    f.style.cssText = 'position:fixed;pointer-events:none;z-index:99996;display:none;box-shadow:0 0 0 1.5px #a855f7;';
    var dirs = ['nw','n','ne','e','se','s','sw','w'];
    var curs = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',e:'e-resize',se:'se-resize',s:'s-resize',sw:'sw-resize',w:'w-resize'};
    dirs.forEach(function(d) {
      var h = document.createElement('div');
      h.setAttribute('data-resize', d);
      h.style.cssText = 'position:absolute;width:8px;height:8px;background:#fff;border:1.5px solid #a855f7;pointer-events:auto;cursor:'+curs[d]+';box-sizing:border-box;border-radius:1px;';
      f.appendChild(h);
    });
    var lbl = document.createElement('div');
    lbl.id = 'le-sel-size';
    lbl.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:-22px;background:#a855f7;color:#fff;font-size:10px;font-weight:600;padding:1px 8px;border-radius:3px;white-space:nowrap;pointer-events:none;font-family:system-ui,sans-serif;line-height:16px;';
    f.appendChild(lbl);
    f.addEventListener('mousedown', function(e) {
      var handle = e.target.closest('[data-resize]');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      var el = selectedEls.size === 1 ? [...selectedEls][0] : null;
      if (!el) return;
      pushUndo(true);
      var scale = Reveal.getScale ? Reveal.getScale() : 1;
      var cs = getComputedStyle(el);
      resizeState = {
        el: el, dir: handle.getAttribute('data-resize'), scale: scale,
        startX: e.clientX, startY: e.clientY,
        origW: parseFloat(cs.width) || el.getBoundingClientRect().width / scale,
        origH: parseFloat(cs.height) || el.getBoundingClientRect().height / scale,
        origL: parseFloat(cs.left) || 0, origT: parseFloat(cs.top) || 0,
      };
    });
    document.body.appendChild(f);
    return f;
  }

  function showSelectionFrame() {
    if (selectedEls.size !== 1) { hideSelectionFrame(); return; }
    if (!selFrame) selFrame = createSelFrame();
    selFrame.style.display = '';
    updateSelectionFrame();
  }

  function updateSelectionFrame() {
    if (!selFrame || selectedEls.size !== 1) return;
    var el = [...selectedEls][0];
    var rect = el.getBoundingClientRect();
    var scale = Reveal.getScale ? Reveal.getScale() : 1;
    selFrame.style.left = rect.left + 'px';
    selFrame.style.top = rect.top + 'px';
    selFrame.style.width = rect.width + 'px';
    selFrame.style.height = rect.height + 'px';
    var w = rect.width, h = rect.height;
    selFrame.querySelectorAll('[data-resize]').forEach(function(hd) {
      var p = hd.getAttribute('data-resize');
      var sx = -4, sy = -4;
      if (p.includes('e')) sx = w - 4; else if (!p.includes('w')) sx = w / 2 - 4;
      if (p.includes('s')) sy = h - 4; else if (!p.includes('n')) sy = h / 2 - 4;
      hd.style.left = sx + 'px'; hd.style.top = sy + 'px';
    });
    var lbl = document.getElementById('le-sel-size');
    if (lbl) lbl.textContent = Math.round(w / scale) + ' × ' + Math.round(h / scale);
  }

  function hideSelectionFrame() {
    if (selFrame) selFrame.style.display = 'none';
  }

  // ── Toast ──
  const toast = document.createElement('div');
  toast.className = 'le-toast';
  document.body.appendChild(toast);
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.left = getSlideCenter() + 'px';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
    sendToPopup({ type: 'toast', msg });
  }

  // ── Dock / Popup ──
  function openDocked() {
    docked = true;
    var oldSidebar = document.getElementById('le-dock-sidebar');
    if (oldSidebar) oldSidebar.remove();

    // body padding으로 .reveal의 width:100%가 자연스럽게 줄어듦
    document.body.style.setProperty('padding-right', DOCK_WIDTH + 'px', 'important');

    var sidebar = document.createElement('div');
    sidebar.id = 'le-dock-sidebar';
    sidebar.style.cssText = 'position:fixed;right:0;top:0;width:' + DOCK_WIDTH + 'px;height:100vh;z-index:99998;border-left:1px solid #d4d4d8;background:#e4e4e7;';
    var iframe = document.createElement('iframe');
    iframe.src = '/editor-popup';
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    sidebar.appendChild(iframe);
    document.body.appendChild(sidebar);
    dockFrame = iframe;

    requestAnimationFrame(function() {
      if (Reveal.layout) Reveal.layout();
      updateToolbarPos();
    });
  }

  function openPopup() {
    docked = false;
    const w = DOCK_WIDTH, h = 780;
    const left = window.screenX + window.outerWidth + 10;
    const top = window.screenY + 50;
    editorPopup = window.open(
      '/editor-popup', 'SlideEditorPopup',
      'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes'
    );
  }

  function closeDock() {
    var sidebar = document.getElementById('le-dock-sidebar');
    if (sidebar) sidebar.remove();
    dockFrame = null;
    docked = false;

    document.body.style.removeProperty('padding-right');

    requestAnimationFrame(function() {
      if (Reveal.layout) Reveal.layout();
      updateToolbarPos();
    });
  }

  function closePopup() {
    if (editorPopup && !editorPopup.closed) editorPopup.close();
    editorPopup = null;
  }

  function toggleDock(toDock) {
    if (toDock) {
      closePopup();
      openDocked();
    } else {
      closeDock();
      openPopup();
    }
    setTimeout(() => {
      sendToPopup({ type: 'connected' });
      updateSlideInfo();
      notifySelection();
    }, 500);
  }

  function sendToPopup(data) {
    const msg = { source: 'le-main', ...data };
    if (docked && dockFrame && dockFrame.contentWindow) {
      dockFrame.contentWindow.postMessage(msg, '*');
    } else if (!docked && editorPopup && !editorPopup.closed) {
      editorPopup.postMessage(msg, '*');
    }
  }

  function notifySelection() {
    const count = selectedEls.size;
    if (count === 0) {
      hideSelectionFrame();
      sendToPopup({ type: 'deselected' });
    } else if (count === 1) {
      showSelectionFrame();
      const el = [...selectedEls][0];
      notifyElementProps(el);
    } else {
      hideSelectionFrame();
      sendToPopup({ type: 'multiSelected', count });
    }
    sendToPopup({ type: 'selectionChanged', count });
  }

  function notifyElementProps(el) {
    const cs = getComputedStyle(el);
    const scale = Reveal.getScale ? Reveal.getScale() : 1;
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const cls = el.className ? '.' + el.className.split(' ').filter(c => !c.startsWith('le-')).join('.') : '';
    const fontSize = Math.round(parseFloat(cs.fontSize));
    const rotation = cs.transform && cs.transform !== 'none'
      ? Math.round(Math.atan2(parseFloat(cs.transform.split(',')[1] || 0), parseFloat(cs.transform.split(',')[0]?.replace(/^matrix\(/, '') || 1)) * 180 / Math.PI)
      : 0;
    sendToPopup({
      type: 'elementSelected',
      fontSize,
      fontWeight: cs.fontWeight || '',
      fontFamily: el.style.fontFamily || cs.fontFamily || '',
      color: rgbToHex(el.style.color || cs.color),
      bgColor: (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent')
        ? rgbToHex(cs.backgroundColor) : null,
      x: Math.round(parseFloat(cs.left) || 0),
      y: Math.round(parseFloat(cs.top) || 0),
      w: Math.round(rect.width / scale),
      h: Math.round(rect.height / scale),
      rotation,
      opacity: Math.round(parseFloat(cs.opacity) * 100),
      borderRadius: Math.round(parseFloat(cs.borderRadius) || 0),
      lineHeight: Math.round(parseFloat(cs.lineHeight) || 0),
      letterSpacing: parseFloat(cs.letterSpacing) || 0,
      borderColor: (cs.borderStyle !== 'none') ? rgbToHex(cs.borderColor) : null,
      borderWidth: parseFloat(cs.borderWidth) || 0,
      boxShadow: cs.boxShadow !== 'none' ? cs.boxShadow : '',
      info: tag + cls + '  |  ' + fontSize + 'px  |  weight ' + cs.fontWeight
    });
  }

  function rgbToHex(rgb) {
    if (!rgb) return '#000000';
    if (rgb.startsWith('#')) return rgb.length > 7 ? rgb.slice(0,7) : rgb;
    const m = rgb.match(/(\d+)/g);
    if (!m || m.length < 3) return '#000000';
    return '#' + m.slice(0,3).map(x => parseInt(x).toString(16).padStart(2,'0')).join('');
  }

  // ── Message handler ──
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.source !== 'le-popup') return;
    const { action, value } = e.data;

    if (action === 'popupReady') {
      sendToPopup({ type: 'connected' });
      updateSlideInfo();
      notifySelection();
      return;
    }
    if (action === 'dock') { toggleDock(true); return; }
    if (action === 'undock') { toggleDock(false); return; }
    if (action === 'setZoom') { setZoom(parseInt(value) || 100); return; }
    if (action === 'undo') { doUndo(); return; }
    if (action === 'redo') { doRedo(); return; }
    if (action === 'copy') { doCopy(); return; }
    if (action === 'paste') { doPaste(); return; }

    const els = [...selectedEls];
    const el = editingEl || els[0] || null;

    const _modActions = ['setFont','setSize','setWeight','setColor','setBg','bold','italic','underline','textAlign','setX','setY','setW','setH','setRotation','setOpacity','setBorderRadius','setLineHeight','setLetterSpacing','setStrokeColor','setStrokeWidth','setShadow'];
    if (_modActions.indexOf(action) >= 0) { pushUndo(); }
    const _frameActions = ['setX','setY','setW','setH','setRotation','setBorderRadius'];

    switch (action) {
      case 'save': doSave(); break;
      case 'prevSlide': Reveal.prev(); break;
      case 'nextSlide': Reveal.next(); break;

      case 'setFont':
        if (value) els.forEach(e => { e.style.setProperty('font-family', value, 'important'); });
        isDirty = true; break;
      case 'setSize':
        if (value) els.forEach(e => { e.style.setProperty('font-size', value + 'px', 'important'); });
        isDirty = true; break;
      case 'setWeight':
        els.forEach(e => { e.style.setProperty('font-weight', value, 'important'); });
        isDirty = true; break;
      case 'setColor':
        els.forEach(e => {
          e.style.setProperty('color', value, 'important');
          e.querySelectorAll('*').forEach(c => c.style.setProperty('color', value, 'important'));
        });
        isDirty = true; break;
      case 'setBg':
        els.forEach(e => { e.style.setProperty('background-color', value, 'important'); });
        isDirty = true; break;
      case 'bold':
        els.forEach(e => {
          const cw = parseInt(getComputedStyle(e).fontWeight);
          e.style.setProperty('font-weight', cw >= 700 ? '400' : '700', 'important');
        });
        isDirty = true; break;
      case 'italic':
        els.forEach(e => {
          const cs = getComputedStyle(e);
          e.style.setProperty('font-style', cs.fontStyle === 'italic' ? 'normal' : 'italic', 'important');
        });
        isDirty = true; break;
      case 'underline':
        els.forEach(e => {
          const cs = getComputedStyle(e);
          e.style.setProperty('text-decoration', cs.textDecoration.includes('underline') ? 'none' : 'underline', 'important');
        });
        isDirty = true; break;
      case 'textAlign':
        els.forEach(e => { e.style.setProperty('text-align', value, 'important'); });
        isDirty = true; break;

      // ── Position / Size ──
      case 'setX':
        els.forEach(e => {
          if (getComputedStyle(e).position === 'static') e.style.position = 'relative';
          e.style.left = value + 'px';
        });
        isDirty = true; break;
      case 'setY':
        els.forEach(e => {
          if (getComputedStyle(e).position === 'static') e.style.position = 'relative';
          e.style.top = value + 'px';
        });
        isDirty = true; break;
      case 'setW':
        els.forEach(e => { e.style.setProperty('width', value + 'px', 'important'); });
        isDirty = true; break;
      case 'setH':
        els.forEach(e => { e.style.setProperty('height', value + 'px', 'important'); });
        isDirty = true; break;
      case 'setRotation':
        els.forEach(e => { e.style.setProperty('transform', 'rotate(' + value + 'deg)', 'important'); });
        isDirty = true; break;

      // ── Appearance ──
      case 'setOpacity':
        els.forEach(e => { e.style.setProperty('opacity', (parseFloat(value) / 100).toString()); });
        isDirty = true; break;
      case 'setBorderRadius':
        els.forEach(e => { e.style.setProperty('border-radius', value + 'px', 'important'); });
        isDirty = true; break;

      // ── Typography extended ──
      case 'setLineHeight':
        els.forEach(e => { e.style.setProperty('line-height', value + 'px', 'important'); });
        isDirty = true; break;
      case 'setLetterSpacing':
        els.forEach(e => { e.style.setProperty('letter-spacing', value + 'px', 'important'); });
        isDirty = true; break;

      // ── Stroke ──
      case 'setStrokeColor':
        els.forEach(e => {
          e.style.setProperty('border-color', value, 'important');
          if (!e.style.borderStyle || e.style.borderStyle === 'none') e.style.setProperty('border-style', 'solid', 'important');
        });
        isDirty = true; break;
      case 'setStrokeWidth':
        els.forEach(e => {
          e.style.setProperty('border-width', value + 'px', 'important');
          if (!e.style.borderStyle || e.style.borderStyle === 'none') e.style.setProperty('border-style', 'solid', 'important');
        });
        isDirty = true; break;

      // ── Effects ──
      case 'setShadow':
        if (value) els.forEach(e => { e.style.setProperty('box-shadow', value, 'important'); });
        else els.forEach(e => { e.style.removeProperty('box-shadow'); });
        isDirty = true; break;

      // ── Group / Ungroup ──
      case 'group': doGroup(); break;
      case 'ungroup': doUngroup(); break;

      // ── Align ──
      case 'alignLeft': case 'alignCenter': case 'alignRight':
      case 'alignTop': case 'alignMiddle': case 'alignBottom':
        doAlign(action); break;
    }
    if (_frameActions.indexOf(action) >= 0) updateSelectionFrame();
  });

  // ── Editable targets ──
  const EDITABLE = 'h1,h2,h3,h4,p,li,td,th,span,strong,em,img,div.cover-label,div.cover-sub,div.cover-meta,div.cover-meta>div,div.section-num,div.section-sub,div.summary-msg,div.gui-category,div.value,div.label,div.s-num,div.s-title,div.s-metric,div.exp-item,div.exp-grid,div.asis-tobe,div.asis-box,div.tobe-box,div.evidence,div.ps-grid,div.le-group,div.le-web-embed';

  function getEditableTarget(el) {
    if (!el) return null;
    const slide = el.closest('section');
    if (!slide) return null;
    if (el.matches && el.matches(EDITABLE)) return el;
    const parent = el.closest(EDITABLE);
    if (parent && parent.closest('section')) return parent;
    if (el.closest('section') && el.tagName === 'DIV') return el;
    if (el.children.length === 0 && el.textContent.trim()) return el;
    return null;
  }

  // ── Selection ──
  function clearSelection() {
    selectedEls.forEach(el => el.classList.remove('le-selected'));
    selectedEls.clear();
    hideSelectionFrame();
  }

  function addToSelection(el) {
    selectedEls.add(el);
    el.classList.add('le-selected');
  }

  function removeFromSelection(el) {
    selectedEls.delete(el);
    el.classList.remove('le-selected');
  }

  function selectSingle(el) {
    clearSelection();
    if (editingEl) stopEditing();
    addToSelection(el);
    notifySelection();
  }

  function toggleSelection(el) {
    if (editingEl) stopEditing();
    if (selectedEls.has(el)) {
      removeFromSelection(el);
    } else {
      addToSelection(el);
    }
    notifySelection();
  }

  // ── Editing ──
  function startEditing(el) {
    if (editingEl) stopEditing();
    pushUndo(true);
    clearSelection();
    editingEl = el;
    el.classList.add('le-editing');
    Reveal.configure({ keyboard: false });

    const iframe = el.querySelector('iframe');
    if (iframe) {
      iframe.style.pointerEvents = 'auto';
      return;
    }
    if (el.tagName === 'IMG') return;

    el.contentEditable = 'true';
    el.style.setProperty('outline', '1.5px solid #a855f7', 'important');
    el.focus();
    isDirty = true;
  }

  function stopEditing() {
    if (!editingEl) return;
    const iframe = editingEl.querySelector('iframe');
    if (iframe) iframe.style.pointerEvents = 'none';
    editingEl.contentEditable = 'false';
    editingEl.removeAttribute('contenteditable');
    editingEl.classList.remove('le-editing');
    editingEl.style.removeProperty('outline');
    editingEl = null;
    Reveal.configure({ keyboard: true });
  }

  // ── Drag (moves all selected) ──
  function startDrag(e, el) {
    if (editingEl === el) return;
    pushUndo(true);
    const scale = Reveal.getScale ? Reveal.getScale() : 1;
    const items = [];
    selectedEls.forEach(sel => {
      const cs = getComputedStyle(sel);
      if (cs.position === 'static') sel.style.position = 'relative';
      items.push({
        el: sel,
        origLeft: parseFloat(cs.left) || 0,
        origTop: parseFloat(cs.top) || 0,
      });
      sel.classList.add('le-dragging');
    });
    dragState = { items, startX: e.clientX, startY: e.clientY, scale };
    e.preventDefault();
  }

  document.addEventListener('mousemove', function(e) {
    if (resizeState) {
      var dx = (e.clientX - resizeState.startX) / resizeState.scale;
      var dy = (e.clientY - resizeState.startY) / resizeState.scale;
      var el = resizeState.el, dir = resizeState.dir;
      var w = resizeState.origW, h = resizeState.origH;
      var l = resizeState.origL, t = resizeState.origT;
      if (dir.includes('e')) w += dx;
      if (dir.includes('w')) { w -= dx; l += dx; }
      if (dir.includes('s')) h += dy;
      if (dir.includes('n')) { h -= dy; t += dy; }
      if (e.shiftKey && resizeState.origH > 0) {
        var ratio = resizeState.origW / resizeState.origH;
        if (dir === 'e' || dir === 'w') h = w / ratio;
        else if (dir === 'n' || dir === 's') w = h * ratio;
        else h = w / ratio;
      }
      if (w > 10) {
        el.style.setProperty('width', Math.round(w) + 'px', 'important');
        if (dir.includes('w')) el.style.left = Math.round(l) + 'px';
      }
      if (h > 10) {
        el.style.setProperty('height', Math.round(h) + 'px', 'important');
        if (dir.includes('n')) el.style.top = Math.round(t) + 'px';
      }
      updateSelectionFrame();
      isDirty = true;
      return;
    }
    if (!dragState) return;
    var dx = (e.clientX - dragState.startX) / dragState.scale;
    var dy = (e.clientY - dragState.startY) / dragState.scale;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    dragState.items.forEach(item => {
      item.el.style.left = (item.origLeft + dx) + 'px';
      item.el.style.top = (item.origTop + dy) + 'px';
    });
    isDirty = true;
    updateSelectionFrame();
  });

  document.addEventListener('mouseup', function() {
    if (resizeState) {
      resizeState = null;
      notifySelection();
      return;
    }
    if (dragState) {
      dragState.items.forEach(item => item.el.classList.remove('le-dragging'));
      dragState = null;
      updateSelectionFrame();
    }
  });

  // ── Click events ──
  document.addEventListener('click', function(e) {
    const target = getEditableTarget(e.target);
    if (target) {
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        toggleSelection(target);
      } else if (selectedEls.size === 1 && selectedEls.has(target)) {
        startEditing(target);
      } else {
        selectSingle(target);
      }
    } else {
      if (editingEl) stopEditing();
      clearSelection();
      notifySelection();
    }
  }, true);

  document.addEventListener('mousedown', function(e) {
    const target = getEditableTarget(e.target);
    if (target && selectedEls.has(target) && editingEl !== target) {
      startDrag(e, target);
    }
  });

  document.addEventListener('mouseover', function(e) {
    if (dragState || editingEl) return;
    const target = getEditableTarget(e.target);
    if (!target || selectedEls.has(target)) return;
    var isAncestorOfSelected = false;
    selectedEls.forEach(function(sel) { if (target.contains(sel)) isAncestorOfSelected = true; });
    if (!isAncestorOfSelected) target.classList.add('le-editable-hover');
  });
  document.addEventListener('mouseout', function(e) {
    const target = getEditableTarget(e.target);
    if (target) target.classList.remove('le-editable-hover');
  });

  // ── Group / Ungroup ──
  function doGroup() {
    const els = [...selectedEls];
    if (els.length < 2) { showToast('2개 이상 선택 필요'); return; }
    pushUndo(true);

    const parent = els[0].parentElement;
    const sameParent = els.every(el => el.parentElement === parent);
    if (!sameParent) { showToast('같은 영역의 요소만 그룹 가능'); return; }

    const siblings = [...parent.children];
    els.sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));

    const group = document.createElement('div');
    group.className = 'le-group';
    parent.insertBefore(group, els[0]);
    els.forEach(el => group.appendChild(el));

    clearSelection();
    addToSelection(group);
    notifySelection();
    isDirty = true;
    showToast('그룹 생성 (' + els.length + '개)');
  }

  function doUngroup() {
    const els = [...selectedEls];
    const groups = els.filter(el => el.classList.contains('le-group'));
    if (groups.length === 0) { showToast('그룹을 선택하세요'); return; }
    pushUndo(true);

    clearSelection();
    groups.forEach(group => {
      const parent = group.parentElement;
      const children = [...group.children];
      children.forEach(child => {
        parent.insertBefore(child, group);
        addToSelection(child);
      });
      group.remove();
    });
    notifySelection();
    isDirty = true;
    showToast('그룹 해제');
  }

  // ── Align ──
  function doAlign(action) {
    const els = [...selectedEls];
    if (els.length < 2) { showToast('2개 이상 선택 필요'); return; }

    const scale = Reveal.getScale ? Reveal.getScale() : 1;
    const rects = els.map(el => {
      const r = el.getBoundingClientRect();
      return {
        el,
        left: r.left / scale,
        top: r.top / scale,
        right: r.right / scale,
        bottom: r.bottom / scale,
        width: r.width / scale,
        height: r.height / scale,
        cx: (r.left + r.right) / 2 / scale,
        cy: (r.top + r.bottom) / 2 / scale,
      };
    });

    let ref;
    switch (action) {
      case 'alignLeft':
        ref = Math.min(...rects.map(r => r.left));
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curLeft = parseFloat(cs.left) || 0;
          r.el.style.left = (curLeft + ref - r.left) + 'px';
        });
        break;

      case 'alignCenter':
        ref = rects.reduce((s, r) => s + r.cx, 0) / rects.length;
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curLeft = parseFloat(cs.left) || 0;
          r.el.style.left = (curLeft + ref - r.cx) + 'px';
        });
        break;

      case 'alignRight':
        ref = Math.max(...rects.map(r => r.right));
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curLeft = parseFloat(cs.left) || 0;
          r.el.style.left = (curLeft + ref - r.right) + 'px';
        });
        break;

      case 'alignTop':
        ref = Math.min(...rects.map(r => r.top));
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curTop = parseFloat(cs.top) || 0;
          r.el.style.top = (curTop + ref - r.top) + 'px';
        });
        break;

      case 'alignMiddle':
        ref = rects.reduce((s, r) => s + r.cy, 0) / rects.length;
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curTop = parseFloat(cs.top) || 0;
          r.el.style.top = (curTop + ref - r.cy) + 'px';
        });
        break;

      case 'alignBottom':
        ref = Math.max(...rects.map(r => r.bottom));
        rects.forEach(r => {
          const cs = getComputedStyle(r.el);
          if (cs.position === 'static') r.el.style.position = 'relative';
          const curTop = parseFloat(cs.top) || 0;
          r.el.style.top = (curTop + ref - r.bottom) + 'px';
        });
        break;
    }
    isDirty = true;
    showToast('정렬 완료');
  }

  // ── Slide info ──
  function updateSlideInfo() {
    const idx = Reveal.getIndices();
    const total = Reveal.getTotalSlides();
    sendToPopup({ type: 'slideInfo', current: idx.h + 1, total });
  }
  Reveal.on('slidechanged', updateSlideInfo);
  setTimeout(updateSlideInfo, 500);

  // ── Save ──
  async function doSave() {
    if (editingEl) stopEditing();
    const sections = document.querySelectorAll('.reveal .slides > section');
    const slides = [];
    sections.forEach(sec => {
      const clone = sec.cloneNode(true);
      clone.querySelectorAll('.le-selected,.le-editing,.le-editable-hover,.le-dragging').forEach(el => {
        el.classList.remove('le-selected','le-editing','le-editable-hover','le-dragging');
      });
      clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
      const allEls = [clone, ...clone.querySelectorAll('*')];
      allEls.forEach(el => {
        el.removeAttribute('hidden');
        el.removeAttribute('aria-hidden');
        el.classList.remove('present', 'future', 'past', 'stack');
        if (el.style && (el.style.display === 'block' || el.style.display === 'none')) el.style.removeProperty('display');
        if (el.classList.length === 0) el.removeAttribute('class');
      });
      slides.push(clone.outerHTML);
    });
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slides })
      });
      const data = await res.json();
      if (data.ok) { isDirty = false; showToast('저장 완료 (' + data.count + '장)'); }
      else showToast('저장 실패: ' + (data.error || ''));
    } catch(e) { showToast('저장 오류: ' + e.message); }
  }

  // ── Keyboard (capture phase — fires before reveal.js) ──
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); e.stopPropagation(); doSave(); return; }
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault(); e.stopPropagation();
      if (editingEl) stopEditing();
      doUndo(); return;
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault(); e.stopPropagation();
      if (editingEl) stopEditing();
      doRedo(); return;
    }
    if (e.ctrlKey && e.key === 'c' && !editingEl && selectedEls.size > 0) { e.preventDefault(); e.stopPropagation(); doCopy(); return; }
    if (e.ctrlKey && e.key === 'v' && !editingEl) { e.preventDefault(); e.stopPropagation(); doPaste(); return; }
    if (e.ctrlKey && e.key === 'g') { e.preventDefault(); e.stopPropagation(); doGroup(); return; }
    if (e.ctrlKey && e.shiftKey && e.key === 'G') { e.preventDefault(); e.stopPropagation(); doUngroup(); return; }
    if (e.key === 'Escape') {
      if (editingEl) stopEditing();
      else { clearSelection(); notifySelection(); }
    }
    if (e.key === 'Delete' && selectedEls.size > 0 && !editingEl) {
      e.preventDefault();
      pushUndo(true);
      const els = [...selectedEls];
      clearSelection();
      els.forEach(el => el.remove());
      notifySelection();
      isDirty = true;
      showToast(els.length + '개 삭제');
    }
  }, true);

  // ── Zoom ──
  let zoomLevel = 100;
  function setZoom(level) {
    zoomLevel = Math.max(25, Math.min(200, level));
    const slides = document.querySelector('.reveal .slides');
    if (slides) {
      slides.style.transformOrigin = 'top left';
      if (zoomLevel === 100) {
        slides.style.transform = '';
      } else {
        const baseScale = Reveal.getScale ? Reveal.getScale() : 1;
        slides.style.transform = 'scale(' + (baseScale * zoomLevel / 100) + ')';
      }
    }
    sendToPopup({ type: 'zoomChanged', zoom: zoomLevel });
  }

  document.addEventListener('wheel', function(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(zoomLevel + (e.deltaY < 0 ? 10 : -10));
    }
  }, { passive: false });

  // ── Toolbar ──
  let toolbarEl = null;

  function createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.id = 'le-canvas-toolbar';
    toolbarEl = toolbar;

    const tools = [
      { id: 'image', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>', tip: '이미지' },
      null,
      { id: 'rect', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>', tip: '사각형' },
      { id: 'circle', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>', tip: '원' },
      null,
      { id: 'text', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/></svg>', tip: '텍스트' },
      null,
      { id: 'web', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', tip: '웹' },
    ];

    toolbar.style.cssText = 'position:fixed !important;bottom:20px !important;left:50% !important;transform:translateX(-50%) !important;background:#f4f4f5 !important;border:1px solid #d4d4d8 !important;border-radius:10px !important;padding:4px 6px !important;display:flex !important;align-items:center !important;gap:2px !important;z-index:999999 !important;box-shadow:0 4px 16px rgba(0,0,0,0.08),0 1px 3px rgba(0,0,0,0.06) !important;';

    tools.forEach(function(t) {
      if (t === null) {
        var sep = document.createElement('div');
        sep.style.cssText = 'width:1px;height:20px;background:#d4d4d8;margin:0 3px;flex-shrink:0;';
        toolbar.appendChild(sep);
        return;
      }
      var btn = document.createElement('div');
      btn.setAttribute('data-tool', t.id);
      btn.title = t.tip;
      btn.style.cssText = 'width:34px;height:34px;border:none;border-radius:6px;background:transparent;color:#52525b;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,color 0.15s;';
      btn.innerHTML = t.icon;
      btn.querySelector('svg').style.cssText = 'width:18px;height:18px;';
      btn.addEventListener('mouseenter', function() { btn.style.background = '#e4e4e7'; btn.style.color = '#18181b'; });
      btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; btn.style.color = '#52525b'; });
      toolbar.appendChild(btn);
    });

    document.body.appendChild(toolbar);

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.cssText = 'display:none !important;';
    fileInput.id = 'le-image-input';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', function(ev) {
      var file = ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(r) { addImageToSlide(r.target.result); };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    toolbar.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    toolbar.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('[data-tool]');
      if (!btn) return;
      var tool = btn.getAttribute('data-tool');
      if (tool === 'image') fileInput.click();
      else if (tool === 'rect') addRectToSlide();
      else if (tool === 'circle') addCircleToSlide();
      else if (tool === 'text') addTextToSlide();
      else if (tool === 'web') addWebToSlide();
    });

    updateToolbarPos();
  }

  function getSlideCenter() {
    var rev = document.querySelector('.reveal');
    if (!rev) return window.innerWidth / 2;
    var r = rev.getBoundingClientRect();
    return r.left + r.width / 2;
  }

  function updateToolbarPos() {
    if (!toolbarEl) return;
    var cx = getSlideCenter();
    toolbarEl.style.setProperty('left', cx + 'px', 'important');
  }

  function addImageToSlide(dataUrl) {
    pushUndo(true);
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'position:relative;max-width:300px;max-height:200px;cursor:move;border-radius:4px;';
    slide.appendChild(img);
    clearSelection();
    addToSelection(img);
    notifySelection();
    isDirty = true;
    showToast('이미지 추가됨');
  }

  function addRectToSlide() {
    pushUndo(true);
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    const rect = document.createElement('div');
    rect.style.cssText = 'position:relative;width:200px;height:120px;background:#e4e4e7;border:2px solid #a1a1aa;border-radius:8px;';
    rect.innerHTML = ' ';
    slide.appendChild(rect);
    clearSelection();
    addToSelection(rect);
    notifySelection();
    isDirty = true;
    showToast('사각형 추가됨');
  }

  function addCircleToSlide() {
    pushUndo(true);
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    const circle = document.createElement('div');
    circle.style.cssText = 'position:relative;width:150px;height:150px;background:#e4e4e7;border:2px solid #a1a1aa;border-radius:50%;';
    circle.innerHTML = ' ';
    slide.appendChild(circle);
    clearSelection();
    addToSelection(circle);
    notifySelection();
    isDirty = true;
    showToast('원 추가됨');
  }

  function addWebToSlide() {
    const url = prompt('삽입할 웹 URL을 입력하세요:', 'https://');
    if (!url || url === 'https://' || url.trim() === '') return;
    pushUndo(true);
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    const container = document.createElement('div');
    container.className = 'le-web-embed';
    container.style.cssText = 'position:relative;width:560px;height:360px;border-radius:8px;overflow:hidden;border:2px solid #d4d4d8;background:#fff;';
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.cssText = 'width:100%;height:100%;border:none;pointer-events:none;';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    iframe.setAttribute('loading', 'lazy');
    container.appendChild(iframe);
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;padding:2px 8px;border-radius:4px;pointer-events:none;z-index:1;';
    badge.textContent = new URL(url).hostname;
    container.appendChild(badge);
    slide.appendChild(container);
    clearSelection();
    addToSelection(container);
    notifySelection();
    isDirty = true;
    showToast('웹 삽입됨 — 더블클릭으로 상호작용');
  }

  function addTextToSlide() {
    pushUndo(true);
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    const text = document.createElement('p');
    text.style.cssText = 'position:relative;font-size:18px;color:#27272a;';
    text.textContent = '텍스트를 입력하세요';
    slide.appendChild(text);
    clearSelection();
    addToSelection(text);
    notifySelection();
    isDirty = true;
    showToast('텍스트 추가됨');
  }

  window.addEventListener('beforeunload', function(e) {
    if (isDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  setTimeout(openDocked, 300);
  setTimeout(createToolbar, 100);
  window.addEventListener('resize', function() {
    setTimeout(function() { if (Reveal.layout) Reveal.layout(); updateToolbarPos(); }, 50);
  });
  showToast('라이브 편집 모드');
})();
