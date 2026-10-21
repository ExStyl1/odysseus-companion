/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

const BUNDLE_URL = 'https://ca-certs.tcsbank.ru/v0/tinkoff-bundle.crt';
// [nessy-fork] statist-trusted-ca
const RUSSIAN_ROOT_URL = 'https://ca-certs.tcsbank.ru/v0/russian-root-ca.crt';
const RUSSIAN_ROOT_FINGERPRINT =
  'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';
const CERT_DIR = path.join(process.cwd(), 'certs');
const CERT_PATH = path.join(CERT_DIR, 'tinkoff-bundle.crt');
const RUSSIAN_ROOT_PATH = path.join(CERT_DIR, 'russian-root-ca.crt');
const TEMP_CERT_PATH = `${CERT_PATH}.tmp`;
const TEMP_RUSSIAN_ROOT_PATH = `${RUSSIAN_ROOT_PATH}.tmp`;

// Create certs directory if it doesn't exist
if (!fs.existsSync(CERT_DIR)) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
}

function isRussianRoot(cert) {
  try {
    return (
      new X509Certificate(cert).fingerprint256 === RUSSIAN_ROOT_FINGERPRINT
    );
  } catch {
    return false;
  }
}

function isCertificateBundle(bundle) {
  const certificates = bundle.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!certificates?.length) return false;

  try {
    certificates.forEach((certificate) => new X509Certificate(certificate));
    return true;
  } catch {
    return false;
  }
}

if (
  fs.existsSync(CERT_PATH) &&
  fs.existsSync(RUSSIAN_ROOT_PATH) &&
  isCertificateBundle(fs.readFileSync(CERT_PATH, 'utf8')) &&
  isRussianRoot(fs.readFileSync(RUSSIAN_ROOT_PATH, 'utf8'))
) {
  console.log(`Certificates already exist at ${CERT_DIR}, skipping download`);
  process.exit(0);
}

console.log(
  `Downloading certificates from ${BUNDLE_URL} and ${RUSSIAN_ROOT_URL}...`,
);

// Setup proxy options if needed (for CI environments)
const httpsProxy = process.env['https_proxy'] || process.env['HTTPS_PROXY'];

function getRequestOptions(url) {
  const ca = fs.existsSync(CERT_PATH) ? fs.readFileSync(CERT_PATH) : undefined;

  if (!httpsProxy) return { ca };

  const proxyUrl = new URL(httpsProxy);
  return {
    hostname: proxyUrl.hostname,
    port: proxyUrl.port,
    path: url,
    method: 'GET',
    headers: {
      Host: new URL(url).host,
    },
    ca,
  };
}

function downloadCert(url) {
  return new Promise((resolve, reject) => {
    const options = getRequestOptions(url);
    const request = httpsProxy
      ? https.request(options)
      : https.get(url, options);

    request.on('response', (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirects
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          console.log(`Redirecting to ${redirectUrl}`);
          downloadCert(redirectUrl).then(resolve, reject);
          return;
        }
      }
      handleResponse(response, resolve, reject);
    });

    request.on('error', reject);

    if (httpsProxy) {
      request.end();
    }
  });
}

function handleResponse(response, resolve, reject) {
  if (response.statusCode !== 200) {
    reject(
      new Error(
        `Failed to download certificate. Status code: ${response.statusCode}`,
      ),
    );
    return;
  }

  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  response.on('error', reject);
}

Promise.all([downloadCert(BUNDLE_URL), downloadCert(RUSSIAN_ROOT_URL)])
  .then(([bundle, russianRoot]) => {
    if (!isCertificateBundle(bundle)) {
      throw new Error('Downloaded CA bundle is invalid');
    }
    if (!isRussianRoot(russianRoot)) {
      throw new Error('Russian root certificate fingerprint mismatch');
    }

    fs.writeFileSync(TEMP_CERT_PATH, `${bundle.trim()}\n`);
    fs.writeFileSync(TEMP_RUSSIAN_ROOT_PATH, `${russianRoot.trim()}\n`);
    fs.renameSync(TEMP_CERT_PATH, CERT_PATH);
    fs.renameSync(TEMP_RUSSIAN_ROOT_PATH, RUSSIAN_ROOT_PATH);
    console.log(`Certificates downloaded successfully to ${CERT_DIR}`);
    process.exit(0);
  })
  .catch((err) => {
    fs.rmSync(TEMP_CERT_PATH, { force: true });
    fs.rmSync(TEMP_RUSSIAN_ROOT_PATH, { force: true });
    console.error('Error downloading certificate:', err.message);
    process.exit(1);
  });
