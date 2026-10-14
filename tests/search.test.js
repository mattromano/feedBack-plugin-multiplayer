'use strict';
// Queue search: "+ Add" must work for any library song, whatever
// characters its filename / title / artist contain.
// Run: node --test tests/search.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Core's esc() (static/js/dom.js): text-node escaping only — & < > but
// not quotes.
const coreEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function freshPlugin({ songs }) {
    const els = {
        'mp-search': { value: 'oasis' },
        'mp-search-results': { innerHTML: '' },
    };
    const posts = [];
    global.window = { addEventListener: () => {} };
    global.document = { addEventListener: () => {}, getElementById: id => els[id] || null };
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.sessionStorage = { getItem: () => null, setItem: () => {} };
    global.esc = coreEsc;
    global.fetch = async (url, opts) => {
        if (String(url).startsWith('/api/library')) {
            return { ok: true, json: async () => ({ songs, total: songs.length }) };
        }
        posts.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ ok: true }) };
    };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const m = require(file);
    m._setRoomForTest('ABC123', 'p1');
    return { m, els, posts };
}

const tricky = {
    filename: "Oasis/Don't Look Back in Anger.feedpak",
    title: "Don't Look Back in Anger",
    artist: 'Oasis "live"',
    arrangements: [{ name: 'Lead' }, { name: 'Bass' }],
};

test('result buttons carry only an index, never song text', async () => {
    const { els } = freshPlugin({ songs: [tricky] });
    await global.window.mpSearchSongs();
    const html = els['mp-search-results'].innerHTML;
    assert.match(html, /onclick="mpAddSearchResult\(0\)"/);
    assert.ok(!/onclick="[^"]*Anger/.test(html), 'song text must not be inside onclick');
});

test('"+ Add" queues a song with an apostrophe and quotes intact', async () => {
    const { posts } = freshPlugin({ songs: [{ filename: 'a.feedpak', title: 'A', artist: 'X', arrangements: [{ name: 'Lead' }, { name: 'Bass' }] }, tricky] });
    await global.window.mpSearchSongs();
    await global.window.mpAddSearchResult(1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/api/plugins/multiplayer/rooms/ABC123/queue');
    assert.deepEqual(posts[0].body, {
        player_id: 'p1',
        filename: tricky.filename,
        title: tricky.title,
        artist: tricky.artist,
        arrangements: ['Lead', 'Bass'],
    });
});

test('an index from a stale result list is ignored', async () => {
    const { posts } = freshPlugin({ songs: [tricky] });
    await global.window.mpSearchSongs();
    await global.window.mpAddSearchResult(5);
    assert.equal(posts.length, 0);
});

test('search pages through every match and ranks the Drums version first', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
        filename: `s${i}`, title: `Song ${i}`, artist: 'A', arrangements: [{ name: 'Lead' }],
    }));
    many[120].arrangements = [{ name: 'Lead' }, { name: 'Drums' }];
    many[120].format = 'feedpak';
    const pages = [];
    const { els, m } = freshPlugin({ songs: [] });
    global.fetch = async url => {
        const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        pages.push(page);
        return { ok: true, json: async () => ({ songs: many.slice(page * 100, page * 100 + 100), total: many.length }) };
    };
    await global.window.mpSearchSongs();
    assert.deepEqual(pages, [0, 1]);
    const html = els['mp-search-results'].innerHTML;
    assert.equal((html.match(/mpAddSearchResult\(/g) || []).length, 60);   // capped list
    assert.ok(html.indexOf('Song 120') < html.indexOf('Song 0'), 'Drums version listed first');
    assert.ok(html.includes('Lead, Drums · feedpak'));
    assert.equal(typeof m._sortSearchResults, 'function');
});
