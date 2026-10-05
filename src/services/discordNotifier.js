/**
 * Discord notifier — LIVE & konten, lewat Bot Token + channel id.
 *
 * Dua fungsi terpisah dengan tujuan yang tidak ambigu:
 *   sendLiveNotification(data)    -> HANYA ke DISCORD_LIVE_CHANNEL_ID
 *   sendContentNotification(data) -> HANYA ke DISCORD_CONTENT_CHANNEL_ID
 *
 * Channel id diikat ke instance saat konstruksi dan tidak pernah dilewatkan
 * sebagai argumen, sehingga secara struktural mustahil mengirim notifikasi
 * konten ke channel LIVE atau sebaliknya -- pola yang sama seperti versi
 * webhook sebelumnya, cuma transportnya diganti dari webhook URL menjadi
 * Bot Token (lewat DiscordBotService) supaya satu bot bisa menangani semua
 * (LIVE, konten, welcome) tanpa perlu mengelola beberapa webhook terpisah.
 */

import { formatDuration, formatNumber, safeUrl, toIsoTimestamp, truncate } from '../utils/format.js';

/** Merah khas TikTok — dipakai untuk LIVE. */
export const COLOR_LIVE = 0xfe2c55;
/** Cyan khas TikTok — dipakai untuk konten baru. */
export const COLOR_CONTENT = 0x25f4ee;
/** Abu-abu — dipakai saat sesi LIVE sudah berakhir. */
export const COLOR_LIVE_ENDED = 0x4f545c;

/** Batas panjang dari dokumentasi Discord. */
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
};

/**
 * Membuang field yang bernilai null/undefined secara rekursif.
 * Discord menolak payload yang memuat `"url": null`.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function compact(value) {
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map(compact).filter((v) => v !== undefined));
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const cleaned = compact(v);
      if (cleaned === undefined) continue;
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
        continue;
      }
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      out[k] = cleaned;
    }
    return /** @type {any} */ (out);
  }
  return value;
}

/**
 * Membuat satu field embed inline, atau null kalau nilainya tidak tersedia.
 * Dipakai supaya statistik yang tidak diketahui DIHILANGKAN, bukan ditulis "0".
 *
 * @param {string} name
 * @param {string|null} value
 */
function statField(name, value) {
  if (!value) return null;
  return { name: truncate(name, LIMITS.fieldName), value: truncate(value, LIMITS.fieldValue), inline: true };
}

/**
 * Field waktu pada embed LIVE: "Mulai" (relatif, mis. "12 minutes ago") saat
 * sesi masih berlangsung, berganti jadi "Durasi" (JJ:MM:DD) begitu sesi
 * berakhir. Durasi dihitung dari `startedAt` sampai `endedAt` -- `endedAt`
 * WAJIB disuplai pemanggil (liveMonitor.js, saat mendeteksi sesi berakhir)
 * supaya fungsi ini tetap murni/testable, tidak diam-diam memanggil
 * `Date.now()` sendiri. Kalau `ended: true` tapi `endedAt` tidak disuplai
 * (seharusnya tidak pernah terjadi lewat jalur normal), fallback ke waktu
 * saat ini sebagai jaring pengaman -- field durasi tetap tampil daripada hilang.
 *
 * @param {import('../types.js').LiveStatus} data
 * @param {boolean} ended
 * @returns {{ name: string, value: string, inline: boolean } | null}
 */
function timeField(data, ended) {
  if (!data.startedAt) return null;

  if (!ended) {
    return {
      name: '⏱️ Mulai',
      value: `<t:${Math.floor(new Date(data.startedAt).getTime() / 1000)}:R>`,
      inline: true,
    };
  }

  const startedAtMs = new Date(data.startedAt).getTime();
  const endedAtMs = data.endedAt ? new Date(data.endedAt).getTime() : Date.now();
  const duration = formatDuration(endedAtMs - startedAtMs);
  return duration ? { name: '⏱️ Durasi', value: duration, inline: true } : null;
}

/**
 * Field jumlah penonton: "Viewers" (penonton bersamaan saat ini) selagi
 * masih LIVE, berganti jadi "Total Viewers" (kumulatif selama sesi,
 * BEST-EFFORT -- lihat catatan di liveProvider.js) begitu sesi berakhir.
 * Kalau totalViewers tidak tersedia saat ended (mis. TikTok mengubah
 * struktur data), fallback ke `viewers` biasa daripada menghilangkan field
 * ini sepenuhnya -- info penonton terakhir tetap lebih baik daripada tidak ada.
 *
 * @param {import('../types.js').LiveStatus} data
 * @param {boolean} ended
 * @returns {{ name: string, value: string, inline: boolean } | null}
 */
function viewersField(data, ended) {
  if (ended) {
    const total = formatNumber(data.totalViewers);
    if (total) return { name: '👁️ Total Viewers', value: total, inline: true };
  }
  return statField('👁️ Viewers', formatNumber(data.viewers));
}

/**
 * Menyusun embed untuk notifikasi LIVE.
 *
 * @param {import('../types.js').LiveStatus} data
 * @param {{ ended?: boolean }} [options]
 */
export function buildLiveEmbed(data, options = {}) {
  const { ended = false } = options;
  const displayName = data.displayName || data.username;
  const url = safeUrl(data.url);

  const descriptionLines = [
    ended
      ? `**@${data.username}** sudah selesai LIVE.`
      : `**@${data.username}** sedang LIVE sekarang!`,
  ];
  if (data.title) {
    descriptionLines.push('', `> ${truncate(data.title, 500)}`);
  }

  return compact({
    title: ended ? '⚫ LIVE Berakhir' : '🔴 TikTok LIVE',
    url,
    color: ended ? COLOR_LIVE_ENDED : COLOR_LIVE,
    description: truncate(descriptionLines.join('\n'), LIMITS.description),
    author: {
      name: truncate(`${displayName} (@${data.username})`, LIMITS.author),
      url: `https://www.tiktok.com/@${data.username}`,
      icon_url: safeUrl(data.avatar),
    },
    fields: [
      data.title ? { name: 'Title', value: truncate(data.title, LIMITS.fieldValue), inline: false } : null,
      viewersField(data, ended),
      timeField(data, ended),
      url ? { name: '🔗 Link', value: `[Watch LIVE](${url})`, inline: false } : null,
    ].filter(Boolean),
    image: safeUrl(data.thumbnail) ? { url: safeUrl(data.thumbnail) } : null,
    footer: { text: truncate('TikTok LIVE Notifier', LIMITS.footer) },
    timestamp: toIsoTimestamp(data.startedAt) ?? new Date().toISOString(),
  });
}

/**
 * Menyusun embed untuk notifikasi konten baru.
 *
 * @param {import('../types.js').ContentItem} data
 */
export function buildContentEmbed(data) {
  const displayName = data.displayName || data.username;
  const url = safeUrl(data.url);

  const stats = [
    statField('👁️ Views', formatNumber(data.views)),
    statField('❤️ Likes', formatNumber(data.likes)),
    statField('💬 Comments', formatNumber(data.comments)),
    statField('🔄 Shares', formatNumber(data.shares)),
  ].filter(Boolean);

  const descriptionLines = [`**@${data.username}**`];
  if (data.caption) {
    descriptionLines.push('', `> ${truncate(data.caption, 600).replace(/\n/g, '\n> ')}`);
  }

  return compact({
    title: '🎬 New TikTok Video',
    url,
    color: COLOR_CONTENT,
    description: truncate(descriptionLines.join('\n'), LIMITS.description),
    author: {
      name: truncate(`${displayName} (@${data.username})`, LIMITS.author),
      url: `https://www.tiktok.com/@${data.username}`,
    },
    fields: [
      ...stats,
      url ? { name: '🔗 Link', value: `[Watch on TikTok](${url})`, inline: false } : null,
    ].filter(Boolean),
    image: safeUrl(data.thumbnail) ? { url: safeUrl(data.thumbnail) } : null,
    footer: {
      text: truncate(
        stats.length > 0 ? 'TikTok Content Notifier' : 'TikTok Content Notifier • statistik tidak tersedia',
        LIMITS.footer,
      ),
    },
    timestamp: toIsoTimestamp(data.publishedAt) ?? new Date().toISOString(),
  });
}

export class DiscordNotifier {
  /**
   * @param {{
   *   discordBot: import('./discordBot.js').DiscordBotService,
   *   liveChannelId: string|null,
   *   contentChannelId: string|null,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ discordBot, liveChannelId, contentChannelId, logger }) {
    this.discordBot = discordBot;
    this.liveChannelId = liveChannelId;
    this.contentChannelId = contentChannelId;
    this.logger = logger;
  }

  /**
   * Notifikasi LIVE. HANYA memakai DISCORD_LIVE_CHANNEL_ID.
   *
   * @param {import('../types.js').LiveStatus} data
   * @returns {Promise<{ id: string|null }|null>} null kalau channel tidak dikonfigurasi
   */
  async sendLiveNotification(data) {
    if (!this.liveChannelId) {
      this.logger.debug('Notifikasi LIVE dilewati: DISCORD_LIVE_CHANNEL_ID tidak dikonfigurasi.');
      return null;
    }

    const payload = {
      content: `🔴 **@${data.username}** sedang LIVE! @everyone`,
      embeds: [buildLiveEmbed(data)],
      allowed_mentions: { parse: ['everyone'] },
    };

    const result = await this.discordBot.sendChannelMessage(this.liveChannelId, payload);
    this.logger.info(`Notifikasi LIVE terkirim untuk @${data.username}`, {
      liveId: data.liveId,
      messageId: result.id,
    });
    return result;
  }

  /**
   * Meng-EDIT pesan LIVE yang sudah ada (mis. saat jumlah penonton berubah).
   * Meng-edit jauh lebih hemat rate limit daripada mengirim pesan baru.
   *
   * @param {string} messageId
   * @param {import('../types.js').LiveStatus} data
   * @param {{ ended?: boolean }} [options]
   * @returns {Promise<boolean>} true kalau berhasil
   */
  async updateLiveNotification(messageId, data, options = {}) {
    if (!this.liveChannelId || !messageId) return false;

    const payload = {
      content: options.ended
        ? `⚫ **@${data.username}** sudah selesai LIVE.`
        : `🔴 **@${data.username}** sedang LIVE!`,
      embeds: [buildLiveEmbed(data, options)],
      allowed_mentions: { parse: [] },
    };

    try {
      await this.discordBot.editChannelMessage(this.liveChannelId, messageId, payload);
      this.logger.info(`Pesan LIVE diperbarui untuk @${data.username}`, {
        messageId,
        viewers: data.viewers,
        ended: Boolean(options.ended),
      });
      return true;
    } catch (error) {
      // Pesan bisa saja sudah dihapus manual (404). Itu bukan kondisi fatal.
      const level = error?.status === 404 ? 'warn' : 'error';
      this.logger[level](`Gagal memperbarui pesan LIVE: ${error?.message}`, { messageId });
      return false;
    }
  }

  /**
   * Notifikasi konten baru. HANYA memakai DISCORD_CONTENT_CHANNEL_ID.
   *
   * @param {import('../types.js').ContentItem} data
   * @returns {Promise<{ id: string|null }|null>} null kalau channel tidak dikonfigurasi
   */
  async sendContentNotification(data) {
    if (!this.contentChannelId) {
      this.logger.debug('Notifikasi konten dilewati: DISCORD_CONTENT_CHANNEL_ID tidak dikonfigurasi.');
      return null;
    }

    const payload = {
      content: `@everyone 🎬 Video baru dari **@${data.username}**`,
      embeds: [buildContentEmbed(data)],
      allowed_mentions: { parse: ['everyone'] },
    };

    const result = await this.discordBot.sendChannelMessage(this.contentChannelId, payload);
    this.logger.info(`Notifikasi konten terkirim untuk video ${data.id}`, {
      messageId: result.id,
    });
    return result;
  }
}
