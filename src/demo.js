// Демо-набор публикаций для проверки интерфейса без сети.
// ВАЖНО: это синтетический пример, а не живые новости. Ссылки ведут на реальные
// публикации, но кластеры собраны вручную для демонстрации порога и подтверждений.

const MIN = 60_000;

export function demoArticles(now = Date.now()) {
  const at = (minutes) => now - minutes * MIN;
  const article = (data) => ({
    id: `${data.sourceId}-${Buffer.from(data.title).toString('base64url').slice(0, 10)}`,
    categories: data.categories || [],
    author: '',
    ...data,
    publishedAt: at(data.minutesAgo ?? 30),
  });

  return [
    // Событие 1: три источника, высокий приоритет — проходит.
    article({
      sourceId: 'interfax', sourceName: 'Интерфакс', domain: 'interfax.ru', tier: 'A', type: 'state-agency',
      title: 'Мужчина погиб при атаке БПЛА в Курской области',
      summary: 'Мужчина погиб после атаки украинского дрона в Поныровском районе Курской области, сообщил губернатор Александр Хинштейн. Вражеский беспилотник атаковал работающий трактор в селе Первомайском.',
      link: 'https://www.interfax.ru/russia/1127652', categories: ['В России'], minutesAgo: 42,
    }),
    article({
      sourceId: 'tass', sourceName: 'ТАСС', domain: 'tass.ru', tier: 'A', type: 'state-agency',
      title: 'В Курской области мужчина погиб при атаке БПЛА',
      summary: 'В результате атаки украинского беспилотника в Поныровском районе Курской области погиб мужчина, сообщил губернатор Александр Хинштейн.',
      link: 'https://tass.ru/proisshestviya/28295900', categories: ['Происшествия'], minutesAgo: 38,
    }),
    article({
      sourceId: 'rbc', sourceName: 'РБК', domain: 'rbc.ru', tier: 'B', type: 'business',
      title: 'При атаке дрона в Курской области погиб мужчина',
      summary: 'В Поныровском районе Курской области украинский беспилотник атаковал трактор, погиб мужчина. Об этом сообщил губернатор Александр Хинштейн.',
      link: 'https://www.rbc.ru/rbcfreenews/6af02d7d98a7918b99e18100',
      categories: ['В России'], minutesAgo: 35,
    }),

    // Событие 2: удары по энергетике — ТАСС + Интерфакс, проходит.
    article({
      sourceId: 'tass', sourceName: 'ТАСС', domain: 'tass.ru', tier: 'A', type: 'state-agency',
      title: 'ВС РФ поразили объекты энергетики, используемые в интересах ВСУ',
      summary: 'Российские военные поразили объекты энергетической инфраструктуры, работавшие на нужды украинских войск, сообщили в Минобороны России.',
      link: 'https://tass.ru/armiya-i-opk/28295937', categories: ['Армия и ОПК'], minutesAgo: 26,
    }),
    article({
      sourceId: 'interfax', sourceName: 'Интерфакс', domain: 'interfax.ru', tier: 'A', type: 'state-agency',
      title: 'ВС РФ поразили объекты энергетики Украины',
      summary: 'Вооружённые силы России нанесли удары по объектам энергетики Украины, заявили в Минобороны.',
      link: 'https://www.interfax.ru/world/1127650', categories: ['В мире'], minutesAgo: 24,
    }),

    // Событие 3: стрельба в Кракове — три источника, проходит.
    article({
      sourceId: 'bbc-ru', sourceName: 'BBC News Русская служба', domain: 'bbc.co.uk', tier: 'A', type: 'foreign',
      title: 'Стрельба в Кракове: погибли шесть человек, власти заявили об ультраправых взглядах нападавшего',
      summary: 'В субботу 24-летний гражданин Польши, предположительно находившийся под влиянием крайне правой идеологии, убил шесть человек на центральной площади Кракова, еще 16 человек получили ранения. Полиция открыла огонь и задержала нападавшего.',
      link: 'https://www.bbc.com/russian/articles/cwzd695epv57o', categories: ['В мире'], minutesAgo: 55,
    }),
    article({
      sourceId: 'rt-ru', sourceName: 'RT на русском', domain: 'rt.com', tier: 'C', type: 'state-affiliated',
      title: 'В Кракове при стрельбе погибли шесть человек',
      summary: 'На центральной площади Кракова неизвестный открыл огонь по людям, погибли шесть человек, ещё 16 пострадали. Подозреваемый задержан.',
      link: 'https://russian.rt.com/world/news/000000-krakov-strelba', categories: ['В мире'], minutesAgo: 50,
    }),
    article({
      sourceId: 'lenta', sourceName: 'Лента.ру', domain: 'lenta.ru', tier: 'B', type: 'state-affiliated',
      title: 'В Кракове при стрельбе на площади погибли шесть человек',
      summary: 'В центре Кракова произошла стрельба, погибли шесть человек, ещё 16 получили ранения. Нападавший задержан, мотивы выясняются.',
      link: 'https://lenta.ru/news/2026/11/08/krakov-strelba/', categories: ['В мире'], minutesAgo: 48,
    }),

    // Событие 4: умеренный законопроект — РБК + ТАСС, проходит на грани порога.
    article({
      sourceId: 'rbc', sourceName: 'РБК', domain: 'rbc.ru', tier: 'B', type: 'business',
      title: 'Россияне смогут ставить самозапрет на звонки из-за рубежа с 1 марта 2027 года',
      summary: 'Россияне с 1 марта 2027 года смогут установить запрет на входящие звонки из сетей иностранных операторов, следует из закона о мерах против телефонного мошенничества.',
      link: 'https://www.rbc.ru/rbcfreenews/6af02d7d98a7918b99e181cd', categories: ['Общество'], minutesAgo: 70,
    }),
    article({
      sourceId: 'tass', sourceName: 'ТАСС', domain: 'tass.ru', tier: 'A', type: 'state-agency',
      title: 'Россияне смогут запретить звонки из-за рубежа с 1 марта 2027 года',
      summary: 'С 1 марта 2027 года граждане смогут установить запрет на входящие звонки из сетей иностранных операторов, сообщает Госдума.',
      link: 'https://tass.ru/obschestvo/28295800', categories: ['Общество'], minutesAgo: 66,
    }),

    // Событие 5: спортивная новость, один источник — не проходит по подтверждениям.
    article({
      sourceId: 'rbc', sourceName: 'РБК', domain: 'rbc.ru', tier: 'B', type: 'business',
      title: 'Малкин вошел в топ-20 лучших бомбардиров в истории НХЛ',
      summary: 'Форвард «Питтсбурга» Евгений Малкин сделал три голевые передачи в матче с «Лос-Анджелесом» и набрал 1 421 очко в регулярных чемпионатах НХЛ.',
      link: 'https://www.rbc.ru/sport/08/11/2026/6af02d2af07a758c7ac38ac7', categories: ['Спорт'], minutesAgo: 90,
    }),

    // Событие 6: слух из одного источника — не проходит.
    article({
      sourceId: 'lenta', sourceName: 'Лента.ру', domain: 'lenta.ru', tier: 'B', type: 'state-affiliated',
      title: 'Источник сообщил о возможной отставке главы одного из регионов',
      summary: 'По слухам, в правительстве обсуждают возможную отставку главы одного из регионов, официального подтверждения нет.',
      link: 'https://lenta.ru/news/2026/11/08/sluh-otstavka/', categories: ['Россия'], minutesAgo: 120,
    }),

    // Событие 7: наука, один источник — не проходит.
    article({
      sourceId: 'interfax', sourceName: 'Интерфакс', domain: 'interfax.ru', tier: 'A', type: 'state-agency',
      title: 'Ученые зафиксировали 29 вспышек на Солнце за вчерашние сутки',
      summary: 'На Солнце за минувшие сутки зарегистрировано 29 вспышек, что стало повторением рекорда 21 века, сообщила лаборатория солнечной астрономии.',
      link: 'https://www.interfax.ru/world/1127654', categories: ['В мире'], minutesAgo: 75,
    }),

    // Событие 8: городская новость, один источник — не проходит.
    article({
      sourceId: 'tass', sourceName: 'ТАСС', domain: 'tass.ru', tier: 'A', type: 'state-agency',
      title: 'Фасады Петербурга украсят световые проекции ко Дню градостроительства',
      summary: 'Праздник отмечают в более чем 30 странах каждый год, в Петербурге подготовили световые проекции на фасадах.',
      link: 'https://tass.ru/obschestvo/28295923', categories: ['Общество'], minutesAgo: 60,
    }),
  ];
}
