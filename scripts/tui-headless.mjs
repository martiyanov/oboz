#!/usr/bin/env node
// Headless-проверка TUI без настоящего терминала: эмулируем TTY и клавиши,
// снимаем кадры. Использование: node scripts/tui-headless.mjs [--empty]
import { buildDigest } from '../src/digest.js';
import { loadConfig } from '../src/config.js';
import { runTui } from '../src/tui.js';

const EMPTY = process.argv.includes('--empty');
const COLUMNS = 112;
const ROWS = 42;
const frames = [];

process.stdout.isTTY = true;
process.stdout.columns = COLUMNS;
process.stdout.rows = ROWS;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  frames.push(String(chunk));
  return true;
};
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdin.resume = () => {};
process.stdin.pause = () => {};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function press(name, str = '') {
  process.stdin.emit('keypress', str, {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: str,
  });
}

function renderLastFrame() {
  const raw = frames.join('');
  const chunks = raw.split('\x1b[2J').slice(1);
  if (!chunks.length) return '(нет кадра)';
  const text = chunks[chunks.length - 1].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return text.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n+$/, '');
}

const digest = await buildDigest({ demo: true, region: 'ru', threshold: EMPTY ? 0.95 : 0.55, wiki: false });
const config = await loadConfig();
const done = runTui({
  digest,
  config,
  options: { demo: true, region: 'ru', threshold: EMPTY ? 0.95 : 0.55, limit: 12 },
  rebuild: async () => buildDigest({ demo: true, region: 'ru', threshold: EMPTY ? 0.95 : 0.55, wiki: false }),
});

await wait(300);
const steps = [];
steps.push(['Стартовый экран', renderLastFrame()]);

if (!EMPTY) {
  press('return', '\r');
  await wait(250);
  steps.push(['Досье события (Enter)', renderLastFrame()]);

  press('return', '\r');
  await wait(250);
  steps.push(['Тезис: подтверждающие публикации (Enter на тезисе)', renderLastFrame()]);

  press('escape');
  await wait(200);

  press('down');
  await wait(80);
  press('down');
  await wait(80);
  press('down');
  await wait(80);
  press('down');
  await wait(80);
  steps.push(['Листание тезисов/источников (4×вниз)', renderLastFrame()]);

  press('return', '\r');
  await wait(250);
  steps.push(['Карточка источника (Enter)', renderLastFrame()]);

  press('escape');
  await wait(150);
  press('escape');
  await wait(200);
  steps.push(['Назад в список (Esc×2)', renderLastFrame()]);

  press('?', '?');
  await wait(200);
  steps.push(['Помощь (?)', renderLastFrame()]);
  press('escape');
  await wait(150);

  press('e', 'e');
  await wait(200);
  steps.push(['Скрытые события (e)', renderLastFrame()]);
  press('escape');
  await wait(150);

  press('t', 't');
  await wait(200);
  steps.push(['Порог +0.05 (t)', renderLastFrame()]);
} else {
  press('t', 't');
  await wait(250);
  steps.push(['Порог +0.05 на пустом экране', renderLastFrame()]);
}

press('q', 'q');
await done;
process.stdout.write = originalWrite;
process.stdout.write = originalWrite;

for (const [title, frame] of steps) {
  originalWrite(`\n===== ${title} =====\n${frame}\n`);
}
process.exit(0);
