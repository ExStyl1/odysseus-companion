---
title: Локальный запуск nessy serve
---

# Локальный запуск `nessy serve` (v0.16-alpha)

Шаблоны предназначены для одного пользователя и локального daemon с собственным bearer token. Контейнеры, несколько host и TLS отложены до v0.16.x.

## Bearer token

```bash
openssl rand -hex 32 > ~/.nessy-serve-token
chmod 600 ~/.nessy-serve-token
export NESSY_SERVER_TOKEN="$(cat ~/.nessy-serve-token)"
```

Не добавляйте export в shell profile: токен унаследуют все процессы. Сервер читает `--token` либо `NESSY_SERVER_TOKEN`; TypeScript `DaemonClient` также использует переменную по умолчанию.

## Linux: systemd user unit

Узнайте абсолютный путь через `which nessy`. Создайте `~/.config/systemd/user/nessy-serve.service`:

```ini
[Unit]
Description=Nessy CLI daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/your-project
ExecStart=/PATH/TO/nessy serve --hostname 127.0.0.1 --port 4170
EnvironmentFile=%h/.nessy-serve-token-env
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
echo "NESSY_SERVER_TOKEN=$(cat ~/.nessy-serve-token)" > ~/.nessy-serve-token-env
chmod 600 ~/.nessy-serve-token-env
systemctl --user daemon-reload
systemctl --user enable --now nessy-serve.service
loginctl enable-linger "$(whoami)"
journalctl --user -u nessy-serve -f
```

`enable-linger` сохраняет user manager после logout и reboot. Для shared host возможен system unit с `User=%i`, но токен всё равно должен быть в защищённом `EnvironmentFile`.

## macOS: launchd

В `~/Library/LaunchAgents/com.nessylm.nessy-serve.plist` задайте Label, абсолютные `ProgramArguments` (`/PATH/TO/nessy`, `serve`, `--hostname`, `127.0.0.1`, `--port`, `4170`), абсолютный `WorkingDirectory`, `NESSY_SERVER_TOKEN`, `RunAtLoad=true`, `KeepAlive/SuccessfulExit=false`, `ThrottleInterval=10` и логи в `~/Library/Logs/nessy-serve/`. Файл содержит токен, поэтому выполните `chmod 600`.

```bash
mkdir -p ~/Library/Logs/nessy-serve
chmod 600 ~/Library/LaunchAgents/com.nessylm.nessy-serve.plist
launchctl load ~/Library/LaunchAgents/com.nessylm.nessy-serve.plist
launchctl unload ~/Library/LaunchAgents/com.nessylm.nessy-serve.plist
```

После изменения plist нужен unload/load; load очищает log files.

## tmux и nohup

```bash
tmux new -d -s nessy-serve "cd ~/your-project && nessy serve --hostname 127.0.0.1"
tmux attach -t nessy-serve
tmux kill-session -t nessy-serve
```

```bash
nohup bash -c 'cd ~/your-project && nessy serve --hostname 127.0.0.1' > nessy-serve.log 2>&1 &
echo $!
```

Оба варианта наследуют `NESSY_SERVER_TOKEN`, но не переживают reboot и не перезапускают упавший daemon. Явный `cd` предотвращает `400 workspace_mismatch`.

## Проверка и ротация

```bash
curl http://127.0.0.1:4170/health
curl -H "Authorization: Bearer $NESSY_SERVER_TOKEN" http://127.0.0.1:4170/capabilities
```

При настроенном токене все loopback routes кроме `/health` требуют Authorization. `401` означает несовпадение токенов. Для ротации перезапишите token/env file с mode 600, перезапустите systemd или unload/load launchd и обновите клиентские процессы.

## Семантика перезапуска и ограничения

systemd и предложенный launchd перезапускают daemon только после ошибки; tmux/nohup — никогда. SSE `Last-Event-ID` восстанавливает подключение лишь в пределах жизни одного процесса. Перезапуск теряет in-memory sessions. В alpha отсутствуют контейнерное развёртывание, federation, координация нескольких daemon, автогенерация токенов и native Windows service; на Windows используйте WSL2.
