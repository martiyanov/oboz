// Пути проекта: единая точка для кэша и состояния.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const SOURCES_PATH = path.join(ROOT, 'sources.json');
export const CACHE_DIR = process.env.OBOZ_CACHE_DIR || path.join(ROOT, '.cache');
export const STATE_DIR = process.env.OBOZ_STATE_DIR || path.join(ROOT, '.state');
export const RSS_CACHE_DIR = path.join(CACHE_DIR, 'rss');
export const WIKI_CACHE_DIR = path.join(CACHE_DIR, 'wiki');
export const SEEN_PATH = path.join(STATE_DIR, 'seen.json');
export const DIGEST_LOG = path.join(STATE_DIR, 'digest.log');
