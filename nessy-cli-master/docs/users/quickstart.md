# Quickstart

> 👏 Welcome to Nessy CLI!

This quickstart guide will have you using AI-powered coding assistance in just a few minutes. By the end, you'll understand how to use Nessy CLI for common development tasks.

## Before you begin

Make sure you have:

- A **terminal** or command prompt open
- A code project to work with
- A [Spirit llm account](https://devplatform.tcsbank.ru/tenants/dps-arch-office/llm-proxy/accounts/4144/api-keys) account

```
https://devplatform.tcsbank.ru/tenants/\{ваш tenant\}/llm-proxy/accounts/4144/api-keys
```

## Step 1: Install Nessy CLI

To install Nessy CLI, use one of the following methods:

### Quick Install (Recommended)

**macOS — Self Service**

1. Откройте на вашем компьютере приложение **Self Service**. Оно уже
   установлено.
2. Введите в поиске `Nessy CLI`.
3. Нажмите **Install** под названием **Nessy CLI**.

**Linux / macOS — установка из терминала**

**macOS**

```bash
    bash -c "$(/usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.sh)"
```

**Linux**

```bash
    CURL=/usr/bin/curl
    [ -x "$CURL" ] || CURL=/bin/curl
    "$CURL" -fsSL https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.sh | bash
```

The absolute paths ensure the installer uses the system certificate store even
when Anaconda or another environment provides a different `curl` on `PATH`.

**Windows (Run as Administrator)**

```cmd
    "%SystemRoot%\System32\curl.exe" -fsSL -o "%TEMP%\install-nessy.bat" https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.bat && "%TEMP%\install-nessy.bat"
```

The absolute path bypasses `curl.exe` provided by Anaconda or another
environment on `PATH`.

```cmd
powershell -Command "Invoke-WebRequest 'https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/install -nessy.bat' -OutFile (Join-Path $env:TEMP 'install -nessy.bat'); & (Join-Path $env:TEMP 'install -nessy.bat')"
```

> [!note]
>
> It's recommended to restart your terminal after installation to ensure environment variables take effect.

### Manual Installation

**Prerequisites**

Make sure you have Node.js 22 or later installed. Download it from [nodejs.org](https://nodejs.org/en/download).

**NPM**

```bash
npm install -g @nestor/nessy-cli@latest
```

## Step 2: Create llm proxy key

## Step 3: Start your first session

Open your terminal in any project directory and start Nessy CLI:

```bash
# optiona
cd /path/to/your/project
# start nessy
nessy
```

You'll see the Nessy CLI welcome screen with your session information, recent conversations, and latest updates. Type `/help` for available commands.

## Chat with Nessy CLI

### Ask your first question

Nessy CLI will analyze your files and provide a summary. You can also ask more specific questions:

```
explain the folder structure
```

You can also ask Nessy CLI about its own capabilities:

```
what can Nessy CLI do?
```

> [!note]
>
> Nessy CLI reads your files as needed - you don't have to manually add context. Nessy CLI also has access to its own documentation and can answer questions about its features and capabilities.

### Make your first code change

Now let's make Nessy CLI do some actual coding. Try a simple task:

```
add a hello world function to the main file
```

Nessy CLI will:

1. Find the appropriate file
2. Show you the proposed changes
3. Ask for your approval
4. Make the edit

> [!note]
>
> Nessy CLI always asks for permission before modifying files. You can approve individual changes or enable "Accept all" mode for a session.

### Use Git with Nessy CLI

Nessy CLI makes Git operations conversational:

```
what files have I changed?
```

```
commit my changes with a descriptive message
```

You can also prompt for more complex Git operations:

```
create a new branch called feature/quickstart
```

```
show me the last 5 commits
```

```
help me resolve merge conflicts
```

### Fix a bug or add a feature

Nessy CLI is proficient at debugging and feature implementation.

Describe what you want in natural language:

```
add input validation to the user registration form
```

Or fix existing issues:

```
there's a bug where users can submit empty forms - fix it
```

Nessy CLI will:

- Locate the relevant code
- Understand the context
- Implement a solution
- Run tests if available

### Test out other common workflows

There are a number of ways to work with Nessy CLI:

**Refactor code**

```
refactor the authentication module to use async/await instead of callbacks
```

**Write tests**

```
write unit tests for the calculator functions
```

**Update documentation**

```
update the README with installation instructions
```

**Code review**

```
review my changes and suggest improvements
```

> [!tip]
>
> **Remember**: Nessy CLI is your AI pair programmer. Talk to it like you would a helpful colleague - describe what you want to achieve, and it will help you get there.

## Essential commands

Here are the most important commands for daily use:

| Command               | What it does                                     | Example                       |
| --------------------- | ------------------------------------------------ | ----------------------------- |
| `nessy`               | start Nessy CLI                                  | `nessy`                       |
| `/auth`               | Change authentication method (in session)        | `/auth`                       |
| `/doctor`             | Check current authentication and environment     | `/doctor`                     |
| `/help`               | Display help information for available commands  | `/help` or `/?`               |
| `/compress`           | Replace chat history with summary to save Tokens | `/compress`                   |
| `/clear`              | Clear terminal screen content                    | `/clear` (shortcut: `Ctrl+L`) |
| `/theme`              | Change Nessy CLI visual theme                    | `/theme`                      |
| `/language`           | View or change language settings                 | `/language`                   |
| → `ui [language]`     | Set UI interface language                        | `/language ui zh-CN`          |
| → `output [language]` | Set LLM output language                          | `/language output Chinese`    |
| `/quit`               | Exit Nessy CLI immediately                       | `/quit` or `/exit`            |

See the [CLI reference](./features/commands) for a complete list of commands.

## Pro tips for beginners

**Be specific with your requests**

- Instead of: "fix the bug"
- Try: "fix the login bug where users see a blank screen after entering wrong credentials"

**Use step-by-step instructions**

- Break complex tasks into steps:

```
1. create a new database table for user profiles
2. create an API endpoint to get and update user profiles
3. build a webpage that allows users to see and edit their information
```

**Let Nessy CLI explore first**

- Before making changes, let Nessy CLI understand your code:

```
analyze the database schema
```

```
build a dashboard showing products that are most frequently returned by our UK customers
```

**Save time with shortcuts**

- Press `?` to see all available keyboard shortcuts
- Use Tab for command completion
- Press ↑ for command history
- Type `/` to see all slash commands

## Getting help

- **In Nessy CLI**: Type `/help` or ask "how do I..."
- **Documentation**: You're here! Browse other guides
