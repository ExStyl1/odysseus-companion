import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Full UX flow for a deprecated model, driven against the mock server:
 *   1. user works with `mock-model-a` — replies are successful
 *   2. backend takes the model out of service → HTTP 404 "no longer supported"
 *   3. user opens the `/model` dialog and picks `mock-model-b`
 *   4. continuation is successful again on the new model
 *
 * Requires the mock to be running first:
 *   PORT=4122 node integration-tests/terminal-capture/scenarios/model-deprecation-mock.js
 */
export default {
  name: 'model-deprecation',
  spawn: [
    'bash',
    '-c',
    'NESSY_HOME=/tmp/nessy-model-deprecation ' +
      'node dist/cli.js ' +
      '--auth-type openai ' +
      '--openai-base-url http://127.0.0.1:4122/v1 ' +
      '--openai-api-key sk-mock ' +
      '-m mock-model-a ' +
      '--approval-mode default',
  ],
  terminal: { title: 'nessy-cli', cwd: '../../..' },
  flow: [
    { type: 'Первый запрос к модели' },
    { type: 'Второй запрос к модели' },
    { type: 'Третий запрос к модели' },
    { type: '/model' },
    { key: 'Enter' },
    { key: ['ArrowDown', 'Enter'] },
    { type: 'Продолжаем работу с новой моделью' },
  ],
} satisfies ScenarioConfig;
