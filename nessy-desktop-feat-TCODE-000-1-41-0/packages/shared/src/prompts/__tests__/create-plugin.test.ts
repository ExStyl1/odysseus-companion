import { describe, expect, it } from 'bun:test';

import {
  CREATE_PLUGIN_CREATOR_SKILL_NAME,
  CREATE_PLUGIN_MANIFEST_FILENAME,
  CREATE_PLUGIN_PROMPT,
} from '../create-plugin.ts';

describe('create-plugin macro prompt', () => {
  it('matches the creator prompt snapshot', () => {
    // Snapshot the load-bearing macro contract: interview-first, our bundle
    // manifest, and the local-install-through-the-existing-path step.
    expect(CREATE_PLUGIN_PROMPT).toMatchSnapshot();
  });

  it('drives the bundled plugin-creator skill', () => {
    expect(CREATE_PLUGIN_CREATOR_SKILL_NAME).toBe('plugin-creator');
    expect(CREATE_PLUGIN_PROMPT).toContain('plugin-creator');
  });

  it('targets our plugin bundle manifest', () => {
    expect(CREATE_PLUGIN_MANIFEST_FILENAME).toBe('nessy-extension.json');
    expect(CREATE_PLUGIN_PROMPT).toContain('nessy-extension.json');
  });

  it('interviews the user before writing', () => {
    expect(CREATE_PLUGIN_PROMPT).toContain('interview me');
    expect(CREATE_PLUGIN_PROMPT).toContain('clarifying questions');
    expect(CREATE_PLUGIN_PROMPT).toContain('do not invent');
  });

  it('installs through the existing local-install path (no new mechanism)', () => {
    // No elevated access, no new tool: scaffold via the normal write path, then
    // install through the existing plugin-management local-folder install.
    expect(CREATE_PLUGIN_PROMPT).toContain('normal file-writing tool');
    expect(CREATE_PLUGIN_PROMPT).toContain('existing plugin install flow');
    expect(CREATE_PLUGIN_PROMPT).toContain('rather than any new mechanism');
  });
});
