import { defineConfig } from 'vitepress';

const page = (path: string) => `${path.replace(/\.html$/, '')}.html`;
const item = (text: string, link: string) => ({ text, link: page(link) });

const englishNav = [
  item('Start', '/getting-started/introduction'),
  item('Sources', '/sources/overview'),
  item('Plugins', '/plugins/overview'),
  item('Reference', '/reference/config/config-file'),
];

const englishSidebar = [
  {
    text: 'Getting started',
    items: [
      item('Introduction', '/getting-started/introduction'),
      item('Installation', '/getting-started/installation'),
    ],
  },
  {
    text: 'Core concepts',
    items: [
      item('Conversations', '/core-concepts/conversations'),
      item('Interactions', '/core-concepts/interactions'),
      item('Permissions', '/core-concepts/permissions'),
      item('Decision model', '/core-concepts/decision-model'),
      item('Working directory', '/core-concepts/working-directory'),
    ],
  },
  {
    text: 'Sources',
    items: [
      item('Overview', '/sources/overview'),
      item('API sources', '/sources/apis/overview'),
      item('Curl examples', '/sources/apis/curl-examples'),
      item('Local filesystems', '/sources/local-filesystems'),
      item('MCP overview', '/sources/mcp-servers/overview'),
      item('Connecting MCP servers', '/sources/mcp-servers/connecting-servers'),
      item('MCP authentication', '/sources/mcp-servers/authentication'),
      item('External models and MCP tools', '/sources/mcp-servers/external-models'),
      item('Organisation MCP servers', '/sources/mcp-servers/managed-servers'),
    ],
  },
  {
    text: 'Skills and workflow',
    items: [
      item('Skills', '/skills/overview'),
      item('Plugins', '/plugins/overview'),
      item('Statuses', '/statuses/overview'),
      item('Customizing statuses', '/statuses/customizing'),
      item('Board', '/board/overview'),
      item('Tasks', '/board/tasks'),
      item('Projects', '/projects/overview'),
      item('Pages', '/pages/overview'),
      item('Labels', '/labels/overview'),
      item('Label auto-rules', '/labels/auto-rules'),
      item('Automations', '/automations/overview'),
    ],
  },
  {
    text: 'Browser',
    items: [
      item('Overview', '/browser/overview'),
      item('API discovery', '/browser/api-discovery'),
      item('Examples', '/browser/examples'),
    ],
  },
  {
    text: 'Go further',
    items: [
      item('Workspaces', '/go-further/workspaces'),
      item('Themes', '/go-further/themes'),
      item('Deep links', '/go-further/deeplinks'),
      item('Document tools', '/go-further/document-tools'),
      item('Performance', '/go-further/performance'),
      item('Rich output', '/go-further/rich-output'),
      item('Sharing', '/go-further/sharing'),
      item('Publishing Pages', '/go-further/publishing-pages'),
      item('Connect to anything', '/go-further/connect-to-anything'),
      item('iPhone and iPad', '/go-further/mobile'),
    ],
  },
  {
    text: 'Customization',
    items: [
      item('Colors', '/customisation/colors'),
      item('Icons', '/customisation/icons'),
      item('Theme files', '/customisation/themes'),
    ],
  },
  {
    text: 'Reference',
    items: [
      item('CLI', '/reference/cli'),
      item('Config file', '/reference/config/config-file'),
      item('Preferences', '/reference/config/preferences'),
      item('Credentials', '/reference/config/credentials'),
      item('LLM connections', '/reference/config/llm-connections'),
      item('Custom endpoints', '/reference/config/custom-endpoint'),
      item('Environment variables', '/reference/config/environment-variables'),
      item('Network proxy', '/reference/config/network-proxy'),
      item('OpenAPI', '/api-reference/openapi'),
      item('Server CLI', '/server/cli'),
      item('Headless server', '/server/headless'),
    ],
  },
];

const russianNav = [
  item('Старт', '/ru/getting-started/introduction'),
  item('Источники', '/ru/sources/overview'),
  item('Плагины', '/ru/plugins/overview'),
  item('Справка', '/ru/reference/config/config-file'),
];

const russianSidebar = [
  {
    text: 'Начало работы',
    items: [
      item('Введение', '/ru/getting-started/introduction'),
      item('Установка', '/ru/getting-started/installation'),
    ],
  },
  {
    text: 'Основные понятия',
    items: [
      item('Диалоги', '/ru/core-concepts/conversations'),
      item('Взаимодействия', '/ru/core-concepts/interactions'),
      item('Разрешения', '/ru/core-concepts/permissions'),
      item('Модель решений', '/ru/core-concepts/decision-model'),
      item('Рабочая папка', '/ru/core-concepts/working-directory'),
    ],
  },
  {
    text: 'Источники',
    items: [
      item('Обзор', '/ru/sources/overview'),
      item('API-источники', '/ru/sources/apis/overview'),
      item('Примеры curl', '/ru/sources/apis/curl-examples'),
      item('Локальные файловые системы', '/ru/sources/local-filesystems'),
      item('Обзор MCP', '/ru/sources/mcp-servers/overview'),
      item('Подключение MCP-серверов', '/ru/sources/mcp-servers/connecting-servers'),
      item('Аутентификация MCP', '/ru/sources/mcp-servers/authentication'),
      item('Внешние модели и MCP-инструменты', '/ru/sources/mcp-servers/external-models'),
      item('MCP-серверы организации', '/ru/sources/mcp-servers/managed-servers'),
    ],
  },
  {
    text: 'Навыки и workflow',
    items: [
      item('Навыки', '/ru/skills/overview'),
      item('Плагины', '/ru/plugins/overview'),
      item('Статусы', '/ru/statuses/overview'),
      item('Настройка статусов', '/ru/statuses/customizing'),
      item('Доска', '/ru/board/overview'),
      item('Задачи', '/ru/board/tasks'),
      item('Проекты', '/ru/projects/overview'),
      item('Страницы', '/ru/pages/overview'),
      item('Метки', '/ru/labels/overview'),
      item('Автоправила меток', '/ru/labels/auto-rules'),
      item('Автоматизации', '/ru/automations/overview'),
    ],
  },
  {
    text: 'Браузер',
    items: [
      item('Обзор', '/ru/browser/overview'),
      item('Поиск API', '/ru/browser/api-discovery'),
      item('Примеры', '/ru/browser/examples'),
    ],
  },
  {
    text: 'Дополнительно',
    items: [
      item('Рабочие области', '/ru/go-further/workspaces'),
      item('Темы', '/ru/go-further/themes'),
      item('Deep links', '/ru/go-further/deeplinks'),
      item('Инструменты документов', '/ru/go-further/document-tools'),
      item('Производительность', '/ru/go-further/performance'),
      item('Rich output', '/ru/go-further/rich-output'),
      item('Sharing', '/ru/go-further/sharing'),
      item('Публикация страниц', '/ru/go-further/publishing-pages'),
      item('Подключение к чему угодно', '/ru/go-further/connect-to-anything'),
      item('iPhone и iPad', '/ru/go-further/mobile'),
    ],
  },
  {
    text: 'Кастомизация',
    items: [
      item('Цвета', '/ru/customisation/colors'),
      item('Иконки', '/ru/customisation/icons'),
      item('Файлы тем', '/ru/customisation/themes'),
    ],
  },
  {
    text: 'Справочник',
    items: [
      item('CLI', '/ru/reference/cli'),
      item('Config file', '/ru/reference/config/config-file'),
      item('Preferences', '/ru/reference/config/preferences'),
      item('Credentials', '/ru/reference/config/credentials'),
      item('LLM connections', '/ru/reference/config/llm-connections'),
      item('Custom endpoints', '/ru/reference/config/custom-endpoint'),
      item('Environment variables', '/ru/reference/config/environment-variables'),
      item('Network proxy', '/ru/reference/config/network-proxy'),
      item('OpenAPI', '/ru/api-reference/openapi'),
      item('Server CLI', '/ru/server/cli'),
      item('Headless server', '/ru/server/headless'),
    ],
  },
];

export default defineConfig({
  title: 'Nessy Desktop',
  description: 'Internal product documentation for Nessy Desktop.',
  base: '/docs/',
  cleanUrls: false,
  appearance: true,
  lastUpdated: false,
  srcExclude: ['public/**'],
  head: [
    ['meta', { name: 'theme-color', content: '#0f766e' }],
  ],
  themeConfig: {
    logo: '/logo/nessy.png',
    siteTitle: 'Nessy Desktop',
    i18nRouting: false,
    langMenuLabel: 'Choose language',
    search: {
      provider: 'local',
    },
    socialLinks: [],
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      link: '/index.html',
      themeConfig: {
        nav: englishNav,
        sidebar: englishSidebar,
        footer: {
          message: 'Internal documentation for Nessy Desktop.',
          copyright: 'T-Bank internal use.',
        },
      },
    },
    ru: {
      label: 'Русский',
      lang: 'ru',
      link: '/ru/index.html',
      themeConfig: {
        langMenuLabel: 'Выбрать язык',
        nav: russianNav,
        sidebar: russianSidebar,
        footer: {
          message: 'Внутренняя документация Nessy Desktop.',
          copyright: 'Для внутреннего использования T-Bank.',
        },
      },
    },
  },
});
