/**
 * Pemuatan dan validasi konfigurasi.
 *
 * Prinsip: aplikasi GAGAL SAAT START dengan pesan yang jelas kalau konfigurasi
 * wajib tidak ada — bukan crash misterius di tengah jalan beberapa menit kemudian.
 *
 * Tidak ada dependency: `process.loadEnvFile()` adalah API bawaan Node (>= 20.12
 * / 21.7), jadi `dotenv` tidak diperlukan.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError } from './utils/errors.js';
import { normalizeUsername } from './utils/format.js';

/** Interval polling paling cepat yang diizinkan, agar tetap sopan ke TikTok. */
export const MIN_CHECK_INTERVAL = 15_000;

const CONTENT_PROVIDERS = new Set(['web', 'official', 'mock', 'disabled']);

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Memuat file .env ke `process.env` bila ada.
 * Variabel yang sudah ada di environment (mis. dari PM2 atau Docker) menang.
 *
 * @param {string} [envPath]
 * @returns {boolean} true kalau ada file yang dimuat
 */
export function loadEnvFile(envPath = resolve(process.cwd(), '.env')) {
  if (!existsSync(envPath)) return false;
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch (error) {
    throw new ConfigError(`Gagal membaca file .env di ${envPath}: ${error?.message}`);
  }
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @param {string[]} errors
 */
function readInteger(env, key, fallback, bounds, errors) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`${key} harus berupa bilangan bulat, dapat "${raw}".`);
    return fallback;
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    errors.push(`${key} minimal ${bounds.min}, dapat ${value}.`);
    return fallback;
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    errors.push(`${key} maksimal ${bounds.max}, dapat ${value}.`);
    return fallback;
  }
  return value;
}

/**
 * Memvalidasi format Discord snowflake id (guild id, channel id, dll):
 * murni digit, 17-20 karakter.
 *
 * @param {string|undefined} raw
 * @param {string} key
 * @param {string[]} errors
 * @returns {string|null}
 */
function readSnowflake(raw, key, errors) {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^\d{17,20}$/.test(value)) {
    errors.push(`${key} harus berupa Discord snowflake id (17-20 digit angka), dapat "${value}".`);
    return null;
  }
  return value;
}

/**
 * Membangun objek konfigurasi dari environment.
 * Mengumpulkan SEMUA masalah lalu melaporkannya sekaligus, supaya pengguna
 * tidak harus memperbaiki satu per satu lewat restart berulang.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<ReturnType<typeof buildConfig>>}
 */
export function buildConfig(env = process.env) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const username = normalizeUsername(env.TIKTOK_USERNAME);
  if (!username) {
    errors.push('TIKTOK_USERNAME wajib diisi (username TikTok tanpa tanda @).');
  } else if (!/^[\w.]{1,24}$/.test(username)) {
    errors.push(
      `TIKTOK_USERNAME "${username}" tidak valid. Username TikTok hanya berisi huruf, angka, titik, dan underscore.`,
    );
  }

  // --- Discord: SATU Bot Token dipakai bersama untuk LIVE, konten, dan
  // welcome member -- tidak ada lagi webhook. Tiap fitur dibedakan lewat
  // channel id-nya sendiri, bukan lewat kredensial terpisah seperti webhook
  // dulu (pemisahan channel tetap dijamin secara struktural lewat kode di
  // discordNotifier.js: satu instance = satu channel id per notifikasi).
  const botToken = env.DISCORD_BOT_TOKEN?.trim() || null;
  const liveChannelId = readSnowflake(env.DISCORD_LIVE_CHANNEL_ID, 'DISCORD_LIVE_CHANNEL_ID', errors);
  const contentChannelId = readSnowflake(
    env.DISCORD_CONTENT_CHANNEL_ID,
    'DISCORD_CONTENT_CHANNEL_ID',
    errors,
  );

  // Catatan: pengecekan "minimal satu fitur harus aktif" dipindah ke akhir
  // fungsi, setelah field welcome & botToken selesai di-parse.
  if (!liveChannelId) {
    warnings.push('DISCORD_LIVE_CHANNEL_ID belum diisi — monitoring LIVE dinonaktifkan.');
  }
  if (!contentChannelId) {
    warnings.push('DISCORD_CONTENT_CHANNEL_ID belum diisi — monitoring konten dinonaktifkan.');
  }

  const checkInterval = readInteger(
    env,
    'CHECK_INTERVAL',
    60_000,
    { min: MIN_CHECK_INTERVAL, max: 86_400_000 },
    errors,
  );
  const liveUpdateInterval = readInteger(
    env,
    'LIVE_UPDATE_INTERVAL',
    300_000,
    { min: 0, max: 86_400_000 },
    errors,
  );
  const maxContentPerCycle = readInteger(env, 'MAX_CONTENT_PER_CYCLE', 3, { min: 1, max: 20 }, errors);
  const requestTimeout = readInteger(env, 'REQUEST_TIMEOUT', 15_000, { min: 1000, max: 120_000 }, errors);
  const maxRetries = readInteger(env, 'MAX_RETRIES', 3, { min: 0, max: 10 }, errors);

  if (liveUpdateInterval > 0 && liveUpdateInterval < checkInterval) {
    warnings.push(
      `LIVE_UPDATE_INTERVAL (${liveUpdateInterval}ms) lebih kecil dari CHECK_INTERVAL (${checkInterval}ms); ` +
        'update penonton tetap dibatasi oleh CHECK_INTERVAL.',
    );
  }

  const contentProvider = (env.TIKTOK_CONTENT_PROVIDER ?? 'web').trim().toLowerCase();
  if (!CONTENT_PROVIDERS.has(contentProvider)) {
    errors.push(
      `TIKTOK_CONTENT_PROVIDER harus salah satu dari: ${[...CONTENT_PROVIDERS].join(', ')}. Dapat "${contentProvider}".`,
    );
  }

  const official = {
    clientKey: env.TIKTOK_CLIENT_KEY?.trim() || null,
    clientSecret: env.TIKTOK_CLIENT_SECRET?.trim() || null,
    refreshToken: env.TIKTOK_REFRESH_TOKEN?.trim() || null,
  };
  if (contentProvider === 'official') {
    const missing = Object.entries(official)
      .filter(([, v]) => !v)
      .map(([k]) => `TIKTOK_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
    if (missing.length > 0) {
      errors.push(
        `TIKTOK_CONTENT_PROVIDER=official membutuhkan: ${missing.join(', ')}.`,
      );
    }
  }

  const mockFile = env.TIKTOK_MOCK_FILE?.trim() || './data/mock-content.json';
  if (contentProvider === 'mock' && !existsSync(resolve(mockFile))) {
    errors.push(`TIKTOK_MOCK_FILE tidak ditemukan: ${resolve(mockFile)}`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    errors.push(`LOG_LEVEL harus salah satu dari: ${[...LOG_LEVELS].join(', ')}. Dapat "${logLevel}".`);
  }

  const stateFile = resolve(env.STATE_FILE?.trim() || './data/state.json');

  // --- Welcome member (opsional, fitur terpisah dari notifikasi TikTok) ---
  // DISCORD_GUILD_ID dan DISCORD_WELCOME_CHANNEL_ID wajib diisi BERSAMAAN
  // (botToken sudah dicek terpisah di bawah, sekarang kredensial bersama).
  const guildId = readSnowflake(env.DISCORD_GUILD_ID, 'DISCORD_GUILD_ID', errors);
  const welcomeChannelId = readSnowflake(
    env.DISCORD_WELCOME_CHANNEL_ID,
    'DISCORD_WELCOME_CHANNEL_ID',
    errors,
  );
  const welcomeMaxPerCycle = readInteger(env, 'WELCOME_MAX_PER_CYCLE', 5, { min: 1, max: 50 }, errors);

  const welcomePairPresent = [guildId, welcomeChannelId].filter(Boolean).length;
  if (welcomePairPresent === 1) {
    errors.push(
      'DISCORD_GUILD_ID dan DISCORD_WELCOME_CHANNEL_ID harus diisi bersamaan untuk fitur welcome member. ' +
        'Kosongkan keduanya untuk mematikan fitur ini, atau isi keduanya untuk mengaktifkan.',
    );
  }
  if (welcomePairPresent === 0) {
    warnings.push('DISCORD_GUILD_ID/DISCORD_WELCOME_CHANNEL_ID belum diisi — fitur sambutan member baru dinonaktifkan.');
  }

  const liveEnabled = Boolean(botToken && liveChannelId);
  const contentEnabled = Boolean(botToken && contentChannelId) && contentProvider !== 'disabled';
  const welcomeEnabled = Boolean(botToken && guildId && welcomeChannelId);

  // Channel id sudah diisi tapi bot token belum -- ini beda dari "fitur
  // dimatikan sengaja", jadi wajib error yang jelas, bukan cuma warning.
  if (!botToken && (liveChannelId || contentChannelId || welcomePairPresent === 2)) {
    errors.push(
      'DISCORD_BOT_TOKEN wajib diisi karena minimal satu channel Discord sudah dikonfigurasi ' +
        '(DISCORD_LIVE_CHANNEL_ID / DISCORD_CONTENT_CHANNEL_ID / DISCORD_GUILD_ID+DISCORD_WELCOME_CHANNEL_ID).',
    );
  } else if (!botToken) {
    warnings.push('DISCORD_BOT_TOKEN belum diisi — semua fitur Discord (LIVE, konten, welcome) dinonaktifkan.');
  }

  // Setidaknya satu fitur (LIVE, konten, atau welcome member) harus aktif.
  // Kalau ada channel yang sudah dikonfigurasi tapi botToken kosong, error
  // spesifik di atas sudah cukup menjelaskan -- tidak perlu pesan generik ini juga.
  const anyChannelConfigured = Boolean(liveChannelId || contentChannelId || welcomePairPresent > 0);
  if (!liveEnabled && !contentEnabled && !welcomeEnabled && !anyChannelConfigured) {
    errors.push(
      'Tidak ada fitur yang aktif. Isi DISCORD_BOT_TOKEN plus minimal salah satu dari ' +
        'DISCORD_LIVE_CHANNEL_ID, DISCORD_CONTENT_CHANNEL_ID, atau (DISCORD_GUILD_ID + DISCORD_WELCOME_CHANNEL_ID).',
    );
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Konfigurasi tidak valid:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
        'Periksa file .env kamu. Contoh lengkapnya ada di .env.example.',
    );
  }

  return Object.freeze({
    username,
    profileUrl: `https://www.tiktok.com/@${username}`,
    liveUrl: `https://www.tiktok.com/@${username}/live`,

    discord: Object.freeze({
      botToken,
      liveChannelId,
      contentChannelId,
    }),

    checkInterval,
    liveUpdateInterval,
    maxContentPerCycle,
    requestTimeout,
    maxRetries,

    contentProvider,
    official: Object.freeze(official),
    mockFile: resolve(mockFile),

    logLevel,
    stateFile,

    liveEnabled,
    contentEnabled,

    welcome: Object.freeze({
      guildId,
      channelId: welcomeChannelId,
      maxPerCycle: welcomeMaxPerCycle,
    }),
    welcomeEnabled,

    warnings: Object.freeze(warnings),
  });
}
