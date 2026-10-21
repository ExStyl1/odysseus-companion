# Пример скрипта прокси

Следующее является примером скрипта прокси, который может быть использован с переменной окружения `NESSY_SANDBOX_PROXY_COMMAND`. Этот скрипт разрешает только `HTTPS` соединения с `example.com:443` и отклоняет все остальные запросы.

```javascript
#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Пример прокси-сервера, который слушает на :::8877 и разрешает только HTTPS соединения с example.com.
// Установите `NESSY_SANDBOX_PROXY_COMMAND=scripts/example-proxy.js` для запуска прокси вместе с песочницей
// Тестируйте через `curl https://example.com` внутри песочницы (в режиме оболочки или через инструмент оболочки)

import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import console from 'node:console';

const PROXY_PORT = 8877;
const ALLOWED_DOMAINS = ['example.com', 'googleapis.com'];
const ALLOWED_PORT = '443';

const server = http.createServer((req, res) => {
  // Отклонить все запросы, кроме CONNECT для HTTPS
  console.log(
    `[PROXY] Отклонение не-CONNECT запроса для: ${req.method} ${req.url}`,
  );
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
});

server.on('connect', (req, clientSocket, head) => {
  // req.url будет в формате "hostname:port" для CONNECT запроса.
  const { port, hostname } = new URL(`http://${req.url}`);

  console.log(`[PROXY] Перехвачен CONNECT запрос для: ${hostname}:${port}`);

  if (
    ALLOWED_DOMAINS.some(
      (domain) => hostname == domain || hostname.endsWith(`.${domain}`),
    ) &&
    port === ALLOWED_PORT
  ) {
    console.log(`[PROXY] Разрешение соединения с ${hostname}:${port}`);

    // Установить TCP соединение с оригинальным назначением.
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Создать туннель путём передачи данных между клиентом и сервером назначения.
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      console.error(`[PROXY] Ошибка подключения к назначению: ${err.message}`);
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    });
  } else {
    console.log(`[PROXY] Отклонение соединения с ${hostname}:${port}`);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  }

  clientSocket.on('error', (err) => {
    // Это может произойти, если клиент отключается.
    console.error(`[PROXY] Ошибка сокета клиента: ${err.message}`);
  });
});

server.listen(PROXY_PORT, () => {
  const address = server.address();
  console.log(`[PROXY] Прокси слушает на ${address.address}:${address.port}`);
  console.log(
    `[PROXY] Разрешение HTTPS соединений с доменами: ${ALLOWED_DOMAINS.join(', ')}`,
  );
});
```
