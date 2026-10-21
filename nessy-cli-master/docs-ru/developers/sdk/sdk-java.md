---
title: Java SDK(alpha)
---

# Java SDK для Nessy CLI

Java SDK для Nessy CLI — это минимальный экспериментальный SDK для программного доступа к функциональности Nessy CLI. Он предоставляет Java-интерфейс для взаимодействия с Nessy CLI, позволяя разработчикам интегрировать возможности Nessy CLI в свои Java-приложения.

## Требования

- Java >= 1.8
- Maven >= 3.6.0 (для сборки из исходного кода)
- nessy >= 0.5.0

### Зависимости

- **Логирование**: ch.qos.logback:logback-classic
- **Утилиты**: org.apache.commons:commons-lang3
- **Обработка JSON**: com.alibaba.fastjson2:fastjson2
- **Тестирование**: JUnit 5 (org.junit.jupiter:junit-jupiter)

## Установка

Добавьте следующую зависимость в ваш Maven `pom.xml`:

```xml
<dependency>
    <groupId>ru.tbank</groupId>
    <artifactId>nessy-cli-sdk</artifactId>
    <version>{$version}</version>
</dependency>
```

Настройте репозиторий Artifactory в `pom.xml`:

```xml
<repositories>
    <repository>
        <id>tcs-artifactory</id>
        <name>TCS Artifactory</name>
        <url>https://artifactory.tcsbank.ru/artifactory/maven-all</url>
    </repository>
</repositories>
```

Или если используете Gradle, добавьте в ваш `build.gradle`:

```gradle
repositories {
    maven {
        url 'https://artifactory.tcsbank.ru/artifactory/maven-all'
    }
}

dependencies {
    implementation 'ru.tbank:nessy-cli-sdk:{$version}'
}
```

:::note
Пакет размещён во внутреннем Maven-репозитории TCS. Убедитесь, что у вас настроен доступ к Artifactory.
:::

## Сборка и запуск

### Команды сборки

```bash
# Компилировать проект
mvn compile

# Запустить тесты
mvn test

# Упаковать JAR
mvn package

# Установить в локальный репозиторий
mvn install
```

## Быстрый старт

Простейший способ использования SDK — через метод `NessyCLI.simpleQuery()`:

```java
public static void runSimpleExample() {
    List<String> result = NessyCLI.simpleQuery("hello world");
    result.forEach(logger::info);
}
```

Для более продвинутого использования с пользовательскими опциями транспорта:

```java
public static void runTransportOptionsExample() {
    TransportOptions options = new TransportOptions()
            .setModel("qwen3-coder-flash")
            .setPermissionMode(PermissionMode.AUTO_EDIT)
            .setCwd("./")
            .setEnv(new HashMap<String, String>() {{put("CUSTOM_VAR", "value");}})
            .setIncludePartialMessages(true)
            .setTurnTimeout(new Timeout(120L, TimeUnit.SECONDS))
            .setMessageTimeout(new Timeout(90L, TimeUnit.SECONDS))
            .setAllowedTools(Arrays.asList("read_file", "write_file", "list_directory"));

    List<String> result = NessyCLI.simpleQuery("who are you, what are your capabilities?", options);
    result.forEach(logger::info);
}
```

Для потоковой обработки контента с пользовательскими потребителями контента:

```java
public static void runStreamingExample() {
    NessyCLI.simpleQuery("who are you, what are your capabilities?",
            new TransportOptions().setMessageTimeout(new Timeout(10L, TimeUnit.SECONDS)), new AssistantContentSimpleConsumers() {

                @Override
                public void onText(Session session, TextAssistantContent textAssistantContent) {
                    logger.info("Получен текстовый контент: {}", textAssistantContent.getText());
                }

                @Override
                public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
                    logger.info("Получен контент размышлений: {}", thinkingAssistantContent.getThinking());
                }

                @Override
                public void onToolUse(Session session, ToolUseAssistantContent toolUseContent) {
                    logger.info("Получен контент использования инструмента: {} с аргументами: {}",
                            toolUseContent, toolUseContent.getInput());
                }

                @Override
                public void onToolResult(Session session, ToolResultAssistantContent toolResultContent) {
                    logger.info("Получен контент результата инструмента: {}", toolResultContent.getContent());
                }

                @Override
                public void onOtherContent(Session session, AssistantContent<?> other) {
                    logger.info("Получен другой контент: {}", other);
                }

                @Override
                public void onUsage(Session session, AssistantUsage assistantUsage) {
                    logger.info("Получена информация об использовании: Входные токены: {}, Выходные токены: {}",
                            assistantUsage.getUsage().getInputTokens(), assistantUsage.getUsage().getOutputTokens());
                }
            }.setDefaultPermissionOperation(Operation.allow));
    logger.info("Пример потоковой обработки завершён.");
}
```

другие примеры смотрите в src/test/java/com/alibaba/nessy/code/cli/example

## Архитектура

SDK следует многоуровневой архитектуре:

- **Слой API**: Предоставляет основные точки входа через класс `NessyCLI` с простыми статическими методами для базового использования
- **Слой сессий**: Управляет сессиями связи с Nessy CLI через класс `Session`
- **Транспортный слой**: Обрабатывает механизм связи между SDK и процессом CLI (в настоящее время использует транспорт процесса через `ProcessTransport`)
- **Протокольный слой**: Определяет структуры данных для связи на основе протокола CLI
- **Утилиты**: Общие утилиты для параллельного выполнения, обработки таймаутов и управления ошибками

## Ключевые возможности

### Режимы разрешений

SDK поддерживает различные режимы разрешений для контроля выполнения инструментов:

- **`default`**: Инструменты записи запрещены, если не одобрены через callback `canUseTool` или в `allowedTools`. Инструменты только для чтения выполняются без подтверждения.
- **`plan`**: Блокирует все инструменты записи, инструктируя ИИ сначала представить план.
- **`auto-edit`**: Авто-одобрение инструментов редактирования (`edit`, `write_file`, `notebook_edit`), в то время как другие инструменты требуют подтверждения.

### Потребители событий сессий и потребители контента ассистента

SDK предоставляет два ключевых интерфейса для обработки событий и контента от CLI:

#### Интерфейс SessionEventConsumers

Интерфейс `SessionEventConsumers` предоставляет callback для различных типов сообщений во время сессии:

- `onSystemMessage`: Обрабатывает системные сообщения от CLI (получает Session и SDKSystemMessage)
- `onResultMessage`: Обрабатывает сообщения результатов от CLI (получает Session и SDKResultMessage)
- `onAssistantMessage`: Обрабатывает сообщения ассистента (ответы ИИ) (получает Session и SDKAssistantMessage)
- `onPartialAssistantMessage`: Обрабатывает частичные сообщения ассистента во время потоковой передачи (получает Session и SDKPartialAssistantMessage)
- `onUserMessage`: Обрабатывает пользовательские сообщения (получает Session и SDKUserMessage)
- `onOtherMessage`: Обрабатывает другие типы сообщений (получает Session и String сообщение)
- `onControlResponse`: Обрабатывает ответы управления (получает Session и CLIControlResponse)
- `onControlRequest`: Обрабатывает запросы управления (получает Session и CLIControlRequest, возвращает CLIControlResponse)
- `onPermissionRequest`: Обрабатывает запросы разрешений (получает Session и CLIControlRequest\<CLIControlPermissionRequest\>, возвращает Behavior)

#### Интерфейс AssistantContentConsumers

Интерфейс `AssistantContentConsumers` обрабатывает различные типы контента в сообщениях ассистента:

- `onText`: Обрабатывает текстовый контент (получает Session и TextAssistantContent)
- `onThinking`: Обрабатывает контент размышлений (получает Session и ThinkingAssistantContent)
- `onToolUse`: Обрабатывает контент использования инструмента (получает Session и ToolUseAssistantContent)
- `onToolResult`: Обрабатывает контент результата инструмента (получает Session и ToolResultAssistantContent)
- `onOtherContent`: Обрабатывает другие типы контента (получает Session и AssistantContent)
- `onUsage`: Обрабатывает информацию об использовании (получает Session и AssistantUsage)
- `onPermissionRequest`: Обрабатывает запросы разрешений (получает Session и CLIControlPermissionRequest, возвращает Behavior)
- `onOtherControlRequest`: Обрабатывает другие запросы управления (получает Session и ControlRequestPayload, возвращает ControlResponsePayload)

#### Взаимосвязь между интерфейсами

**Важное примечание об иерархии событий:**

- `SessionEventConsumers` — это **высокоуровневый** обработчик событий, который обрабатывает различные типы сообщений (системные, ассистента, пользователя и т.д.)
- `AssistantContentConsumers` — это **низкоуровневый** обработчик контента, который обрабатывает различные типы контента в сообщениях ассистента (текст, инструменты, размышления и т.д.)

**Взаимосвязь обработчиков:**

- `SessionEventConsumers` → `AssistantContentConsumers` (SessionEventConsumers использует AssistantContentConsumers для обработки контента в сообщениях ассистента)

**Взаимосвязи вывода событий:**

- `onAssistantMessage` → `onText`, `onThinking`, `onToolUse`, `onToolResult`, `onOtherContent`, `onUsage`
- `onPartialAssistantMessage` → `onText`, `onThinking`, `onToolUse`, `onToolResult`, `onOtherContent`
- `onControlRequest` → `onPermissionRequest`, `onOtherControlRequest`

**Взаимосвязи таймаутов событий:**

Каждый метод обработчика событий имеет соответствующий метод таймаута, который позволяет настроить поведение таймаута для этого специфичного события:

- `onSystemMessage` ↔ `onSystemMessageTimeout`
- `onResultMessage` ↔ `onResultMessageTimeout`
- `onAssistantMessage` ↔ `onAssistantMessageTimeout`
- `onPartialAssistantMessage` ↔ `onPartialAssistantMessageTimeout`
- `onUserMessage` ↔ `onUserMessageTimeout`
- `onOtherMessage` ↔ `onOtherMessageTimeout`
- `onControlResponse` ↔ `onControlResponseTimeout`
- `onControlRequest` ↔ `onControlRequestTimeout`

Для методов таймаута AssistantContentConsumers:

- `onText` ↔ `onTextTimeout`
- `onThinking` ↔ `onThinkingTimeout`
- `onToolUse` ↔ `onToolUseTimeout`
- `onToolResult` ↔ `onToolResultTimeout`
- `onOtherContent` ↔ `onOtherContentTimeout`
- `onPermissionRequest` ↔ `onPermissionRequestTimeout`
- `onOtherControlRequest` ↔ `onOtherControlRequestTimeout`

**Значения таймаутов по умолчанию:**

- Таймаут по умолчанию `SessionEventSimpleConsumers`: 180 секунд (Timeout.TIMEOUT_180_SECONDS)
- Таймаут по умолчанию `AssistantContentSimpleConsumers`: 60 секунд (Timeout.TIMEOUT_60_SECONDS)

**Требования иерархии таймаутов:**

Для правильной работы должны поддерживаться следующие взаимосвязи таймаутов:

- Возвращаемое значение `onAssistantMessageTimeout` должно быть больше, чем возвращаемые значения `onTextTimeout`, `onThinkingTimeout`, `onToolUseTimeout`, `onToolResultTimeout` и `onOtherContentTimeout`
- Возвращаемое значение `onControlRequestTimeout` должно быть больше, чем возвращаемые значения `onPermissionRequestTimeout` и `onOtherControlRequestTimeout`

### Опции транспорта

Класс `TransportOptions` позволяет конфигурировать, как SDK связывается с Nessy CLI:

- `pathToNessyExecutable`: Путь к исполняемому файлу Nessy CLI
- `cwd`: Рабочий каталог для процесса CLI
- `model`: Модель ИИ для использования в сессии
- `permissionMode`: Режим разрешения, контролирующий выполнение инструментов
- `env`: Переменные окружения для передачи процессу CLI
- `maxSessionTurns`: Ограничивает количество ходов разговора в сессии
- `coreTools`: Список основных инструментов, которые должны быть доступны ИИ
- `excludeTools`: Список инструментов для исключения из доступности ИИ
- `allowedTools`: Список инструментов, предварительно одобренных для использования без дополнительного подтверждения
- `authType`: Тип аутентификации для использования в сессии
- `includePartialMessages`: Включает получение частичных сообщений во время потоковых ответов
- `turnTimeout`: Таймаут для полного хода разговора
- `messageTimeout`: Таймаут для отдельных сообщений в пределах хода
- `resumeSessionId`: ID предыдущей сессии для возобновления
- `otherOptions`: Дополнительные опции командной строки для передачи в CLI

### Функции управления сессиями

- **Создание сессии**: Используйте `NessyCLI.newSession()` для создания новой сессии с пользовательскими опциями
- **Управление сессиями**: Класс `Session` предоставляет методы для отправки подсказок, обработки ответов и управления состоянием сессии
- **Очистка сессии**: Всегда закрывайте сессии используя `session.close()` для правильного завершения процесса CLI
- **Возобновление сессии**: Используйте `setResumeSessionId()` в `TransportOptions` для возобновления предыдущей сессии
- **Прерывание сессии**: Используйте `session.interrupt()` для прерывания текущей выполняемой подсказки
- **Динамическое переключение модели**: Используйте `session.setModel()` для изменения модели во время сессии
- **Динамическое переключение режима разрешений**: Используйте `session.setPermissionMode()` для изменения режима разрешений во время сессии

### Конфигурация пула потоков

SDK использует пул потоков для управления параллельными операциями со следующей конфигурацией по умолчанию:

- **Размер основного пула**: 30 потоков
- **Максимальный размер пула**: 100 потоков
- **Время жизни**: 60 секунд
- **Ёмкость очереди**: 300 задач (используя LinkedBlockingQueue)
- **Именование потоков**: "nessy_cli-pool-\{number\}"
- **Потоки-демоны**: false
- **Обработчик отклонённых выполнений**: CallerRunsPolicy

## Обработка ошибок

SDK предоставляет специфичные типы исключений для различных сценариев ошибок:

- `SessionControlException`: Выбрасывается при проблеме с управлением сессией (создание, инициализация и т.д.)
- `SessionSendPromptException`: Выбрасывается при проблеме с отправкой подсказки или получением ответа
- `SessionClosedException`: Выбрасывается при попытке использовать закрытую сессию

## FAQ / Устранение неполадок

### В: Нужно ли мне устанавливать Nessy CLI отдельно?

О: Да, требуется Nessy CLI 0.5.5 или выше.

### В: Какие версии Java поддерживаются?

О: SDK требует Java 1.8 или выше.

### В: Как обрабатывать долго-running запросы?

О: SDK включает утилиты таймаутов. Вы можете настроить таймауты используя класс `Timeout` в `TransportOptions`.

### В: Почему некоторые инструменты не выполняются?

О: Это вероятно из-за режимов разрешений. Проверьте ваши настройки режима разрешений и рассмотрите использование `allowedTools` для предварительного одобрения определённых инструментов.

### В: Как возобновить предыдущую сессию?

О: Используйте метод `setResumeSessionId()` в `TransportOptions` для возобновления предыдущей сессии.

### В: Могу ли я настроить окружение для процесса CLI?

О: Да, используйте метод `setEnv()` в `TransportOptions` для передачи переменных окружения процессу CLI.

## Лицензия

Apache-2.0
