'use strict';
// Join links (/?mp=CODE), the "How to join" helpers and the in-room
// signal other plugins read (<html data-mp-room>, `multiplayer:room`).
// Run: node --test tests/join.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function el(extra) {
    const classes = new Set(['hidden']);
    return {
        value: '', textContent: '', innerHTML: '', href: '', dataset: {},
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c),
            contains: c => classes.has(c),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
        },
        focus() { this.focused = true; },
        ...extra,
    };
}

// Loads screen.js as the browser would at `href`, with just enough DOM.
function load({ href = 'http://127.0.0.1:8000/', savedName = '', screenReady = true, desktop = null, joinStatus = 200 } = {}) {
    const url = new URL(href);
    const els = {};
    for (const id of ['mp-join-code', 'mp-join-name', 'mp-create-name', 'mp-lobby-error',
        'mp-lobby-view', 'mp-room-view', 'mp-room-code', 'mp-joinhelp-url', 'mp-joinhelp-code',
        'mp-joinhelp-local-note', 'mp-joinhelp-lan', 'mp-joinhelp-lan-links', 'mp-joinhelp-lan-note',
        'mp-lan-lobby', 'mp-lan-toggle', 'mp-lan-lobby-status']) els[id] = el();
    els['mp-joinhelp-lan-links'].children = [];
    els['mp-joinhelp-lan-links'].appendChild = function (c) { this.children.push(c); };
    Object.defineProperty(els['mp-joinhelp-lan-links'], 'innerHTML', {
        get() { return ''; }, set() { this.children = []; },
    });
    Object.defineProperty(els['mp-joinhelp-lan-links'], 'childElementCount', { get() { return this.children.length; } });
    if (screenReady) els['plugin-multiplayer'] = el();
    const events = [];
    const fetches = [];
    const replaced = [];
    const shown = [];
    const store = { slopsmith_mp: JSON.stringify({ name: savedName }) };
    global.window = {
        addEventListener: () => {},
        dispatchEvent: e => events.push(e),
        showScreen: id => shown.push(id),
        feedBackDesktop: desktop || undefined,
    };
    global.document = {
        addEventListener: () => {},
        getElementById: id => els[id] || null,
        documentElement: { dataset: {} },
        createElement: () => {
            const c = el({ children: [] });
            c.appendChild = x => c.children.push(x);
            return c;
        },
    };
    global.location = {
        href: url.href, origin: url.origin, hostname: url.hostname, search: url.search,
    };
    global.history = { state: null, replaceState: (_s, _t, u) => replaced.push(u) };
    global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
    global.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} };
    global.WebSocket.OPEN = 1;
    global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
    const session = {};
    global.sessionStorage = {
        getItem: k => (k in session ? session[k] : null),
        setItem: (k, v) => { session[k] = String(v); },
        removeItem: k => { delete session[k]; },
    };
    global.fetch = async (u, opts) => {
        fetches.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (String(u).endsWith('/join') && joinStatus === 404) {
            return { ok: false, status: 404, json: async () => ({ error: 'Room not found' }) };
        }
        if (String(u).endsWith('/join')) {
            return { ok: true, status: 200, json: async () => ({ code: 'ABC234', player_id: 'p2', room: { players: {}, queue: [] } }) };
        }
        return { ok: false, json: async () => ({}) };
    };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const m = require(file);
    return { m, els, events, fetches, replaced, shown, session };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('_isLoopbackHost: only addresses other devices cannot reach', () => {
    const { m } = load();
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '[::1]', '::1', 'app.localhost', 'LOCALHOST']) {
        assert.equal(m._isLoopbackHost(h), true, h);
    }
    for (const h of ['192.168.4.72', 'my-pc.local', '10.0.0.5', 'example.com', '', undefined]) {
        assert.equal(m._isLoopbackHost(h), false, String(h));
    }
});

test('_joinLink builds origin/?mp=CODE', () => {
    const { m } = load();
    assert.equal(m._joinLink('http://192.168.1.5:18000', 'ABC234'), 'http://192.168.1.5:18000/?mp=ABC234');
    assert.equal(m._joinLink('http://127.0.0.1:8000/', 'ABC234'), 'http://127.0.0.1:8000/?mp=ABC234');
});

test('_parseJoinCode accepts room codes only', () => {
    const { m } = load();
    assert.equal(m._parseJoinCode('?mp=abc234'), 'ABC234');
    assert.equal(m._parseJoinCode('?x=1&mp=ABC234'), 'ABC234');
    for (const bad of ['', '?mp=', '?mp=AB', '?mp=ABC234XYZ', '?mp=AB%3Cx', '?other=ABC234']) {
        assert.equal(m._parseJoinCode(bad), null, bad);
    }
});

test('no ?mp= → nothing happens on load', async () => {
    const { fetches, replaced, shown } = load();
    await tick();
    assert.deepEqual([fetches.length, replaced.length, shown.length], [0, 0, 0]);
});

test('a join link with a saved name joins the room and raises the in-room signal', async () => {
    const { els, events, fetches, replaced, shown } = load({
        href: 'http://192.168.1.5:18000/?mp=abc234#x', savedName: 'Bob',
    });
    await tick(); await tick();
    assert.deepEqual(replaced, ['/#x']);                 // ?mp= stripped, hash kept
    assert.deepEqual(shown, ['plugin-multiplayer']);
    assert.equal(fetches[0].url, '/api/plugins/multiplayer/rooms/ABC234/join');
    assert.deepEqual(fetches[0].body, { name: 'Bob' });
    assert.equal(global.document.documentElement.dataset.mpRoom, 'ABC234');
    const ev = events.filter(e => e.type === 'multiplayer:room');
    assert.deepEqual(ev.map(e => e.detail.room), ['ABC234']);
    // Panel shows this page's join link; LAN origin → no loopback warning.
    assert.equal(els['mp-joinhelp-url'].textContent, 'http://192.168.1.5:18000/?mp=ABC234');
    assert.equal(els['mp-joinhelp-code'].textContent, 'ABC234');
    assert.equal(els['mp-joinhelp-local-note'].classList.contains('hidden'), true);
});

test('leaving the room clears the in-room signal', async () => {
    const { events } = load({ href: 'http://127.0.0.1:8000/?mp=ABC234', savedName: 'Bob' });
    await tick(); await tick();
    await global.window.mpLeaveRoom();
    assert.equal('mpRoom' in global.document.documentElement.dataset, false);
    assert.deepEqual(events.filter(e => e.type === 'multiplayer:room').map(e => e.detail.room), ['ABC234', null]);
});

test('loopback origin shows the "only this computer" note', async () => {
    const { els } = load({ href: 'http://127.0.0.1:8000/?mp=ABC234', savedName: 'Bob' });
    await tick(); await tick();
    assert.equal(els['mp-joinhelp-local-note'].classList.contains('hidden'), false);
});

test('without a saved name the link fills the code and asks for a name', async () => {
    const { els, fetches } = load({ href: 'http://127.0.0.1:8000/?mp=ABC234' });
    await tick();
    assert.equal(fetches.length, 0);
    assert.equal(els['mp-join-code'].value, 'ABC234');
    assert.equal(els['mp-join-name'].focused, true);
    assert.match(els['mp-lobby-error'].textContent, /ABC234/);
});

test('a tab already in that room (reload) is not re-joined', async () => {
    // Reload: sessionStorage still holds this room, so the plugin's
    // showScreen hook reconnects it before the auto-join gets a turn.
    const { fetches } = load({ href: 'http://127.0.0.1:8000/?mp=ABC234', savedName: 'Bob', screenReady: false });
    global.sessionStorage.setItem('mp_room', 'ABC234');
    global.sessionStorage.setItem('mp_player', 'p1');
    const getById = global.document.getElementById;
    global.document.getElementById = id => (id === 'plugin-multiplayer' ? {} : getById(id));
    await new Promise(r => setTimeout(r, 250));     // past one 200 ms retry
    assert.equal(fetches.filter(f => String(f.url).endsWith('/join')).length, 0);
});

// ── Players on other devices: the desktop's LAN-access switch ─────────────

function fakeDesktop(initial) {
    const calls = [];
    let state = { ...initial };
    return {
        calls,
        network: {
            getLanAccess: async () => ({ ...state }),
            setLanAccess: async on => {
                calls.push(on);
                state = { enabled: on, urls: on ? ['http://192.168.1.5:18000'] : [] };
                return { success: true, ...state };
            },
        },
    };
}

const visible = e => !e.classList.contains('hidden');
const linkTexts = els => els['mp-joinhelp-lan-links'].children.map(r => r.children[0].textContent);

test('_lanJoinLinks: one join link per reported address, only when on', () => {
    const { m } = load();
    const st = { enabled: true, urls: ['http://192.168.1.5:18000', 'http://10.0.0.2:18000', 'javascript:x', 7] };
    assert.deepEqual(m._lanJoinLinks(st, 'ABC234'),
        ['http://192.168.1.5:18000/?mp=ABC234', 'http://10.0.0.2:18000/?mp=ABC234']);
    assert.deepEqual(m._lanJoinLinks({ ...st, enabled: false }, 'ABC234'), []);
    assert.deepEqual(m._lanJoinLinks(null, 'ABC234'), []);
});

test('plain browser: no network-sharing UI, generic loopback note instead', async () => {
    const { els } = load({ href: 'http://127.0.0.1:8000/?mp=ABC234', savedName: 'Bob' });
    await tick(); await tick();
    assert.equal(visible(els['mp-lan-lobby']), false);
    assert.equal(visible(els['mp-joinhelp-lan']), false);
    assert.equal(visible(els['mp-joinhelp-local-note']), true);
});

test('desktop, sharing off: lobby toggle shown unchecked', async () => {
    const d = fakeDesktop({ enabled: false, urls: [] });
    const { els } = load({ desktop: d });
    // Lobby render happens on showScreen; drive it like the shell would.
    global.window.showScreen('plugin-multiplayer');
    await tick(); await tick();
    assert.equal(visible(els['mp-lan-lobby']), true);
    assert.equal(els['mp-lan-toggle'].checked, false);
    assert.match(els['mp-lan-lobby-status'].textContent, /^Off/);
});

test('desktop: turning sharing on lists network join links in the room', async () => {
    const d = fakeDesktop({ enabled: false, urls: [] });
    const { els } = load({ desktop: d, href: 'http://127.0.0.1:8000/?mp=ABC234', savedName: 'Bob' });
    await tick(); await tick(); await tick();
    // In the room, sharing off: no links, the "how to turn it on" note, and
    // the generic loopback note stays hidden (the desktop switch replaces it).
    assert.equal(visible(els['mp-joinhelp-lan']), true);
    assert.deepEqual(linkTexts(els), []);
    assert.match(els['mp-joinhelp-lan-note'].textContent, /leave this room/);
    assert.equal(visible(els['mp-joinhelp-local-note']), false);

    await global.window.mpSetLanAccess(true);
    assert.deepEqual(d.calls, [true]);
    assert.equal(els['mp-lan-toggle'].checked, true);
    assert.equal(els['mp-lan-toggle'].disabled, false);
    assert.deepEqual(linkTexts(els), ['http://192.168.1.5:18000/?mp=ABC234']);
    assert.match(els['mp-joinhelp-lan-note'].textContent, /firewall/);
});

test('desktop: a failing switch reports the error and keeps the real state', async () => {
    const d = fakeDesktop({ enabled: false, urls: [] });
    d.network.setLanAccess = async () => { throw new Error('backend did not restart'); };
    const { els } = load({ desktop: d });
    await global.window.mpSetLanAccess(true);
    assert.match(els['mp-lobby-error'].textContent, /backend did not restart/);
    assert.equal(els['mp-lan-toggle'].checked, false);
    assert.equal(els['mp-lan-toggle'].disabled, false);
});

test('"Room not found" explains that rooms live on the host computer', async () => {
    const { els } = load({ joinStatus: 404 });
    els['mp-join-name'].value = 'Bob';
    els['mp-join-code'].value = 'ZZZ999';
    await global.window.mpJoinRoom();
    assert.match(els['mp-lobby-error'].textContent, /^Room not found\. Rooms live on the computer that created them/);
});
