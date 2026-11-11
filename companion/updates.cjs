const { version: installedVersion } = require('./package.json');

const repository = 'ExStyl1/odysseus-companion';
const releases = `https://github.com/${repository}/releases`;
const stableVersion = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function releaseUrl(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw Error('Некорректная версия Companion');
  }
  return `${releases}/tag/companion-v${version}`;
}

async function latestReleaseVersion(fetchRelease) {
  const signal = AbortSignal.timeout(10000);
  const options = { headers: { 'User-Agent': 'Odysseus-Companion' }, redirect: 'manual', signal };
  let response;
  try {
    response = await fetchRelease(`https://api.github.com/repos/${repository}/releases/latest`, {
      ...options, headers: { ...options.headers, Accept: 'application/vnd.github+json' },
    });
    if (response.ok) {
      const release = await response.json();
      if (release.draft === false && release.prerelease === false && typeof release.tag_name === 'string') {
        const match = /^companion-v(.+)$/.exec(release.tag_name);
        if (match && stableVersion.test(match[1])) return match[1];
      }
    }
  } catch {
    // The public release page also works when the API is blocked or rate limited.
  }
  try {
    const page = await fetchRelease(`${releases}/latest`, { ...options, method: 'HEAD', signal: AbortSignal.timeout(10000) });
    const location = page.headers.get('location');
    if (page.status >= 300 && page.status < 400 && location) {
      const url = new URL(location, releases);
      const prefix = `${releases}/tag/companion-v`;
      if (url.href.startsWith(prefix)) {
        const version = url.href.slice(prefix.length);
        if (stableVersion.test(version)) return version;
      }
    }
  } catch {}
  throw Error('Не удалось проверить обновления. Откройте страницу релизов GitHub или повторите позже.');
}

async function checkForUpdate({ fetchRelease = fetch, currentVersion = installedVersion } = {}) {
  const latestVersion = await latestReleaseVersion(fetchRelease);
  if (!stableVersion.test(currentVersion)) throw Error('Не удалось определить установленную версию Companion.');

  const latest = latestVersion.split('.').map(Number);
  const current = currentVersion.split('.').map(Number);
  const firstDifference = latest.findIndex((part, index) => part !== current[index]);
  const available = firstDifference !== -1 && latest[firstDifference] > current[firstDifference];
  return { currentVersion, latestVersion, available };
}

module.exports = { checkForUpdate, installedVersion, releaseUrl, releases };
