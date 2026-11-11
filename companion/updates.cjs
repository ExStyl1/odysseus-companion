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

async function checkForUpdate({ fetchRelease = fetch, currentVersion = installedVersion } = {}) {
  let response;
  try {
    response = await fetchRelease(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Odysseus-Companion' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw Error('Не удалось связаться с GitHub. Проверьте подключение и повторите.');
  }
  if (!response.ok) throw Error(`GitHub не вернул данные релиза (HTTP ${response.status}). Повторите позже.`);

  const release = await response.json().catch(() => null);
  const latestVersion = typeof release?.tag_name === 'string' && release.tag_name.startsWith('companion-v')
    ? release.tag_name.slice('companion-v'.length)
    : '';
  if (!stableVersion.test(latestVersion) || release.draft !== false || release.prerelease !== false) {
    throw Error('GitHub вернул данные о неподдерживаемом выпуске Companion.');
  }
  if (!stableVersion.test(currentVersion)) throw Error('Не удалось определить установленную версию Companion.');

  const latest = latestVersion.split('.').map(Number);
  const current = currentVersion.split('.').map(Number);
  const firstDifference = latest.findIndex((part, index) => part !== current[index]);
  const available = firstDifference !== -1 && latest[firstDifference] > current[firstDifference];
  return { currentVersion, latestVersion, available };
}

module.exports = { checkForUpdate, installedVersion, releaseUrl };
