// Тесты фильтра по ключевым словам (закладки).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, eventMatchesQuery, filterByQuery } from '../src/query.js';

test('query: парсинг ключевых слов — регистр, ё, запятые, дубли', () => {
  assert.deepEqual(parseQuery('Курск, БПЛА,  курск '), ['курск', 'бпла']);
  assert.deepEqual(parseQuery('ёлка; музыка'), ['елка', 'музыка']);
  assert.deepEqual(parseQuery(''), []);
  assert.deepEqual(parseQuery(null), []);
});

test('query: совпадение по заголовку или лиду, любое слово (OR)', () => {
  const event = {
    title: 'Мужчина погиб при атаке БПЛА в Курской области',
    summary: 'Губернатор сообщил о трагедии.',
  };
  assert.equal(eventMatchesQuery(event, ['курск']), true);
  assert.equal(eventMatchesQuery(event, ['бпла', 'музыка']), true);
  assert.equal(eventMatchesQuery(event, ['музыка']), false);
  assert.equal(eventMatchesQuery(event, []), true);
});

test('query: короткие слова ищутся как целые слова (без ложных вхождений)', () => {
  assert.equal(eventMatchesQuery({ title: 'Новости транспорта', summary: '' }, ['спорт']), false);
  assert.equal(eventMatchesQuery({ title: 'Новости спорта', summary: '' }, ['спорт']), true);
});

test('query: фильтрация списка событий', () => {
  const events = [
    { id: '1', title: 'Курская область: атака БПЛА', summary: '' },
    { id: '2', title: 'Новый альбом группы', summary: '' },
  ];
  assert.deepEqual(filterByQuery(events, ['курск']).map((e) => e.id), ['1']);
  assert.deepEqual(filterByQuery(events, ['альбом']).map((e) => e.id), ['2']);
  assert.deepEqual(filterByQuery(events, []).map((e) => e.id), ['1', '2']);
});
