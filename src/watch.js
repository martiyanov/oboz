// Периодический обзор: раз в N минут, только новые события выше порога.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { SEEN_PATH, DIGEST_LOG, STATE_DIR } from './paths.js';
import { buildDigest } from './digest.js';
import { formatDigest } from './format.js';
import { sleep, formatDateTimeRu } from './util.js';

async function loadSeen() {
  try {
    const data = JSON.parse(await fs.readFile(SEEN_PATH, 'utf8'));
    return new Set(Array.isArray(data.ids) ? data.ids : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(ids) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(SEEN_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), ids: ids.slice(-1000) }));
  } catch {
    /* состояние не критично */
  }
}

async function appendLog(lines) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.appendFile(DIGEST_LOG, `${lines.join('\n')}\n`);
  } catch {
    /* журнал не критичен */
  }
}

function notifyMac(title, body) {
  if (process.platform !== 'darwin') return;
  try {
    const script = `display notification ${JSON.stringify(body)} with title "Обозреватель" subtitle ${JSON.stringify(title)}`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* уведомления не критичны */ });
    child.unref();
  } catch {
    /* уведомление не критично */
  }
}

export async function runWatch(options) {
  const {
    region = 'ru',
    threshold = 0.55,
    limit = 12,
    everyMs = 3_600_000,
    demo = false,
    quiet = false,
    once = false,
    notify = true,
  } = options;

  const seen = await loadSeen();
  const startedAt = new Date();
  if (!quiet) {
    process.stdout.write(
      `ОБОЗРЕВАТЕЛЬ · наблюдение\n` +
      `Регион: ${region} · порог: ${Number(threshold).toFixed(2)} · период: ${Math.round(everyMs / 60_000)} мин\n` +
      `Начало: ${formatDateTimeRu(startedAt.getTime())} · Ctrl+C — остановить\n\n`,
    );
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    process.stdout.write('\nНаблюдение остановлено.\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    let digest;
    try {
      digest = await buildDigest({ region, threshold, limit, demo, wiki: false });
    } catch (error) {
      if (!quiet) process.stderr.write(`Ошибка обзора: ${error.message || error}\n`);
      await sleep(everyMs);
      continue;
    }

    const fresh = digest.passed.filter((event) => !seen.has(event.id));
    const stamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const logLines = [];

    if (fresh.length) {
      const view = { ...digest, passed: fresh, stats: { ...digest.stats, passed: fresh.length } };
      const text = formatDigest(view, { width: 96 });
      process.stdout.write(`\n[${stamp}] Новые значимые события: ${fresh.length}\n${text}\n`);
      logLines.push(`\n[${new Date().toISOString()}] ${fresh.length} новых событий (порог ${Number(threshold).toFixed(2)})`);
      for (const event of fresh) {
        logLines.push(`  [${event.score.toFixed(2)}] ${event.title} — ${event.articles.map((a) => a.sourceName).join(', ')}`);
        logLines.push(`  ${event.articles[0]?.link || ''}`);
        if (notify) notifyMac(event.title, `Оценка ${event.score.toFixed(2)} · ${event.domains.length} источника`);
      }
      await appendLog(logLines);
    } else if (!quiet) {
      process.stdout.write(
        `[${stamp}] Ничего существенного (порог ${Number(threshold).toFixed(2)}): ${digest.stats.events} событий, ` +
        `${digest.stats.articlesUsed} публикаций, ${digest.stats.sourcesOk}/${digest.stats.sourcesTotal} источников.\n`,
      );
    }

    for (const event of digest.passed) seen.add(event.id);
    await saveSeen([...seen]);

    if (once) break;
    if (!quiet) {
      process.stdout.write(`Следующая проверка через ${Math.round(everyMs / 60_000)} мин.\n`);
    }
    await sleep(everyMs);
  }
  return 0;
}
