/**
 * Discord Bot REST client.
 *
 * Satu-satunya jalur komunikasi ke Discord di project ini (webhook sudah
 * tidak dipakai lagi -- semua notifikasi LIVE, konten, dan welcome sama-sama
 * lewat Bot Token + channel id). Dipakai untuk tiga hal:
 *   1. Membaca daftar member server (butuh privileged intent "Server
 *      Members" aktif di Developer Portal) -- untuk fitur welcome.
 *   2. Mengirim pesan baru ke sebuah channel (LIVE, konten, welcome, rules).
 *   3. Mengedit pesan yang sudah terkirim (update jumlah penonton LIVE tanpa
 *      mengirim pesan baru).
 *
 * Referensi resmi: https://discord.com/developers/docs/resources/guild
 * (List Guild Members) dan .../resources/message (Create Message & Edit
 * Message, termasuk multipart untuk attachment).
 */

import { HttpError } from '../utils/errors.js';
import { fetchWithTimeout, isRetryableStatus, parseRetryAfter, withRetry } from '../utils/http.js';

const API_BASE = 'https://discord.com/api/v10';

/** Maksimum member per halaman sesuai batas Discord. */
const MEMBERS_PAGE_SIZE = 1000;

/**
 * User-Agent JUJUR sesuai format yang direkomendasikan Discord sendiri
 * (`DiscordBot ($url, $version)`). Ini PENTING dan bukan sekadar formalitas:
 * `fetchWithTimeout` di utils/http.js secara default mengirim User-Agent
 * PALSU ala Chrome (sengaja, untuk endpoint TikTok agar tidak diblokir WAF).
 * Kalau dipakai apa adanya ke Discord API, Discord API JUSTRU MENOLAKNYA
 * dengan HTTP 403 (code 40333 "internal network error") -- proteksi mereka
 * mendeteksi Bot Token dipakai bersama User-Agent yang menyamar sebagai
 * browser sebagai pola mencurigakan. Header ini di bawah meng-override
 * default itu supaya request ke Discord selalu jujur.
 */
const DISCORD_USER_AGENT =
  'DiscordBot (https://github.com/RanR112/bot-discord, 1.0.0)';

/**
 * Membentuk URL avatar CDN Discord, dengan fallback ke default avatar kalau
 * user tidak punya avatar custom.
 *
 * @param {{ id: string, avatar: string|null, discriminator?: string }} user
 * @returns {string}
 */
export function buildAvatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  // Sistem username baru (tanpa diskriminator #0000): index dari user id.
  // eslint-disable-next-line no-bitwise
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Mengubah Guild Member Object mentah dari Discord menjadi bentuk yang dipakai
 * di seluruh aplikasi.
 *
 * @param {any} raw
 * @returns {import('../types.js').GuildMember|null}
 */
export function mapGuildMember(raw) {
  const user = raw?.user;
  if (!user?.id) return null;
  // Catatan: Discord List Guild Members MENYERTAKAN bot di responsnya
  // (dikonfirmasi langsung saat debugging: bot "OwO" ikut muncul). Ini
  // sengaja TIDAK difilter -- bot baru yang ditambahkan ke server juga
  // dianggap member dan ikut disambut, sesuai yang diinginkan di project ini.

  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username : 'unknown',
    displayName:
      (typeof raw.nick === 'string' && raw.nick) ||
      (typeof user.global_name === 'string' && user.global_name) ||
      null,
    avatarUrl: buildAvatarUrl({ id: String(user.id), avatar: raw.avatar ?? user.avatar ?? null }),
    joinedAt: typeof raw.joined_at === 'string' ? raw.joined_at : null,
  };
}

export class DiscordBotService {
  /**
   * @param {{
   *   botToken: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ botToken, timeoutMs = 15_000, retries = 3, logger }) {
    this.botToken = botToken;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  /**
   * @param {string} path diawali "/"
   * @returns {Record<string, string>}
   * @private
   */
  #headers(extra = {}) {
    return {
      authorization: `Bot ${this.botToken}`,
      'user-agent': DISCORD_USER_AGENT,
      ...extra,
    };
  }

  /**
   * Mengambil nama server (dipakai untuk teks kartu welcome).
   *
   * @param {string} guildId
   * @returns {Promise<string|null>} null kalau gagal -- bukan error fatal,
   *          pemanggil cukup memakai teks generik sebagai fallback.
   */
  async getGuildName(guildId) {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/guilds/${guildId}`, {
        method: 'GET',
        headers: this.#headers(),
        timeoutMs: this.timeoutMs,
      });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body?.name === 'string' ? body.name : null;
    } catch {
      return null;
    }
  }

  /**
   * Mengambil SELURUH member server (dengan pagination otomatis).
   * Butuh privileged intent "Server Members" aktif di Developer Portal --
   * kalau tidak, Discord membalas 403 dengan pesan yang jelas soal intent.
   *
   * @param {string} guildId
   * @returns {Promise<import('../types.js').GuildMember[]>}
   */
  async listGuildMembers(guildId) {
    /** @type {import('../types.js').GuildMember[]} */
    const members = [];
    let after = '0';

    for (;;) {
      const url = `${API_BASE}/guilds/${guildId}/members?limit=${MEMBERS_PAGE_SIZE}&after=${after}`;

      const page = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: this.#headers(),
            timeoutMs: this.timeoutMs,
          });
          const text = await response.text();

          if (!response.ok) {
            const hint =
              response.status === 403
                ? ' Kemungkinan privileged intent "Server Members" belum diaktifkan di Discord Developer Portal, atau bot belum di-invite ke server ini.'
                : '';
            throw new HttpError(`HTTP ${response.status} saat membaca member server.${hint}`, {
              status: response.status,
              retryable: isRetryableStatus(response.status),
              retryAfterMs: parseRetryAfter(response.headers),
              body: text.slice(0, 300),
            });
          }

          try {
            return JSON.parse(text);
          } catch {
            throw new HttpError('Response daftar member bukan JSON yang valid', { retryable: false });
          }
        },
        {
          retries: this.retries,
          onRetry: ({ attempt, delayMs, error }) => {
            this.logger.warn(
              `Percobaan ulang ${attempt} baca member server dalam ${delayMs}ms: ${error.message}`,
            );
          },
        },
      );

      if (!Array.isArray(page) || page.length === 0) break;

      for (const raw of page) {
        const member = mapGuildMember(raw);
        if (member) members.push(member);
      }

      if (page.length < MEMBERS_PAGE_SIZE) break;
      after = String(page.at(-1)?.user?.id ?? after);
    }

    return members;
  }

  /**
   * Membangun FormData multipart untuk body Create/Edit Message. Dipisah
   * dari #request supaya dipakai bersama oleh send & edit.
   *
   * @param {{ embeds?: object[], content?: string, file?: { buffer: Buffer, filename: string, contentType: string } }} payload
   * @private
   */
  #buildForm(payload) {
    const { file, ...jsonPayload } = payload;
    const form = new FormData();
    form.append('payload_json', JSON.stringify(jsonPayload));
    if (file) {
      form.append('files[0]', new Blob([file.buffer], { type: file.contentType }), file.filename);
    }
    return form;
  }

  /**
   * @param {string} url
   * @param {string} method
   * @param {object} payload
   * @param {string} label dipakai di pesan error/log, mis. "kirim pesan LIVE"
   * @returns {Promise<{ id: string|null }>}
   * @private
   */
  async #request(url, method, payload, label) {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, {
          method,
          headers: this.#headers(),
          body: this.#buildForm(payload),
          timeoutMs: this.timeoutMs,
        });
        const text = await response.text();

        if (!response.ok) {
          const hint =
            response.status === 403
              ? ' Bot mungkin tidak punya izin "Send Messages"/"Embed Links"/"Attach Files" di channel ini, atau channel id-nya salah.'
              : response.status === 404
                ? ' Channel atau pesan tidak ditemukan -- cek DISCORD_*_CHANNEL_ID, atau pesannya sudah dihapus manual.'
                : '';
          throw new HttpError(`HTTP ${response.status} saat ${label}.${hint}`, {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            retryAfterMs: parseRetryAfter(response.headers),
            body: text.slice(0, 300),
          });
        }

        try {
          const body = JSON.parse(text);
          return { id: body?.id ?? null };
        } catch {
          return { id: null };
        }
      },
      {
        retries: this.retries,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(`Percobaan ulang ${attempt} ${label} dalam ${delayMs}ms: ${error.message}`);
        },
      },
    );
  }

  /**
   * Mengirim pesan BARU ke sebuah channel, dengan dukungan lampiran gambar
   * (multipart/form-data). Dipakai untuk LIVE, konten, welcome, dan pesan
   * biasa lainnya.
   *
   * @param {string} channelId
   * @param {{
   *   embeds?: object[],
   *   content?: string,
   *   file?: { buffer: Buffer, filename: string, contentType: string },
   * }} payload
   * @returns {Promise<{ id: string|null }>}
   */
  async sendChannelMessage(channelId, payload) {
    return this.#request(`${API_BASE}/channels/${channelId}/messages`, 'POST', payload, 'kirim pesan');
  }

  /**
   * Mengedit pesan yang SUDAH ADA. Dipakai untuk update jumlah penonton LIVE
   * tanpa mengirim pesan baru (setara `PATCH .../webhooks/.../messages/<id>`
   * di era webhook, sekarang lewat Bot Token).
   *
   * @param {string} channelId
   * @param {string} messageId
   * @param {{ embeds?: object[], content?: string }} payload
   * @returns {Promise<{ id: string|null }>}
   */
  async editChannelMessage(channelId, messageId, payload) {
    return this.#request(
      `${API_BASE}/channels/${channelId}/messages/${messageId}`,
      'PATCH',
      payload,
      'edit pesan',
    );
  }
}
