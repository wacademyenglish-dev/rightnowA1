/*!
 * WOLF EDITOR v1.0
 * Editor drop-in para as aulas Wolf Labs.
 *
 *   <script src="wolf-editor.js"></script>
 *   <script>WolfEditor.init({ lessonId: 'a1-demonstratives' })</script>
 *
 * Opera sobre o DOM, não sobre o formato interno da aula.
 * Por isso funciona em qualquer aula do catálogo sem reescrever nada.
 *
 * As edições ficam SÓ no navegador do professor (IndexedDB).
 * O arquivo original nunca é tocado.
 *
 * TRAVAR UM ELEMENTO
 * Qualquer elemento com o atributo data-wl-lock — e tudo dentro dele —
 * fica fora do editor: não aceita clique, não aceita troca de imagem,
 * e ignora patch importado de fora.
 *
 *   <div class="originals" data-wl-lock> ... </div>
 *
 * Use em marca, assinatura e qualquer coisa que o professor não deve reescrever.
 */
(function (global) {
'use strict';

var DB_NAME = 'wolf-editor', DB_VER = 1;
var db = null, applying = false, observer = null;

var S = {
  lessonId: 'lesson',
  rootSel: 'body',
  sceneKey: null,
  text:   {},   // "scene|path" -> html
  media:  {},   // "scene|path" -> blobKey
  hidden: [],   // chaves de cena desligadas
  order:  null,
  on: false,
  urls: {},
  undo: [],     // pilha de desfazer da sessão
  dirty: false  // há alteração ainda não salva
};

/* ============================================================
   ARMAZENAMENTO — IndexedDB com queda para LocalStorage
   ============================================================ */
function openDB() {
  return new Promise(function (res) {
    if (!global.indexedDB) return res(null);
    var rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = function (e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('patches')) d.createObjectStore('patches');
      if (!d.objectStoreNames.contains('blobs'))   d.createObjectStore('blobs');
    };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror   = function () { res(null); };
  });
}
function idb(store, mode, fn) {
  return new Promise(function (res, rej) {
    if (!db) return rej('nodb');
    var tx = db.transaction(store, mode), rq = fn(tx.objectStore(store));
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror   = function () { rej(rq.error); };
  });
}
function lsKey() { return 'wolf-editor:' + S.lessonId; }

function persist() {
  var data = { text: S.text, media: S.media, hidden: S.hidden, order: S.order, updatedAt: Date.now() };
  if (db) {
    idb('patches', 'readwrite', function (st) { return st.put(data, S.lessonId); })['catch'](function () {});
  } else {
    try { localStorage.setItem(lsKey(), JSON.stringify(data)); } catch (e) {}
  }
  badge();
}
function restore() {
  if (db) {
    return idb('patches', 'readonly', function (st) { return st.get(S.lessonId); })
      .then(function (d) { if (d) { S.text = d.text || {}; S.media = d.media || {}; S.hidden = d.hidden || []; S.order = d.order || null; } })
      ['catch'](function () {});
  }
  try {
    var d = JSON.parse(localStorage.getItem(lsKey()) || 'null');
    if (d) { S.text = d.text || {}; S.media = d.media || {}; S.hidden = d.hidden || []; S.order = d.order || null; }
  } catch (e) {}
  return Promise.resolve();
}
function putBlob(key, blob) {
  if (db) return idb('blobs', 'readwrite', function (st) { return st.put(blob, S.lessonId + '|' + key); });
  return Promise.reject('Images require IndexedDB');
}
function getBlob(key) {
  if (db) return idb('blobs', 'readonly', function (st) { return st.get(S.lessonId + '|' + key); });
  return Promise.resolve(null);
}

/* ============================================================
   CAMINHO ESTÁVEL ATÉ O ELEMENTO
   ============================================================ */
function root() { return document.querySelector(S.rootSel) || document.body; }

function scene() {
  if (typeof S.sceneKey === 'function') { try { return String(S.sceneKey()); } catch (e) {} }
  var a = document.querySelector('.slide.active, .scene.on, .screen.active');
  if (a && a.parentElement) return 's' + Array.prototype.indexOf.call(a.parentElement.children, a);
  var h = document.querySelector('h1,h2');
  return h ? 'h:' + (h.textContent || '').trim().slice(0, 24) : 'root';
}

function pathOf(el) {
  var r = root(), p = [];
  while (el && el !== r && el.parentElement) {
    p.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
    el = el.parentElement;
  }
  return p.join('.');
}
function elAt(path) {
  var el = root(), parts = path === '' ? [] : path.split('.');
  for (var i = 0; i < parts.length; i++) {
    el = el.children[+parts[i]];
    if (!el) return null;
  }
  return el;
}
function keyOf(el) { return scene() + '|' + pathOf(el); }

/* ============================================================
   O QUE PODE SER EDITADO
   ============================================================ */
var TEXT_TAGS = /^(H1|H2|H3|H4|H5|P|SPAN|LI|TD|TH|BUTTON|LABEL|STRONG|EM|SMALL|B|I|A|DIV)$/;
var SKIP = /wl-ed|wl-dock|wl-panel/;

/* elementos travados: marca, assinatura, qualquer coisa que o professor não pode reescrever */
/* Regiões que o professor NÃO edita:
   · WOLF LABS ORIGINALS  (data-wl-lock)
   · qualquer coisa de áudio — trocar o texto quebraria o mapa de voz
   · a lousa e a barra de ferramentas — são do professor, não da aula */
var NO_EDIT = '[data-wl-lock],.au,.script,.jumpwarn,.board2,.bscrim,.tools,.knows,audio';
function isLocked(el) {
  if (!el || !el.closest) return false;
  if (el.closest(NO_EDIT)) return true;
  if (el.querySelector && el.querySelector('.au')) return true;
  return false;
}

function isTextLeaf(el) {
  if (!el || !TEXT_TAGS.test(el.tagName)) return false;
  if (SKIP.test(el.className || '')) return false;
  if (el.closest && el.closest('.wl-ed-ui')) return false;
  if (isLocked(el)) return false;
  var t = (el.textContent || '').trim();
  if (!t || t.length > 600) return false;
  // só folhas de texto: nenhum filho em bloco
  for (var i = 0; i < el.children.length; i++) {
    var c = el.children[i];
    if (/^(DIV|SECTION|UL|OL|TABLE|H1|H2|H3|P)$/.test(c.tagName)) return false;
  }
  if (el.tagName === 'DIV' && el.children.length) return false;
  return true;
}
function isMedia(el) {
  if (!el || (el.closest && el.closest('.wl-ed-ui'))) return false;
  if (isLocked(el)) return false;
  if (el.tagName === 'IMG') return true;
  var bg = getComputedStyle(el).backgroundImage;
  return !!(bg && bg !== 'none' && bg.indexOf('url(') === 0 && el.offsetWidth > 60 && el.offsetHeight > 40);
}

/* ============================================================
   APLICAR PATCHES
   ============================================================ */
function applyAll() {
  applying = true;
  var sc = scene();
  Object.keys(S.text).forEach(function (k) {
    if (k.indexOf(sc + '|') !== 0) return;
    var el = elAt(k.slice(sc.length + 1));
    if (el && !isLocked(el) && el.innerHTML !== S.text[k]) el.innerHTML = S.text[k];
  });
  Object.keys(S.media).forEach(function (k) {
    if (k.indexOf(sc + '|') !== 0) return;
    var el = elAt(k.slice(sc.length + 1));
    if (!el || isLocked(el)) return;
    var mk = S.media[k];
    var put = function (url) {
      if (el.tagName === 'IMG') { if (el.src !== url) el.src = url; }
      else { var want = 'url("' + url + '")'; if (el.style.backgroundImage !== want) el.style.backgroundImage = want; }
    };
    if (S.urls[mk]) return put(S.urls[mk]);
    getBlob(mk).then(function (b) { if (b) { S.urls[mk] = URL.createObjectURL(b); put(S.urls[mk]); } });
  });
  applying = false;
}

/* ============================================================
   MODO DE EDIÇÃO
   ============================================================ */
function setEdit(on) {
  S.on = on;
  document.body.classList.toggle('wl-editing', on);
  var btn = document.getElementById('wl-toggle');
  if (btn) { btn.classList.toggle('wl-active', on); btn.title = on ? 'Exit edit mode' : 'Edit this lesson'; }
  if (!on) {
    Array.prototype.forEach.call(document.querySelectorAll('[contenteditable]'), function (e) {
      e.removeAttribute('contenteditable');
    });
  }
  toast(on ? 'Edit mode on. Click any text or image.' : 'Edit mode off.');
}

function onOver(e) {
  if (!S.on) return;
  var el = e.target;
  document.querySelectorAll('.wl-hover').forEach(function (x) { x.classList.remove('wl-hover'); });
  if (isTextLeaf(el) || isMedia(el)) el.classList.add('wl-hover');
}

function onClick(e) {
  if (!S.on) return;
  var el = e.target;
  if (el.closest && el.closest('.wl-ed-ui')) return;

  if (isMedia(el)) {
    e.preventDefault(); e.stopPropagation();
    pickMedia(el);
    return;
  }
  if (!isTextLeaf(el)) return;
  e.preventDefault(); e.stopPropagation();

  var key = keyOf(el), original = el.getAttribute('data-wl-orig');
  if (original === null) el.setAttribute('data-wl-orig', el.innerHTML);

  el.setAttribute('contenteditable', 'true');
  el.classList.add('wl-live');
  el.focus();
  var r = document.createRange(); r.selectNodeContents(el);
  var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);

  var before = S.text[key];
  var finish = function () {
    el.removeAttribute('contenteditable');
    el.classList.remove('wl-live');
    var html = el.innerHTML;
    if (html !== el.getAttribute('data-wl-orig')) {
      S.undo.push({ kind: 'text', key: key, prev: before });
      S.text[key] = html;
      S.dirty = true;
      persist();          // salva sempre; o botão Salvar é só confirmação visual
      renderList();
    }
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKey);
  };
  var onKey = function (ev) {
    if (ev.key === 'Escape') { el.innerHTML = el.getAttribute('data-wl-orig'); el.blur(); }
    if (ev.key === 'Enter' && !ev.shiftKey && el.tagName !== 'DIV') { ev.preventDefault(); el.blur(); }
  };
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKey);
}

function pickMedia(el) {
  var key = keyOf(el);
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = function () {
    var f = inp.files && inp.files[0]; if (!f) return;
    if (f.size > 4 * 1024 * 1024) return toast('Image is over 4 MB. Compress it first.', true);
    var mk = 'm' + Date.now();
    putBlob(mk, f).then(function () {
      S.media[key] = mk; persist();
      S.urls[mk] = URL.createObjectURL(f);
      applyAll(); renderList();
      toast('Image replaced.');
    })['catch'](function (m) { toast(String(m), true); });
  };
  inp.click();
}

/* ============================================================
   EXPORTAR / IMPORTAR
   ============================================================ */
function exportAll() {
  var pack = { wolfEditor: 1, lessonId: S.lessonId, exportedAt: new Date().toISOString(),
               text: S.text, hidden: S.hidden, order: S.order, media: {} };
  var keys = Object.keys(S.media);
  var jobs = keys.map(function (k) {
    return getBlob(S.media[k]).then(function (b) {
      if (!b) return null;
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { pack.media[k] = fr.result; res(); };
        fr.readAsDataURL(b);
      });
    });
  });
  Promise.all(jobs).then(function () {
    var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.lessonId + '.wolfedit.json';
    a.click();
    toast('File exported.');
  });
}

/* base64 -> Blob sem fetch: mantém o arquivo 100% livre de chamadas de rede */
function dataUrlToBlob(url) {
  if (typeof url !== 'string' || url.indexOf('data:') !== 0) return null;
  try {
    var parts = url.split(','), mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    var bin = atob(parts[1]), len = bin.length, arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) { return null; }
}

function importAll() {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = function () {
    var f = inp.files && inp.files[0]; if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var p;
      try { p = JSON.parse(fr.result); } catch (e) { return toast('Invalid file.', true); }
      if (!p || !p.wolfEditor) return toast('Not a Wolf Editor file.', true);
      if (p.lessonId !== S.lessonId &&
          !confirm('This file belongs to lesson "' + p.lessonId + '". Import anyway?')) return;

      S.text = p.text || {}; S.hidden = p.hidden || []; S.order = p.order || null; S.media = {};
      var jobs = Object.keys(p.media || {}).map(function (k) {
        var b = dataUrlToBlob(p.media[k]);
        if (!b) return Promise.resolve();
        var mk = 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
        return putBlob(mk, b).then(function () { S.media[k] = mk; });
      });
      Promise.all(jobs).then(function () {
        persist(); applyAll(); renderList(); toast('Changes imported.');
      });
    };
    fr.readAsText(f);
  };
  inp.click();
}

function revert(key) {
  delete S.text[key]; delete S.media[key];
  persist(); renderList();
  toast('Reverted. Reload to see the original.');
}

/* Desfazer — volta a última alteração da sessão */
function undo() {
  var last = S.undo.pop();
  if (!last) return toast('Nothing to undo.');
  if (last.prev === undefined) { delete S.text[last.key]; persist(); location.reload(); return; }
  S.text[last.key] = last.prev;
  persist(); applyAll(); renderList(); toast('Undone.');
}

/* Salvar — já salva a cada edição; isto confirma e tranquiliza o professor */
function saveNow() {
  persist(); S.dirty = false;
  var n = Object.keys(S.text).length + Object.keys(S.media).length;
  toast(n ? n + ' change' + (n > 1 ? 's' : '') + ' saved in this browser.' : 'Nothing to save yet.');
}

/* Concluir — sai do modo edição e fecha o painel */
function finishEditing() {
  saveNow(); setEdit(false);
  var p = document.querySelector('.wl-panel'); if (p) p.classList.remove('wl-open');
}
function revertAll() {
  if (!confirm('Delete ALL your changes for this lesson? It goes back to the original.')) return;
  S.text = {}; S.media = {}; S.hidden = []; S.order = null;
  persist();
  location.reload();
}

/* ============================================================
   INTERFACE
   ============================================================ */
var CSS = [
'.wl-ed-ui,.wl-ed-ui *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
'.wl-dock{position:fixed;right:16px;bottom:88px;z-index:2147483000;flex-direction:column;gap:8px;display:none}',
'body.wl-editing .wl-dock{display:flex}',
'body.wl-editing #wl-toggle{display:none}',
'.wl-dock button{width:46px;height:46px;border-radius:14px;border:1px solid rgba(255,255,255,.16);',
'  background:rgba(18,18,22,.92);color:#e8e6e3;cursor:pointer;font-size:17px;display:flex;',
'  align-items:center;justify-content:center;backdrop-filter:blur(14px);transition:.2s;position:relative}',
'.wl-dock button:hover{background:#2a2a32;transform:translateY(-2px)}',
'.wl-dock button.wl-active{background:#f0a13c;color:#1a1206;border-color:#f0a13c}',
'.wl-bar{position:fixed;left:50%;bottom:92px;transform:translateX(-50%) translateY(24px);z-index:2147483000;',
'  display:none;gap:8px;padding:9px 11px;border-radius:16px;background:rgba(18,18,22,.95);',
'  border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(16px);opacity:0;transition:.28s cubic-bezier(.16,1,.3,1)}',
'body.wl-editing .wl-bar{display:flex;opacity:1;transform:translateX(-50%) translateY(0)}',
'.wl-bar button{display:flex;align-items:center;gap:7px;padding:9px 16px;border-radius:11px;',
'  border:1px solid rgba(255,255,255,.16);background:transparent;color:#e8e6e3;font-size:13px;',
'  cursor:pointer;transition:.2s;white-space:nowrap}',
'.wl-bar button:hover{background:rgba(255,255,255,.1)}',
'.wl-bar button.wl-primary{background:#f0a13c;color:#1a1206;border-color:#f0a13c;font-weight:600}',
'.wl-bar button.wl-primary:hover{background:#f5b358}',
'.wl-bar .wl-hint{color:#8d8880;font-size:12px;align-self:center;padding:0 6px;border-right:1px solid rgba(255,255,255,.14);margin-right:2px}',
'.wl-count{position:absolute;top:-5px;right:-5px;min-width:19px;height:19px;border-radius:10px;',
'  background:#e2673b;color:#fff;font-size:11px;line-height:19px;padding:0 5px;font-weight:600}',
'.wl-panel{position:fixed;top:0;right:-420px;width:400px;max-width:92vw;height:100%;z-index:2147483001;',
'  background:rgba(14,14,17,.985);backdrop-filter:blur(20px);border-left:1px solid rgba(255,255,255,.1);',
'  color:#e8e6e3;transition:right .34s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column}',
'.wl-panel.wl-open{right:0}',
'.wl-ph{padding:20px 20px 14px;border-bottom:1px solid rgba(255,255,255,.1)}',
'.wl-ph h3{margin:0 0 4px;font-size:16px;font-weight:600}',
'.wl-ph p{margin:0;font-size:12px;color:#9a9691;line-height:1.5}',
'.wl-acts{display:flex;gap:7px;padding:14px 20px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.1)}',
'.wl-acts button{flex:1;min-width:88px;padding:9px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.16);',
'  background:transparent;color:#e8e6e3;font-size:12px;cursor:pointer;transition:.2s}',
'.wl-acts button:hover{background:rgba(255,255,255,.09)}',
'.wl-acts button.wl-danger{border-color:rgba(226,103,59,.5);color:#e2673b}',
'.wl-list{flex:1;overflow-y:auto;padding:12px 20px 26px}',
'.wl-item{padding:11px 0;border-bottom:1px solid rgba(255,255,255,.07)}',
'.wl-item .wl-k{font-size:10px;letter-spacing:1px;color:#f0a13c;text-transform:uppercase;margin-bottom:4px}',
'.wl-item .wl-v{font-size:13px;color:#c9c5c0;line-height:1.45;word-break:break-word;',
'  max-height:52px;overflow:hidden}',
'.wl-item button{margin-top:7px;background:none;border:none;color:#e2673b;font-size:11px;cursor:pointer;padding:0}',
'.wl-empty{color:#78736d;font-size:13px;line-height:1.6;padding:22px 0}',
'.wl-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(70px);z-index:2147483002;',
'  background:#1c1c22;color:#e8e6e3;padding:11px 20px;border-radius:11px;font-size:13px;',
'  border:1px solid rgba(255,255,255,.14);opacity:0;transition:.3s;pointer-events:none;max-width:88vw}',
'.wl-toast.wl-show{opacity:1;transform:translateX(-50%) translateY(0)}',
'.wl-toast.wl-bad{border-color:#e2673b;color:#ffb9a0}',
'body.wl-editing .wl-hover{outline:2px dashed #f0a13c !important;outline-offset:3px;cursor:text !important}',
'body.wl-editing .wl-live{outline:2px solid #f0a13c !important;outline-offset:3px;',
'  background:rgba(240,161,60,.1) !important;cursor:text !important}',
'body.wl-editing .wl-hover img,body.wl-editing img.wl-hover{cursor:copy !important}',
'body.wl-editing [data-wl-lock]{position:relative}',
'body.wl-editing [data-wl-lock]:hover{outline:1px dashed rgba(160,160,160,.35);outline-offset:6px;cursor:not-allowed}'
].join('');

function ico(d) {
  return '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
         'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
}
var I = {
  pen:   ico('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  list:  ico('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  undo:  ico('<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.5-6.4L3 9.5"/>'),
  save:  ico('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
  done:  ico('<path d="m5 12 5 5 9-10"/>')
};

function buildUI() {
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  var dock = document.createElement('div');
  dock.className = 'wl-dock wl-ed-ui';
  dock.innerHTML =
    '<button id="wl-toggle" title="Edit this lesson">' + I.pen + '</button>' +
    '<button id="wl-open" title="My changes">' + I.list + '<span class="wl-count" id="wl-count" style="display:none">0</span></button>';
  document.body.appendChild(dock);

  var bar = document.createElement('div');
  bar.className = 'wl-bar wl-ed-ui';
  bar.innerHTML =
    '<span class="wl-hint">Click any text or image</span>' +
    '<button id="wl-undo">' + I.undo + ' Undo</button>' +
    '<button id="wl-save">' + I.save + ' Save</button>' +
    '<button id="wl-done" class="wl-primary">' + I.done + ' Done</button>';
  document.body.appendChild(bar);

  var panel = document.createElement('div');
  panel.className = 'wl-panel wl-ed-ui';
  panel.innerHTML =
    '<div class="wl-ph">' +
      '<h3>My changes</h3>' +
      '<p>Saved in this browser only. The original lesson never changes.</p>' +
    '</div>' +
    '<div class="wl-acts">' +
      '<button id="wl-exp">Export</button>' +
      '<button id="wl-imp">Import</button>' +
      '<button id="wl-rev" class="wl-danger">Reset all</button>' +
      '<button id="wl-cls">Close</button>' +
    '</div>' +
    '<div class="wl-list" id="wl-list"></div>';
  document.body.appendChild(panel);

  var toastEl = document.createElement('div');
  toastEl.className = 'wl-toast wl-ed-ui'; toastEl.id = 'wl-toast';
  document.body.appendChild(toastEl);

  document.getElementById('wl-toggle').onclick = function () { setEdit(!S.on); };
  document.getElementById('wl-open').onclick   = function () { panel.classList.toggle('wl-open'); renderList(); };
  document.getElementById('wl-cls').onclick    = function () { panel.classList.remove('wl-open'); };
  document.getElementById('wl-exp').onclick    = exportAll;
  document.getElementById('wl-imp').onclick    = importAll;
  document.getElementById('wl-rev').onclick    = revertAll;
  document.getElementById('wl-undo').onclick   = undo;
  document.getElementById('wl-save').onclick   = saveNow;
  document.getElementById('wl-done').onclick   = finishEditing;
}

function renderList() {
  var box = document.getElementById('wl-list'); if (!box) return;
  var keys = Object.keys(S.text).concat(Object.keys(S.media));
  if (!keys.length) {
    box.innerHTML = '<div class="wl-empty">No changes yet.<br><br>' +
      'Click the pencil, then click any text or image in the lesson.</div>';
  } else {
    box.innerHTML = keys.map(function (k) {
      var isImg = !!S.media[k];
      var val = isImg ? 'Image replaced' : String(S.text[k]).replace(/<[^>]+>/g, ' ').trim();
      return '<div class="wl-item"><div class="wl-k">Scene ' + k.split('|')[0] + (isImg ? ' · image' : ' · text') + '</div>' +
             '<div class="wl-v">' + val.slice(0, 160) + '</div>' +
             '<button data-k="' + k.replace(/"/g, '&quot;') + '">Undo this</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button[data-k]'), function (b) {
      b.onclick = function () { revert(b.getAttribute('data-k')); };
    });
  }
  badge();
}
function badge() {
  var c = document.getElementById('wl-count'); if (!c) return;
  var n = Object.keys(S.text).length + Object.keys(S.media).length;
  c.textContent = n; c.style.display = n ? 'block' : 'none';
}
var toastT;
function toast(msg, bad) {
  var t = document.getElementById('wl-toast'); if (!t) return;
  t.textContent = msg;
  t.className = 'wl-toast wl-ed-ui wl-show' + (bad ? ' wl-bad' : '');
  clearTimeout(toastT);
  toastT = setTimeout(function () { t.className = 'wl-toast wl-ed-ui' + (bad ? ' wl-bad' : ''); }, 2600);
}

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */
function init(opt) {
  opt = opt || {};
  S.lessonId = opt.lessonId || (location.pathname.replace(/[^a-z0-9]+/gi, '-') || 'lesson');
  S.rootSel  = opt.root || 'body';
  S.sceneKey = opt.sceneKey || null;

  var pronto = false;
  function arranca() {
    if (pronto) return;
    pronto = true;
    buildUI();
    applyAll();
    renderList();

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);

    // a aula redesenha a cada cena: reaplica os patches depois de cada render
    observer = new MutationObserver(function () {
      if (applying) return;
      clearTimeout(observer._t);
      observer._t = setTimeout(applyAll, 40);
    });
    observer.observe(root(), { childList: true, subtree: true });

    if (!db) toast('IndexedDB unavailable: text is saved, images are not.', true);
  }

  openDB()
    .then(function (d) { db = d; return restore(); })
    .catch(function (e) {
      db = null;
      try { restore(); } catch (x) {}
      console.warn('WolfEditor: fallback para localStorage —', e);
    })
    .then(arranca, arranca);

  // rede de seguranca: se nada acontecer em 2.5s, abre assim mesmo
  setTimeout(arranca, 2500);
}

global.WolfEditor = {
  init: init,
  export: exportAll,
  import: importAll,
  revertAll: revertAll,
  state: function () { return { text: S.text, media: S.media, hidden: S.hidden }; }
};

})(window);
