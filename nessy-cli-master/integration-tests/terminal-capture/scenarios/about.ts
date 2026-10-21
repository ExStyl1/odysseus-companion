import type { ScenarioConfig } from '../scenario-runner.js';

export default {
  name: '/about command',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'nessy-cli', cwd: '../../..' },
  flow: [{ type: 'hi' }, { type: '/about' }],
} satisfies ScenarioConfig;
