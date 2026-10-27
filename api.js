// =============================================================
//  Gegevenslaag: dezelfde functies voor de demo-stand en de echte
//  Supabase-stand. De rest van de app weet niet welke actief is.
// =============================================================

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.45.4';

export async function createApi(config) {
  const hasConfig = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  if (!hasConfig) return createDemoApi();
  if (looksLikeSecretKey(config.SUPABASE_ANON_KEY)) {
    throw new Error('In config.js staat een geheime sleutel (service_role / secret). Gebruik de anon public key, nooit de geheime.');
  }
  const { createClient } = await import(SUPABASE_JS);
  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return createLiveApi(supabase);
}

function looksLikeSecretKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const part = key.split('.')[1] || '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return /"role"\s*:\s*"service_role"/.test(json);
  } catch {
    return false;
  }
}

function fail(error, fallback) {
  if (!error) return;
  const msg = error.message || fallback || 'Er ging iets mis';
  throw new Error(msg);
}

function fileExt(name, fallback) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : fallback;
}

// -------------------------------------------------------------
//  ECHTE STAND (Supabase — cloud of eigen server)
// -------------------------------------------------------------
function createLiveApi(supabase) {
  async function currentUserId() {
    const { data } = await supabase.auth.getUser();
    return data.user ? data.user.id : null;
  }

  async function assertAdmin() {
    const { data, error } = await supabase.rpc('is_admin');
    fail(error);
    if (!data) {
      await supabase.auth.signOut();
      throw new Error('Dit account heeft geen beheerdersrechten.');
    }
  }

  return {
    mode: 'live',

    async getMe() {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) return null;
      const { data: ok } = await supabase.rpc('is_admin');
      if (!ok) { await supabase.auth.signOut(); return null; }
      const { data, error } = await supabase
        .from('profiles').select('username, display_name, avatar_url')
        .eq('id', s.session.user.id).single();
      fail(error);
      return data;
    },

    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        if (/invalid login/i.test(error.message)) throw new Error('E-mail of wachtwoord klopt niet.');
        throw new Error(error.message);
      }
      await assertAdmin();
    },

    async signOut() { await supabase.auth.signOut(); },

    async stats() {
      const { data, error } = await supabase.rpc('admin_stats');
      fail(error);
      return data;
    },

    async listApps() {
      const { data, error } = await supabase
        .from('apps')
        .select('*, app_versions(id, version_name, version_code, changelog, apk_path, size_bytes, created_at)')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      fail(error);
      return data.map(normaliseApp);
    },

    async saveApp(input) {
      let icon_url = input.icon_url || null;
      if (input.iconFile) {
        const path = `${input.slug}/${Date.now()}.${fileExt(input.iconFile.name, 'png')}`;
        const { error: upErr } = await supabase.storage.from('app-icons')
          .upload(path, input.iconFile, { contentType: input.iconFile.type, upsert: false });
        fail(upErr, 'Icoon uploaden mislukt');
        icon_url = supabase.storage.from('app-icons').getPublicUrl(path).data.publicUrl;
      }
      const row = {
        slug: input.slug, name: input.name, package_name: input.package_name || null, tagline: input.tagline || null,
        description: input.description || null, color: input.color,
        status: input.status, sort_order: input.sort_order || 0, icon_url,
      };
      const q = input.id
        ? supabase.from('apps').update(row).eq('id', input.id)
        : supabase.from('apps').insert(row);
      const { error } = await q;
      if (error && /apps_package_name_key/i.test(error.message)) throw new Error('Dit Android-pakket hoort al bij een andere app.');
      if (error && /apps_slug_key|duplicate/i.test(error.message)) throw new Error('Deze korte naam (slug) is al in gebruik.');
      if (error && /package_name/i.test(error.message) && /column/i.test(error.message)) throw new Error('Draai eerst spark-store.sql in Supabase.');
      fail(error);
    },

    async deleteApp(app) {
      const paths = app.versions.map(v => v.apk_path);
      const { error } = await supabase.from('apps').delete().eq('id', app.id);
      fail(error);
      if (paths.length) await supabase.storage.from('apks').remove(paths);
    },

    async setAppStatus(id, status) {
      const { error } = await supabase.from('apps').update({ status }).eq('id', id);
      fail(error);
    },

    async publishVersion(app, { version_name, version_code, changelog, file }) {
      const path = `${app.slug}/${version_code}-${Date.now()}.apk`;
      const { error: upErr } = await supabase.storage.from('apks').upload(path, file, {
        contentType: 'application/vnd.android.package-archive', upsert: false,
      });
      fail(upErr, 'APK uploaden mislukt');
      const { error } = await supabase.from('app_versions').insert({
        app_id: app.id, version_name, version_code, changelog: changelog || null,
        apk_path: path, size_bytes: file.size,
      });
      if (error) {
        await supabase.storage.from('apks').remove([path]);
        if (/app_versions_unique|duplicate/i.test(error.message)) throw new Error('Dit versienummer bestaat al voor deze app.');
        fail(error);
      }
    },

    apkUrl(path) {
      return supabase.storage.from('apks').getPublicUrl(path).data.publicUrl;
    },

    async listUsers() {
      const { data, error } = await supabase.rpc('admin_list_users');
      fail(error);
      return data;
    },

    async setBlocked(id, blocked) {
      const { error } = await supabase.from('profiles').update({ is_blocked: blocked }).eq('id', id);
      fail(error);
    },

    async sendPasswordReset(email) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: 'https://sparkapps.nl/' });
      fail(error);
    },

    async confirmUser(id) {
      const { error } = await supabase.rpc('admin_confirm_user', { p_user_id: id });
      if (error && /admin_confirm_user/i.test(error.message)) throw new Error('Draai eerst spark-confirm.sql in Supabase.');
      fail(error);
    },

    async listAnnouncements() {
      const { data, error } = await supabase.from('announcements')
        .select('*').order('created_at', { ascending: false }).limit(50);
      fail(error);
      return data;
    },

    async postAnnouncement({ message, style, title }) {
      const row = { message, created_by: await currentUserId() };
      if (style && style !== 'banner') row.style = style;
      if (title) row.title = title;
      const { error } = await supabase.from('announcements').insert(row);
      if (error && /style|title/i.test(error.message) && /column/i.test(error.message)) throw new Error('Draai eerst spark-extra.sql in Supabase.');
      fail(error);
    },

    async deleteUser(id) {
      const { error } = await supabase.rpc('admin_delete_user', { p_user_id: id });
      if (error && /admin_delete_user/i.test(error.message)) throw new Error('Draai eerst spark-extra.sql in Supabase.');
      fail(error);
    },

    async setAnnouncementActive(id, active) {
      const { error } = await supabase.from('announcements').update({ active }).eq('id', id);
      fail(error);
    },

    async listLog(limit = 100) {
      const { data, error } = await supabase.from('admin_log')
        .select('*').order('created_at', { ascending: false }).limit(limit);
      fail(error);
      return data;
    },

    async serverStatus() {
      const t0 = performance.now();
      const { error } = await supabase.from('apps').select('id', { head: true, count: 'exact' });
      const ms = Math.round(performance.now() - t0);
      return [
        { name: 'Database', detail: error ? error.message : `Bereikbaar · ${ms} ms`, state: error ? 'bad' : 'ok', label: error ? 'Storing' : 'Draait' },
        { name: 'Cloudflare Tunnel', detail: 'Komt zodra je eigen server draait', state: 'off', label: 'Nog niet gekoppeld' },
        { name: 'Automatische back-up', detail: 'Komt zodra je eigen server draait', state: 'off', label: 'Nog niet gekoppeld' },
        { name: 'Schijfruimte', detail: 'Komt zodra je eigen server draait', state: 'off', label: 'Nog niet gekoppeld' },
      ];
    },
  };
}

function normaliseApp(a) {
  const versions = (a.app_versions || a.versions || []).slice().sort((x, y) => y.version_code - x.version_code);
  const { app_versions, ...rest } = a;
  return { ...rest, versions, latest: versions[0] || null };
}

// -------------------------------------------------------------
//  DEMO-STAND (alles in het geheugen, niks wordt opgeslagen)
// -------------------------------------------------------------
function createDemoApi() {
  const now = Date.now();
  const ago = (days, hours = 0) => new Date(now - days * 864e5 - hours * 36e5).toISOString();
  const id = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const wait = (ms = 220) => new Promise(r => setTimeout(r, ms));

  const me = { id: 'me', username: 'beheerder', display_name: 'Beheerder', avatar_url: null };

  const seed = [
    ['mexo', 'Mexo', 'Je loon altijd in beeld', '#2F4BFF', 'live', [['2.0.0', 20, 3]]],
    ['tidepool', 'Tidepool', 'Vakantie-uitgaven eerlijk verdelen', '#0E9F8E', 'live', [['1.2.0', 3, 6], ['1.1.0', 2, 20]]],
    ['gooi-henk', 'Gooi Henk', 'Hoe ver kun jij Henk gooien?', '#E8590C', 'live', [['1.0.3', 4, 9]]],
    ['henk-herstelt', 'Henk Herstelt', 'Lap Henk weer op', '#C2410C', 'live', [['1.0.0', 1, 7]]],
    ['gerards-imperium', "Gerard's Imperium", 'Bouw Graaiman Bouw BV uit', '#8A6D1F', 'live', [['1.1.0', 2, 5]]],
    ['muse', 'Muse', 'Chat met je eigen personages', '#7A3CFF', 'live', [['1.0.1', 2, 6]]],
    ['grondig', 'Grondig', 'Vloeren beoordelen van 1 tot 10', '#4B5563', 'live', [['1.0.0', 1, 8]]],
    ['bastion', 'Bastion', 'Je wachtwoorden, veilig op slot', '#111827', 'concept', [['0.9.0', 1, 2]]],
  ];
  let apps = seed.map(([slug, name, tagline, color, status, vers], i) => {
    const appId = id();
    return {
      id: appId, slug, name, tagline, description: '', icon_url: null, color, status,
      sort_order: i, created_at: ago(30 - i), updated_at: ago(vers[0][2]),
      versions: vers.map(([vn, vc, d]) => ({
        id: id(), version_name: vn, version_code: vc, changelog: 'Verbeteringen en kleine fixes.',
        apk_path: `${slug}/${vc}.apk`, size_bytes: 6_000_000 + vc * 250_000, created_at: ago(d),
      })),
    };
  });

  let users = [
    { id: 'me', username: 'beheerder', display_name: 'Beheerder', email: 'beheerder@example.com', is_admin: true, is_blocked: false, created_at: ago(30), last_sign_in_at: ago(0, 1), email_confirmed_at: ago(30) },
    { id: id(), username: 'henk', display_name: 'Henk', email: 'henk@example.com', is_admin: false, is_blocked: false, created_at: ago(1, 3), last_sign_in_at: ago(0, 5) },
    { id: id(), username: 'gerard', display_name: 'Gerard Graaiman', email: 'gerard@example.com', is_admin: false, is_blocked: false, created_at: ago(2), last_sign_in_at: ago(1), email_confirmed_at: ago(1) },
    { id: id(), username: 'demo', display_name: 'Demo Gebruiker', email: 'demo@example.com', is_admin: false, is_blocked: false, created_at: ago(5), last_sign_in_at: ago(3), email_confirmed_at: ago(1) },
    { id: id(), username: 'spammer99', display_name: 'Spammer', email: 'spam@example.com', is_admin: false, is_blocked: true, created_at: ago(9), last_sign_in_at: ago(9), email_confirmed_at: ago(1) },
    { id: id(), username: 'test', display_name: 'Testaccount', email: 'test@example.com', is_admin: false, is_blocked: false, created_at: ago(12), last_sign_in_at: ago(10), email_confirmed_at: ago(1) },
  ];

  let announcements = [
    { id: id(), message: 'Nieuwe app: Henk Herstelt!', active: true, created_at: ago(7) },
    { id: id(), message: 'Onderhoud vanavond tussen 22:00 en 23:00.', active: false, created_at: ago(14) },
  ];

  const downloads = {};
  apps.forEach((a, i) => { downloads[a.id] = [42, 31, 57, 24, 18, 12, 9, 2][i] || 0; });
  let downloadsWeek = 37;

  let log = [
    { actor_name: '@beheerder', action: 'Update gepubliceerd: 1.2.0', target: 'Tidepool', created_at: ago(3) },
    { actor_name: 'Systeem', action: 'Nieuw Spark Account', target: '@henk', created_at: ago(1, 3) },
    { actor_name: 'Systeem', action: 'Nieuw Spark Account', target: '@gerard', created_at: ago(2) },
    { actor_name: '@beheerder', action: 'Melding geplaatst', target: 'Nieuwe app: Henk Herstelt!', created_at: ago(7) },
    { actor_name: '@beheerder', action: 'Gebruiker geblokkeerd', target: '@spammer99', created_at: ago(8) },
    { actor_name: '@beheerder', action: 'App toegevoegd', target: 'Bastion', created_at: ago(9) },
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const addLog = (action, target) => log.unshift({ actor_name: '@beheerder', action, target, created_at: new Date().toISOString() });
  let signedIn = false;
  const clone = x => JSON.parse(JSON.stringify(x));

  return {
    mode: 'demo',

    async getMe() { return signedIn ? clone(me) : null; },
    async signIn() { await wait(350); signedIn = true; },
    async signOut() { signedIn = false; },

    async stats() {
      await wait(120);
      const top = apps.slice().sort((a, b) => (downloads[b.id] || 0) - (downloads[a.id] || 0))[0];
      return {
        apps_total: apps.length,
        apps_live: apps.filter(a => a.status === 'live').length,
        apps_concept: apps.filter(a => a.status === 'concept').length,
        users_total: users.length,
        users_new_week: users.filter(u => Date.parse(u.created_at) > now - 7 * 864e5).length,
        downloads_week: downloadsWeek,
        top_app_week: top ? top.name : null,
        downloads_per_app: { ...downloads },
      };
    },

    async listApps() {
      await wait(120);
      return clone(apps).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map(normaliseApp);
    },

    async saveApp(input) {
      await wait();
      if (apps.some(a => a.slug === input.slug && a.id !== input.id)) throw new Error('Deze korte naam (slug) is al in gebruik.');
      let icon_url = input.icon_url || null;
      if (input.iconFile) icon_url = URL.createObjectURL(input.iconFile);
      if (input.id) {
        const a = apps.find(x => x.id === input.id);
        const statusChanged = a.status !== input.status;
        Object.assign(a, { slug: input.slug, name: input.name, package_name: input.package_name, tagline: input.tagline, description: input.description, color: input.color, status: input.status, sort_order: input.sort_order, icon_url, updated_at: new Date().toISOString() });
        addLog(statusChanged ? `Status gewijzigd naar ${input.status}` : 'App bewerkt', input.name);
      } else {
        apps.push({ id: id(), slug: input.slug, name: input.name, package_name: input.package_name, tagline: input.tagline, description: input.description, color: input.color, status: input.status, sort_order: input.sort_order || apps.length, icon_url, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), versions: [] });
        addLog('App toegevoegd', input.name);
      }
    },

    async deleteApp(app) {
      await wait();
      apps = apps.filter(a => a.id !== app.id);
      addLog('App verwijderd', app.name);
    },

    async setAppStatus(appId, status) {
      await wait();
      const a = apps.find(x => x.id === appId);
      a.status = status;
      addLog(`Status gewijzigd naar ${status}`, a.name);
    },

    async publishVersion(app, { version_name, version_code, changelog, file }) {
      await wait(600);
      const a = apps.find(x => x.id === app.id);
      if (a.versions.some(v => v.version_code === version_code)) throw new Error('Dit versienummer bestaat al voor deze app.');
      a.versions.push({ id: id(), version_name, version_code, changelog, apk_path: `${a.slug}/${version_code}.apk`, size_bytes: file.size, created_at: new Date().toISOString() });
      a.updated_at = new Date().toISOString();
      addLog(`Update gepubliceerd: ${version_name}`, a.name);
    },

    apkUrl() { return null; },

    async listUsers() { await wait(120); return clone(users); },

    async setBlocked(userId, blocked) {
      await wait();
      const u = users.find(x => x.id === userId);
      if (u.id === 'me') throw new Error('Je kunt jezelf niet blokkeren.');
      u.is_blocked = blocked;
      addLog(blocked ? 'Gebruiker geblokkeerd' : 'Gebruiker gedeblokkeerd', '@' + u.username);
    },

    async sendPasswordReset() { await wait(400); },

    async confirmUser(userId) {
      await wait();
      const u = users.find(x => x.id === userId);
      u.email_confirmed_at = new Date().toISOString();
      addLog('Account handmatig goedgekeurd', '@' + u.username);
    },

    async listAnnouncements() {
      await wait(100);
      return clone(announcements).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    async postAnnouncement({ message, style, title }) {
      await wait();
      announcements.unshift({ id: id(), message, style: style || 'banner', title, active: true, created_at: new Date().toISOString() });
      addLog('Melding geplaatst', message.slice(0, 80));
    },

    async deleteUser(userId) {
      await wait();
      const u = users.find(x => x.id === userId);
      if (u.is_admin) throw new Error('Neem eerst de beheerdersrechten af voordat je dit account verwijdert');
      users = users.filter(x => x.id !== userId);
      addLog('Account verwijderd', '@' + u.username);
    },

    async setAnnouncementActive(annId, active) {
      await wait();
      const a = announcements.find(x => x.id === annId);
      a.active = active;
      addLog(active ? 'Melding weer aangezet' : 'Melding uitgezet', a.message.slice(0, 80));
    },

    async listLog(limit = 100) { await wait(100); return clone(log.slice(0, limit)); },

    async serverStatus() {
      await wait(150);
      return [
        { name: 'Database (Supabase)', detail: 'api.sparkapps.nl · 18 ms', state: 'ok', label: 'Draait' },
        { name: 'Cloudflare Tunnel', detail: 'Verbonden', state: 'ok', label: 'Draait' },
        { name: 'Spark-appstore', detail: 'sparkapps.nl', state: 'ok', label: 'Draait' },
        { name: 'Automatische back-up', detail: 'Vannacht om 03:00', state: 'ok', label: 'Gelukt' },
        { name: 'Discord-bot', detail: 'Time Tracker', state: 'ok', label: 'Draait' },
        { name: 'Schijfruimte', detail: '34% gebruikt', state: 'ok', label: '34%', meter: 34 },
      ];
    },
  };
}
