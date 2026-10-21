/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../utils/errors.js';
import * as os from 'node:os';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import * as tar from 'tar';
import extract from 'extract-zip';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  ExtensionUpdateState,
  type Extension,
  type ExtensionManager,
} from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { performDpAuth, getDpToken } from '../dp/index.js';
import { DpAuthServiceError } from '../dp/dp-errors.js';

const debugLogger = createDebugLogger('EXT_GITLAB');

const DEFAULT_GITLAB_HOST = 'gitlab.tcsbank.ru';

// [nessy-fork] dp-auth
// Кэширование токена GitLab для предотвращения повторных запросов DP auth
let gitLabTokenRequest: Promise<string> | undefined;

interface GitLabReleaseAsset {
  name: string;
  url: string;
}

interface GitLabRelease {
  tag_name: string;
  assets: {
    links?: GitLabReleaseAsset[];
  };
}

export interface GitLabDownloadResult {
  tagName: string;
  type: 'gitlab-git' | 'gitlab-release';
}

/**
 * Получение токена GitLab через утилиту dp
 * Использует кэширование для предотвращения повторных запросов аутентификации.
 * @returns Токен доступа для GitLab API (из dp auth print-token)
 */
export async function getGitLabToken(): Promise<string> {
  // Используем deduplication как в dpAuthManager.getToken()
  try {
    if (!gitLabTokenRequest) {
      // Сначала пробуем получить токен из кэша (dp auth print-token)
      // без запуска интерактивного login
      gitLabTokenRequest = (async () => {
        const token = await getDpToken();
        if (token) {
          return token;
        }
        // Токена нет — требуется интерактивная аутентификация
        return performDpAuth();
      })();
    }

    const token = await gitLabTokenRequest;
    gitLabTokenRequest = undefined;

    if (!token) {
      throw new Error('dp auth print-token вернул пустой токен');
    }

    return token;
  } catch (error) {
    // Сбрасываем кэш при ошибке
    gitLabTokenRequest = undefined;

    // Если ошибка уже DpAuthServiceError, пробрасываем дальше
    if (error instanceof DpAuthServiceError) {
      throw error;
    }
    // Иначе оборачиваем в понятную ошибку
    throw new Error(
      `Failed to get GitLab token. Run "dp auth configure-git" to set up authentication. ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Клонирует Git-репозиторий из GitLab через git clone.
 * Требует настроенной аутентификации DP Auth через configure-git.
 * @param installMetadata Метаданные для установки расширения.
 * @param destination Путь для клонирования репозитория.
 */
export async function cloneFromGitlab(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<void> {
  const { spawn } = await import('node:child_process');

  // Получаем projectId из installMetadata или парсим из source
  let projectId: string;
  if (installMetadata.gitlabProjectId) {
    projectId = String(installMetadata.gitlabProjectId);
  } else {
    const parsed = parseGitLabSource(installMetadata.source);
    projectId = parsed.projectId;
  }

  const gitlabHost = installMetadata.gitlabHost || DEFAULT_GITLAB_HOST;
  const refToUse = installMetadata.ref || 'HEAD';

  // Формируем HTTPS URL для git clone
  const gitUrl = `https://${gitlabHost}/${projectId}.git`;

  debugLogger.info(`Cloning from GitLab: ${gitUrl} (ref: ${refToUse})`);

  // Формируем команду git clone
  // Credential helper (настроенный через dp auth configure-git) будет использован автоматически
  const args = ['clone', '--depth', '1'];
  if (refToUse !== 'HEAD') {
    args.push('-b', refToUse);
  }
  args.push(gitUrl, destination);

  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        debugLogger.info(`Successfully cloned to ${destination}`);
        resolve();
      } else {
        reject(
          new Error(
            `Не удалось установить расширение из GitLab. ` +
              `Для корректной работы выполните "dp auth configure-git" и повторите попытку.`,
          ),
        );
      }
    });

    gitProcess.on('error', (error) => {
      reject(
        new Error(
          `Не удалось выполнить git clone: ${getErrorMessage(error)}. ` +
            `Выполните "dp auth configure-git" для настройки авторизации.`,
        ),
      );
    });
  });
}

/**
 * Преобразует веб-URL GitLab (для просмотра кода) в Git URL для клонирования.
 * Примеры:
 * - https://gitlab.tcsbank.ru/tenant/repo/-/tree/branch/path -> { projectId: 'tenant/repo', ref: 'branch' }
 * - https://gitlab.tcsbank.ru/tenant/repo/-/blob/branch/path -> { projectId: 'tenant/repo', ref: 'branch' }
 * - https://gitlab.tcsbank.ru/tenant/repo -> { projectId: 'tenant/repo', ref: undefined }
 */
function normalizeGitLabWebUrlToProjectId(pathname: string): {
  projectId: string;
  ref?: string;
} {
  // Удаляем ведущий слэш
  let path = pathname.substring(1);

  // Удаляем .git суффикс если есть
  path = path.replace(/\.git$/, '');

  // Проверяем на специальные пути GitLab для просмотра кода
  // /-/tree/branch/path или /-/blob/branch/path
  const gitlabWebPatterns = [
    /\/-\/tree\/([^/]+)(?:\/(.*))?$/, // /-/tree/branch или /-/tree/branch/path/to/dir
    /\/-\/blob\/([^/]+)(?:\/(.*))?$/, // /-/blob/branch или /-/blob/branch/path/to/file
    /\/-\/archive\/([^/]+)(?:\/(.*))?$/, // /-/archive/tag или /-/archive/tag/path
  ];

  for (const pattern of gitlabWebPatterns) {
    const match = path.match(pattern);
    if (match) {
      // Извлекаем tenant/repo, удаляя /-/tree/... часть
      const projectId = path.substring(0, match.index);
      // ref - это ветка (группа 1 в regex)
      const ref = match[1] || undefined;
      return { projectId, ref };
    }
  }

  // Если нет специальных паттернов, возвращаем как есть (tenant/repo)
  return { projectId: path };
}

/**
 * Парсит источник GitLab в формате tenant/repo или полный URL
 */
export function parseGitLabSource(source: string): {
  gitlabHost: string;
  projectId: string;
  isUrl: boolean;
  ref?: string;
} {
  const gitlabHost = DEFAULT_GITLAB_HOST;

  // Проверяем, является ли источник URL
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      const parsedUrl = new URL(source);
      if (!parsedUrl.hostname.includes(gitlabHost)) {
        throw new Error(
          `Expected GitLab URL with host ${gitlabHost}, got: ${parsedUrl.hostname}`,
        );
      }
      // Извлекаем project ID из пути, нормализуя веб-URL
      const { projectId, ref } = normalizeGitLabWebUrlToProjectId(
        parsedUrl.pathname,
      );
      return { gitlabHost: parsedUrl.hostname, projectId, isUrl: true, ref };
    } catch (error) {
      throw new Error(
        `Invalid GitLab URL: ${source}. ${getErrorMessage(error)}`,
      );
    }
  }

  // Проверяем формат tenant/repo
  const parts = source.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitLab source format: ${source}. Expected "tenant/repo" or full URL.`,
    );
  }

  return { gitlabHost, projectId: source, isUrl: false };
}

/**
 * Получает хеш последнего коммита ветки через GitLab API
 */
// @ts-ignore
async function fetchLatestCommitFromGitlab(
  gitlabHost: string,
  projectId: string,
  token: string,
  branch: string,
): Promise<string> {
  const encodedProjectId = encodeURIComponent(projectId);
  const encodedBranch = encodeURIComponent(branch);
  const url = `https://${gitlabHost}/api/v4/projects/${encodedProjectId}/repository/branches/${encodedBranch}`;

  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': 'nessy-cli', 'Private-Token': token } },
        (res) => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `GitLab API returned status ${res.statusCode} for branch "${branch}".`,
              ),
            );
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data.commit.id as string);
          });
        },
      )
      .on('error', reject);
  });
}

/**
 * Получает информацию о релизе из GitLab API
 */
async function fetchReleaseFromGitlab(
  gitlabHost: string,
  projectId: string,
  token: string,
  ref?: string,
): Promise<GitLabRelease> {
  const encodedProjectId = encodeURIComponent(projectId);
  const endpoint = ref ? `releases/${ref}` : 'releases/latest';
  const url = `https://${gitlabHost}/api/v4/projects/${encodedProjectId}/${endpoint}`;

  const headers: { 'User-Agent': string; 'Private-Token': string } = {
    'User-Agent': 'nessy-cli',
    'Private-Token': token,
  };

  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `Запрос не удался с кодом статуса ${res.statusCode}. Убедитесь, что проект существует и у вас есть доступ.`,
            ),
          );
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString();
          resolve(JSON.parse(data) as GitLabRelease);
        });
      })
      .on('error', reject);
  });
}

/**
 * Загружает архив релиза из GitLab
 */
export async function downloadFromGitLabRelease(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<GitLabDownloadResult> {
  const { source, ref, gitlabHost = DEFAULT_GITLAB_HOST } = installMetadata;

  let projectId: string;
  if (installMetadata.gitlabProjectId) {
    projectId = String(installMetadata.gitlabProjectId);
  } else {
    const parsed = parseGitLabSource(source);
    projectId = parsed.projectId;
  }

  try {
    const token = await getDpToken();
    if (!token) {
      throw new Error(
        'Не удалось получить токен GitLab. Выполните "dp auth configure-git" для настройки авторизации.',
      );
    }
    const releaseData = await fetchReleaseFromGitlab(
      gitlabHost,
      projectId,
      token,
      ref,
    );

    if (!releaseData) {
      throw new Error(
        `Не найдено данных релиза для ${projectId} на теге ${ref}`,
      );
    }

    // Ищем архив для загрузки
    let archiveUrl: string | undefined;
    const assets = releaseData.assets.links || [];

    // Ищем архив для текущей платформы
    const platform = os.platform();
    const arch = os.arch();
    const platformArchPrefix = `${platform}.${arch}.`;
    const platformPrefix = `${platform}.`;

    const platformArchAsset = assets.find((asset) =>
      asset.name.toLowerCase().startsWith(platformArchPrefix),
    );
    const platformAsset = assets.find((asset) =>
      asset.name.toLowerCase().startsWith(platformPrefix),
    );

    if (platformArchAsset) {
      archiveUrl = platformArchAsset.url;
    } else if (platformAsset) {
      archiveUrl = platformAsset.url;
    } else if (assets.length === 1) {
      // Если только один ассет, используем его
      archiveUrl = assets[0].url;
    }

    // Если не найдено специфичных ассетов, используем source archive GitLab
    if (!archiveUrl) {
      const encodedProjectId = encodeURIComponent(projectId);
      const refToUse = ref || releaseData.tag_name || 'HEAD';
      archiveUrl = `https://${gitlabHost}/api/v4/projects/${encodedProjectId}/repository/archive.tar.gz?sha=${refToUse}`;
    }

    const downloadedAssetPath = path.join(
      destination,
      path.basename(new URL(archiveUrl).pathname) || 'archive.tar.gz',
    );

    await downloadFileFromGitLab(archiveUrl, downloadedAssetPath, token);

    await extractFile(downloadedAssetPath, destination);

    // Перемещаем файлы из вложенной директории (если есть)
    const entries = await fs.promises.readdir(destination, {
      withFileTypes: true,
    });
    if (entries.length === 2) {
      const lonelyDir = entries.find((entry) => entry.isDirectory());
      if (lonelyDir) {
        const hasNessyConfig = fs.existsSync(
          path.join(destination, lonelyDir.name, EXTENSIONS_CONFIG_FILENAME),
        );
        const hasGeminiConfig = fs.existsSync(
          path.join(destination, lonelyDir.name, 'gemini-extension.json'),
        );
        const hasMarketplaceConfig = fs.existsSync(
          path.join(
            destination,
            lonelyDir.name,
            '.claude-plugin/marketplace.json',
          ),
        );
        const hasClaudePluginConfig = fs.existsSync(
          path.join(destination, lonelyDir.name, '.claude-plugin/plugin.json'),
        );
        if (
          hasNessyConfig ||
          hasGeminiConfig ||
          hasMarketplaceConfig ||
          hasClaudePluginConfig
        ) {
          const dirPathToExtract = path.join(destination, lonelyDir.name);
          const extractedDirFiles = await fs.promises.readdir(dirPathToExtract);
          for (const file of extractedDirFiles) {
            await fs.promises.rename(
              path.join(dirPathToExtract, file),
              path.join(destination, file),
            );
          }
          await fs.promises.rmdir(dirPathToExtract);
        }
      }
    }

    await fs.promises.unlink(downloadedAssetPath);
    return {
      tagName: releaseData.tag_name,
      type: 'gitlab-release',
    };
  } catch (error) {
    throw new Error(
      `Не удалось загрузить релиз из ${installMetadata.source}: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Загружает файл из GitLab с токеном аутентификации
 */
async function downloadFileFromGitLab(
  url: string,
  dest: string,
  token: string,
): Promise<void> {
  // Определяем тип токена по префиксу и выбираем соответствующий заголовок
  // OAuth токены (ory_at_*) используют Authorization: Bearer
  // Personal/Project токены используют PRIVATE-TOKEN
  const headers: Record<string, string> = {
    // 'User-agent': 'nessy-cli',
  };

  if (token.startsWith('ory_at_') || token.startsWith('oauth_')) {
    // OAuth токен от DP Auth
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    // Personal Access Token или Job Token
    headers['PRIVATE-TOKEN'] = token;
  }

  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          downloadFileFromGitLab(res.headers.location!, dest, token)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Запрос не удался с кодом статуса ${res.statusCode}`),
          );
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve as () => void));
      })
      .on('error', reject);
  });
}

/**
 * Извлекает архив
 */
async function extractFile(file: string, dest: string): Promise<void> {
  if (file.endsWith('.tar.gz')) {
    await tar.x({
      file,
      cwd: dest,
    });
  } else if (file.endsWith('.zip')) {
    await extract(file, { dir: dest });
  } else {
    throw new Error(
      `Неподдерживаемое расширение файла для извлечения: ${file}`,
    );
  }
}

/**
 * Проверяет наличие обновлений для расширения GitLab
 */
export async function checkForGitLabExtensionUpdate(
  extension: Extension,
  extensionManager: ExtensionManager,
): Promise<ExtensionUpdateState> {
  const installMetadata = extension.installMetadata;
  if (
    !installMetadata ||
    (installMetadata.type !== 'gitlab-git' &&
      installMetadata.type !== 'gitlab-release')
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }

  // GitLab git extensions: use git ls-remote to compare latest commit with local HEAD
  // Credentials are handled by git credential helper configured via "dp auth configure-git"
  if (installMetadata.type === 'gitlab-git') {
    const { spawn } = await import('node:child_process');

    try {
      // Получаем remote URL через git remote get-url
      const remoteUrl = await new Promise<string>((resolve, reject) => {
        const gitProcess = spawn('git', ['remote', 'get-url', 'origin'], {
          cwd: extension.path,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        });

        let output = '';
        let errorOutput = '';

        gitProcess.stdout?.on('data', (data) => {
          output += data.toString();
        });

        gitProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        gitProcess.on('close', (code) => {
          if (code === 0) {
            resolve(output.trim());
          } else {
            reject(
              new Error(
                `git remote get-url failed with code ${code}: ${errorOutput}`,
              ),
            );
          }
        });

        gitProcess.on('error', reject);
      });

      if (!remoteUrl) {
        debugLogger.error('No git remotes found.');
        return ExtensionUpdateState.ERROR;
      }

      const refToCheck = installMetadata.ref || 'HEAD';

      // Получаем remote hash через git ls-remote
      const remoteHash = await new Promise<string>((resolve, reject) => {
        const args = ['ls-remote', remoteUrl, refToCheck];
        const gitProcess = spawn('git', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        });

        let output = '';
        let errorOutput = '';

        gitProcess.stdout?.on('data', (data) => {
          output += data.toString();
        });

        gitProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        gitProcess.on('close', (code) => {
          if (code === 0) {
            const hash = output.split('\t')[0];
            resolve(hash);
          } else {
            reject(
              new Error(
                `git ls-remote failed with code ${code}: ${errorOutput}`,
              ),
            );
          }
        });

        gitProcess.on('error', reject);
      });

      if (!remoteHash) {
        debugLogger.error(`Git ref ${refToCheck} not found.`);
        return ExtensionUpdateState.ERROR;
      }

      // Получаем local hash через git rev-parse
      const localHash = await new Promise<string>((resolve, reject) => {
        const gitProcess = spawn('git', ['rev-parse', 'HEAD'], {
          cwd: extension.path,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        });

        let output = '';
        let errorOutput = '';

        gitProcess.stdout?.on('data', (data) => {
          output += data.toString();
        });

        gitProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        gitProcess.on('close', (code) => {
          if (code === 0) {
            resolve(output.trim());
          } else {
            reject(
              new Error(
                `git rev-parse failed with code ${code}: ${errorOutput}`,
              ),
            );
          }
        });

        gitProcess.on('error', reject);
      });

      if (!localHash) {
        debugLogger.error('Unable to get local HEAD hash.');
        return ExtensionUpdateState.ERROR;
      }

      if (remoteHash === localHash) {
        return ExtensionUpdateState.UP_TO_DATE;
      }
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    } catch (error) {
      debugLogger.error(
        `Не удалось проверить обновления для расширения "${installMetadata.source}": ${getErrorMessage(error)}. Выполните "dp auth configure-git" для настройки авторизации.`,
      );
      return ExtensionUpdateState.ERROR;
    }
  }

  // GitLab release extensions
  if (installMetadata.type === 'gitlab-release') {
    try {
      // Only check cached token — do not trigger interactive auth during update checks
      const token = await performDpAuth();
      if (!token) {
        debugLogger.error(
          'GitLab token not available for update check. Run "dp auth configure-git" to set up authentication.',
        );
        return ExtensionUpdateState.ERROR;
      }
      const gitlabHost = installMetadata.gitlabHost || DEFAULT_GITLAB_HOST;
      const projectId = installMetadata.gitlabProjectId
        ? String(installMetadata.gitlabProjectId)
        : parseGitLabSource(installMetadata.source).projectId;

      const fetchLatestTag = async () => {
        const releaseData = await fetchReleaseFromGitlab(
          gitlabHost,
          projectId,
          token,
          installMetadata.ref,
        );
        if (!releaseData) {
          throw new Error(
            `No release data found for project ${projectId} at tag ${installMetadata.ref}`,
          );
        }
        return releaseData.tag_name;
      };

      // Check if the fetched tag differs from the installed releaseTag.
      const latestTag = await fetchLatestTag();
      if (latestTag !== installMetadata.releaseTag) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    } catch (error) {
      debugLogger.error(
        `Не удалось проверить обновления для расширения "${installMetadata.source}": ${getErrorMessage(error)}`,
      );
      return ExtensionUpdateState.ERROR;
    }
  }

  return ExtensionUpdateState.NOT_UPDATABLE;
}
