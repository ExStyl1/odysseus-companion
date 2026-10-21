# Настройка публикации SDK

## Переменные окружения GitLab CI

Для публикации SDK во внутренний Nexus/Artifactory необходимо настроить следующие переменные окружения в GitLab CI:

### Required Variables

1. **NEXUS_USERNAME** - имя пользователя для доступа к Nexus (Java SDK)
2. **NEXUS_PASSWORD** - пароль/токен для доступа к Nexus (Java SDK)
3. **ARTIFACTORY_USERNAME** - имя пользователя для доступа к Artifactory (Python/TypeScript SDK)
4. **ARTIFACTORY_PASSWORD** - пароль/токен для доступа к Artifactory (Python/TypeScript SDK)

Эти переменные должны быть добавлены в GitLab CI/CD Settings -> Variables для проекта `nestor/nessy-cli`.

### Recommended Settings

- **Protected**: true (только для защищенных веток и тегов)
- **Masked**: true (скрыть значение в логах)

## Структура публикации

### TypeScript SDK

- **Package**: `@nestor/nessy-cli-sdk`
- **Registry**: `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-hosted/`
- **Tags**:
  - `release-sdk-typescript-X.Y.Z` - стабильная версия
  - `release-sdk-typescript-X.Y.Z-beta.N` - бета версия

### Python SDK

- **Package**: `nessy-cli-sdk`
- **Registry**: `https://registry.tcsbank.ru/repository/pypi_internal/simple`
- **Tags**:
  - `release-sdk-python-X.Y.Z` - стабильная версия
  - `release-sdk-python-X.Y.Z-beta.N` - бета версия

### Java SDK

- **Package**: `ru.tbank:nessy-cli-sdk`
- **Module**: `packages/sdk-java/nessycli`
- **Registry**:
  - Snapshots: `https://nexus.tcsbank.ru/repository/mvn_processing_snapshot`
  - Releases: `https://nexus.tcsbank.ru/repository/mvn_processing_release`
- **Tags**:
  - `release-sdk-java-X.Y.Z` - стабильная версия
  - `release-sdk-java-X.Y.Z-beta.N` - бета версия

> **Note**: Модуль `client` (Alibaba ACP SDK) не публикуется через GitLab CI, так как требует внешних зависимостей от Alibaba.

## Процесс публикации

### 1. Создание тега

Через GitLab UI или CLI:

```bash
# Стабильная версия
git tag release-sdk-typescript-0.1.0
git push origin release-sdk-typescript-0.1.0

# Бета версия
git tag release-sdk-typescript-0.1.0-beta.0
git push origin release-sdk-typescript-0.1.0-beta.0
```

### 2. Запуск pipeline

Pipeline автоматически запустится при создании тега. Можно также запустить вручную из GitLab UI:

1. Перейти в CI/CD -> Pipelines
2. Нажать "Run Pipeline"
3. Выбрать ветку `master`
4. Запустить job `publish_sdk_*`

### 3. Проверка публикации

После успешного выполнения pipeline проверить наличие пакета в Artifactory:

- npm: https://artifactory.tcsbank.ru/artifactory/webapp/#/artifacts/browse/simple/ByPath/npm-hosted/@nestor/nessy-cli-sdk
- PyPI: https://registry.tcsbank.ru/repository/pypi_internal/simple/nessy-cli-sdk
- Maven: https://artifactory.tcsbank.ru/artifactory/webapp/#/artifacts/browse/simple/ByPath/maven-releases/ru/tbank/nessy-cli-sdk

## Локальная сборка для тестирования

### TypeScript SDK

```bash
cd packages/sdk-typescript
npm run build
npm run bundle:cli
```

### Python SDK

```bash
cd packages/sdk-python
python3 -m venv .venv
source .venv/bin/activate
pip install build
python3 -m build
```

### Java SDK

```bash
cd packages/sdk-java/nessycli
mvn clean package
```

## Troubleshooting

### Ошибки сборки Java SDK

1. **Проблемы с зависимостями**: Убедитесь, что есть доступ к Maven Central
2. **Не найдены зависимости**: Проверьте сетевое подключение

### Ошибки публикации

1. **401 Unauthorized**: Проверьте переменные ARTIFACTORY_USERNAME и ARTIFACTORY_PASSWORD
2. **403 Forbidden**: Убедитесь, что у пользователя есть права на запись в репозиторий
3. **Version already exists**: Увеличьте версию в package.json/pyproject.toml/pom.xml
