import { useState } from 'react';
import { api, useApp } from '../runtime';
import guide from '../../../learning-guide.json';

type Lesson = {
  id: string;
  title: string;
  purpose: string;
  mechanism: string;
  practice: string;
  route: [string, string?];
  question: string;
  answers: [string, string];
  correct: 0 | 1;
};

const lessons: Lesson[] = [
  {
    id: 'connection', title: 'Связь с Nessy',
    purpose: 'Companion хранит рабочее пространство. Nessy ведёт диалог и может обращаться к нему через MCP.',
    mechanism: 'Расширение добавляет инструменты Companion, навыки и обработчики событий в выбранный профиль Nessy. После установки нужна новая сессия.',
    practice: 'Откройте «MCP и плагины». Найдите odysseus-companion и нажмите «Проверить MCP», чтобы увидеть, отвечает ли сервер.',
    route: ['mcp', 'installed'],
    question: 'Где проверить, отвечает ли сервер Companion?', answers: ['В списке MCP', 'В истории чатов'], correct: 0,
  },
  {
    id: 'rag', title: 'Найти ответ в документах',
    purpose: 'RAG помогает найти фрагменты документов и кода, на которые можно сослаться в ответе.',
    mechanism: 'Поиск ограничен выбранным каталогом и проектом. Nessy может получить эти фрагменты перед ответом. Поиск по словам доступен без подключения модели embeddings.',
    practice: 'Выберите каталог, введите вопрос о своём проекте и нажмите «Найти источники». Откройте один результат и сравните его с вопросом.',
    route: ['rag', 'search'],
    question: 'Как проверить, что найденный ответ опирается на ваш проект?', answers: ['Выбрать цвет темы', 'Открыть указанный источник'], correct: 1,
  },
  {
    id: 'graph', title: 'Разобраться в связях',
    purpose: 'Граф помогает увидеть, какие проекты, файлы и решения связаны между собой.',
    mechanism: 'Узлы представляют объекты, а линии показывают связи. Входящие знания можно проверить отдельно перед добавлением в память.',
    practice: 'Откройте карту, выберите узел и посмотрите связанные объекты. Для просмотра названий попробуйте режим «Список».',
    route: ['knowledge', 'graph'],
    question: 'Где посмотреть связи между объектами?', answers: ['На карте графа знаний', 'В списке процессов n8n'], correct: 0,
  },
  {
    id: 'skills', title: 'Выбрать навык',
    purpose: 'Навык подсказывает Nessy порядок работы и проверки для конкретного вида задачи.',
    mechanism: 'Nessy может подобрать инструкцию по тексту запроса. Установка навыка добавляет инструкцию в профиль. Доступ к системе предоставляется её инструментом и настройками.',
    practice: 'Откройте библиотеку, выберите «QA» и посмотрите, для каких запросов предназначен один из навыков.',
    route: ['skills'],
    question: 'Что добавляет навык?', answers: ['Новые права в корпоративной системе', 'Инструкцию по выполнению задачи'], correct: 1,
  },
  {
    id: 'tools', title: 'Подобрать инструменты',
    purpose: 'MCP даёт Nessy возможность вызвать конкретную операцию, например найти документы или изменить личную задачу.',
    mechanism: 'Подбор предлагает инструменты под задачу. Проверка MCP подтверждает ответ сервера, а чтение конкретного ресурса зависит от авторизации.',
    practice: 'В «Подборе для задачи» опишите, что хотите сделать. Посмотрите предложенные навыки и MCP перед запуском Nessy.',
    route: ['mcp', 'task'],
    question: 'Что показывает успешная проверка MCP?', answers: ['Сервер отвечает', 'Доступ открыт ко всем корпоративным данным'], correct: 0,
  },
  {
    id: 'scenarios', title: 'Повторять рабочий процесс',
    purpose: 'Сценарий сохраняет готовую постановку задачи, чтобы повторять её с другими входными данными.',
    mechanism: 'Companion передаёт в Nessy инструкцию и выбранные навыки и MCP. При создании с Nessy помощник может уточнить условия и сохранить сценарий.',
    practice: 'Откройте готовый сценарий и раскройте «Навыки, MCP и этапы». Посмотрите, какие входные данные понадобятся.',
    route: ['overview', 'scenarios'],
    question: 'Что удобно сохранить в сценарии?', answers: ['Повторяемую инструкцию с набором инструментов', 'Только результат одного разговора'], correct: 0,
  },
  {
    id: 'agents', title: 'Распределить работу',
    purpose: 'Субагенты берут отдельные этапы сложной задачи. Например, QA проверяет результат, а ревьюер изучает изменения.',
    mechanism: 'Companion хранит роли и права. Nessy выбирает роль и вызывает штатный Agent или Task, когда инструмент доступен. События запуска и отчёты видны в разделе «Этапы и запуски».',
    practice: 'Откройте роль «Ревьюер» и посмотрите инструкции, инструменты и лимиты. Затем найдите вкладку «Этапы и запуски».',
    route: ['agents', 'definitions'],
    question: 'Когда субагент действительно начинает работу?', answers: ['Когда Companion сохранил план', 'Когда Nessy вызвала Agent или Task'], correct: 1,
  },
  {
    id: 'automation', title: 'Изучить автоматизацию',
    purpose: 'В Companion можно изучать схемы и историю запусков корпоративного n8n.',
    mechanism: 'Companion читает корпоративный API и сохраняет снимок. Процессы выполняются на сервере.',
    practice: 'Откройте «Автоматизации n8n» и проверьте состояние подключения. При наличии ключа загрузите данные и откройте схему процесса.',
    route: ['n8n'],
    question: 'Где редактируют корпоративный процесс?', answers: ['В редакторе корпоративного n8n', 'В снимке Companion'], correct: 0,
  },
  {
    id: 'chats', title: 'Вернуться к разговору',
    purpose: 'История помогает найти прежний разговор, продолжить его и отметить полезность.',
    mechanism: 'Companion читает журналы подключённых профилей Nessy. Папки и оценки хранятся в Companion, оригинальный журнал остаётся в профиле.',
    practice: 'Откройте «Чаты» и найдите разговор по названию. Посмотрите варианты сортировки и доступные действия.',
    route: ['overview', 'chats'],
    question: 'Где найти и оценить прошлый разговор?', answers: ['В графе знаний', 'В разделе «Чаты»'], correct: 1,
  },
  {
    id: 'tasks', title: 'Вести личные задачи',
    purpose: 'Доска помогает зафиксировать следующий шаг и увидеть, что уже в работе.',
    mechanism: 'У задачи есть колонка, описание, срок и приоритет. Изменения из интерфейса и MCP попадают на одну доску.',
    practice: 'Откройте «Доску». Если хотите попробовать, создайте личную задачу и перенесите её в «В работе».',
    route: ['overview', 'board'],
    question: 'Что изменится при переносе задачи в «В работе»?', answers: ['Её колонка на доске', 'Права доступа Nessy'], correct: 0,
  },
];

const storageKey = 'odysseus-learning-v1';

function readProgress(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(saved) ? lessons.filter(({ id }) => saved.includes(id)).map(({ id }) => id) : [];
  } catch {
    return [];
  }
}

export function Learning() {
  const app = useApp();
  const [index, setIndex] = useState(0);
  const [completed, setCompleted] = useState(readProgress);
  const [answer, setAnswer] = useState<number>();
  const [practicing, setPracticing] = useState(false);
  const [reference, setReference] = useState(false);
  const [query, setQuery] = useState('');
  const lesson = lessons[index];

  function askNessy() {
    app.edit('Спросить у Nessy', [{
      name: 'description', label: 'Ваш вопрос', type: 'textarea', required: true,
      wide: true, max: 2500,
    }], async ({ description }) => {
      const result = await api.runScenario({
        assistant: true, builder: 'help', targetId: reference ? undefined : lesson.id,
        description: description.trim(),
      });
      if (result.cancelled) throw Error('Запуск отменён');
    }, {
      submit: 'Открыть вопрос в Nessy ↗',
      hint: 'Nessy получит всю документацию Companion. Можно спросить о стеке, архитектуре, рабочих сценариях или своём проекте.',
    });
  }

  function choose(next: number) {
    setIndex(next);
    setAnswer(undefined);
    setPracticing(false);
  }

  function check(value: number) {
    setAnswer(value);
    if (value !== lesson.correct || completed.includes(lesson.id)) return;
    const next = [...completed, lesson.id];
    setCompleted(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The tour remains usable when browser storage is unavailable.
    }
  }

  if (app.page !== 'learning') {
    if (!practicing || app.page !== lesson.route[0]) return null;
    return (
      <section className="panel learning-practice" aria-label="Практика обучения">
        <div>
          <strong>{lesson.title}</strong>
          <p>{lesson.practice}</p>
        </div>
        <button onClick={() => { setPracticing(false); app.go('learning'); }}>Вернуться к уроку</button>
        <button onClick={() => setPracticing(false)} aria-label="Скрыть подсказку">×</button>
      </section>
    );
  }

  const terms = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  const matches = Object.entries(guide).filter(([, chapter]) => {
    const content = [chapter.title, ...chapter.steps, chapter.troubleshooting].join(' ').toLocaleLowerCase('ru');
    return terms.every(term => content.includes(term));
  });
  return (
    <>
      <div className="learning-toolbar">
        <div className="learning-view-switch" aria-label="Материалы обучения">
          <button aria-pressed={!reference} onClick={() => setReference(false)}>Уроки</button>
          <button aria-pressed={reference} onClick={() => setReference(true)}>Справочник</button>
        </div>
        <button className="primary" onClick={askNessy}>Спросить у Nessy ↗</button>
      </div>
      {reference ? (
        <section className="panel learning-reference" aria-label="Справочник Companion">
          <label htmlFor="learning-search">Поиск по справочнику</label>
          <input id="learning-search" type="search" value={query}
            onChange={event => setQuery(event.target.value)} placeholder="Например, архитектура, регресс или n8n" />
          {matches.length === 0 && <p role="status">Ничего не найдено. Попробуйте другое слово.</p>}
          {matches.map(([id, chapter]) => (
            <details key={id}>
              <summary>{chapter.title}</summary>
              <ol>{chapter.steps.map(step => <li key={step}>{step}</li>)}</ol>
              <p><strong>Если что-то не работает</strong><br />{chapter.troubleshooting}</p>
            </details>
          ))}
        </section>
      ) : <div className="learning-layout">
      <section className="panel learning-outline" aria-label="Уроки">
        <label htmlFor="learning-progress">Пройдено {completed.length} из {lessons.length}</label>
        <progress id="learning-progress" value={completed.length} max={lessons.length} />
        <ol>
          {lessons.map((item, position) => (
            <li key={item.id}>
              <button type="button" aria-current={position === index ? 'step' : undefined}
                onClick={() => choose(position)}>
                <span>{item.title}</span>
                {completed.includes(item.id) && <small>Пройдено</small>}
              </button>
            </li>
          ))}
        </ol>
      </section>
      <article className="panel learning-lesson">
        <h2>{lesson.title}</h2>
        <h3>Зачем это нужно</h3>
        <p>{lesson.purpose}</p>
        <h3>Как это работает</h3>
        <p>{lesson.mechanism}</p>
        <div className="learning-exercise">
          <h3>Попробуйте в приложении</h3>
          <p>{lesson.practice}</p>
          <button className="primary" onClick={() => { setPracticing(true); app.go(...lesson.route); }}>
            Открыть раздел
          </button>
        </div>
        <fieldset className="learning-quiz">
          <legend>{lesson.question}</legend>
          {lesson.answers.map((option, value) => (
            <button type="button" key={option} aria-pressed={answer === value}
              onClick={() => check(value)}>{option}</button>
          ))}
          {answer !== undefined && <p role="status">{answer === lesson.correct
            ? 'Верно. Урок пройден.'
            : 'Попробуйте ещё раз. Подсказка есть в разделе «Как это работает».'}</p>}
        </fieldset>
        <div className="learning-controls">
          <button disabled={index === 0} onClick={() => choose(index - 1)}>Назад</button>
          {index < lessons.length - 1
            ? <button onClick={() => choose(index + 1)}>Следующий урок</button>
            : <button onClick={() => app.go('overview', 'today')}>На обзор</button>}
        </div>
      </article>
    </div>}
    </>
  );
}
