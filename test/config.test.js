import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_CHECK_INTERVAL, buildConfig } from '../src/config.js';
import { ConfigError } from '../src/utils/errors.js';
import { backoffDelay, isRetryableStatus, parseRetryAfter, withRetry } from '../src/utils/http.js';
import { HttpError } from '../src/utils/errors.js';
import {
  formatDuration,
  formatNumber,
  normalizeUsername,
  safeUrl,
  toIsoTimestamp,
  truncate,
} from '../src/utils/format.js';

const BOT_TOKEN = 'bot-token-rahasia';
const LIVE_CHANNEL_ID = '111111111111111111';
const CONTENT_CHANNEL_ID = '222222222222222222';
const GUILD_ID = '333333333333333333';
const WELCOME_CHANNEL_ID = '444444444444444444';

describe('buildConfig', () => {
  it('menerima konfigurasi minimal yang valid', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
      DISCORD_CONTENT_CHANNEL_ID: CONTENT_CHANNEL_ID,
    });

    assert.equal(config.username, 'someone');
    assert.equal(config.checkInterval, 60_000, 'default 1 menit');
    assert.equal(config.liveEnabled, true);
    assert.equal(config.contentEnabled, true);
    assert.equal(config.contentProvider, 'web');
    assert.equal(config.discord.botToken, BOT_TOKEN);
  });

  it('gagal dengan pesan jelas kalau TIKTOK_USERNAME kosong', () => {
    assert.throws(
      () => buildConfig({ DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TIKTOK_USERNAME wajib diisi/);
        return true;
      },
    );
  });

  it('gagal kalau tidak ada fitur apa pun yang aktif', () => {
    assert.throws(() => buildConfig({ TIKTOK_USERNAME: 'someone' }), {
      message: /Tidak ada fitur yang aktif/,
    });
  });

  it('melaporkan SEMUA masalah sekaligus, bukan satu per satu', () => {
    try {
      buildConfig({ CHECK_INTERVAL: 'abc' });
      assert.fail('seharusnya melempar error');
    } catch (error) {
      assert.match(error.message, /TIKTOK_USERNAME/);
      assert.match(error.message, /CHECK_INTERVAL/);
      assert.match(error.message, /Tidak ada fitur yang aktif/);
    }
  });

  it('satu channel saja tetap boleh; fitur lainnya dimatikan dengan peringatan', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
    });

    assert.equal(config.liveEnabled, true);
    assert.equal(config.contentEnabled, false);
    assert.ok(config.warnings.some((w) => w.includes('DISCORD_CONTENT_CHANNEL_ID')));
  });

  it('menolak channel id yang bukan snowflake valid', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_BOT_TOKEN: BOT_TOKEN,
          DISCORD_LIVE_CHANNEL_ID: 'bukan-angka',
        }),
      { message: /DISCORD_LIVE_CHANNEL_ID harus berupa Discord snowflake id/ },
    );
  });

  it('channel sudah diisi tapi bot token kosong -- error spesifik, bukan cuma "tidak ada fitur aktif"', () => {
    try {
      buildConfig({ TIKTOK_USERNAME: 'someone', DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID });
      assert.fail('seharusnya melempar error');
    } catch (error) {
      assert.match(error.message, /DISCORD_BOT_TOKEN wajib diisi/);
      assert.doesNotMatch(error.message, /Tidak ada fitur yang aktif/);
    }
  });

  it('menolak CHECK_INTERVAL di bawah batas minimum', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_BOT_TOKEN: BOT_TOKEN,
          DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
          CHECK_INTERVAL: '1000',
        }),
      { message: new RegExp(`CHECK_INTERVAL minimal ${MIN_CHECK_INTERVAL}`) },
    );
  });

  it('provider official wajib punya kredensialnya', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_BOT_TOKEN: BOT_TOKEN,
          DISCORD_CONTENT_CHANNEL_ID: CONTENT_CHANNEL_ID,
          TIKTOK_CONTENT_PROVIDER: 'official',
        }),
      { message: /TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN/ },
    );
  });

  it('membersihkan username yang ditulis sebagai @user atau URL lengkap', () => {
    const fromUrl = buildConfig({
      TIKTOK_USERNAME: 'https://www.tiktok.com/@someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
    });
    assert.equal(fromUrl.username, 'someone');

    const fromAt = buildConfig({
      TIKTOK_USERNAME: '  @someone  ',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
    });
    assert.equal(fromAt.username, 'someone');
  });
});

describe('buildConfig — welcome member', () => {
  it('nonaktif secara default, dengan WARN', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
    });
    assert.equal(config.welcomeEnabled, false);
    assert.ok(config.warnings.some((w) => w.includes('DISCORD_GUILD_ID')));
  });

  it('aktif kalau bot token + guild id + welcome channel id diisi', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_WELCOME_CHANNEL_ID: WELCOME_CHANNEL_ID,
    });
    assert.equal(config.welcomeEnabled, true);
    assert.equal(config.welcome.guildId, GUILD_ID);
    assert.equal(config.welcome.channelId, WELCOME_CHANNEL_ID);
  });

  it('menolak kalau cuma salah satu dari guild id / welcome channel id diisi', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_BOT_TOKEN: BOT_TOKEN,
          DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
          DISCORD_GUILD_ID: GUILD_ID,
          // DISCORD_WELCOME_CHANNEL_ID sengaja tidak diisi
        }),
      { message: /harus diisi bersamaan untuk fitur welcome member/ },
    );
  });

  it('menolak guild id yang bukan snowflake valid', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_BOT_TOKEN: BOT_TOKEN,
          DISCORD_GUILD_ID: 'bukan-angka',
          DISCORD_WELCOME_CHANNEL_ID: WELCOME_CHANNEL_ID,
        }),
      { message: /DISCORD_GUILD_ID harus berupa Discord snowflake id/ },
    );
  });

  it('aplikasi tetap boleh jalan hanya dengan welcome, tanpa LIVE/konten sama sekali', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_WELCOME_CHANNEL_ID: WELCOME_CHANNEL_ID,
    });
    assert.equal(config.welcomeEnabled, true);
    assert.equal(config.liveEnabled, false);
    assert.equal(config.contentEnabled, false);
  });

  it('satu Bot Token dipakai bersama untuk LIVE, konten, dan welcome', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      DISCORD_LIVE_CHANNEL_ID: LIVE_CHANNEL_ID,
      DISCORD_CONTENT_CHANNEL_ID: CONTENT_CHANNEL_ID,
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_WELCOME_CHANNEL_ID: WELCOME_CHANNEL_ID,
    });
    assert.equal(config.liveEnabled, true);
    assert.equal(config.contentEnabled, true);
    assert.equal(config.welcomeEnabled, true);
    assert.equal(config.discord.botToken, BOT_TOKEN);
  });
});

describe('format helpers', () => {
  it('formatNumber memberi pemisah ribuan, null untuk nilai tak tersedia', () => {
    assert.equal(formatNumber(1234), '1,234');
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(null), null);
    assert.equal(formatNumber(undefined), null);
    assert.equal(formatNumber(Number.NaN), null);
    assert.equal(formatNumber(-5), null);
  });

  it('truncate menambahkan elipsis tanpa melewati batas', () => {
    assert.equal(truncate('halo', 10), 'halo');
    assert.equal(truncate('x'.repeat(20), 5).length, 5);
    assert.equal(truncate(null, 5), '');
  });

  it('toIsoTimestamp menerima epoch detik, ms, dan string ISO', () => {
    assert.equal(toIsoTimestamp(1789602913), new Date(1789602913 * 1000).toISOString());
    assert.equal(toIsoTimestamp(1789602913000), new Date(1789602913000).toISOString());
    assert.equal(toIsoTimestamp('2026-09-25T10:00:00.000Z'), '2026-09-25T10:00:00.000Z');
    assert.equal(toIsoTimestamp('bukan tanggal'), null);
    assert.equal(toIsoTimestamp(null), null);
  });

  it('safeUrl hanya meloloskan http/https', () => {
    assert.equal(safeUrl('https://a.test/b'), 'https://a.test/b');
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('bukan url'), null);
    assert.equal(safeUrl(null), null);
  });

  it('normalizeUsername membuang @, spasi, dan sisa path', () => {
    assert.equal(normalizeUsername('@someone'), 'someone');
    assert.equal(normalizeUsername('https://www.tiktok.com/@someone/live'), 'someone');
    assert.equal(normalizeUsername('  someone  '), 'someone');
    assert.equal(normalizeUsername(undefined), '');
  });

  it('formatDuration mengubah ms jadi JJ:MM:DD, dua digit tiap bagian', () => {
    assert.equal(formatDuration(0), '00:00:00');
    assert.equal(formatDuration(5_000), '00:00:05');
    assert.equal(formatDuration(65_000), '00:01:05');
    assert.equal(formatDuration(3_661_000), '01:01:01', '1 jam 1 menit 1 detik');
    assert.equal(formatDuration(2 * 3_600_000 + 30 * 60_000 + 45_000), '02:30:45');
  });

  it('formatDuration menangani durasi lebih dari 99 jam tanpa terpotong', () => {
    assert.equal(formatDuration(100 * 3_600_000), '100:00:00');
  });

  it('formatDuration membulatkan ke bawah per detik (bukan dibulatkan)', () => {
    assert.equal(formatDuration(1_999), '00:00:01');
  });

  it('formatDuration mengembalikan null untuk nilai tidak valid', () => {
    assert.equal(formatDuration(-1), null);
    assert.equal(formatDuration(NaN), null);
    assert.equal(formatDuration('abc'), null);
    assert.equal(formatDuration(null), null);
    assert.equal(formatDuration(undefined), null);
  });
});

describe('http retry', () => {
  it('menandai status mana yang layak dicoba ulang', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(401), false);
  });

  it('parseRetryAfter membaca detik maupun HTTP-date', () => {
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': '2' })), 2000);
    assert.equal(parseRetryAfter(new Headers({ 'x-ratelimit-reset-after': '0.5' })), 500);
    assert.equal(parseRetryAfter(new Headers({})), undefined);

    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(new Headers({ 'retry-after': future }));
    assert.ok(parsed > 3000 && parsed <= 6000);
  });

  it('backoffDelay naik secara eksponensial dan dibatasi maksimum', () => {
    const rng = () => 1; // jitter maksimum, hasilnya deterministik
    assert.equal(backoffDelay(0, 1000, 30_000, rng), 1000);
    assert.equal(backoffDelay(1, 1000, 30_000, rng), 2000);
    assert.equal(backoffDelay(2, 1000, 30_000, rng), 4000);
    assert.equal(backoffDelay(10, 1000, 30_000, rng), 30_000, 'dibatasi maxMs');
  });

  it('withRetry mengulang error retryable lalu berhasil', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError('boom', { retryable: true });
        return 'ok';
      },
      { retries: 3, sleepFn: async () => {} },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('withRetry TIDAK mengulang error permanen', async () => {
    let calls = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError('404', { retryable: false });
        },
        { retries: 5, sleepFn: async () => {} },
      ),
    );
    assert.equal(calls, 1);
  });

  it('withRetry menyerah setelah percobaan habis dan melempar error terakhir', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new HttpError('selalu gagal', { retryable: true });
          },
          { retries: 2, sleepFn: async () => {} },
        ),
      { message: 'selalu gagal' },
    );
    assert.equal(calls, 3, '1 percobaan awal + 2 pengulangan');
  });
});
