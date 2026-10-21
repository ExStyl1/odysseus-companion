import { describe, expect, it } from 'bun:test';
import {
  applyManagedEnv,
  classifyManagedEnvVar,
  isRefusedManagedEnvVar,
} from '../../config/managed-env.ts';
import {
  GITLAB_HOSTS_ENV_VAR,
  describeStructurallyUnroutableHost,
  describeSupportedRepositoryHosts,
  describeUnlistedGitLabLookalike,
  isSupportedRepositoryHost,
  parseBitbucketOrAzureRepositoryUrl,
  repositoryHostKind,
} from '../repository-hosts.ts';

/**
 * C3.190 (owner answer QL9, 2026-09-11). The predicate this file covers used to
 * be one inline boolean re-spelled in five places; the arms below are the three
 * things the plan row's done-clause asks for — our own git host resolves, a
 * control host still refuses, and the substring test is gone — plus the shape
 * that made the substring dangerous in the first place.
 *
 * Every call passes an explicit `env`, so the verdict never depends on what the
 * runner happens to export.
 */
const NO_ENV: Record<string, string | undefined> = {};

describe('repositoryHostKind (C3.190)', () => {
  it('routes the two host families this app actually has a fetch route for', () => {
    expect(repositoryHostKind('github.com', NO_ENV)).toBe('github');
    expect(repositoryHostKind('www.github.com', NO_ENV)).toBe('github');
    expect(repositoryHostKind('gitlab.com', NO_ENV)).toBe('gitlab');
    expect(repositoryHostKind('gitlab.example.com', NO_ENV)).toBe('gitlab');
  });

  /** The row's first done-clause: our own git host installs. */
  it('resolves the self-hosted GitLab whose hostname does not say "gitlab"', () => {
    expect(repositoryHostKind('git.tcsbank.ru', NO_ENV)).toBe('gitlab');
    expect(repositoryHostKind('gitlab.tcsbank.ru', NO_ENV)).toBe('gitlab');
  });

  /**
   * The row's third done-clause — "something a hostname cannot pass by
   * accident". Each of these passed `hostname.includes('gitlab')` at HEAD and
   * none of them is a GitLab instance by virtue of its spelling.
   */
  it('refuses a hostname that merely CONTAINS "gitlab" inside a label', () => {
    for (const host of ['mygitlab.acme.com', 'notgitlab.io', 'gitlab-mirror.example.net', 'gitlabber.test']) {
      expect({ host, kind: repositoryHostKind(host, NO_ENV) }).toEqual({ host, kind: undefined });
    }
  });

  /**
   * C3.260 (born 2026-09-11 from W15-f's PR-1) — the two hosts C3.190 priced
   * and deferred. Bitbucket's route was measured live from this rig on
   * 2026-09-12; Azure DevOps's was read from `learn.microsoft.com` because
   * `dev.azure.com` answers 503 through this network's proxy.
   */
  it('routes the two hosts C3.260 added', () => {
    expect(repositoryHostKind('bitbucket.org', NO_ENV)).toBe('bitbucket');
    expect(repositoryHostKind('www.bitbucket.org', NO_ENV)).toBe('bitbucket');
    expect(repositoryHostKind('dev.azure.com', NO_ENV)).toBe('azure-devops');
  });

  /** The row's second done-clause: a control host still has no route. */
  it('refuses the hosts with no fetch-only archive route, whatever the page allows upstream', () => {
    for (const host of [
      'git-codecommit.eu-west-1.amazonaws.com',
      'gitea.example.com',
      // Azure DevOps SERVER and the legacy spelling address a repository
      // differently from `dev.azure.com/<org>/<project>/_git/<repo>`, and
      // neither was reachable to drive: they meet the named refusal.
      'contoso.visualstudio.com',
      'tfs.acme.example',
    ]) {
      expect({ host, kind: repositoryHostKind(host, NO_ENV) }).toEqual({ host, kind: undefined });
    }
  });

  it('takes an operator-declared GitLab host, comma- or space-separated, case- and dot-insensitively', () => {
    const env = { [GITLAB_HOSTS_ENV_VAR]: 'code.acme.example, forge.internal' };
    expect(repositoryHostKind('code.acme.example', env)).toBe('gitlab');
    expect(repositoryHostKind('FORGE.INTERNAL.', env)).toBe('gitlab');
    // The declaration is scoped to the hosts it names — it is not a switch that
    // opens every host.
    expect(repositoryHostKind('gitea.example.com', env)).toBeUndefined();
    // ...and without it the same host is refused, which is what makes the two
    // arms above a reading rather than a tautology.
    expect(repositoryHostKind('code.acme.example', NO_ENV)).toBeUndefined();
  });

  /**
   * GitHub Enterprise Server is deliberately NOT declarable: `repositoryApiUrl`
   * sends the github kind to the literal `https://api.github.com/repos/...`, so
   * a declared GHES host would resolve its tags against the wrong server. The
   * env var names GitLab hosts only, and this pins that it cannot smuggle in a
   * github-kind host.
   */
  it('never yields the github kind for a declared host', () => {
    const env = { [GITLAB_HOSTS_ENV_VAR]: 'github.acme-corp.example' };
    expect(repositoryHostKind('github.acme-corp.example', env)).toBe('gitlab');
  });

  it('answers nothing for an empty or malformed hostname', () => {
    for (const host of ['', '   ', '.']) {
      expect(isSupportedRepositoryHost(host, NO_ENV)).toBe(false);
    }
  });
});

describe('the sentence the user reads (C3.190)', () => {
  it('is built from the same sets the predicate reads', () => {
    const described = describeSupportedRepositoryHosts(NO_ENV);
    expect(described).toContain('github.com');
    expect(described).toContain('gitlab');
    expect(described).toContain('git.tcsbank.ru');
    expect(described).toContain('bitbucket.org');
    expect(described).toContain('dev.azure.com');
    expect(described).toContain(GITLAB_HOSTS_ENV_VAR);
  });

  it('names the operator\'s own declared hosts once they exist', () => {
    expect(describeSupportedRepositoryHosts({ [GITLAB_HOSTS_ENV_VAR]: 'forge.internal' }))
      .toContain('forge.internal');
  });

  /**
   * The one host shape C3.190 made worse, said out loud. A `gitlab`-containing
   * hostname resolved before the label test; the refusal has to name the
   * setting that brings it back, or a host that worked yesterday reads as
   * simply unsupported.
   */
  it('tells a former substring match exactly why it stopped resolving, and only it', () => {
    const sentence = describeUnlistedGitLabLookalike('mygitlab.acme.com');
    expect(sentence).toContain('mygitlab.acme.com');
    expect(sentence).toContain(GITLAB_HOSTS_ENV_VAR);
    // A host that never matched the substring gets no such sentence — the
    // message stays about the host in front of the user.
    expect(describeUnlistedGitLabLookalike('gitea.example.com')).toBeUndefined();
    // Nor does a host that still resolves.
    expect(describeUnlistedGitLabLookalike('gitlab.example.com')).toBeUndefined();
  });
});

/**
 * C3.260's third clause — CodeCommit is RECORDED, not built. The distinction is
 * the point: Bitbucket and Azure DevOps were missing routes, and a route is a
 * thing that can be written; CodeCommit publishes none to write.
 */
describe('the structural null (C3.260)', () => {
  it('says a CodeCommit route cannot exist rather than that it is missing, in every region', () => {
    for (const host of [
      'git-codecommit.eu-west-1.amazonaws.com',
      'git-codecommit.us-east-2.amazonaws.com',
    ]) {
      const sentence = describeStructurallyUnroutableHost(host);
      expect({ host, named: sentence?.includes('there is none to add') ?? false })
        .toEqual({ host, named: true });
      // The two readings the sentence rests on, so a lane re-pricing this row
      // meets the evidence rather than the verdict.
      expect(sentence).toContain('private repositories');
      expect(sentence).toContain('78 API operations');
    }
  });

  it('says nothing about a host that merely has no route yet', () => {
    // Every one of these is either supported now or refused for a reason that
    // is not structural — the sentence must not leak onto them.
    for (const host of ['gitea.example.com', 'bitbucket.org', 'dev.azure.com', 'github.com', '']) {
      expect({ host, sentence: describeStructurallyUnroutableHost(host) })
        .toEqual({ host, sentence: undefined });
    }
  });
});

/**
 * C3.260 — ONE parser for the two added hosts, called from the three files that
 * each carry their own GitHub and GitLab branch. The arms below are the shapes
 * those three call sites hand it.
 */
describe('parseBitbucketOrAzureRepositoryUrl (C3.260)', () => {
  const parse = (input: string) => parseBitbucketOrAzureRepositoryUrl(new URL(input), NO_ENV);

  it('takes a Bitbucket workspace/repo, with or without the .git suffix', () => {
    expect(parse('https://bitbucket.org/team/plugin.git')).toEqual({
      kind: 'bitbucket',
      repositoryUrl: 'https://bitbucket.org/team/plugin',
      owner: 'team',
      repo: 'plugin',
    });
    expect(parse('https://bitbucket.org/team/plugin')).toMatchObject({
      repositoryUrl: 'https://bitbucket.org/team/plugin',
    });
  });

  it('reads a ref and a subdirectory out of Bitbucket\'s `src` browse URL', () => {
    expect(parse('https://bitbucket.org/team/plugin/src/release-1.2/plugins/vault')).toEqual({
      kind: 'bitbucket',
      repositoryUrl: 'https://bitbucket.org/team/plugin',
      owner: 'team',
      repo: 'plugin',
      ref: 'release-1.2',
      subdirectory: 'plugins/vault',
    });
  });

  /**
   * `src` is the browse marker, the counterpart of GitHub's `tree`. Anything
   * else addresses something that is NOT a repository directory, and reading it
   * as the repository root is how a `…/-/blob/main/x/SKILL.md` silently became
   * "the whole repository at its default branch" before C3.190.
   */
  it('refuses a Bitbucket marker that is not the directory browse marker', () => {
    for (const url of [
      'https://bitbucket.org/team/plugin/commits/abc',
      'https://bitbucket.org/team/plugin/pull-requests/7',
      'https://bitbucket.org/team/plugin/downloads/plugin.zip',
    ]) {
      expect({ url, parsed: parse(url) }).toEqual({ url, parsed: null });
    }
  });

  it('takes the Azure DevOps organization/project/_git/repo shape and nothing shorter', () => {
    expect(parse('https://dev.azure.com/contoso/tools/_git/plugins')).toEqual({
      kind: 'azure-devops',
      repositoryUrl: 'https://dev.azure.com/contoso/tools/_git/plugins',
      organization: 'contoso',
      project: 'tools',
      repo: 'plugins',
    });
    for (const url of [
      'https://dev.azure.com/contoso',
      'https://dev.azure.com/contoso/tools',
      'https://dev.azure.com/contoso/_git/plugins',
      'https://dev.azure.com/contoso/tools/_git/plugins/extra',
    ]) {
      expect({ url, parsed: parse(url) }).toEqual({ url, parsed: null });
    }
  });

  /**
   * The negative that keeps the parser honest: GitHub and GitLab are parsed by
   * the three call sites' own branches, and a second answer here would be a
   * fourth copy of the question C3.190 removed from five places.
   */
  it('declines GitHub, GitLab and an unsupported host', () => {
    for (const url of [
      'https://github.com/acme/vault',
      'https://gitlab.example.com/group/vault',
      'https://gitea.example.com/team/plugin',
    ]) {
      expect({ url, parsed: parse(url) }).toEqual({ url, parsed: null });
    }
  });
});

/**
 * C3.261 (born 2026-09-11 from W15-f's PR-2) — the row asked for the declared
 * host list to be moved out of an env var and "into managed settings". Measured,
 * it is ALREADY there: a managed `env` block delivers this variable fleet-wide
 * from the root-owned policy file, before the first install, and nobody has to
 * export anything.
 *
 * This file pins the composition rather than either half, because either half
 * alone is satisfiable without the other: the classifier could say `immediate`
 * about a name the writer never writes, and the predicate could read an env
 * object nothing managed ever populates.
 */
describe('the declared list is an administrator\'s to set (C3.261)', () => {
  it('classifies the variable as applied-at-once, where a transport variable is held back', () => {
    expect(classifyManagedEnvVar(GITLAB_HOSTS_ENV_VAR)).toBe('immediate');
    expect(isRefusedManagedEnvVar(GITLAB_HOSTS_ENV_VAR)).toBe(false);
    // The two controls that make the pair above a reading: the classifier does
    // discriminate, and one name really is refused outright.
    expect(classifyManagedEnvVar('HTTPS_PROXY')).toBe('transport');
    expect(isRefusedManagedEnvVar('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION')).toBe(true);
  });

  it.each([
    ['managed-file', false],
    ['server-cache', false],
    ['server-cache', true],
  ] as const)('applies the list from a %s block (confirmed=%p) so the host then resolves', (source, confirmed) => {
    const target: Record<string, string | undefined> = {};
    const application = applyManagedEnv(
      { [GITLAB_HOSTS_ENV_VAR]: 'forge.internal, code.acme.example' },
      { source, confirmed, target },
    );

    expect(application.withholding).toBe(false);
    expect(repositoryHostKind('forge.internal', target)).toBe('gitlab');
    expect(repositoryHostKind('code.acme.example', target)).toBe('gitlab');
    // Negative control on the same target: the block admits the hosts it names
    // and not a host it does not.
    expect(repositoryHostKind('gitea.example.com', target)).toBeUndefined();
  });

  it('answers nothing for the same host with no managed block at all', () => {
    expect(repositoryHostKind('forge.internal', NO_ENV)).toBeUndefined();
  });

  /**
   * The administrator has to be able to FIND the tier, which is the only part of
   * this row that was actually owed.
   */
  it('names the tier that can set it in the sentence the user reads', () => {
    expect(describeSupportedRepositoryHosts(NO_ENV)).toContain('managed settings');
  });
});
