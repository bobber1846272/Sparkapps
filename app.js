import { config } from './config.js';
import { createApi, ALL_PERMS } from './api.js?v=15';

// =============================================================
//  Hulpjes
// =============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Alles wat uit de database komt gaat door esc(): zo kan een gebruiker
// met een rare naam nooit code in jouw beheerderspagina uitvoeren.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmtNumber = n => new Intl.NumberFormat('nl-NL').format(n ?? 0);

function fmtDate(iso) {
  if (!iso) return 'nooit';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (diff < 60) return 'zojuist';
  if (diff < 3600) return `${Math.floor(diff / 60)} min geleden`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 864e5);
  if (days === 0) return `vandaag ${time}`;
  if (days === 1) return `gisteren ${time}`;
  if (days < 7) return `${days} dagen geleden`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.round(bytes / 1e3)} kB`;
}

function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const STATUS_LABEL = { live: 'Live', concept: 'Concept', verborgen: 'Verborgen' };

// De Spark-appstore zelf. Zonder deze app kan niemand de andere apps installeren of updaten,
// dus hij staat altijd bovenaan, blijft live en kan niet verwijderd worden.
const STORE_PKG = 'nl.thomas.sparkapps';
const isStoreApp = a => !!a && a.package_name === STORE_PKG;
const storeFirst = list => [...list].sort((a, b) => isStoreApp(b) - isStoreApp(a));
const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z"/></svg>';

function appIcon(app) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(app.color) ? app.color : '#2F4BFF';
  const inner = app.icon_url
    ? `<img src="${esc(app.icon_url)}" alt="">`
    : esc((app.name || '?').charAt(0).toUpperCase());
  return `<span class="app-icon" style="background:${safeColor}" aria-hidden="true">${inner}</span>`;
}

function avatar(u) {
  const photo = u.avatar_url && /^https:\/\//.test(u.avatar_url);
  const inner = photo ? `<img src="${esc(u.avatar_url)}" alt="">` : esc((u.display_name || u.username || '?').charAt(0).toUpperCase());
  return `<span class="avatar" aria-hidden="true">${inner}</span>`;
}

function statusDot(state) {
  return state === 'ok' ? 'dot' : state === 'bad' ? 'dot bad' : 'dot gray';
}

function logDot(action) {
  if (/blokkeerd|verwijderd|afgenomen|uitgezet/i.test(action) && !/gedeblokkeerd/i.test(action)) return 'dot bad';
  if (/Systeem|Nieuw Spark Account/i.test(action)) return 'dot gray';
  return 'dot accent';
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function confirmDialog(title, text, okLabel = 'Ja') {
  const dlg = $('#dlg-confirm');
  $('#dlg-confirm-title').textContent = title;
  $('#dlg-confirm-text').textContent = text;
  $('#dlg-confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

function showError(form, msg) {
  const el = $('[data-error]', form);
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Bezig…';
  try { return await fn(); }
  finally { button.disabled = false; button.textContent = label; }
}

// =============================================================
//  Rechten
// =============================================================
const PERMS = [
  ['apps', 'Apps en updates', 'Apps toevoegen, APK\'s publiceren en store-pagina\'s bewerken'],
  ['store', 'Store-instellingen', 'Labels, slideshow en binnenkort in de appstore'],
  ['announcements', 'Meldingen', 'Een balk of pop-up in de appstore plaatsen'],
  ['requests', 'Aanvragen en feedback', 'Aanvragen en foutmeldingen van de website beantwoorden'],
  ['users', 'Gebruikers', 'Accounts bekijken, goedkeuren en blokkeren'],
  ['users_delete', 'Accounts verwijderen', 'Een account definitief weghalen'],
  ['trips', 'Reizen', 'Gedeelde reizen en meldingen daarover modereren'],
  ['files', 'Bestanden', 'De beheermap met bestanden'],
  ['server', 'Server', 'De status van de server bekijken'],
  ['log', 'Logboek', 'Zien wie wat gedaan heeft'],
];
const PERM_LABEL = Object.fromEntries(PERMS.map(([k, l]) => [k, l]));
const ROLES = {
  beheerder: { label: 'Beheerder', perms: ALL_PERMS, desc: 'Alles, behalve beheerders beheren.' },
  'app-beheerder': { label: 'App-beheerder', perms: ['apps', 'store', 'announcements', 'log'], desc: 'Apps, updates en de store.' },
  moderator: { label: 'Moderator', perms: ['users', 'trips', 'requests', 'announcements'], desc: 'Gebruikers, reizen en aanvragen.' },
  helpdesk: { label: 'Helpdesk', perms: ['requests', 'users'], desc: 'Aanvragen beantwoorden en gebruikers opzoeken.' },
  eigen: { label: 'Eigen keuze', perms: [], desc: 'Jij kiest zelf de vinkjes.' },
};
const ROLE_LABEL = r => r === 'eigenaar' ? 'Eigenaar' : (ROLES[r]?.label || 'Geen rol');
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const isCustomised = (role, perms) => ROLES[role] && role !== 'eigen' && !sameSet([...perms].sort(), [...ROLES[role].perms].sort());

// Welk recht hoort bij welk onderdeel ('owner' = alleen de eigenaar)
const VIEW_PERM = { overzicht: null, apps: 'apps', gebruikers: 'users', meldingen: 'announcements', store: 'store', aanvragen: 'requests',
  logboek: 'log', reizen: 'trips', bestanden: 'files', server: 'server', beheerders: 'owner' };

function can(perm) {
  const a = state.access;
  if (!perm) return true;
  if (!a) return false;
  if (a.owner) return true;
  return perm !== 'owner' && (a.perms || []).includes(perm);
}

// =============================================================
//  Status van de app
// =============================================================
let api;
const state = {
  me: null,
  apps: [],
  users: [],
  stats: null,
  appFilter: 'alle',
  appSearch: '',
  userSearch: '',
  userFilter: 'alle',
  access: null,
  staff: [],
  requests: [],
  reqFilter: 'open',
  reqKind: 'alle',
};

// =============================================================
//  Opstarten en inloggen
// =============================================================
async function boot() {
  try {
    api = await createApi(config);
  } catch (err) {
    $('#boot').innerHTML = `<div class="login-card"><h2>Kan niet starten</h2><p class="error-text">${esc(err.message)}</p></div>`;
    return;
  }
  $('#login-demo').hidden = api.mode !== 'demo';
  $('#mode-pill').hidden = api.mode !== 'demo';
  if (api.mode === 'demo') {
    $('#login-form [name=email]').value = 'beheerder@example.com';
    $('#login-form [name=password]').value = 'demo';
  }
  try {
    state.me = await api.getMe();
  } catch {
    state.me = null;
  }
  $('#boot').hidden = true;
  state.me ? enterApp() : showLogin();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form [name=email]').focus();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const err = $('#login-error');
  err.hidden = true;
  if (!email || !password) {
    err.textContent = 'Vul je e-mail en wachtwoord in.';
    err.hidden = false;
    return;
  }
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.signIn(email, password);
      state.me = await api.getMe();
      form.password.value = '';
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
});
$$('#login-form input').forEach(i => i.addEventListener('input', () => { $('#login-error').hidden = true; }));

async function enterApp() {
  try { state.access = await api.myAccess(); }
  catch { state.access = { owner: false, role: null, perms: [] }; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me-name').innerHTML = esc('@' + (state.me?.username || 'beheerder')) +
    (state.access.role ? ` <span class="pill pill-role">${esc(ROLE_LABEL(state.access.role))}</span>` : '');
  $$('.nav a').forEach(a => { a.hidden = !can(VIEW_PERM[a.dataset.route]); });
  $$('.nav-sec').forEach(sec => { sec.hidden = !$$('a', sec).some(a => !a.hidden); });
  if (!location.hash) history.replaceState(null, '', '#overzicht');
  route();
}

// =============================================================
//  Navigatie
// =============================================================
const VIEWS = {
  overzicht: renderOverview,
  apps: renderApps,
  gebruikers: renderUsers,
  meldingen: renderAnnouncements,
  logboek: renderLog,
  server: renderServer,
  bestanden: renderFiles,
  reizen: renderTrips,
  store: renderStore,
  aanvragen: renderRequests,
  beheerders: renderStaff,
};

async function route() {
  if ($('#app').hidden) return;
  const name = (location.hash || '#overzicht').slice(1);
  const view = VIEWS[name] ? name : 'overzicht';
  $$('.nav a').forEach(a => a.setAttribute('aria-current', a.dataset.route === view ? 'page' : 'false'));
  const el = $('#view');
  if (!can(VIEW_PERM[view])) {
    el.innerHTML = `<header class="page-head"><div><h1>Geen toegang</h1><p class="lead">Je hebt geen recht voor dit onderdeel. Vraag de eigenaar als je het nodig hebt.</p></div></header>`;
    updateCounts();
    return;
  }
  try {
    await VIEWS[view](el);
  } catch (err) {
    el.innerHTML = `<div class="banner banner-error"><span><strong>Laden mislukt.</strong> ${esc(err.message)}</span></div>`;
  }
  updateCounts();
}
window.addEventListener('hashchange', () => { route(); $('#view').focus({ preventScroll: true }); });

async function updateCounts() {
  try {
    if (!state.stats) state.stats = await api.stats();
    $('#count-apps').textContent = state.stats.apps_total;
    $('#count-users').textContent = state.stats.users_total;
  } catch { /* niet belangrijk */ }
  if (can('trips')) try {
    const r = state.mvReports || await api.mvReports('open');
    state.mvReports = r; $('#count-reports').textContent = r.length || '';
  } catch { /* tabel bestaat nog niet */ }
  if (can('requests')) try {
    const n = await api.countNewRequests();
    $('#count-requests').textContent = n || '';
  } catch { /* tabel bestaat nog niet */ }
}

async function refreshData() {
  state.stats = null; state.mvReports = null;
  await route();
}

// =============================================================
//  OVERZICHT
// =============================================================
// Blokken op het overzicht. Je ziet alleen blokken waar je het recht voor hebt;
// welke je daarvan wilt zien en in welke volgorde, kies je zelf (Overzicht aanpassen).
const WIDGETS = [
  { id: 'stats', label: 'Kerncijfers', desc: 'Apps, accounts en downloads', perm: null, full: true },
  { id: 'apps', label: 'Apps', desc: 'De nieuwste apps en versies', perm: 'apps', full: true },
  { id: 'requests', label: 'Aanvragen en feedback', desc: 'Wat er nog open staat', perm: 'requests' },
  { id: 'users', label: 'Nieuwste gebruikers', desc: 'Wie er net een account heeft', perm: 'users' },
  { id: 'server', label: 'Server', desc: 'Draait alles nog?', perm: 'server' },
  { id: 'announce', label: 'Melding in de store', desc: 'Snel een melding plaatsen', perm: 'announcements' },
  { id: 'log', label: 'Logboek', desc: 'Wat er laatst gebeurd is', perm: 'log' },
];

function myPrefs() {
  let p = state.access?.prefs;
  if (!p || typeof p !== 'object' || !Object.keys(p).length) { try { p = JSON.parse(localStorage.getItem('beheer-prefs') || '{}'); } catch { p = {}; } }
  return p || {};
}

// De blokken die deze beheerder mag zien, in zijn eigen volgorde, met aan/uit
function myWidgets() {
  const ov = myPrefs().overview || {};
  const allowed = WIDGETS.filter(w => can(w.perm));
  const order = Array.isArray(ov.order) ? ov.order : [];
  const hidden = Array.isArray(ov.hidden) ? ov.hidden : [];
  const pos = id => { const i = order.indexOf(id); return i < 0 ? 100 + WIDGETS.findIndex(w => w.id === id) : i; };
  return allowed.sort((a, b) => pos(a.id) - pos(b.id)).map(w => ({ ...w, on: !hidden.includes(w.id) }));
}

async function renderOverview(el) {
  const shown = myWidgets().filter(w => w.on);
  const on = id => shown.some(w => w.id === id);
  const none = async () => [];
  const [stats, apps, users, log, server, requests] = await Promise.all([
    api.stats(), on('apps') ? api.listApps() : none(), on('users') ? api.listUsers() : none(),
    on('log') ? api.listLog(6) : none(), can('server') ? api.serverStatus() : none(),
    on('requests') || (on('stats') && can('requests') && !can('server')) ? api.listRequests().catch(() => []) : none(),
  ]);
  state.stats = stats; if (apps.length) state.apps = apps; if (users.length) state.users = users;
  const backup = server.find(s => /back-up/i.test(s.name));
  const openReq = requests.filter(r => r.status === 'nieuw' || r.status === 'bekeken' || r.status === 'bezig');

  const html = {
    stats: () => `<section class="stats" aria-label="Kerncijfers">
      ${statCard('Apps in de store', stats.apps_live, `${fmtNumber(stats.apps_concept)} concept · ${fmtNumber(stats.apps_total)} totaal`)}
      ${statCard('Spark Accounts', stats.users_total, `${fmtNumber(stats.users_new_week)} nieuw deze week`)}
      ${statCard('Downloads deze week', stats.downloads_week, stats.top_app_week ? `Meest: ${esc(stats.top_app_week)}` : 'Nog geen downloads')}
      ${can('server') ? `<div class="stat">
        <span class="lbl">Laatste back-up</span>
        <span class="val ${backup && backup.state === 'ok' ? 'ok' : ''}">${backup && backup.state === 'ok' ? esc(backup.label) : '—'}</span>
        <span class="sub">${backup ? esc(backup.detail) : 'Nog niet ingesteld'}</span>
      </div>` : can('requests') ? statCard('Open aanvragen', openReq.length, `${fmtNumber(requests.filter(r => r.status === 'nieuw').length)} nieuw`) : ''}
    </section>`,
    apps: () => `<section class="card" aria-labelledby="ov-apps">
      <div class="card-head"><h2 id="ov-apps">Apps</h2><a href="#apps">Alle apps beheren</a></div>
      ${appsTable(storeFirst(apps).slice(0, 6), stats.downloads_per_app)}
    </section>`,
    requests: () => `<section class="card" aria-labelledby="ov-req">
      <div class="card-head"><h2 id="ov-req">Aanvragen en feedback</h2><a href="#aanvragen">Alles bekijken</a></div>
      <div class="list">${openReq.slice(0, 4).map(requestRow).join('') || '<p class="empty">Niks open. Lekker bezig!</p>'}</div>
    </section>`,
    users: () => `<section class="card" aria-labelledby="ov-users">
      <div class="card-head"><h2 id="ov-users">Nieuwste gebruikers</h2><a href="#gebruikers">Alle gebruikers</a></div>
      <div class="list">${users.slice(0, 4).map(userRow).join('') || '<p class="empty">Nog geen gebruikers.</p>'}</div>
    </section>`,
    server: () => `<section class="card" aria-labelledby="ov-server">
      <div class="card-head"><h2 id="ov-server">Server</h2><a href="#server">Details</a></div>
      <div class="list">${server.map(serverRow).join('')}</div>
    </section>`,
    announce: () => `<section class="card" aria-labelledby="ov-ann">
      <h2 id="ov-ann">Melding in de store</h2>
      <p style="color:var(--muted);font-size:14px">Verschijnt bovenaan in de Spark-appstore bij iedereen.</p>
      ${announcementForm('ov')}
    </section>`,
    log: () => `<section class="card" aria-labelledby="ov-log">
      <div class="card-head"><h2 id="ov-log">Logboek</h2><a href="#logboek">Volledig logboek</a></div>
      <div class="list">${log.map(logRow).join('') || '<p class="empty">Nog niks gebeurd.</p>'}</div>
    </section>`,
  };

  el.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Overzicht</h1>
        <p class="lead">Alles van sparkapps.nl op één plek.</p>
      </div>
      <div class="row">
        ${can('server') ? serverPill(server) : ''}
        <button type="button" class="btn" data-action="ov-edit">Overzicht aanpassen</button>
        ${can('apps') ? '<button type="button" class="btn btn-primary" data-action="new-app">+ Nieuwe app</button>' : ''}
      </div>
    </header>

    ${state.access?.legacy ? `<div class="banner"><span><strong>Nog één stap voor subbeheerders.</strong> Voer <code>supabase/beheerders_aanvragen.sql</code> uit in Supabase. Tot die tijd werkt Beheer zoals altijd.</span></div>` : ''}
    ${api.mode === 'demo' ? `<div class="banner"><span><strong>Demo-stand.</strong> Je kijkt naar voorbeeldgegevens. Wijzigingen verdwijnen als je de pagina ververst. Vul <code>config.js</code> in om je echte database te koppelen.</span></div>` : ''}

    <div class="ov-grid">
      ${shown.map(w => `<div class="ov-w${w.full ? ' ov-full' : ''}" data-w="${w.id}">${html[w.id]()}</div>`).join('')
        || `<section class="card ov-full"><p class="empty" style="margin:0">Je overzicht is leeg. Kies via <b>Overzicht aanpassen</b> wat je hier wilt zien.</p></section>`}
    </div>`;
}

// ---- Overzicht aanpassen ----
let ovDraft = [];
function openOverviewDialog() {
  ovDraft = myWidgets();
  drawOverviewDialog();
  $('#dlg-ov').showModal();
}
function drawOverviewDialog() {
  const blocked = WIDGETS.filter(w => !can(w.perm));
  $('#ov-list').innerHTML = ovDraft.map((w, i) => `
    <li class="ov-item">
      <label class="ov-check"><input type="checkbox" data-ov-toggle="${w.id}" ${w.on ? 'checked' : ''}>
        <span><b>${esc(w.label)}</b><small>${esc(w.desc)}${w.full ? ' · hele breedte' : ''}</small></span></label>
      <span class="ov-move">
        <button type="button" class="icon-btn" data-ov-move="${i}" data-dir="-1" aria-label="${esc(w.label)} omhoog" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-ov-move="${i}" data-dir="1" aria-label="${esc(w.label)} omlaag" ${i === ovDraft.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
    </li>`).join('');
  $('#ov-blocked').hidden = !blocked.length;
  $('#ov-blocked').textContent = blocked.length ? `Niet voor jou beschikbaar (geen recht): ${blocked.map(w => w.label).join(', ')}.` : '';
}
$('#ov-list').addEventListener('change', e => {
  const id = e.target.dataset.ovToggle; if (!id) return;
  ovDraft.find(w => w.id === id).on = e.target.checked;
});
$('#ov-list').addEventListener('click', e => {
  const b = e.target.closest('[data-ov-move]'); if (!b) return;
  const i = +b.dataset.ovMove, j = i + +b.dataset.dir;
  if (j < 0 || j >= ovDraft.length) return;
  [ovDraft[i], ovDraft[j]] = [ovDraft[j], ovDraft[i]];
  drawOverviewDialog();
  $(`[data-ov-move="${j}"][data-dir="${b.dataset.dir}"]`)?.focus();
});
$('#form-ov').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const prefs = { ...myPrefs(), overview: { order: ovDraft.map(w => w.id), hidden: ovDraft.filter(w => !w.on).map(w => w.id) } };
  await busy($('button[type=submit]', form), async () => {
    try {
      const where = await api.savePrefs(prefs);
      state.access = { ...state.access, prefs };
      $('#dlg-ov').close();
      toast(where === 'local' ? 'Opgeslagen in deze browser' : 'Je overzicht is opgeslagen');
      route();
    } catch (err) { showError(form, err.message); }
  });
});

function statCard(label, value, sub) {
  return `<div class="stat"><span class="lbl">${esc(label)}</span><span class="val">${fmtNumber(value)}</span><span class="sub">${sub}</span></div>`;
}

function serverPill(server) {
  const bad = server.some(s => s.state === 'bad');
  const allOk = server.every(s => s.state === 'ok');
  if (bad) return `<span class="pill pill-blocked"><span class="dot bad"></span>Storing</span>`;
  if (allOk) return `<span class="pill pill-live"><span class="dot"></span>Server online</span>`;
  return `<span class="pill pill-live"><span class="dot"></span>Database online</span>`;
}

// =============================================================
//  APPS
// =============================================================
function appsTable(apps, downloadsPerApp = {}) {
  if (!apps.length) return '<p class="empty">Geen apps gevonden.</p>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th scope="col">App</th><th scope="col">Versie</th><th scope="col">Status</th>
          <th scope="col">Bijgewerkt</th><th scope="col" class="num">Downloads</th><th scope="col" class="num">Acties</th>
        </tr></thead>
        <tbody>
          ${storeFirst(apps).map(a => `
            <tr${isStoreApp(a) ? ' class="row-core"' : ''}>
              <td><div class="app-cell">${appIcon(a)}<div><div class="t">${esc(a.name)} ${isStoreApp(a) ? `<span class="pill pill-core">${PIN_SVG}Appstore</span>` : ''}</div><div class="s">${esc(a.tagline || a.slug)}</div></div></div></td>
              <td>${a.latest ? esc(a.latest.version_name) : '<span style="color:var(--muted)">Geen APK</span>'}</td>
              <td><span class="pill pill-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></td>
              <td style="color:var(--ink-2)">${fmtDate(a.latest ? a.latest.created_at : a.updated_at)}</td>
              <td class="num">${fmtNumber(downloadsPerApp[a.id] || 0)}</td>
              <td class="actions">
                <button type="button" class="btn btn-sm" data-action="new-version" data-id="${esc(a.id)}" aria-label="Update publiceren voor ${esc(a.name)}">Update</button>
                <button type="button" class="btn btn-sm" data-action="edit-page" data-id="${esc(a.id)}" aria-label="Store-pagina van ${esc(a.name)}">Store-pagina</button>
                <button type="button" class="btn btn-sm btn-link" data-action="edit-app" data-id="${esc(a.id)}" aria-label="${esc(a.name)} bewerken">Bewerken</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function renderApps(el) {
  const [apps, stats] = await Promise.all([api.listApps(), api.stats()]);
  state.apps = apps; state.stats = stats;
  drawApps(el);
}

function storeCard() {
  const s = state.apps.find(isStoreApp);
  if (!s) return `
    <section class="card card-core" aria-labelledby="core-t">
      <div class="core-head">
        <span class="app-icon" style="background:#12285A" aria-hidden="true">S</span>
        <div class="grow"><h2 id="core-t">${PIN_SVG} De appstore staat nog niet in Beheer</h2>
          <p class="core-sub">Zet Spark Apps (<code>${STORE_PKG}</code>) hier neer. Dan kun je de store updaten en werkt de downloadknop op de website.</p></div>
        <button type="button" class="btn btn-primary" data-action="add-store">Appstore toevoegen</button>
      </div>
    </section>`;
  const v = s.latest;
  return `
    <section class="card card-core" aria-labelledby="core-t">
      <div class="core-head">
        ${appIcon(s)}
        <div class="grow">
          <h2 id="core-t">${esc(s.name)} <span class="pill pill-core">${PIN_SVG}Vastgezet · de appstore</span></h2>
          <p class="core-sub">Hiermee installeren en updaten mensen alle andere apps. Hij blijft altijd live en kan niet verwijderd worden.</p>
        </div>
      </div>
      <div class="core-facts">
        <div><span>Versie</span><b>${v ? `${esc(v.version_name)} <small>(code ${esc(v.version_code)})</small>` : 'Nog geen APK'}</b></div>
        <div><span>Status</span><b><span class="pill pill-${esc(s.status)}">${esc(STATUS_LABEL[s.status] || s.status)}</span></b></div>
        <div><span>Bijgewerkt</span><b>${fmtDate(v ? v.created_at : s.updated_at)}</b></div>
        <div><span>Downloads</span><b>${fmtNumber(state.stats?.downloads_per_app?.[s.id] || 0)}</b></div>
      </div>
      ${s.status !== 'live' ? `<div class="banner banner-error"><span><strong>De appstore staat niet live.</strong> Niemand kan hem nu downloaden. Zet hem via Bewerken weer op Live.</span></div>` : ''}
      <div class="row">
        <button type="button" class="btn btn-primary" data-action="new-version" data-id="${esc(s.id)}">Store-update publiceren</button>
        <button type="button" class="btn" data-action="edit-page" data-id="${esc(s.id)}">Store-pagina</button>
        <button type="button" class="btn btn-link" data-action="edit-app" data-id="${esc(s.id)}">Bewerken</button>
      </div>
    </section>`;
}

function drawApps(el) {
  const q = state.appSearch.toLowerCase();
  const others = state.apps.filter(a => !isStoreApp(a));
  const list = others.filter(a =>
    (state.appFilter === 'alle' || a.status === state.appFilter) &&
    (!q || a.name.toLowerCase().includes(q) || a.slug.includes(q)));
  const count = s => others.filter(a => s === 'alle' || a.status === s).length;

  el.innerHTML = `
    <header class="page-head">
      <div><h1>Apps</h1><p class="lead">Wat er in de Spark-appstore staat.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-app">+ Nieuwe app</button>
    </header>
    ${storeCard()}
    <section class="card" aria-label="Lijst met apps">
      <div class="card-head">
        <div class="filters" role="group" aria-label="Filter op status">
          ${['alle', 'live', 'concept', 'verborgen'].map(s => `
            <button type="button" class="chip" data-action="app-filter" data-value="${s}" aria-pressed="${state.appFilter === s}">
              ${s === 'alle' ? 'Alle' : STATUS_LABEL[s]} (${count(s)})
            </button>`).join('')}
        </div>
        <label style="flex:0 1 260px"><span class="sr-only">Zoek een app</span>
          <input type="search" id="app-search" placeholder="Zoek een app" value="${esc(state.appSearch)}">
        </label>
      </div>
      ${appsTable(list, state.stats?.downloads_per_app)}
    </section>`;

  const search = $('#app-search', el);
  search.addEventListener('input', () => {
    state.appSearch = search.value;
    const pos = search.selectionStart;
    drawApps(el);
    const s2 = $('#app-search', el); s2.focus(); s2.setSelectionRange(pos, pos);
  });
}

function openAppDialog(app, preset) {
  const dlg = $('#dlg-app');
  const form = $('#form-app');
  form.reset();
  showError(form, '');
  if (!app && preset) app = { ...preset, id: '' };
  $('#dlg-app-title').textContent = app ? `${app.name} bewerken` : 'Nieuwe app';
  form.id.value = app?.id || '';
  form.icon_url.value = app?.icon_url || '';
  form.name.value = app?.name || '';
  form.slug.value = app?.slug || '';
  form.slug.dataset.touched = app ? '1' : '';
  form.package_name.value = app?.package_name || '';
  form.tagline.value = app?.tagline || '';
  form.description.value = app?.description || '';
  form.status.value = app?.status || 'concept';
  form.sort_order.value = app?.sort_order ?? state.apps.length;
  form.color.value = app?.color || '#2F4BFF';
  const core = isStoreApp(app);
  form.dataset.core = core ? '1' : '';
  $('[data-action=delete-app]', form).hidden = !app?.id || core;
  form.package_name.readOnly = core;
  $$('option', form.status).forEach(o => { o.disabled = core && o.value !== 'live'; });
  if (core) form.status.value = 'live';
  $('#app-core-note').hidden = !core;
  dlg.showModal();
  form.name.focus();
}

$('#form-app').name.addEventListener('input', e => {
  const form = $('#form-app');
  if (!form.slug.dataset.touched) form.slug.value = slugify(e.target.value);
});
$('#form-app').slug.addEventListener('input', e => { e.target.dataset.touched = '1'; });

$('#form-app').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const name = form.name.value.trim();
  const slug = form.slug.value.trim();
  const icon = form.icon.files[0];
  if (!name) return showError(form, 'Geef de app een naam.');
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return showError(form, 'De korte naam mag alleen kleine letters, cijfers en - bevatten (2 tot 40 tekens).');
  const pkg = form.package_name.value.trim();
  if (pkg && !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg)) return showError(form, 'Het Android-pakket ziet er niet goed uit. Voorbeeld: nl.thomas.potje');
  if (icon && icon.size > 1048576) return showError(form, 'Het icoon is groter dan 1 MB.');
  if (form.dataset.core && pkg !== STORE_PKG) return showError(form, `Het pakket van de appstore moet ${STORE_PKG} blijven.`);
  if (form.dataset.core && form.status.value !== 'live') return showError(form, 'De appstore moet live blijven, anders kan niemand hem downloaden.');
  showError(form, '');
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.saveApp({
        id: form.id.value || null, name, slug, package_name: pkg || null,
        tagline: form.tagline.value.trim(), description: form.description.value.trim(),
        status: form.status.value, sort_order: parseInt(form.sort_order.value, 10) || 0,
        color: form.color.value, icon_url: form.icon_url.value || null, iconFile: icon || null,
      });
      $('#dlg-app').close();
      const isNew = !form.id.value;
      toast(isNew ? 'App toegevoegd. Vul nu de store-pagina in' : 'App opgeslagen');
      await refreshData();
      if (isNew) {
        if (!state.apps.some(a => a.slug === slug)) state.apps = await api.listApps();
        const fresh = state.apps.find(a => a.slug === slug);
        if (fresh) openPageDialog(fresh);
      }
    } catch (err) {
      showError(form, err.message);
    }
  });
});

function openVersionDialog(app) {
  const dlg = $('#dlg-version');
  const form = $('#form-version');
  form.reset();
  showError(form, '');
  form.dataset.appId = app.id;
  $('#dlg-version-title').textContent = `Update voor ${app.name}`;
  $('#dlg-version-lead').textContent = app.latest
    ? `Huidige versie: ${app.latest.version_name} (code ${app.latest.version_code})`
    : 'Dit wordt de eerste versie van deze app.';
  form.version_code.value = (app.latest?.version_code || 0) + 1;
  dlg.showModal();
  form.version_name.focus();
}

$('#form-version').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const app = state.apps.find(a => a.id === form.dataset.appId);
  const version_name = form.version_name.value.trim();
  const version_code = parseInt(form.version_code.value, 10);
  const file = form.apk.files[0];
  if (!version_name) return showError(form, 'Vul een versie in, bijvoorbeeld 1.2.0.');
  if (!Number.isInteger(version_code) || version_code < 1) return showError(form, 'De versiecode moet een heel getal van 1 of hoger zijn.');
  if (app.latest && version_code <= app.latest.version_code) return showError(form, `De versiecode moet hoger zijn dan ${app.latest.version_code}, anders kan Android de update niet installeren.`);
  if (!file) return showError(form, 'Kies het APK-bestand.');
  if (!/\.apk$/i.test(file.name)) return showError(form, 'Dit is geen .apk-bestand.');
  if (file.size > 209715200) return showError(form, 'De APK is groter dan 200 MB.');
  showError(form, '');
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.publishVersion(app, { version_name, version_code, changelog: form.changelog.value.trim(), file });
      $('#dlg-version').close();
      toast(`${app.name} ${version_name} gepubliceerd`);
      refreshData();
    } catch (err) {
      showError(form, err.message);
    }
  });
});

// =============================================================
//  GEBRUIKERS
// =============================================================
function userRow(u) {
  const isMe = u.username === state.me?.username;
  return `
    <div class="list-item">
      ${avatar(u)}
      <div class="who-block">
        <span class="t">${esc(u.display_name)} ${u.is_admin ? '<span class="pill pill-admin">Beheerder</span>' : ''} ${u.is_blocked ? '<span class="pill pill-blocked">Geblokkeerd</span>' : ''} ${u.email_confirmed_at ? '' : '<span class="pill pill-concept">Niet bevestigd</span>'}</span>
        <span class="s">@${esc(u.username)} · lid sinds ${fmtDate(u.created_at)}</span>
      </div>
      ${u.email_confirmed_at || !can('users') ? '' : `<button type="button" class="btn btn-sm btn-primary" data-action="confirm-user" data-id="${esc(u.id)}">Goedkeuren</button>`}
      <button type="button" class="btn btn-sm" data-action="view-user" data-id="${esc(u.id)}">Bekijken</button>
      ${isMe || !can('users') || (u.is_admin && !state.access?.owner) ? '' : u.is_blocked
        ? `<button type="button" class="btn btn-sm" data-action="unblock" data-id="${esc(u.id)}">Deblokkeren</button>`
        : `<button type="button" class="btn btn-sm btn-danger" data-action="block" data-id="${esc(u.id)}">Blokkeren</button>`}
    </div>`;
}

async function renderUsers(el) {
  state.users = await api.listUsers();
  drawUsers(el);
}

function drawUsers(el) {
  const q = state.userSearch.toLowerCase();
  const list = state.users.filter(u =>
    (state.userFilter === 'alle' || (state.userFilter === 'geblokkeerd' ? u.is_blocked : state.userFilter === 'wachtend' ? !u.email_confirmed_at : u.is_admin)) &&
    (!q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)));
  const counts = { alle: state.users.length, wachtend: state.users.filter(u => !u.email_confirmed_at).length, geblokkeerd: state.users.filter(u => u.is_blocked).length, beheerders: state.users.filter(u => u.is_admin).length };

  el.innerHTML = `
    <header class="page-head">
      <div><h1>Gebruikers</h1><p class="lead">Iedereen met een Spark Account.</p></div>
    </header>
    <section class="card" aria-label="Lijst met gebruikers">
      <div class="card-head">
        <div class="filters" role="group" aria-label="Filter gebruikers">
          ${[['alle', 'Alle'], ['wachtend', 'Niet bevestigd'], ['geblokkeerd', 'Geblokkeerd'], ['beheerders', 'Beheerders']].map(([v, l]) => `
            <button type="button" class="chip" data-action="user-filter" data-value="${v}" aria-pressed="${state.userFilter === v}">${l} (${counts[v]})</button>`).join('')}
        </div>
        <label style="flex:0 1 280px"><span class="sr-only">Zoek een gebruiker</span>
          <input type="search" id="user-search" placeholder="Naam, @gebruikersnaam of e-mail" value="${esc(state.userSearch)}">
        </label>
      </div>
      <div class="list">${list.map(userRow).join('') || '<p class="empty">Niemand gevonden.</p>'}</div>
    </section>`;

  const search = $('#user-search', el);
  search.addEventListener('input', () => {
    state.userSearch = search.value;
    const pos = search.selectionStart;
    drawUsers(el);
    const s2 = $('#user-search', el); s2.focus(); s2.setSelectionRange(pos, pos);
  });
}

function openUserDialog(u) {
  $('#dlg-user-title').textContent = u.display_name;
  $('#dlg-user-body').innerHTML = `
    <div class="list">
      <div class="list-item">${avatar(u)}<div class="who-block"><span class="t">${esc(u.display_name)}</span><span class="s">@${esc(u.username)}</span></div></div>
      <div class="list-item"><div class="who-block"><span class="s">E-mail</span><span class="t">${esc(u.email || '—')}</span></div></div>
      <div class="list-item"><div class="who-block"><span class="s">Lid sinds</span><span class="t">${fmtDate(u.created_at)}</span></div></div>
      <div class="list-item"><div class="who-block"><span class="s">Laatst ingelogd</span><span class="t">${fmtDate(u.last_sign_in_at)}</span></div></div>
      <div class="list-item"><div class="who-block"><span class="s">E-mail bevestigd</span><span class="t">${u.email_confirmed_at ? fmtDate(u.email_confirmed_at) : 'Nog niet'}</span></div></div>
      <div class="list-item"><div class="who-block"><span class="s">Status</span><span class="t">${u.is_blocked ? 'Geblokkeerd' : 'Actief'}${u.is_admin ? ' · Beheerder' : ''}</span></div></div>
    </div>
    <div class="dlg-foot">
      ${u.is_admin || u.username === state.me?.username || !can('users_delete') ? '' : `<button type="button" class="btn btn-danger" data-action="delete-user" data-id="${esc(u.id)}">Account verwijderen</button>`}
      <span style="flex:1"></span>
      ${state.access?.owner && u.username !== state.me?.username && !u.is_blocked
        ? `<button type="button" class="btn" data-action="staff-edit" data-id="${esc(u.id)}">${u.is_admin ? 'Rechten wijzigen' : 'Beheerder maken'}</button>` : ''}
      <button type="button" class="btn" data-action="reset-pw" data-id="${esc(u.id)}">Wachtwoord-reset mailen</button>
    </div>`;
  $('#dlg-user').showModal();
}


// =============================================================
//  AANVRAGEN (van de website)
// =============================================================
const REQ_KIND = { app: 'App-aanvraag', fout: 'Fout', feedback: 'Feedback' };
const REQ_STATUS = { nieuw: 'Nieuw', bekeken: 'Bekeken', bezig: 'Mee bezig', klaar: 'Klaar', afgewezen: 'Afgewezen' };
const REQ_PILL = { nieuw: 'pill-admin', bekeken: 'pill-verborgen', bezig: 'pill-concept', klaar: 'pill-live', afgewezen: 'pill-blocked' };
const REQ_ICON = {
  app: '<path d="M12 3l2.4 5.6L20 9.2l-4.4 3.9 1.3 5.9L12 16l-4.9 3 1.3-5.9L4 9.2l5.6-.6z"/>',
  fout: '<path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  feedback: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};
const reqIcon = k => `<span class="req-ic req-${esc(k)}" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${REQ_ICON[k] || REQ_ICON.feedback}</svg></span>`;

function requestRow(r) {
  return `
    <div class="list-item">
      ${reqIcon(r.kind)}
      <div class="who-block">
        <span class="t">${esc(r.title)}</span>
        <span class="s">${esc(REQ_KIND[r.kind] || r.kind)}${r.app_name ? ' · ' + esc(r.app_name) : ''} · ${r.user ? '@' + esc(r.user.username) : 'onbekend'} · ${fmtDate(r.created_at)}${r.reply ? ' · beantwoord' : ''}</span>
      </div>
      <span class="pill ${REQ_PILL[r.status] || ''}">${esc(REQ_STATUS[r.status] || r.status)}</span>
      <button type="button" class="btn btn-sm" data-action="req-open" data-id="${esc(r.id)}">Openen</button>
    </div>`;
}

async function renderRequests(el) {
  state.requests = await api.listRequests();
  drawRequests(el);
}

function drawRequests(el) {
  const groups = { open: ['nieuw', 'bekeken', 'bezig'], nieuw: ['nieuw'], klaar: ['klaar', 'afgewezen'], alle: Object.keys(REQ_STATUS) };
  const inKind = r => state.reqKind === 'alle' || r.kind === state.reqKind;
  const list = state.requests.filter(r => groups[state.reqFilter].includes(r.status) && inKind(r));
  const count = g => state.requests.filter(r => groups[g].includes(r.status) && inKind(r)).length;
  el.innerHTML = `
    <header class="page-head">
      <div><h1>Aanvragen</h1><p class="lead">Ideeën voor apps, foutmeldingen en feedback van sparkapps.nl. De afzender ziet je antwoord en de status op zijn account.</p></div>
    </header>
    <section class="card" aria-label="Lijst met aanvragen">
      <div class="card-head">
        <div class="filters" role="group" aria-label="Filter op status">
          ${[['open', 'Open'], ['nieuw', 'Nieuw'], ['klaar', 'Afgerond'], ['alle', 'Alles']].map(([v, l]) => `
            <button type="button" class="chip" data-action="req-filter" data-value="${v}" aria-pressed="${state.reqFilter === v}">${l} (${count(v)})</button>`).join('')}
        </div>
        <div class="filters" role="group" aria-label="Filter op soort">
          ${[['alle', 'Alle soorten'], ['app', 'App-aanvragen'], ['fout', 'Fouten'], ['feedback', 'Feedback']].map(([v, l]) => `
            <button type="button" class="chip" data-action="req-kind" data-value="${v}" aria-pressed="${state.reqKind === v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="list">${list.map(requestRow).join('') || '<p class="empty">Niks gevonden.</p>'}</div>
    </section>`;
}

function openRequestDialog(r) {
  const form = $('#form-req');
  form.reset(); showError(form, '');
  form.dataset.id = r.id;
  $('#dlg-req-title').textContent = r.title;
  $('#req-meta').innerHTML = `
    <div class="list-item">${reqIcon(r.kind)}<div class="who-block"><span class="t">${esc(REQ_KIND[r.kind] || r.kind)}${r.app_name ? ' · ' + esc(r.app_name) : ''}</span>
      <span class="s">Van ${r.user ? `${esc(r.user.display_name || r.user.username)} (@${esc(r.user.username)})` : 'onbekend'} · ${fmtDate(r.created_at)}</span></div></div>
    ${r.body ? `<div class="req-body">${esc(r.body)}</div>` : '<p class="empty" style="margin:0">Geen extra uitleg.</p>'}
    ${r.device ? `<p class="req-device">Toestel: ${esc(r.device)}</p>` : ''}`;
  form.status.value = r.status;
  form.reply.value = r.reply || '';
  $('#dlg-req').showModal();
}

$('#form-req').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const r = state.requests.find(x => x.id === form.dataset.id);
  let status = form.status.value;
  const reply = form.reply.value.trim();
  if (reply && status === 'nieuw') status = 'bekeken';
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.updateRequest(r.id, { status, reply: reply || null });
      $('#dlg-req').close();
      toast(reply && reply !== (r.reply || '') ? 'Antwoord verstuurd' : 'Opgeslagen');
      route();
    } catch (err) { showError(form, err.message); }
  });
});

// =============================================================
//  BEHEERDERS (alleen de eigenaar)
// =============================================================
async function renderStaff(el) {
  const [staff, users] = await Promise.all([api.listStaff(), api.listUsers()]);
  state.staff = staff; state.users = users;
  const permChips = perms => perms.length ? perms.map(p => `<span class="perm-chip">${esc(PERM_LABEL[p] || p)}</span>`).join('') : '<span class="perm-chip off">Nog geen rechten</span>';
  el.innerHTML = `
    <header class="page-head">
      <div><h1>Beheerders</h1><p class="lead">Wie mag wat in Beheer. Alleen jij als eigenaar kunt dit aanpassen.</p></div>
      <button type="button" class="btn btn-primary" data-action="staff-add">+ Beheerder toevoegen</button>
    </header>
    <section class="card" aria-label="Lijst met beheerders">
      <div class="list">
        ${staff.map(s => `
          <div class="list-item staff-item">
            ${avatar({ display_name: s.display_name, username: s.username, avatar_url: s.avatar_url })}
            <div class="who-block">
              <span class="t">${esc(s.display_name || s.username)}
                <span class="pill ${s.role === 'eigenaar' ? 'pill-core' : 'pill-admin'}">${esc(ROLE_LABEL(s.role))}${isCustomised(s.role, s.perms) ? ' · aangepast' : ''}</span>
                ${s.is_blocked ? '<span class="pill pill-blocked">Geblokkeerd</span>' : ''}</span>
              <span class="s">@${esc(s.username)}${s.role === 'eigenaar' ? ' · mag alles, ook beheerders beheren' : ''}</span>
              ${s.role === 'eigenaar' ? '' : `<span class="perm-chips">${permChips(s.perms)}</span>`}
            </div>
            ${s.role === 'eigenaar' ? '' : `
              <button type="button" class="btn btn-sm" data-action="staff-edit" data-id="${esc(s.user_id)}">Rechten</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="staff-remove" data-id="${esc(s.user_id)}">Weghalen</button>`}
          </div>`).join('')}
      </div>
    </section>
    <section class="card" aria-labelledby="roles-t">
      <h2 id="roles-t">De rollen</h2>
      <p style="color:var(--muted);font-size:14px;margin-top:0">Een rol zet de vinkjes voor je aan. Per persoon kun je daarna nog vinkjes aan- of uitzetten.</p>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Rol</th>${PERMS.map(([k, l]) => `<th scope="col" class="perm-col">${esc(l)}</th>`).join('')}</tr></thead>
        <tbody>${Object.entries(ROLES).filter(([k]) => k !== 'eigen').map(([k, r]) => `
          <tr><td><b>${esc(r.label)}</b><div class="s" style="color:var(--muted);font-size:13px">${esc(r.desc)}</div></td>
            ${PERMS.map(([p]) => `<td class="perm-col">${r.perms.includes(p) ? '<span class="yes" aria-label="ja">✓</span>' : '<span class="no" aria-label="nee">–</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table></div>
    </section>`;
}

function openStaffDialog(userId) {
  const form = $('#form-staff');
  form.reset(); showError(form, '');
  const s = state.staff.find(x => x.user_id === userId);
  const u = state.users.find(x => x.id === userId);
  form.user.value = userId || '';
  $('#dlg-staff-title').textContent = userId ? `Rechten van ${u?.display_name || s?.display_name || 'beheerder'}` : 'Beheerder toevoegen';
  $('#staff-pick').hidden = !!userId;
  $('#staff-who').innerHTML = userId ? `<div class="list-item">${avatar(u || { display_name: s?.display_name, username: s?.username })}<div class="who-block"><span class="t">${esc(u?.display_name || s?.display_name)}</span><span class="s">@${esc(u?.username || s?.username)}</span></div></div>` : '';
  $('#staff-search').value = '';
  drawStaffPick();
  const role = s?.role && ROLES[s.role] ? s.role : 'moderator';
  form.role.value = role;
  $('#staff-perms').innerHTML = PERMS.map(([k, l, d]) => `
    <label class="perm-opt"><input type="checkbox" name="perm" value="${k}"><span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`).join('');
  setPermBoxes(s ? s.perms : ROLES[role].perms);
  $('#dlg-staff').showModal();
  (userId ? form.role : $('#staff-search')).focus();
}

function setPermBoxes(perms) {
  $$('#staff-perms input').forEach(i => { i.checked = perms.includes(i.value); });
  updateRoleNote();
}
function updateRoleNote() {
  const form = $('#form-staff');
  const perms = $$('#staff-perms input:checked').map(i => i.value);
  $('#staff-role-note').textContent = isCustomised(form.role.value, perms) ? `${ROLE_LABEL(form.role.value)}, met jouw aanpassingen` : ROLES[form.role.value]?.desc || '';
}

function drawStaffPick() {
  const form = $('#form-staff');
  const q = $('#staff-search').value.trim().toLowerCase();
  const pool = state.users.filter(u => !u.is_admin && !u.is_blocked && u.username !== state.me?.username &&
    (!q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)));
  $('#staff-results').innerHTML = pool.slice(0, 6).map(u => `
    <label class="pick-opt"><input type="radio" name="pick" value="${esc(u.id)}" ${form.user.value === u.id ? 'checked' : ''}>
      ${avatar(u)}<span class="who-block"><span class="t">${esc(u.display_name)}</span><span class="s">@${esc(u.username)}</span></span></label>`).join('')
    || '<p class="empty">Niemand gevonden. De persoon moet eerst een Spark Account hebben.</p>';
}

$('#staff-search').addEventListener('input', drawStaffPick);
$('#staff-results').addEventListener('change', e => { if (e.target.name === 'pick') $('#form-staff').user.value = e.target.value; });
$('#form-staff').role.addEventListener('change', e => setPermBoxes(ROLES[e.target.value].perms));
$('#staff-perms').addEventListener('change', updateRoleNote);

$('#form-staff').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const userId = form.user.value;
  const perms = $$('#staff-perms input:checked').map(i => i.value);
  if (!userId) return showError(form, 'Kies eerst wie beheerder wordt.');
  if (!perms.length) return showError(form, 'Zet minstens één vinkje aan.');
  const u = state.users.find(x => x.id === userId);
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.setStaff(userId, form.role.value, perms);
      $('#dlg-staff').close();
      toast(`${u ? '@' + u.username : 'Beheerder'} opgeslagen`);
      $('#dlg-user')?.close();
      route();
    } catch (err) { showError(form, err.message); }
  });
});

// =============================================================
//  MELDINGEN
// =============================================================
function announcementForm(prefix) {
  return `
    <form class="ann-form" data-form="announcement" novalidate style="display:flex;flex-direction:column;gap:12px">
      <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
        <legend style="font-size:14px;font-weight:500;padding:0;margin-bottom:8px">Hoe tonen?</legend>
        <div class="filters">
          <label class="chip" style="display:inline-flex;align-items:center;gap:8px"><input type="radio" name="style" value="banner" checked> Balk bovenaan</label>
          <label class="chip" style="display:inline-flex;align-items:center;gap:8px"><input type="radio" name="style" value="popup"> Pop-up op het hele scherm</label>
        </div>
      </fieldset>
      <label class="field" data-popup-only hidden><span>Titel van de pop-up</span>
        <input type="text" name="title" maxlength="60" placeholder="Bijv. Nieuwe app!">
      </label>
      <label class="field" for="${prefix}-ann"><span>Bericht</span></label>
      <textarea id="${prefix}-ann" name="message" rows="3" maxlength="280" placeholder="Bijv. Nieuwe app: Henk Herstelt!"></textarea>
      <p class="error-text" data-error role="alert" hidden></p>
      <div class="row"><button type="submit" class="btn btn-primary">Plaatsen</button><small style="color:var(--muted)">Max. 280 tekens. Een pop-up ziet iedereen één keer.</small></div>
    </form>`;
}

document.addEventListener('change', e => {
  if (e.target.name !== 'style') return;
  const form = e.target.closest('[data-form=announcement]');
  if (form) $('[data-popup-only]', form).hidden = e.target.value !== 'popup';
});

async function renderAnnouncements(el) {
  const items = await api.listAnnouncements();
  el.innerHTML = `
    <header class="page-head"><div><h1>Meldingen</h1><p class="lead">Berichten in de Spark-appstore: als balk bovenaan of als pop-up.</p></div></header>
    <section class="card" aria-labelledby="ann-new"><h2 id="ann-new">Nieuwe melding</h2>${announcementForm('page')}</section>
    <section class="card" aria-labelledby="ann-list">
      <h2 id="ann-list">Alle meldingen</h2>
      <div class="list">
        ${items.map(a => `
          <div class="list-item">
            <div class="who-block">
              <span class="t">${a.title ? `<strong>${esc(a.title)}</strong> · ` : ''}${esc(a.message)}</span>
              <span class="s">${a.style === 'popup' ? 'Pop-up' : 'Balk bovenaan'} · ${fmtDate(a.created_at)}</span>
            </div>
            <span class="pill ${a.active ? 'pill-live' : 'pill-verborgen'}">${a.active ? 'Zichtbaar' : 'Uit'}</span>
            <button type="button" class="btn btn-sm" data-action="toggle-ann" data-id="${esc(a.id)}" data-active="${a.active}">${a.active ? 'Uitzetten' : 'Weer aanzetten'}</button>
          </div>`).join('') || '<p class="empty">Nog geen meldingen.</p>'}
      </div>
    </section>`;
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form=announcement]');
  if (!form) return;
  e.preventDefault();
  const message = form.message.value.trim();
  const style = form.querySelector('[name=style]:checked').value;
  const title = form.title.value.trim();
  if (!message) return showError(form, 'Typ eerst een bericht.');
  showError(form, '');
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.postAnnouncement({ message, style, title: style === 'popup' && title ? title : null });
      form.reset();
      $('[data-popup-only]', form).hidden = true;
      toast('Melding geplaatst');
      refreshData();
    } catch (err) {
      showError(form, err.message);
    }
  });
});
document.addEventListener('input', e => {
  const form = e.target.closest('[data-form=announcement], #form-app, #form-version');
  if (form) showError(form, '');
});

// =============================================================
//  LOGBOEK
// =============================================================
function logRow(l) {
  return `
    <div class="log-item">
      <span class="${logDot(l.action + ' ' + l.actor_name)}"></span>
      <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span class="t">${esc(l.action)}${l.target ? ` <span style="color:var(--muted)">·</span> ${esc(l.target)}` : ''}</span>
        <span class="s">${esc(l.actor_name || 'Systeem')} · ${fmtDate(l.created_at)}</span>
      </div>
    </div>`;
}

async function renderLog(el) {
  const log = await api.listLog(200);
  el.innerHTML = `
    <header class="page-head"><div><h1>Logboek</h1><p class="lead">Elke beheerdersactie wordt automatisch vastgelegd en kan niet aangepast worden.</p></div></header>
    <section class="card" aria-label="Logboek"><div class="list">${log.map(logRow).join('') || '<p class="empty">Nog niks gebeurd.</p>'}</div></section>`;
}

// =============================================================
//  BESTANDEN (privé-map, alleen voor beheerders)
// =============================================================
function cleanFileName(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^A-Za-z0-9._()-]/g, '').replace(/^\.+/, '').slice(0, 120) || 'bestand';
}
function cleanFolder(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

// =============================================================
//  REIZEN (Mijn Vakanties): meldingen en openbare reizen
// =============================================================
const SITE_TRIP = id => `https://sparkapps.nl/reizen/?t=${encodeURIComponent(id)}`;
async function renderTrips(el) {
  const [reports, trips] = await Promise.all([api.mvReports('open'), api.mvPublicList()]);
  state.mvReports = reports; state.mvTrips = trips;
  el.innerHTML = `
    <header class="page-head"><div><h1>Reizen</h1><p class="lead">Openbare reizen uit Mijn Vakanties, en wat mensen gemeld hebben.</p></div>
      <button type="button" class="btn" data-action="refresh">Vernieuwen</button></header>
    <section class="card" aria-labelledby="rep-h">
      <h2 id="rep-h">Meldingen ${reports.length ? `<span class="pill pill-blocked">${reports.length} open</span>` : ''}</h2>
      <div class="list">${reports.map(r => `
        <div class="list-item" style="align-items:flex-start">
          <div class="who-block" style="flex:1 1 260px;min-width:0">
            <span class="t"><strong>${esc(r.reason)}</strong></span>
            <span class="s">Gemeld door ${esc(r.reporter || '?')} · ${fmtDate(r.created_at)} · reis <a href="${SITE_TRIP(r.trip_id)}" target="_blank" rel="noopener">${esc(r.trip_title || r.trip_id)}</a> van @${esc(r.trip_owner?.username || '?')}</span>
            ${r.comment ? `<span class="t" style="margin-top:6px;padding:8px 10px;border-radius:8px;background:var(--gray-bg)">💬 @${esc(r.comment.user?.username || '?')}: “${esc(r.comment.body)}”${r.comment.hidden ? ' <em>(verborgen)</em>' : ''}</span>` : ''}
          </div>
          <div class="row" style="gap:6px">
            ${r.comment ? `<button type="button" class="btn btn-sm" data-action="mv-hide-comment" data-id="${esc(r.comment.id)}" data-value="${r.comment.hidden ? '0' : '1'}">${r.comment.hidden ? 'Reactie terugzetten' : 'Reactie verbergen'}</button>` : ''}
            <button type="button" class="btn btn-sm" data-action="mv-hide-trip" data-id="${esc(r.trip_id)}" data-value="${r.trip_hidden ? '0' : '1'}">${r.trip_hidden ? 'Reis weer tonen' : 'Reis verbergen'}</button>
            ${(() => { const u = r.comment ? r.comment.user : r.trip_owner; return u && !u.is_blocked ? `<button type="button" class="btn btn-sm btn-danger" data-action="mv-block" data-id="${esc(u.id)}" data-value="${esc(u.username)}">@${esc(u.username)} blokkeren</button>` : ''; })()}
            <button type="button" class="btn btn-sm btn-primary" data-action="mv-done" data-id="${esc(r.id)}">Afgehandeld</button>
          </div>
        </div>`).join('') || '<p class="empty">Geen open meldingen. 🎉</p>'}</div>
    </section>
    <section class="card" aria-labelledby="pub-h">
      <h2 id="pub-h">Openbare reizen <span class="count">${trips.length}</span></h2>
      <div class="list">${trips.map(t => `
        <div class="list-item">
          <div class="who-block" style="flex:1 1 220px;min-width:0">
            <span class="t"><a href="${SITE_TRIP(t.trip_id)}" target="_blank" rel="noopener">${esc(t.title)}</a> · @${esc(t.owner?.username || '?')}</span>
            <span class="s">${esc(t.location || '')} · ${t.places_count} plekken · ❤️ ${t.likes} · 💬 ${t.comments} · ${fmtDate(t.published_at)}</span>
          </div>
          <span class="pill ${t.hidden ? 'pill-blocked' : t.visible ? 'pill-live' : 'pill-verborgen'}">${t.hidden ? 'Verborgen' : t.visible ? 'Zichtbaar' : 'Na thuiskomst'}</span>
          <button type="button" class="btn btn-sm" data-action="mv-hide-trip" data-id="${esc(t.trip_id)}" data-value="${t.hidden ? '0' : '1'}">${t.hidden ? 'Weer tonen' : 'Verbergen'}</button>
        </div>`).join('') || '<p class="empty">Nog geen openbare reizen.</p>'}</div>
    </section>`;
}

async function renderFiles(el) {
  const files = await api.listFiles();
  state.files = files;
  const folders = [...new Set(files.map(f => f.folder || 'Algemeen'))].sort((a, b) => a.localeCompare(b, 'nl'));
  el.innerHTML = `
    <header class="page-head"><div><h1>Bestanden</h1><p class="lead">Je eigen privé-map. Alleen beheerders kunnen deze bestanden zien en downloaden.</p></div></header>
    <section class="card" aria-labelledby="files-new">
      <h2 id="files-new">Bestand bewaren</h2>
      <form id="form-file" class="stack" style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
        <div class="row" style="align-items:flex-end">
          <label class="field" style="flex:1;min-width:200px"><span>Map</span>
            <input type="text" name="folder" list="folder-list" maxlength="40" placeholder="Bijv. Mexo of Sleutels">
            <datalist id="folder-list">${folders.map(f => `<option value="${esc(f)}">`).join('')}</datalist>
          </label>
          <label class="field" style="flex:2;min-width:220px"><span>Bestand(en) (max 50 MB per stuk)</span>
            <input type="file" name="file" multiple required>
          </label>
          <button type="submit" class="btn btn-primary">Uploaden</button>
        </div>
        <p class="error-text" data-error role="alert" hidden></p>
      </form>
    </section>
    ${folders.map(folder => `
    <section class="card" aria-label="Map ${esc(folder)}">
      <h2>${esc(folder)}</h2>
      <div class="list">
        ${files.filter(f => (f.folder || 'Algemeen') === folder).map(f => `
          <div class="list-item">
            <div class="who-block" style="flex:1 1 220px;min-width:0"><span class="t" style="overflow-wrap:anywhere">${esc(f.name)}</span><span class="s">${f.size < 1000 ? 'kleiner dan 1 kB' : fmtSize(f.size)} · ${fmtDate(f.updated_at)}</span></div>
            <button type="button" class="btn btn-sm" data-action="file-download" data-id="${esc(f.path)}">Downloaden</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="file-delete" data-id="${esc(f.path)}">Verwijderen</button>
          </div>`).join('')}
      </div>
    </section>`).join('') || '<section class="card"><p class="empty">Nog geen bestanden bewaard.</p></section>'}`;
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('#form-file');
  if (!form) return;
  e.preventDefault();
  const list = Array.from(form.file.files || []);
  const folder = cleanFolder(form.folder.value) || 'Algemeen';
  if (!list.length) return showError(form, 'Kies eerst een bestand.');
  const big = list.find(f => f.size > 52428800);
  if (big) return showError(form, `${big.name} is groter dan 50 MB.`);
  const exists = list.filter(f => (state.files || []).some(x => x.path === `${folder}/${cleanFileName(f.name)}`));
  if (exists.length) {
    const ok = await confirmDialog('Bestand vervangen?', `In de map ${folder} staat al: ${exists.map(f => cleanFileName(f.name)).join(', ')}. Wil je dat vervangen door de nieuwe versie?`, 'Vervangen');
    if (!ok) return;
  }
  showError(form, '');
  await busy($('button[type=submit]', form), async () => {
    try {
      for (const f of list) await api.uploadFile(folder, f, cleanFileName(f.name));
      toast(list.length === 1 ? 'Bestand bewaard' : `${list.length} bestanden bewaard`);
      refreshData();
    } catch (err) { showError(form, err.message); }
  });
});

// =============================================================
//  SERVER
// =============================================================
function serverRow(s) {
  return `
    <div class="list-item">
      <div class="who-block"><span class="t">${esc(s.name)}</span><span class="s">${esc(s.detail)}</span></div>
      <span class="pill ${s.state === 'ok' ? 'pill-live' : s.state === 'bad' ? 'pill-blocked' : 'pill-verborgen'}"><span class="${statusDot(s.state)}"></span>${esc(s.label)}</span>
      ${s.meter != null ? `<div class="meter" style="flex-basis:100%" role="img" aria-label="${esc(s.label)} gebruikt"><div style="width:${Math.max(0, Math.min(100, Number(s.meter)))}%"></div></div>` : ''}
    </div>`;
}

async function renderServer(el) {
  const server = await api.serverStatus();
  el.innerHTML = `
    <header class="page-head">
      <div><h1>Server</h1><p class="lead">Draait alles nog?</p></div>
      <button type="button" class="btn" data-action="refresh">Opnieuw controleren</button>
    </header>
    ${api.mode === 'live' ? `<div class="banner"><span>De database is gekoppeld. Tunnel, back-ups en schijfruimte verschijnen hier zodra je eigen server draait.</span></div>` : ''}
    <section class="card" aria-label="Onderdelen"><div class="list">${server.map(serverRow).join('')}</div></section>`;
}

// =============================================================
//  STORE-PAGINA: alles wat er in de Spark-appstore over een app staat
//  (ondertitel, Over deze app, categorie, kleuren, functies,
//   gegevensbeveiliging, jaar, screenshots met bijschrift)
// =============================================================
const PRIV_ICONS = [['phone', 'Telefoon'], ['lock', 'Slot'], ['user', 'Geen account'], ['wifi', 'Zonder internet'], ['globe', 'Online']];
const PRIV_PRESETS = [
  ['phone', 'Gegevens blijven op je telefoon'], ['lock', 'Beveiligd met een code of vingerafdruk'],
  ['user', 'Geen account nodig'], ['wifi', 'Werkt zonder internet'], ['globe', 'Synchroniseert met je Spark Account'],
];
let storeImport = null;                      // huidige inhoud van de store-app, om mee te beginnen
async function loadStoreImport() {
  if (storeImport) return storeImport;
  try { const r = await fetch('store-import/apps.json', { cache: 'no-cache' }); storeImport = r.ok ? await r.json() : []; }
  catch { storeImport = []; }
  return storeImport;
}
const normName = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findImport(app) {
  return (storeImport || []).find(x => (app.package_name && x.pkg === app.package_name)
    || normName(x.name) === normName(app.name) || (x.match || []).some(m => normName(m) === normName(app.name))
    || normName(x.id) === normName(app.slug)) || null;
}
function darkerHex(hex) {
  const n = parseInt(String(hex || '#2F4BFF').slice(1), 16) || 0;
  const d = x => Math.round(x * 0.62).toString(16).padStart(2, '0');
  return '#' + d((n >> 16) & 255) + d((n >> 8) & 255) + d(n & 255);
}
const pg = { app: null, data: null, imported: false };

async function openPageDialog(app) {
  await loadStoreImport();
  const d = app.details && app.details.v ? app.details : null;
  const imp = d ? null : findImport(app);
  pg.app = app; pg.imported = !!imp;
  pg.data = {
    tagline: app.tagline || (imp && imp.tagline) || '',
    description: app.description || (imp && imp.desc) || '',
    cat: (d && d.cat) || (imp && imp.cat) || '',
    bg: (d && d.bg) || (imp && imp.bg) || app.color || '#2F4BFF',
    bg2: (d && d.bg2) || (imp && imp.bg2) || darkerHex(app.color),
    made: (d && d.made) || (imp && imp.made) || String(new Date().getFullYear()),
    features: ((d && d.features) || (imp && imp.features) || []).slice(),
    privacy: ((d && d.privacy) || (imp && imp.privacy) || []).map(p => ({ ...p })),
    shots: d ? (d.shots || []).map(s => ({ ...s }))
      : imp ? imp.shots.map(s => ({ importUrl: 'store-import/shots/' + s.file, title: s.title, sub: s.sub })) : [],
  };
  $('#dlg-page-title').textContent = `Store-pagina · ${app.name}`;
  showError($('#form-page'), ''); $('#page-busy').textContent = '';
  drawPage();
  $('#dlg-page').showModal();
}

function shotSrc(s) { return s.url || s.preview || s.importUrl || ''; }

function drawPage() {
  const p = pg.data, a = pg.app;
  const cats = [...new Set([...(storeImport || []).map(x => x.cat), ...state.apps.map(x => x.details && x.details.cat)].filter(Boolean))].sort();
  $('#page-body').innerHTML = `
    ${pg.imported ? `<div class="banner"><span><strong>Overgenomen uit de store.</strong> Dit is wat er nu in de store-app staat. Klik op Opslaan om het in Beheer te zetten; daarna pas je het hier aan.</span></div>` : ''}
    <div class="pg-preview" style="background:linear-gradient(135deg, ${esc(p.bg)}, ${esc(p.bg2)})">
      ${appIcon(a)}<div><b>${esc(a.name)}</b><span>${esc(p.tagline || 'Ondertitel van de app')}</span></div>
    </div>
    <div class="pg-sec">
      <h3>Over de app</h3>
      <label class="field"><span>Ondertitel</span><input type="text" maxlength="80" data-pg="tagline" value="${esc(p.tagline)}" placeholder="Eén zin over de app"></label>
      <label class="field"><span>Over deze app</span><textarea rows="4" maxlength="2000" data-pg="description" placeholder="Wat doet de app en voor wie is hij?">${esc(p.description)}</textarea></label>
      <div class="form-grid">
        <label class="field"><span>Categorie</span><input type="text" maxlength="24" list="cat-list" data-pg="cat" value="${esc(p.cat)}" placeholder="Bijv. Geld, Planning, Fun-apps">
          <datalist id="cat-list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Gemaakt in</span><input type="text" maxlength="4" inputmode="numeric" data-pg="made" value="${esc(p.made)}"></label>
        <label class="field"><span>Kleur boven</span><input type="color" data-pg="bg" value="${esc(p.bg)}"></label>
        <label class="field"><span>Kleur onder</span><input type="color" data-pg="bg2" value="${esc(p.bg2)}"></label>
      </div>
    </div>
    <div class="pg-sec">
      <h3>Wat kan hij</h3>
      <p class="hint">Eén functie per regel, kort en krachtig. Maximaal 10.</p>
      <textarea rows="5" data-pg="features" placeholder="Diensten in een paar tikken&#10;Toeslagen automatisch">${esc(p.features.join('\n'))}</textarea>
    </div>
    <div class="pg-sec">
      <h3>Gegevensbeveiliging</h3>
      <div class="list" style="gap:8px">
        ${p.privacy.map((x, i) => `
          <div class="pg-row">
            <select data-pg="priv-icon" data-i="${i}" aria-label="Icoon">${PRIV_ICONS.map(([v, l]) => `<option value="${v}" ${x.icon === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input type="text" maxlength="60" data-pg="priv-text" data-i="${i}" value="${esc(x.text)}">
            <button type="button" class="btn btn-sm btn-danger" data-action="pg-priv-del" data-id="${i}">Weg</button>
          </div>`).join('') || '<p class="empty" style="text-align:left;padding:0">Nog niks. Kies hieronder wat past.</p>'}
      </div>
      <div class="filters">${PRIV_PRESETS.filter(([, t]) => !p.privacy.some(x => x.text === t)).map(([ic, t]) => `<button type="button" class="chip" data-action="pg-priv-add" data-value="${ic}|${esc(t)}">+ ${esc(t)}</button>`).join('')}
        <button type="button" class="chip" data-action="pg-priv-add" data-value="phone|">+ Eigen regel</button></div>
    </div>
    <div class="pg-sec">
      <h3>Screenshots <span class="count">${p.shots.length}</span></h3>
      <p class="hint">Staande schermafbeeldingen (JPG, PNG of WEBP, max. 3 MB). De eerste staat vooraan. Geef elk een korte titel en een zin uitleg.</p>
      <div class="shots">
        ${p.shots.map((s, i) => `
          <div class="shot">
            <img src="${esc(shotSrc(s))}" alt="">
            ${s.url ? '' : '<span class="pill pill-new" style="align-self:flex-start">Nieuw</span>'}
            <input type="text" maxlength="40" placeholder="Titel" data-pg="shot-title" data-i="${i}" value="${esc(s.title)}">
            <input type="text" maxlength="90" placeholder="Eén zin uitleg" data-pg="shot-sub" data-i="${i}" value="${esc(s.sub)}">
            <div class="pg-row">
              <button type="button" class="btn btn-sm" data-action="pg-shot-move" data-id="${i}" data-value="-1" ${i === 0 ? 'disabled' : ''} aria-label="Naar voren">←</button>
              <button type="button" class="btn btn-sm" data-action="pg-shot-move" data-id="${i}" data-value="1" ${i === p.shots.length - 1 ? 'disabled' : ''} aria-label="Naar achteren">→</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="pg-shot-del" data-id="${i}">Weg</button>
            </div>
          </div>`).join('')}
      </div>
      <label class="field"><span>Screenshots toevoegen</span><input type="file" id="pg-shot-files" accept="image/jpeg,image/png,image/webp" multiple></label>
    </div>`;
}

// typen en kiezen in de store-pagina
document.addEventListener('input', e => {
  const t = e.target, k = t.dataset && t.dataset.pg; if (!k || !pg.data) return;
  const p = pg.data, i = +t.dataset.i;
  if (k === 'features') p.features = t.value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10);
  else if (k === 'priv-text') p.privacy[i].text = t.value;
  else if (k === 'priv-icon') p.privacy[i].icon = t.value;
  else if (k === 'shot-title') p.shots[i].title = t.value;
  else if (k === 'shot-sub') p.shots[i].sub = t.value;
  else p[k] = t.value;
  if (k === 'tagline' || k === 'bg' || k === 'bg2') {
    const pv = $('.pg-preview'); if (pv) { pv.style.background = `linear-gradient(135deg, ${p.bg}, ${p.bg2})`; $('span', pv).textContent = p.tagline || 'Ondertitel van de app'; }
  }
});
document.addEventListener('change', e => {
  if (e.target.id !== 'pg-shot-files' || !pg.data) return;
  const files = Array.from(e.target.files || []);
  const bad = files.find(f => !/^image\/(jpeg|png|webp)$/.test(f.type) || f.size > 3145728);
  if (bad) { showError($('#form-page'), `${bad.name} is geen JPG/PNG/WEBP of groter dan 3 MB.`); return; }
  if (pg.data.shots.length + files.length > 10) { showError($('#form-page'), 'Maximaal 10 screenshots per app.'); return; }
  files.forEach(f => pg.data.shots.push({ file: f, preview: URL.createObjectURL(f), title: '', sub: '' }));
  showError($('#form-page'), ''); drawPage();
});

$('#form-page').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget, p = pg.data;
  if (!p.tagline.trim()) return showError(form, 'Vul een ondertitel in.');
  if (!/^\d{4}$/.test(p.made)) return showError(form, 'Vul bij "Gemaakt in" een jaartal in, bijvoorbeeld 2026.');
  showError(form, '');
  const nNew = p.shots.filter(s => !s.url).length;
  $('#page-busy').textContent = nNew ? `${nNew} screenshot${nNew === 1 ? '' : 's'} uploaden…` : '';
  await busy($('button[type=submit]', form), async () => {
    try {
      await api.saveAppPage(pg.app, {
        tagline: p.tagline.trim(), description: p.description.trim(),
        details: { cat: p.cat.trim(), bg: p.bg, bg2: p.bg2, made: p.made, features: p.features,
          privacy: p.privacy.filter(x => x.text.trim()).map(x => ({ icon: x.icon, text: x.text.trim() })) },
        shots: p.shots.map(s => ({ ...s, title: (s.title || '').trim(), sub: (s.sub || '').trim() })),
      });
      $('#dlg-page').close();
      toast(`Store-pagina van ${pg.app.name} opgeslagen`);
      refreshData();
    } catch (err) { showError(form, err.message); }
    finally { $('#page-busy').textContent = ''; }
  });
});

// =============================================================
//  STORE: labels, Binnenkort en slideshow in de Spark-appstore
//  (stond vroeger verstopt in de store-app zelf, achter 5x tikken)
// =============================================================
const LABEL_TYPES = [['auto', 'Automatisch'], ['none', 'Geen label'], ['new', 'Nieuw'], ['upd', 'Bijgewerkt'], ['hot', 'Uitgelicht'], ['pop', 'Populair'], ['beta', 'Bèta'], ['own', 'Eigen tekst']];
const LABEL_DAYS = [[0, 'Altijd'], [7, '7 dagen'], [14, '14 dagen'], [30, '30 dagen']];
const SOON_STATUS = [['idea', 'Idee'], ['dev', 'In ontwikkeling'], ['test', 'Testen'], ['soon', 'Bijna klaar']];
const SOON_DEFAULT = [{ id: 'geheim', name: 'Geheim project', tagline: 'Er wordt aan gebouwd. Meer zeg ik nog niet.', status: 'dev', progress: 20, visible: true }];
const storeKey = a => a.package_name || a.slug;      // zo herkent de store-app de app
const store = { tab: 'labels', data: null, saved: '', noTable: false };

async function renderStore(el) {
  const [apps, data] = await Promise.all([
    api.listApps(),
    api.getStoreSettings().catch(err => { if (err.message === 'NO_TABLE') { store.noTable = true; return {}; } throw err; }),
  ]);
  state.apps = apps;
  store.data = {
    labels: data.labels && typeof data.labels === 'object' ? data.labels : {},
    soon: Array.isArray(data.soon) ? data.soon : structuredClone(SOON_DEFAULT),
    slides: Array.isArray(data.slides) ? data.slides : [],
    soon_slide: data.soon_slide !== false,
  };
  store.saved = JSON.stringify(store.data);
  drawStore(el);
}

const storeDirty = () => store.data && JSON.stringify(store.data) !== store.saved;
const liveApps = () => state.apps.filter(a => a.status === 'live');

function drawStore(el = $('#view')) {
  const tabs = [['labels', 'Labels'], ['soon', 'Binnenkort'], ['slides', 'Slideshow']];
  const intro = {
    labels: 'Kies per app welk label er op de kaarten in de store staat. <strong>Automatisch</strong> laat de store zelf kiezen: Nieuw of Bijgewerkt, 14 dagen lang.',
    soon: 'Apps waar je aan werkt. Ze staan in de store onder Binnenkort. Staat een app eenmaal in de store met dezelfde naam, dan verdwijnt hij daar vanzelf.',
    slides: 'Kies welke apps in de slideshow op de hoofdpagina van de store komen, in de volgorde waarin je ze aanvinkt. Vink je <strong>niks</strong> aan, dan doet de store het automatisch.',
  }[store.tab];
  el.innerHTML = `
    <header class="page-head">
      <div><h1>Store</h1><p class="lead">Hoe de Spark-appstore eruitziet voor iedereen.</p></div>
      <div class="row">
        <span class="pill ${storeDirty() ? 'pill-concept' : 'pill-live'}" id="store-state">${storeDirty() ? 'Niet opgeslagen' : 'Opgeslagen'}</span>
        <button type="button" class="btn btn-primary" data-action="store-save" ${store.noTable ? 'disabled' : ''}>Opslaan</button>
      </div>
    </header>
    ${store.noTable ? `<div class="banner banner-error"><span><strong>Nog één stap.</strong> Voer <code>supabase/store_settings.sql</code> uit in Supabase (SQL Editor → New query → Run). Daarna kun je hier opslaan.</span></div>` : ''}
    <section class="card">
      <div class="card-head">
        <div class="filters" role="tablist" aria-label="Onderdeel">
          ${tabs.map(([v, l]) => `<button type="button" class="chip" role="tab" data-action="store-tab" data-value="${v}" aria-pressed="${store.tab === v}">${l}</button>`).join('')}
        </div>
        ${store.tab === 'labels' ? '<button type="button" class="btn btn-sm" data-action="store-labels-auto">Alles automatisch</button>'
          : store.tab === 'slides' ? '<button type="button" class="btn btn-sm" data-action="store-slides-auto">Automatisch</button>'
          : '<button type="button" class="btn btn-sm btn-primary" data-action="soon-add">+ App toevoegen</button>'}
      </div>
      <p style="color:var(--muted);font-size:14px;margin:4px 0 14px">${intro}</p>
      <div class="list">${store.tab === 'labels' ? drawLabels() : store.tab === 'soon' ? drawSoon() : drawSlides()}</div>
    </section>`;
}

function drawLabels() {
  const apps = liveApps();
  if (!apps.length) return '<p class="empty">Nog geen live apps. Zet een app op Live bij Apps.</p>';
  return apps.map(a => {
    const k = storeKey(a), cur = store.data.labels[k] || { type: 'auto' };
    const left = cur.until ? Math.ceil((cur.until - Date.now()) / 864e5) : 0;
    return `
      <div class="list-item" style="flex-wrap:wrap">
        <div class="app-cell" style="flex:1 1 220px">${appIcon(a)}<div><div class="t">${esc(a.name)}</div><div class="s">${cur.until ? (left > 0 ? `nog ${left} ${left === 1 ? 'dag' : 'dagen'} zichtbaar` : 'verlopen, weer automatisch') : esc(k)}</div></div></div>
        <label><span class="sr-only">Label voor ${esc(a.name)}</span>
          <select data-st="label-type" data-key="${esc(k)}">${LABEL_TYPES.map(([v, l]) => `<option value="${v}" ${cur.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${cur.type === 'own' ? `<label><span class="sr-only">Eigen tekst</span><input type="text" maxlength="16" placeholder="Bijv. Favoriet" value="${esc(cur.text || '')}" data-st="label-text" data-key="${esc(k)}" style="width:150px"></label>` : ''}
        ${cur.type !== 'auto' && cur.type !== 'none' ? `<label><span class="sr-only">Hoe lang</span><select data-st="label-days" data-key="${esc(k)}">${LABEL_DAYS.map(([v, l]) => `<option value="${v}" ${(cur.days || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      </div>`;
  }).join('') + '<p class="empty" style="text-align:left;padding:12px 4px 0">Staat een app er niet tussen? Zet hem bij Apps op Live en vul het Android-pakket in.</p>';
}

function drawSoon() {
  const l = store.data.soon;
  if (!l.length) return '<p class="empty">Nog niks in de maak.</p>';
  return l.map((x, i) => `
    <div class="list-item" style="flex-direction:column;align-items:stretch;gap:10px;${x.visible === false ? 'opacity:.6' : ''}">
      <div class="row" style="gap:8px">
        <label class="field" style="flex:1;min-width:200px"><span>Naam</span><input type="text" maxlength="28" placeholder="Naam van de app" value="${esc(x.name || '')}" data-st="soon-name" data-i="${i}"></label>
        <label class="field"><span>Status</span><select data-st="soon-status" data-i="${i}">${SOON_STATUS.map(([v, t]) => `<option value="${v}" ${(x.status || 'dev') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Korte teaser</span><textarea rows="2" maxlength="90" data-st="soon-tagline" data-i="${i}">${esc(x.tagline || '')}</textarea></label>
      <label class="field"><span>Voortgang <strong id="soon-p-${i}">${+x.progress || 0}%</strong></span><input type="range" min="0" max="100" step="5" value="${+x.progress || 0}" data-st="soon-progress" data-i="${i}"></label>
      <div class="row" style="gap:8px">
        <label style="display:inline-flex;align-items:center;gap:8px"><input type="checkbox" ${x.visible === false ? '' : 'checked'} data-st="soon-visible" data-i="${i}"> Zichtbaar in de store</label>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-sm" data-action="soon-move" data-id="${i}" data-value="-1" ${i === 0 ? 'disabled' : ''} aria-label="Omhoog">↑</button>
        <button type="button" class="btn btn-sm" data-action="soon-move" data-id="${i}" data-value="1" ${i === l.length - 1 ? 'disabled' : ''} aria-label="Omlaag">↓</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="soon-del" data-id="${i}">Verwijderen</button>
      </div>
    </div>`).join('');
}

function drawSlides() {
  const apps = liveApps(), pick = store.data.slides;
  return apps.map(a => {
    const k = storeKey(a), i = pick.indexOf(k);
    return `
      <label class="list-item" style="cursor:pointer">
        <input type="checkbox" ${i > -1 ? 'checked' : ''} data-st="slide" data-key="${esc(k)}">
        <div class="app-cell" style="flex:1">${appIcon(a)}<div><div class="t">${esc(a.name)}</div><div class="s">${esc(a.tagline || '')}</div></div></div>
        ${i > -1 ? `<span class="pill pill-admin">${i + 1}</span>` : ''}
      </label>`;
  }).join('') + `
    <label class="list-item" style="cursor:pointer">
      <input type="checkbox" ${store.data.soon_slide ? 'checked' : ''} data-st="soon-slide">
      <div class="who-block"><span class="t">Binnenkort-slide</span><span class="s">Altijd als laatste, alleen als er iets in Binnenkort staat</span></div>
    </label>`;
}

function markStore() {
  const p = $('#store-state'); if (!p) return;
  const d = storeDirty();
  p.className = `pill ${d ? 'pill-concept' : 'pill-live'}`; p.textContent = d ? 'Niet opgeslagen' : 'Opgeslagen';
}

// Wijzigingen in het Store-scherm (zonder alles opnieuw te tekenen tijdens het typen)
function storeInput(e) {
  const t = e.target, kind = t.dataset?.st;
  if (!kind || !store.data) return;
  const d = store.data, i = +t.dataset.i, k = t.dataset.key;
  if (kind === 'label-type') {
    if (t.value === 'auto') delete d.labels[k];
    else { const c = d.labels[k] || {}; c.type = t.value; if (t.value === 'none') { delete c.until; delete c.days; } d.labels[k] = c; }
    drawStore();
  } else if (kind === 'label-text') { if (d.labels[k]) d.labels[k].text = t.value.trim(); }
  else if (kind === 'label-days') {
    const c = d.labels[k]; if (!c) return; const n = +t.value;
    c.days = n; if (n) c.until = Date.now() + n * 864e5; else delete c.until;
    drawStore();
  }
  else if (kind === 'soon-name') d.soon[i].name = t.value;
  else if (kind === 'soon-tagline') d.soon[i].tagline = t.value;
  else if (kind === 'soon-status') { d.soon[i].status = t.value; if (t.value === 'soon' && (+d.soon[i].progress || 0) < 80) { d.soon[i].progress = 90; drawStore(); } }
  else if (kind === 'soon-progress') { d.soon[i].progress = +t.value; const b = $(`#soon-p-${i}`); if (b) b.textContent = t.value + '%'; }
  else if (kind === 'soon-visible') { d.soon[i].visible = t.checked; drawStore(); }
  else if (kind === 'slide') { const at = d.slides.indexOf(k); if (t.checked && at < 0) d.slides.push(k); if (!t.checked && at > -1) d.slides.splice(at, 1); drawStore(); }
  else if (kind === 'soon-slide') d.soon_slide = t.checked;
  markStore();
}
document.addEventListener('input', e => { if (e.target.dataset?.st && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') storeInput(e); });
document.addEventListener('change', e => { if (e.target.dataset?.st && (e.target.type === 'checkbox' || e.target.tagName === 'SELECT')) storeInput(e); });
window.addEventListener('beforeunload', e => { if (storeDirty() && location.hash === '#store') { e.preventDefault(); e.returnValue = ''; } });

async function saveStore(btn) {
  const before = JSON.parse(store.saved), d = store.data;
  d.soon = d.soon.filter(x => (x.name || '').trim() || (x.tagline || '').trim());
  await busy(btn, async () => {
    for (const key of ['labels', 'soon', 'slides', 'soon_slide']) {
      if (JSON.stringify(before[key]) !== JSON.stringify(d[key])) await api.saveStoreSetting(key, d[key]);
    }
  });
  store.saved = JSON.stringify(d);
  drawStore();
  toast('Opgeslagen. De store laat het zien zodra hij opnieuw opent');
}

// =============================================================
//  Klikken (één luisteraar voor de hele app)
// =============================================================
document.addEventListener('click', async e => {
  const closer = e.target.closest('[data-close]');
  if (closer) { closer.closest('dialog').close(); return; }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, value } = btn.dataset;

  switch (action) {
    case 'logout':
      await api.signOut();
      state.me = null;
      history.replaceState(null, '', '#');
      showLogin();
      break;

    case 'new-app':
      openAppDialog(null);
      break;

    case 'ov-edit': openOverviewDialog(); break;
    case 'ov-reset':
      ovDraft = WIDGETS.filter(w => can(w.perm)).map(w => ({ ...w, on: true }));
      drawOverviewDialog();
      break;

    case 'add-store':
      openAppDialog(null, { name: 'Spark Apps', slug: 'spark-apps', package_name: STORE_PKG, status: 'live', color: '#12285A', sort_order: 0,
        tagline: 'Alle Spark-apps, updates en je account' });
      break;

    case 'edit-app':
      openAppDialog(state.apps.find(a => a.id === id));
      break;

    case 'new-version':
      openVersionDialog(state.apps.find(a => a.id === id));
      break;

    case 'delete-app': {
      const form = $('#form-app');
      const app = state.apps.find(a => a.id === form.id.value);
      if (isStoreApp(app)) { toast('De appstore kan niet verwijderd worden.', true); return; }
      $('#dlg-app').close();
      const ok = await confirmDialog(`${app.name} verwijderen?`, 'De app en al zijn versies (APK\'s) worden definitief verwijderd. Mensen die hem al hebben, houden hem op hun telefoon.', 'Verwijderen');
      if (!ok) return;
      try { await api.deleteApp(app); toast(`${app.name} verwijderd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'app-filter':
      state.appFilter = value;
      drawApps($('#view'));
      break;

    case 'user-filter':
      state.userFilter = value;
      drawUsers($('#view'));
      break;

    case 'view-user':
      openUserDialog(state.users.find(u => u.id === id));
      break;

    case 'req-filter': state.reqFilter = value; drawRequests($('#view')); break;
    case 'req-kind': state.reqKind = value; drawRequests($('#view')); break;
    case 'req-open': {
      if (!state.requests.some(r => r.id === id)) state.requests = await api.listRequests();
      openRequestDialog(state.requests.find(r => r.id === id));
      break;
    }
    case 'req-delete': {
      const form = $('#form-req');
      const r = state.requests.find(x => x.id === form.dataset.id);
      $('#dlg-req').close();
      if (!await confirmDialog('Deze aanvraag verwijderen?', `"${r.title}" verdwijnt ook bij de afzender. Wil je hem liever afsluiten? Zet de status dan op Klaar of Afgewezen.`, 'Verwijderen')) return;
      try { await api.deleteRequest(r.id); toast('Verwijderd'); route(); } catch (err) { toast(err.message, true); }
      break;
    }

    case 'staff-add':
      openStaffDialog(null);
      break;
    case 'staff-edit':
      if (!state.staff.length) try { state.staff = await api.listStaff(); } catch { /* */ }
      openStaffDialog(id);
      break;
    case 'staff-remove': {
      const s = state.staff.find(x => x.user_id === id);
      if (!await confirmDialog(`@${s.username} als beheerder weghalen?`, 'Het account blijft gewoon bestaan, alleen de toegang tot Beheer verdwijnt.', 'Weghalen')) return;
      try { await api.removeStaff(id); toast(`@${s.username} is geen beheerder meer`); route(); } catch (err) { toast(err.message, true); }
      break;
    }

    case 'block': {
      const u = state.users.find(x => x.id === id);
      const ok = await confirmDialog(`@${u.username} blokkeren?`, 'Deze persoon kan dan niet meer inloggen in de Spark-apps. Je kunt dit altijd terugdraaien.', 'Blokkeren');
      if (!ok) return;
      try { await api.setBlocked(id, true); toast(`@${u.username} geblokkeerd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'confirm-user': {
      const u = state.users.find(x => x.id === id);
      const ok = await confirmDialog(`@${u.username} goedkeuren?`, 'Het account wordt bevestigd alsof deze persoon op de link in de mail heeft geklikt. Daarna kan hij of zij meteen inloggen.', 'Goedkeuren');
      if (!ok) return;
      try { await api.confirmUser(id); toast(`@${u.username} goedgekeurd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'delete-user': {
      const u = state.users.find(x => x.id === id);
      $('#dlg-user').close();
      const ok = await confirmDialog(`@${u.username} verwijderen?`, 'Het account en het profiel worden definitief verwijderd. Dit kun je niet terugdraaien. Wil je iemand alleen tegenhouden? Kies dan Blokkeren.', 'Verwijderen');
      if (!ok) return;
      try { await api.deleteUser(id); toast(`@${u.username} verwijderd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'reset-pw': {
      const u = state.users.find(x => x.id === id);
      try { await busy(btn, () => api.sendPasswordReset(u.email)); toast(`Mail gestuurd naar ${u.email}`); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'unblock': {
      const u = state.users.find(x => x.id === id);
      try { await api.setBlocked(id, false); toast(`@${u.username} gedeblokkeerd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'toggle-ann':
      try {
        await busy(btn, () => api.setAnnouncementActive(id, btn.dataset.active !== 'true'));
        refreshData();
      } catch (err) { toast(err.message, true); }
      break;

    case 'file-download': {
      try {
        const blob = await busy(btn, () => api.downloadFile(id));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = id.split('/').pop();
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (err) { toast(err.message, true); }
      break;
    }

    case 'file-delete': {
      const name = id.split('/').pop();
      const ok = await confirmDialog(`${name} verwijderen?`, 'Het bestand wordt definitief uit je privé-map gehaald. Dit kun je niet terugdraaien.', 'Verwijderen');
      if (!ok) return;
      try { await api.deleteFile(id); toast(`${name} verwijderd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'mv-hide-trip':
      try { await busy(btn, () => api.mvHideTrip(id, value === '1')); toast(value === '1' ? 'Reis verborgen' : 'Reis weer zichtbaar'); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;

    case 'mv-hide-comment':
      try { await busy(btn, () => api.mvHideComment(id, value === '1')); toast(value === '1' ? 'Reactie verborgen' : 'Reactie teruggezet'); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;

    case 'mv-done':
      try { await busy(btn, () => api.mvReportDone(id)); toast('Melding afgehandeld'); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;

    case 'mv-block': {
      const ok = await confirmDialog(`@${value} blokkeren?`, 'Deze persoon kan dan niet meer inloggen in de Spark-apps. Zijn of haar reizen en reacties zijn niet meer te zien. Je kunt dit altijd terugdraaien bij Gebruikers.', 'Blokkeren');
      if (!ok) return;
      try { await api.setBlocked(id, true); toast(`@${value} geblokkeerd`); refreshData(); }
      catch (err) { toast(err.message, true); }
      break;
    }

    case 'refresh':
      await busy(btn, refreshData);
      break;

    case 'edit-page':
      try { await openPageDialog(state.apps.find(a => a.id === id)); } catch (err) { toast(err.message, true); }
      break;
    case 'pg-priv-add': {
      const [icon, ...t] = value.split('|');
      pg.data.privacy.push({ icon, text: t.join('|') }); drawPage();
      if (!t.join('')) $$('[data-pg=priv-text]').pop()?.focus();
      break;
    }
    case 'pg-priv-del': pg.data.privacy.splice(+id, 1); drawPage(); break;
    case 'pg-shot-del': pg.data.shots.splice(+id, 1); drawPage(); break;
    case 'pg-shot-move': {
      const l = pg.data.shots, i = +id, j = i + (+value);
      if (j >= 0 && j < l.length) { [l[i], l[j]] = [l[j], l[i]]; drawPage(); }
      break;
    }

    case 'store-tab': store.tab = value; drawStore(); break;
    case 'store-save':
      try { await saveStore(btn); } catch (err) { toast(err.message, true); }
      break;
    case 'store-labels-auto': store.data.labels = {}; drawStore(); break;
    case 'store-slides-auto': store.data.slides = []; drawStore(); break;
    case 'soon-add':
      store.data.soon.push({ id: 'soon-' + Date.now(), name: '', tagline: '', status: 'idea', progress: 0, visible: true });
      drawStore();
      $$('[data-st=soon-name]').pop()?.focus();
      break;
    case 'soon-move': {
      const l = store.data.soon, i = +id, j = i + (+value);
      if (j < 0 || j >= l.length) break;
      [l[i], l[j]] = [l[j], l[i]]; drawStore();
      break;
    }
    case 'soon-del': {
      const x = store.data.soon[+id];
      const ok = await confirmDialog(`${x.name || 'Deze app'} weghalen?`, 'Hij verdwijnt uit Binnenkort zodra je opslaat.', 'Weghalen');
      if (!ok) return;
      store.data.soon.splice(+id, 1); drawStore();
      break;
    }
  }
});

// =============================================================
//  Installeerbaar maken (werkt via https of localhost)
// =============================================================
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();

// Logo = home-knop: altijd terug naar het overzicht (ook als je er al bent: dan ververst hij)
$('.brand').addEventListener('click', e => {
  if (location.hash === '#overzicht') { e.preventDefault(); window.scrollTo({ top: 0 }); route(); }
});
