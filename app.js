import { config } from './config.js';
import { createApi } from './api.js?v=9';

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
      enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
});
$$('#login-form input').forEach(i => i.addEventListener('input', () => { $('#login-error').hidden = true; }));

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me-name').textContent = '@' + (state.me?.username || 'beheerder');
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
};

async function route() {
  if ($('#app').hidden) return;
  const name = (location.hash || '#overzicht').slice(1);
  const view = VIEWS[name] ? name : 'overzicht';
  $$('.nav a').forEach(a => a.setAttribute('aria-current', a.dataset.route === view ? 'page' : 'false'));
  const el = $('#view');
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
  try {
    const r = state.mvReports || await api.mvReports('open');
    state.mvReports = r; $('#count-reports').textContent = r.length || '';
  } catch { /* tabel bestaat nog niet */ }
}

async function refreshData() {
  state.stats = null; state.mvReports = null;
  await route();
}

// =============================================================
//  OVERZICHT
// =============================================================
async function renderOverview(el) {
  const [stats, apps, users, log, server] = await Promise.all([
    api.stats(), api.listApps(), api.listUsers(), api.listLog(6), api.serverStatus(),
  ]);
  state.stats = stats; state.apps = apps; state.users = users;
  const backup = server.find(s => /back-up/i.test(s.name));

  el.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Overzicht</h1>
        <p class="lead">Alles van sparkapps.nl op één plek.</p>
      </div>
      <div class="row">
        ${serverPill(server)}
        <button type="button" class="btn btn-primary" data-action="new-app">+ Nieuwe app</button>
      </div>
    </header>

    ${api.mode === 'demo' ? `<div class="banner"><span><strong>Demo-stand.</strong> Je kijkt naar voorbeeldgegevens. Wijzigingen verdwijnen als je de pagina ververst. Vul <code>config.js</code> in om je echte database te koppelen.</span></div>` : ''}

    <section class="stats" aria-label="Kerncijfers">
      ${statCard('Apps in de store', stats.apps_live, `${fmtNumber(stats.apps_concept)} concept · ${fmtNumber(stats.apps_total)} totaal`)}
      ${statCard('Spark Accounts', stats.users_total, `${fmtNumber(stats.users_new_week)} nieuw deze week`)}
      ${statCard('Downloads deze week', stats.downloads_week, stats.top_app_week ? `Meest: ${esc(stats.top_app_week)}` : 'Nog geen downloads')}
      <div class="stat">
        <span class="lbl">Laatste back-up</span>
        <span class="val ${backup && backup.state === 'ok' ? 'ok' : ''}">${backup && backup.state === 'ok' ? esc(backup.label) : '—'}</span>
        <span class="sub">${backup ? esc(backup.detail) : 'Nog niet ingesteld'}</span>
      </div>
    </section>

    <section class="card" aria-labelledby="ov-apps">
      <div class="card-head">
        <h2 id="ov-apps">Apps</h2>
        <a href="#apps">Alle apps beheren</a>
      </div>
      ${appsTable(apps.slice(0, 6), stats.downloads_per_app)}
    </section>

    <div class="grid-2">
      <section class="card" aria-labelledby="ov-users">
        <div class="card-head"><h2 id="ov-users">Nieuwste gebruikers</h2><a href="#gebruikers">Alle gebruikers</a></div>
        <div class="list">${users.slice(0, 4).map(userRow).join('') || '<p class="empty">Nog geen gebruikers.</p>'}</div>
      </section>

      <section class="card" aria-labelledby="ov-server">
        <div class="card-head"><h2 id="ov-server">Server</h2><a href="#server">Details</a></div>
        <div class="list">${server.map(serverRow).join('')}</div>
      </section>

      <section class="card" aria-labelledby="ov-ann">
        <h2 id="ov-ann">Melding in de store</h2>
        <p style="color:var(--muted);font-size:14px">Verschijnt bovenaan in de Spark-appstore bij iedereen.</p>
        ${announcementForm('ov')}
      </section>

      <section class="card" aria-labelledby="ov-log">
        <div class="card-head"><h2 id="ov-log">Logboek</h2><a href="#logboek">Volledig logboek</a></div>
        <div class="list">${log.map(logRow).join('') || '<p class="empty">Nog niks gebeurd.</p>'}</div>
      </section>
    </div>`;
}

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
          ${apps.map(a => `
            <tr>
              <td><div class="app-cell">${appIcon(a)}<div><div class="t">${esc(a.name)}</div><div class="s">${esc(a.tagline || a.slug)}</div></div></div></td>
              <td>${a.latest ? esc(a.latest.version_name) : '<span style="color:var(--muted)">Geen APK</span>'}</td>
              <td><span class="pill pill-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></td>
              <td style="color:var(--ink-2)">${fmtDate(a.latest ? a.latest.created_at : a.updated_at)}</td>
              <td class="num">${fmtNumber(downloadsPerApp[a.id] || 0)}</td>
              <td class="actions">
                <button type="button" class="btn btn-sm" data-action="new-version" data-id="${esc(a.id)}" aria-label="Update publiceren voor ${esc(a.name)}">Update</button>
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

function drawApps(el) {
  const q = state.appSearch.toLowerCase();
  const list = state.apps.filter(a =>
    (state.appFilter === 'alle' || a.status === state.appFilter) &&
    (!q || a.name.toLowerCase().includes(q) || a.slug.includes(q)));
  const count = s => state.apps.filter(a => s === 'alle' || a.status === s).length;

  el.innerHTML = `
    <header class="page-head">
      <div><h1>Apps</h1><p class="lead">Wat er in de Spark-appstore staat.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-app">+ Nieuwe app</button>
    </header>
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

function openAppDialog(app) {
  const dlg = $('#dlg-app');
  const form = $('#form-app');
  form.reset();
  showError(form, '');
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
  $('[data-action=delete-app]', form).hidden = !app;
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
      toast(form.id.value ? 'App opgeslagen' : 'App toegevoegd');
      refreshData();
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
      ${u.email_confirmed_at ? '' : `<button type="button" class="btn btn-sm btn-primary" data-action="confirm-user" data-id="${esc(u.id)}">Goedkeuren</button>`}
      <button type="button" class="btn btn-sm" data-action="view-user" data-id="${esc(u.id)}">Bekijken</button>
      ${isMe ? '' : u.is_blocked
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
      ${u.is_admin || u.username === state.me?.username ? '' : `<button type="button" class="btn btn-danger" data-action="delete-user" data-id="${esc(u.id)}">Account verwijderen</button>`}
      <span style="flex:1"></span>
      <button type="button" class="btn" data-action="reset-pw" data-id="${esc(u.id)}">Wachtwoord-reset mailen</button>
    </div>`;
  $('#dlg-user').showModal();
}

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

    case 'edit-app':
      openAppDialog(state.apps.find(a => a.id === id));
      break;

    case 'new-version':
      openVersionDialog(state.apps.find(a => a.id === id));
      break;

    case 'delete-app': {
      const form = $('#form-app');
      const app = state.apps.find(a => a.id === form.id.value);
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
