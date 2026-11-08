// Тесты каталога тем и городов: разметка публикаций и фильтрация событий.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTopics, classifyArticle, detectCategories, detectCities, filterByCategoryCity,
} from '../src/topics.js';

const catalog = await loadTopics();

function article(title, summary = '') {
  return { title, summary, sourceTopics: [] };
}

test('topics: музыкальная новость получает тему music, технологии — tech', () => {
  const music = classifyArticle(article(
    'Группа «Би-2» объявила новый альбом и концерт в Москве',
    'Музыканты выступят в столице осенью.',
  ), catalog);
  assert.ok(music.topics.includes('music'));

  const tech = classifyArticle(article(
    'Apple представила новый iPhone с чипом A19',
    'Компания показала смартфон на презентации.',
  ), catalog);
  assert.ok(tech.topics.includes('tech'));
});

test('topics: «оператор» не считается музыкой (exact-слово «опера»)', () => {
  const result = classifyArticle(article(
    'Оператор «Турецкого потока» подал иск к европейской компании',
    'Газопровод работает в штатном режиме.',
  ), catalog);
  assert.ok(!result.topics.includes('music'), JSON.stringify(result.topics));
  assert.ok(!result.topics.includes('tech'), JSON.stringify(result.topics));
});

test('topics: «спорт» не находится внутри «транспорта»', () => {
  const result = classifyArticle(article(
    'Минобороны сообщило об ударах по объектам транспорта',
    'Под удар попала логистическая инфраструктура.',
  ), catalog);
  assert.ok(!result.topics.includes('sport'), JSON.stringify(result.topics));
});

test('topics: города Москва и Нижний Новгород распознаются по тексту', () => {
  assert.deepEqual(detectCities('В Москве открыли новую станцию метро', catalog), ['moscow']);
  assert.deepEqual(detectCities('В Нижнем Новгороде открыли новый мост через Оку', catalog), ['nizhny']);
  assert.deepEqual(detectCities('В Казани прошёл фестиваль', catalog), []);
});

test('topics: городская лента задаёт город и тему из источника', () => {
  const cityArticle = {
    title: 'В городе открыли новый концертный зал',
    summary: 'Маршрут свяжет два района.',
    sourceTopics: ['music'],
    sourceCity: 'nizhny',
    tier: 'B',
  };
  const result = classifyArticle(cityArticle, catalog);
  assert.deepEqual(result.cities, ['nizhny']);
  assert.ok(result.topics.includes('music'), JSON.stringify(result.topics));
});

test('topics: фильтр по теме/городу оставляет только подходящие события', () => {
  const events = [
    { id: '1', topics: ['tech'], cities: ['moscow'] },
    { id: '2', topics: ['music'], cities: [] },
    { id: '3', topics: ['tech', 'economy'], cities: ['nizhny'] },
  ];
  assert.deepEqual(filterByCategoryCity(events, { category: 'tech' }).map((e) => e.id), ['1', '3']);
  assert.deepEqual(filterByCategoryCity(events, { city: 'moscow' }).map((e) => e.id), ['1']);
  assert.deepEqual(
    filterByCategoryCity(events, { category: 'tech', city: 'nizhny' }).map((e) => e.id),
    ['3'],
  );
  assert.deepEqual(filterByCategoryCity(events, {}).map((e) => e.id), ['1', '2', '3']);
});

test('topics: detectCategories не размечает пустой текст', () => {
  assert.deepEqual(detectCategories('', catalog), []);
});
