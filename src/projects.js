// Проекты владельца и релевантность новостей.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_DIR } from './paths.js';
import { loadTopics } from './topics.js';
import { loadSources } from './config.js';

export const PROJECTS_FILE = path.join(STATE_DIR, 'projects.json');
export const PROJECTS_DEFAULT_FILE = path.join(ROOT, 'projects.default.json');
const MAX_PROJECTS = 40;
const MAX_KEYWORDS = 30;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordHit(hay, keyword) {
  if (!keyword) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = keyword.length <= 3 ? '(?=$| )' : '';
  return new RegExp(`(?:^| )${escaped}${boundary}`).test(hay);
}

export function sanitizeProject(input, catalog, sourceIds) {
  const project = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = String(project.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48);
  const name = String(project.name || '').trim().slice(0, 80);
  const keywords = Array.isArray(project.keywords)
    ? [...new Set(project.keywords.map((value) => normalizeText(value).slice(0, 60)).filter(Boolean))].slice(0, MAX_KEYWORDS)
    : [];
  const topics = Array.isArray(project.topics)
    ? [...new Set(project.topics.filter((topic) => catalog.categoryIds.has(topic)))].slice(0, 20)
    : [];
  const sources = Array.isArray(project.sources)
    ? [...new Set(project.sources.filter((source) => sourceIds.has(source)))].slice(0, 100)
    : [];
  const cities = Array.isArray(project.cities)
    ? [...new Set(project.cities.filter((city) => catalog.cityIds.has(city)))].slice(0, 10)
    : [];
  const priority = Math.max(1, Math.min(5, Math.round(Number(project.priority) || 3)));
  return {
    id,
    name: name || id,
    description: String(project.description || '').trim().slice(0, 300),
    enabled: project.enabled !== false,
    priority,
    keywords,
    topics,
    sources,
    cities,
  };
}

export async function loadProjects() {
  const catalog = await loadTopics();
  const { sources } = await loadSources();
  const sourceIds = new Set(sources.map((source) => source.id));
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(PROJECTS_FILE, 'utf8'));
  } catch {
    try {
      raw = JSON.parse(await fs.readFile(PROJECTS_DEFAULT_FILE, 'utf8'));
    } catch {
      raw = { projects: [] };
    }
  }
  const projects = Array.isArray(raw.projects)
    ? raw.projects.map((project) => sanitizeProject(project, catalog, sourceIds)).filter((project) => project.id && project.name)
    : [];
  return { projects: projects.slice(0, MAX_PROJECTS), catalog, sourceIds };
}

export async function saveProjects(projects) {
  const catalog = await loadTopics();
  const { sources } = await loadSources();
  const sourceIds = new Set(sources.map((source) => source.id));
  const sanitized = [];
  const seen = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    const item = sanitizeProject(project, catalog, sourceIds);
    if (!item.id || !item.name || seen.has(item.id)) continue;
    seen.add(item.id);
    sanitized.push(item);
    if (sanitized.length >= MAX_PROJECTS) break;
  }
  const payload = { version: 1, updatedAt: new Date().toISOString(), projects: sanitized };
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PROJECTS_FILE, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

export function eventText(event) {
  return normalizeText(`${event.title || ''} ${event.summary || ''} ${(event.claims || []).map((claim) => claim.text || '').join(' ')}`);
}

// Релевантность события проекту: слова (заголовок весомее), темы, города, источники.
export function projectMatchScore(event, project) {
  if (!project.enabled) return 0;
  const title = normalizeText(event.title);
  const text = eventText(event);
  let keywordScore = 0;
  for (const keyword of project.keywords) {
    if (keywordHit(title, keyword)) keywordScore += 3;
    else if (keywordHit(text, keyword)) keywordScore += 1;
  }
  // Проект с ключевыми словами не должен «ловить» событие только по широкой теме
  // (например, «экономика»): совпадение темы/города/источника — лишь бонус к слову.
  if (project.keywords.length && keywordScore === 0) return 0;

  let score = keywordScore;
  const topics = new Set(event.topics || []);
  for (const topic of project.topics) if (topics.has(topic)) score += 1;
  const cities = new Set(event.cities || []);
  for (const city of project.cities) if (cities.has(city)) score += 1;
  const eventSources = new Set((event.articles || []).map((article) => article.sourceId).filter(Boolean));
  for (const sourceId of project.sources) if (eventSources.has(sourceId)) score += 0.5;
  if (score === 0) return 0;
  score += project.priority * 0.3;
  return Math.round(score * 100) / 100;
}

// Группировка событий по проектам: событие может попасть в несколько проектов.
export function groupByProjects(events, projects) {
  const groups = projects
    .filter((project) => project.enabled)
    .map((project) => ({ project, events: [] }));
  const byId = new Map(groups.map((group) => [group.project.id, group]));
  for (const event of events) {
    let best = null;
    for (const group of groups) {
      const score = projectMatchScore(event, group.project);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { group, score };
    }
    if (best) best.group.events.push({ ...event, relevance: best.score });
  }
  for (const group of groups) {
    group.events.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
  }
  return groups;
}
