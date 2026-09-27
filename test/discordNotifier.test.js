import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLOR_CONTENT,
  COLOR_LIVE,
  COLOR_LIVE_ENDED,
  DiscordNotifier,
  buildContentEmbed,
  buildLiveEmbed,
} from '../src/services/discordNotifier.js';
import { redactSecrets } from '../src/utils/logger.js';

const LIVE_CHANNEL_ID = '111111111111111111';
const CONTENT_CHANNEL_ID = '222222222222222222';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('buildLiveEmbed', () => {
  const data = {
    username: 'someone',
    displayName: 'Some One',
    isLive: true,
    liveId: 'room-A',
    title: 'Judul Live',
    viewers: 1234,
    url: 'https://www.tiktok.com/@someone/live',
    thumbnail: 'https://p16-webcast.tiktokcdn.com/cover.jpg',
    startedAt: '2026-09-25T10:00:00.000Z',
    avatar: 'https://p16.tiktokcdn.com/avatar.jpg',
  };

  it('memakai warna LIVE dan memuat judul, penonton, serta link', () => {
    const embed = buildLiveEmbed(data);
    assert.equal(embed.color, COLOR_LIVE);
    assert.match(embed.description, /@someone.*sedang LIVE/s);

    const fieldNames = embed.fields.map((f) => f.name);
    assert.ok(fieldNames.some((n) => n === 'Title'));
    assert.ok(fieldNames.some((n) => n.includes('Viewers')));

    const viewers = embed.fields.find((f) => f.name.includes('Viewers'));
    assert.equal(viewers.value, '1,234', 'angka diformat dengan pemisah ribuan');

    const link = embed.fields.find((f) => f.name.includes('Link'));
    assert.equal(link.value, `[Watch LIVE](${data.url})`);
    assert.equal(embed.image.url, data.thumbnail);
  });

  it('memakai warna abu-abu saat sesi sudah berakhir', () => {
    const embed = buildLiveEmbed(data, { ended: true });
    assert.equal(embed.color, COLOR_LIVE_ENDED);
    assert.match(embed.description, /selesai LIVE/);
  });

  it('saat masih LIVE: field "Mulai" berisi timestamp relatif Discord', () => {
    const embed = buildLiveEmbed(data);
    const field = embed.fields.find((f) => f.name.includes('Mulai'));
    assert.ok(field, 'field Mulai harus ada saat masih LIVE');
    assert.equal(
      field.value,
      `<t:${Math.floor(new Date(data.startedAt).getTime() / 1000)}:R>`,
    );
    assert.equal(embed.fields.some((f) => f.name.includes('Durasi')), false);
  });

  it('saat sudah berakhir: field "Mulai" diganti "Durasi" berformat JJ:MM:DD', () => {
    const embed = buildLiveEmbed(
      { ...data, endedAt: '2026-09-25T11:30:45.000Z' }, // 1j 30m 45d setelah startedAt 10:00:00
      { ended: true },
    );
    const durasi = embed.fields.find((f) => f.name.includes('Durasi'));
    assert.ok(durasi, 'field Durasi harus ada saat sudah berakhir');
    assert.equal(durasi.value, '01:30:45');
    assert.equal(embed.fields.some((f) => f.name.includes('Mulai')), false, 'field Mulai tidak boleh tersisa');
  });

  it('tetap menampilkan Durasi (fallback ke waktu sekarang) walau endedAt tidak disuplai', () => {
    // Jaring pengaman: seharusnya tidak pernah terjadi lewat liveMonitor.js
    // (selalu mengirim endedAt), tapi kalau terjadi, field tetap tampil
    // daripada hilang tanpa penjelasan.
    const embed = buildLiveEmbed(data, { ended: true });
    const durasi = embed.fields.find((f) => f.name.includes('Durasi'));
    assert.ok(durasi);
    assert.match(durasi.value, /^\d{2,}:\d{2}:\d{2}$/);
  });

  it('menghilangkan field yang datanya tidak tersedia, bukan menulis nol palsu', () => {
    const embed = buildLiveEmbed({ ...data, title: null, viewers: null, thumbnail: null });
    const names = embed.fields.map((f) => f.name);
    assert.equal(names.some((n) => n.includes('Viewers')), false);
    assert.equal(names.includes('Title'), false);
    assert.equal('image' in embed, false);
  });

  it('menolak URL thumbnail yang tidak valid agar Discord tidak menolak payload', () => {
    const embed = buildLiveEmbed({ ...data, thumbnail: 'javascript:alert(1)' });
    assert.equal('image' in embed, false);
  });

  it('tidak pernah memuat nilai null (Discord menolak payload seperti itu)', () => {
    const embed = buildLiveEmbed({ ...data, title: null, viewers: null, avatar: null });
    assert.equal(JSON.stringify(embed).includes('null'), false);
  });
});

describe('buildContentEmbed', () => {
  const data = {
    id: '123',
    username: 'someone',
    displayName: 'Some One',
    caption: 'Caption video...',
    url: 'https://www.tiktok.com/@someone/video/123',
    thumbnail: 'https://p16.tiktokcdn.com/cover.jpg',
    publishedAt: '2026-09-25T09:00:00.000Z',
    views: 12345,
    likes: 1234,
    comments: 123,
    shares: 123,
    source: 'web',
  };

  it('memakai warna konten dan menampilkan keempat statistik', () => {
    const embed = buildContentEmbed(data);
    assert.equal(embed.color, COLOR_CONTENT);
    assert.notEqual(embed.color, COLOR_LIVE, 'warna LIVE dan konten harus berbeda');

    const values = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Views') && v === '12,345'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Likes') && v === '1,234'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Comments') && v === '123'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Shares') && v === '123'));
  });

  it('tetap membentuk embed yang valid saat statistik tidak tersedia', () => {
    const embed = buildContentEmbed({
      ...data,
      views: null,
      likes: null,
      comments: null,
      shares: null,
    });
    const link = embed.fields.find((f) => f.name.includes('Link'));
    assert.ok(link, 'link ke video tetap ada');
    assert.match(embed.footer.text, /statistik tidak tersedia/);
  });

  it('memotong caption yang sangat panjang', () => {
    const embed = buildContentEmbed({ ...data, caption: 'x'.repeat(5000) });
    assert.ok(embed.description.length <= 4096);
  });
});

describe('DiscordNotifier — pemisahan channel', () => {
  /** Mock DiscordBotService: merekam pemanggilan tanpa menyentuh jaringan. */
  function mockDiscordBot() {
    const sent = [];
    const edited = [];
    return {
      sent,
      edited,
      sendChannelMessage: async (channelId, payload) => {
        sent.push({ channelId, payload });
        return { id: `msg-${sent.length}` };
      },
      editChannelMessage: async (channelId, messageId, payload) => {
        edited.push({ channelId, messageId, payload });
        return { id: messageId };
      },
    };
  }

  const liveData = {
    username: 'someone',
    displayName: 'Some One',
    isLive: true,
    liveId: 'room-A',
    title: 't',
    viewers: 1,
    url: 'https://www.tiktok.com/@someone/live',
    thumbnail: null,
    startedAt: '2026-09-25T10:00:00.000Z',
    avatar: null,
  };

  const contentData = {
    id: '1',
    username: 'someone',
    displayName: 'Some One',
    caption: 'c',
    url: 'https://www.tiktok.com/@someone/video/1',
    thumbnail: null,
    publishedAt: '2026-09-25T09:00:00.000Z',
    views: null,
    likes: null,
    comments: null,
    shares: null,
    source: 'web',
  };

  it('notifikasi LIVE hanya pergi ke channel LIVE', async () => {
    const discordBot = mockDiscordBot();
    const notifier = new DiscordNotifier({
      discordBot,
      liveChannelId: LIVE_CHANNEL_ID,
      contentChannelId: CONTENT_CHANNEL_ID,
      logger: silentLogger,
    });

    await notifier.sendLiveNotification(liveData);

    assert.equal(discordBot.sent.length, 1);
    assert.equal(discordBot.sent[0].channelId, LIVE_CHANNEL_ID);
    assert.notEqual(discordBot.sent[0].channelId, CONTENT_CHANNEL_ID);
  });

  it('notifikasi konten hanya pergi ke channel konten', async () => {
    const discordBot = mockDiscordBot();
    const notifier = new DiscordNotifier({
      discordBot,
      liveChannelId: LIVE_CHANNEL_ID,
      contentChannelId: CONTENT_CHANNEL_ID,
      logger: silentLogger,
    });

    await notifier.sendContentNotification(contentData);

    assert.equal(discordBot.sent.length, 1);
    assert.equal(discordBot.sent[0].channelId, CONTENT_CHANNEL_ID);
    assert.notEqual(discordBot.sent[0].channelId, LIVE_CHANNEL_ID);
  });

  it('melewati notifikasi LIVE tanpa error kalau channel-nya tidak dikonfigurasi', async () => {
    const discordBot = mockDiscordBot();
    const notifier = new DiscordNotifier({
      discordBot,
      liveChannelId: null,
      contentChannelId: CONTENT_CHANNEL_ID,
      logger: silentLogger,
    });
    assert.equal(await notifier.sendLiveNotification(liveData), null);
    assert.equal(discordBot.sent.length, 0);
  });

  it('updateLiveNotification mengedit pesan di channel LIVE, bukan mengirim baru', async () => {
    const discordBot = mockDiscordBot();
    const notifier = new DiscordNotifier({
      discordBot,
      liveChannelId: LIVE_CHANNEL_ID,
      contentChannelId: CONTENT_CHANNEL_ID,
      logger: silentLogger,
    });

    const ok = await notifier.updateLiveNotification('msg-1', liveData);

    assert.equal(ok, true);
    assert.equal(discordBot.sent.length, 0, 'tidak mengirim pesan baru');
    assert.equal(discordBot.edited.length, 1);
    assert.equal(discordBot.edited[0].channelId, LIVE_CHANNEL_ID);
    assert.equal(discordBot.edited[0].messageId, 'msg-1');
  });

  it('updateLiveNotification mengembalikan false (bukan melempar) kalau edit gagal', async () => {
    const discordBot = {
      sendChannelMessage: async () => ({ id: 'x' }),
      editChannelMessage: async () => {
        const err = new Error('404 not found');
        err.status = 404;
        throw err;
      },
    };
    const notifier = new DiscordNotifier({
      discordBot,
      liveChannelId: LIVE_CHANNEL_ID,
      contentChannelId: null,
      logger: silentLogger,
    });

    const ok = await notifier.updateLiveNotification('msg-1', liveData);
    assert.equal(ok, false);
  });
});

describe('redactSecrets', () => {
  it('menyamarkan field objek yang namanya sensitif', () => {
    const redacted = redactSecrets({ botToken: 'abc', refresh_token: 'xyz', aman: 'ok' });
    assert.equal(redacted.botToken, '***redacted***');
    assert.equal(redacted.refresh_token, '***redacted***');
    assert.equal(redacted.aman, 'ok');
  });
});
