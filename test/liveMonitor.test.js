import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LiveMonitor, decideLiveAction, resolveLiveId } from '../src/monitors/liveMonitor.js';
import { parseLiveRoomPayload } from '../src/services/tiktok/liveProvider.js';
import { StateStore, createDefaultState } from '../src/utils/state.js';

/** @param {Partial<import('../src/types.js').LiveStatus>} [overrides] */
function liveStatus(overrides = {}) {
  return {
    username: 'someone',
    displayName: 'Some One',
    isLive: true,
    liveId: 'room-A',
    title: 'Judul Live',
    viewers: 1234,
    url: 'https://www.tiktok.com/@someone/live',
    thumbnail: null,
    startedAt: '2026-09-25T10:00:00.000Z',
    avatar: null,
    ...overrides,
  };
}

describe('parseLiveRoomPayload', () => {
  it('menganggap OFFLINE walaupun liveRoom masih berisi data siaran lama', () => {
    // Ini perilaku TikTok yang sebenarnya: `liveRoom` tetap ada saat offline,
    // lengkap dengan roomId, judul, dan cover dari siaran terakhir. Kalau
    // dianggap live, notifier akan mengira akun LIVE selamanya.
    const payload = {
      statusCode: 0,
      data: {
        user: { nickname: 'TikTok', status: 4, roomId: '7686285865370340097' },
        liveRoom: {
          status: 4,
          title: 'Siaran kemarin',
          startTime: 1789602913,
          coverUrl: 'https://p16-webcast.tiktokcdn.com/cover.jpg',
          liveRoomStats: { userCount: 1 },
        },
      },
    };

    const result = parseLiveRoomPayload(payload, 'tiktok');
    assert.equal(result.isLive, false);
    assert.equal(result.liveId, null);
    assert.equal(result.title, null, 'judul siaran lama tidak boleh bocor');
    assert.equal(result.viewers, null);
    assert.equal(result.displayName, 'TikTok');
  });

  it('mengenali status 2 sebagai sedang LIVE dan memetakan seluruh field', () => {
    const payload = {
      statusCode: 0,
      data: {
        user: {
          nickname: 'Some One',
          status: 2,
          roomId: 'room-A',
          avatarMedium: 'https://p16.tiktokcdn.com/a.jpg',
        },
        liveRoom: {
          status: 2,
          title: 'Judul Live',
          startTime: 1789602913,
          coverUrl: 'https://p16-webcast.tiktokcdn.com/cover.jpg',
          liveRoomStats: { userCount: 4321 },
        },
      },
    };

    const result = parseLiveRoomPayload(payload, 'someone');
    assert.equal(result.isLive, true);
    assert.equal(result.liveId, 'room-A');
    assert.equal(result.title, 'Judul Live');
    assert.equal(result.viewers, 4321);
    assert.equal(result.url, 'https://www.tiktok.com/@someone/live');
    assert.equal(result.startedAt, new Date(1789602913 * 1000).toISOString());
    assert.equal(result.thumbnail, 'https://p16-webcast.tiktokcdn.com/cover.jpg');
  });

  it('tidak meledak saat field-field hilang', () => {
    const result = parseLiveRoomPayload({ data: { user: { status: 2 } } }, 'someone');
    assert.equal(result.isLive, true);
    assert.equal(result.title, null);
    assert.equal(result.viewers, null);
    assert.equal(result.liveId, null);
  });
});

describe('resolveLiveId', () => {
  it('memakai roomId kalau tersedia', () => {
    assert.equal(resolveLiveId(liveStatus()), 'room-A');
  });

  it('jatuh ke waktu mulai kalau roomId tidak ada', () => {
    assert.equal(
      resolveLiveId(liveStatus({ liveId: null })),
      'start:2026-09-25T10:00:00.000Z',
    );
  });

  it('null saat tidak LIVE', () => {
    assert.equal(resolveLiveId(liveStatus({ isLive: false })), null);
  });
});

describe('decideLiveAction — skenario satu sesi = satu notifikasi', () => {
  it('10:00 LIVE mulai -> kirim notifikasi', () => {
    const decision = decideLiveAction(createDefaultState(), liveStatus());
    assert.equal(decision.action, 'notify');
    assert.equal(decision.liveId, 'room-A');
  });

  it('10:01 dan 10:02 masih LIVE sesi sama -> tidak ada notifikasi baru', () => {
    // liveMessageId diisi karena begitu perilaku nyatanya: #handleNewSession
    // selalu menyimpan id pesan begitu notifikasi pertama terkirim. Tanpanya,
    // fixture ini justru mensimulasikan skenario "pesan hilang" yang lain.
    const state = {
      ...createDefaultState(),
      currentLiveId: 'room-A',
      lastLiveStatus: true,
      liveMessageId: 'msg-1',
    };
    for (let i = 0; i < 2; i += 1) {
      assert.equal(decideLiveAction(state, liveStatus()).action, 'none');
    }
  });

  it('11:00 LIVE berakhir -> aksi end', () => {
    const state = { ...createDefaultState(), currentLiveId: 'room-A', lastLiveStatus: true };
    const decision = decideLiveAction(state, liveStatus({ isLive: false, liveId: null }));
    assert.equal(decision.action, 'end');
  });

  it('12:30 LIVE lagi dengan room berbeda -> kirim notifikasi baru', () => {
    const afterEnd = { ...createDefaultState(), currentLiveId: null, lastLiveStatus: false };
    const decision = decideLiveAction(afterEnd, liveStatus({ liveId: 'room-B' }));
    assert.equal(decision.action, 'notify');
    assert.equal(decision.liveId, 'room-B');
  });

  it('tetap diam kalau memang tidak LIVE dan sebelumnya juga tidak', () => {
    const decision = decideLiveAction(
      createDefaultState(),
      liveStatus({ isLive: false, liveId: null }),
    );
    assert.equal(decision.action, 'none');
  });

  it('room berganti tanpa sempat terdeteksi offline tetap dianggap sesi baru', () => {
    const state = { ...createDefaultState(), currentLiveId: 'room-A', lastLiveStatus: true };
    assert.equal(decideLiveAction(state, liveStatus({ liveId: 'room-B' })).action, 'notify');
  });
});

describe('decideLiveAction — update jumlah penonton', () => {
  const base = {
    ...createDefaultState(),
    currentLiveId: 'room-A',
    lastLiveStatus: true,
    liveMessageId: 'msg-1',
    lastLiveUpdateAt: '2026-09-25T10:00:00.000Z',
    lastViewerCount: 1000,
  };
  const now = Date.parse('2026-09-25T10:10:00.000Z');

  it('meng-update saat interval terlewati dan penonton berubah', () => {
    const decision = decideLiveAction(base, liveStatus({ viewers: 2000 }), {
      now,
      liveUpdateInterval: 300_000,
    });
    assert.equal(decision.action, 'update');
  });

  it('tidak meng-update sebelum interval terlewati (hemat rate limit)', () => {
    const decision = decideLiveAction(base, liveStatus({ viewers: 2000 }), {
      now: Date.parse('2026-09-25T10:01:00.000Z'),
      liveUpdateInterval: 300_000,
    });
    assert.equal(decision.action, 'none');
  });

  it('tidak meng-update kalau jumlah penonton sama', () => {
    const decision = decideLiveAction(base, liveStatus({ viewers: 1000 }), {
      now,
      liveUpdateInterval: 300_000,
    });
    assert.equal(decision.action, 'none');
  });

  it('LIVE_UPDATE_INTERVAL=0 mematikan update sepenuhnya', () => {
    const decision = decideLiveAction(base, liveStatus({ viewers: 9999 }), {
      now,
      liveUpdateInterval: 0,
    });
    assert.equal(decision.action, 'none');
  });

  it('mengirim notifikasi pengganti kalau pesan sebelumnya hilang (mis. dihapus manual)', () => {
    // Bukan 'none': channel tidak boleh dibiarkan tanpa notifikasi untuk sesi
    // yang masih berlangsung hanya karena pesannya sudah tidak ada.
    const decision = decideLiveAction(
      { ...base, liveMessageId: null },
      liveStatus({ viewers: 9999 }),
      { now, liveUpdateInterval: 300_000 },
    );
    assert.equal(decision.action, 'notify');
    assert.equal(decision.liveId, 'room-A');
  });

  it('tetap mengirim notifikasi pengganti walau update penonton dinonaktifkan', () => {
    const decision = decideLiveAction(
      { ...base, liveMessageId: null },
      liveStatus({ viewers: 9999 }),
      { now, liveUpdateInterval: 0 },
    );
    assert.equal(decision.action, 'notify');
  });
});

describe('LiveMonitor.check — mengirim endedAt saat sesi berakhir', () => {
  const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

  function memoryStore(initial = {}) {
    const store = new StateStore('/tmp/unused-live-state.json');
    store.state = { ...createDefaultState(), ...initial };
    store.save = async () => {};
    return store;
  }

  it('meng-update pesan dengan endedAt (ISO string) begitu LIVE terdeteksi berakhir', async () => {
    const updateCalls = [];
    const tiktok = { getLiveStatus: async () => liveStatus({ isLive: false, liveId: null }) };
    const discord = {
      sendLiveNotification: async () => ({ id: 'msg-1' }),
      updateLiveNotification: async (messageId, data, options) => {
        updateCalls.push({ messageId, data, options });
        return true;
      },
    };
    const store = memoryStore({
      currentLiveId: 'room-A',
      lastLiveStatus: true,
      liveStartedAt: '2026-09-25T10:00:00.000Z',
      liveMessageId: 'msg-1',
      lastViewerCount: 500,
    });

    const monitor = new LiveMonitor({
      tiktok,
      discord,
      store,
      config: { username: 'someone', liveUpdateInterval: 300_000 },
      logger: silentLogger,
    });

    const before = Date.now();
    await monitor.check();
    const after = Date.now();

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].options.ended, true);
    assert.equal(updateCalls[0].data.startedAt, '2026-09-25T10:00:00.000Z');

    const endedAtMs = Date.parse(updateCalls[0].data.endedAt);
    assert.ok(Number.isFinite(endedAtMs), 'endedAt harus ISO string yang valid');
    assert.ok(
      endedAtMs >= before && endedAtMs <= after,
      'endedAt harus mencatat waktu terdeteksinya berakhir, bukan waktu lain',
    );
  });
});
