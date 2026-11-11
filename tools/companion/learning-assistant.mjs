import { join } from 'node:path';
import { json } from './paths.mjs';
import { text } from './workspace-store.mjs';
import { mcpCatalog } from './catalog.mjs';

export function learningAssistant(paths, input) {
  const question = text(input.description, 2500);
  const guide = json(join(paths.root, 'companion/learning-guide.json'));
  const chapters = Object.values(guide);
  if (!chapters.length) throw Error('Справочник Companion не найден. Проверьте сборку приложения.');
  const topic = Object.hasOwn(guide, input.targetId) ? guide[input.targetId].title : undefined;
  const handbook = chapters.map(chapter =>
    [chapter.title, ...chapter.steps.map((step, index) => `${index + 1}. ${step}`),
      'Если что-то не работает: ' + chapter.troubleshooting].join('\n')
  ).join('\n\n');
  const companionEnabled = mcpCatalog(paths).some(server => server.name === 'odysseus-companion' && server.enabled);
  return {
    prompt: [
      'Ты помощник по Odysseus Companion. Используй всю документацию ниже как источник сведений о проекте. Объясняй по-русски, указывай названия глав, разделов интерфейса и конкретные шаги. Описывай доступные возможности с учётом их зависимостей и отличай их от планов. Связывай сведения из разных разделов, если это помогает ответить.',
      'Для сведений о локальных проектах используй доступные операции чтения MCP Companion: сначала определи нужный каталог и проект, при неоднозначности уточни их у пользователя. Если сведений о текущей установке недостаточно, скажи об этом. Не меняй данные и не запускай автоматизации в ответ на вопрос о работе приложения.',
      'Справочник Odysseus Companion:',
      handbook,
      ...(topic ? ['Вопрос открыт из темы «' + topic + '».'] : []),
      'Вопрос пользователя:',
      question,
    ].join('\n\n'),
    readOnly: true,
    allowedMcpNames: companionEnabled ? ['odysseus-companion'] : [],
  };
}
