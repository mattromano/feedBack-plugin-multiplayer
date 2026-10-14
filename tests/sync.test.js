'use strict';
// Guest playback sync: host clock stamps + output-latency difference,
// min-RTT clock offset, seek-only drift correction (no playbackRate nudges).
// Run: node --test tests/sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    const clock = { t: 10000 };
    const audio = { currentTime: 0, playbackRate: 1, paused: false, addEventListener: () => {}, play: async () => {}, pause() { this.paused = true; } };
    global.window = { addEventListener: () => {} };
    global.document = { addEventListener: () => {}, getElementById: id => (id === 'audio' ? audio : null) };
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.sessionStorage = { getItem: () => null, setItem: () => {} };
    Object.defineProperty(globalThis, 'performance', {
        value: { now: () => clock.t }, configurable: true, writable: true,
    });
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const m = require(file);
    m._setSyncForTest({ isHost: false, room: { speed: 1 }, clockOffset: 0, settleUntil: 0, seekLead: 0.15 });
    return { m, audio, clock };
}

// A heartbeat stamped "now" on the server clock (no transit, no ahead info).
const hb = (m, clock, time) => ({ type: 'heartbeat', time, server_time: clock.t, host_server_t: clock.t });

test('clock offset comes from the smallest-RTT round', () => {
    const { m } = freshPlugin();
    assert.equal(m._bestClockRound([{ rtt: 5, offset: 1 }, { rtt: 9, offset: 2 }]), null);
    const best = m._bestClockRound([
        { rtt: 12, offset: 40 }, { rtt: 3, offset: 31 }, { rtt: 7, offset: 35 }, { rtt: 30, offset: 50 },
    ]);
    assert.deepEqual(best, { rtt: 3, offset: 31 });
});

test('host time is projected to now from the host clock stamp', () => {
    const { m, clock } = freshPlugin();
    m._setSyncForTest({ clockOffset: 500 });   // server = local + 500
    const serverNow = clock.t + 500;
    // Sampled 80 ms ago on the server clock, at 1x and 0.5x.
    assert.ok(Math.abs(m._hostTimeNow({ time: 10, host_server_t: serverNow - 80 }, 1) - 10.08) < 1e-9);
    assert.ok(Math.abs(m._hostTimeNow({ time: 10, host_server_t: serverNow - 80 }, 0.5) - 10.04) < 1e-9);
    // Older hosts: fall back to the server's receive stamp.
    assert.ok(Math.abs(m._hostTimeNow({ time: 10, host_server_t: null, server_time: serverNow - 20 }, 1) - 10.02) < 1e-9);
    // Transit is clamped to [0, 2] s.
    assert.equal(m._hostTimeNow({ time: 10, host_server_t: serverNow + 1000 }, 1), 10);
    assert.equal(m._hostTimeNow({ time: 10, host_server_t: serverNow - 9000 }, 1), 12);
});

test('output-latency difference is added once both sides know it', () => {
    const { m, clock } = freshPlugin();
    const msg = { time: 10, host_server_t: clock.t, ahead_ms: 40 };
    assert.equal(m._hostTimeNow(msg, 1), 10);                // ours unknown yet
    window.__hwtRenderAheadMs = 60;
    window.__hwtStemsSmooth = () => true;
    for (let i = 0; i < 5; i++) m._aheadMs();
    assert.equal(m._aheadMs(), 60);
    assert.ok(Math.abs(m._hostTimeNow(msg, 1) - 10.02) < 1e-9);   // we render 20 ms further ahead
    assert.equal(m._hostTimeNow({ ...msg, ahead_ms: null }, 1), 10);
});

test('small drift is left alone and playbackRate is never nudged', () => {
    const { m, audio, clock } = freshPlugin();
    for (let i = 0; i < 10; i++) {
        audio.currentTime = 10.02;      // 20 ms ahead: under the 30 ms threshold
        m._onHeartbeat(hb(m, clock, 10));
        assert.equal(audio.currentTime, 10.02);
        assert.equal(audio.playbackRate, 1);
        clock.t += 100;
    }
    // Even a sustained 40 ms drift never changes the rate (stems pitch worklet).
    audio.currentTime = 10.04;
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.playbackRate, 1);
    // A stale non-1 rate is reset to the room speed.
    audio.playbackRate = 1.002;
    audio.currentTime = 10;
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.playbackRate, 1);
});

test('drift over 30 ms on 3 heartbeats in a row -> one seek with the lead', () => {
    const { m, audio, clock } = freshPlugin();
    audio.currentTime = 9.95;           // 50 ms behind
    m._onHeartbeat(hb(m, clock, 10));
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.currentTime, 9.95);
    // A good heartbeat in between resets the count.
    audio.currentTime = 10;
    m._onHeartbeat(hb(m, clock, 10));
    audio.currentTime = 9.95;
    m._onHeartbeat(hb(m, clock, 10));
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.currentTime, 9.95);
    m._onHeartbeat(hb(m, clock, 10));
    assert.ok(Math.abs(audio.currentTime - 10.15) < 1e-9);   // expected + 150 ms lead
    const st = m._getSyncForTest();
    assert.equal(st.seekPending, true);
    assert.equal(st.settleUntil, clock.t + 700);
    // Heartbeats during the settle window are ignored.
    audio.currentTime = 5;
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.currentTime, 5);
});

test('the drift after a seek settles tunes the seek lead', () => {
    const { m, audio, clock } = freshPlugin();
    audio.currentTime = 9;              // 1 s off: seek at once
    m._onHeartbeat(hb(m, clock, 10));
    assert.ok(Math.abs(audio.currentTime - 10.15) < 1e-9);
    clock.t += 800;
    audio.currentTime = 10.84;          // landed 40 ms ahead of the host (10.8)
    m._onHeartbeat(hb(m, clock, 10.8));
    const st = m._getSyncForTest();
    assert.equal(st.seekPending, false);
    assert.ok(Math.abs(st.seekLead - 0.11) < 1e-9);
    assert.ok(Math.abs(st.lastDriftMs - 40) < 1e-6);
});

test('host and paused guests ignore heartbeats', () => {
    const { m, audio, clock } = freshPlugin();
    audio.currentTime = 3;
    m._setSyncForTest({ isHost: true });
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.currentTime, 3);
    m._setSyncForTest({ isHost: false });
    audio.paused = true;
    m._onHeartbeat(hb(m, clock, 10));
    assert.equal(audio.currentTime, 3);
});

test('play starts at the projected host time and settles first', () => {
    const { m, audio, clock } = freshPlugin();
    audio.paused = true;
    m._onPlaybackState({ type: 'playback_state', state: 'playing', time: 20, speed: 1, host_server_t: clock.t - 50, server_time: clock.t - 30 });
    assert.ok(Math.abs(audio.currentTime - 20.05) < 1e-9);
    assert.equal(audio.playbackRate, 1);
    assert.equal(m._getSyncForTest().settleUntil, clock.t + 700);
});
