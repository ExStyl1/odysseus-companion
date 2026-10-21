import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMessage,
  generateKey,
  readKey,
  readPrivateKey,
  sign,
} from 'openpgp'
import {
  verifyDetachedFile,
  verifyDetachedText,
} from '../linux-update-signature'

let fixtureDir: string
let publicKey: string
let privateKey: string
let fingerprint: string

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'linux-update-signature-'))
  const key = await generateKey({
    type: 'curve25519',
    userIDs: [{ name: 'Nessy update test' }],
  })
  publicKey = key.publicKey
  privateKey = key.privateKey
  fingerprint = (await readKey({ armoredKey: publicKey }))
    .getFingerprint()
    .toUpperCase()
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

async function signatureFor(bytes: Uint8Array): Promise<string> {
  return sign({
    message: await createMessage({ binary: bytes }),
    signingKeys: await readPrivateKey({ armoredKey: privateKey }),
    detached: true,
  }) as Promise<string>
}

describe('Linux update signature verification', () => {
  it('accepts a file and manifest signed by the pinned key', async () => {
    const bytes = new TextEncoder().encode('signed AppImage fixture')
    const filePath = join(fixtureDir, 'update.AppImage')
    const signature = await signatureFor(bytes)
    writeFileSync(filePath, bytes)

    await verifyDetachedFile(filePath, signature, publicKey, fingerprint)
    await verifyDetachedText(
      'version: 1.2.3\n',
      await signatureFor(new TextEncoder().encode('version: 1.2.3\n')),
      publicKey,
      fingerprint,
    )
  })

  it('rejects a modified file', async () => {
    const original = new TextEncoder().encode('original')
    const filePath = join(fixtureDir, 'tampered.AppImage')
    const signature = await signatureFor(original)
    writeFileSync(filePath, 'modified')

    await expect(
      verifyDetachedFile(filePath, signature, publicKey, fingerprint),
    ).rejects.toThrow()
  })

  it('rejects a public key whose fingerprint is not pinned', async () => {
    const filePath = join(fixtureDir, 'wrong-key.AppImage')
    writeFileSync(filePath, 'fixture')

    await expect(
      verifyDetachedFile(filePath, 'invalid', publicKey, '0'.repeat(40)),
    ).rejects.toThrow('fingerprint mismatch')
  })

  it('rejects a signature made by another key', async () => {
    const bytes = new TextEncoder().encode('wrong signer')
    const filePath = join(fixtureDir, 'wrong-signer.AppImage')
    const otherKey = await generateKey({
      type: 'curve25519',
      userIDs: [{ name: 'Wrong update signer' }],
    })
    const signature = await sign({
      message: await createMessage({ binary: bytes }),
      signingKeys: await readPrivateKey({ armoredKey: otherKey.privateKey }),
      detached: true,
    })
    writeFileSync(filePath, bytes)

    await expect(
      verifyDetachedFile(
        filePath,
        signature as string,
        publicKey,
        fingerprint,
      ),
    ).rejects.toThrow()
  })

  it('rejects a missing or malformed signature', async () => {
    const filePath = join(fixtureDir, 'missing-signature.AppImage')
    writeFileSync(filePath, 'fixture')

    await expect(
      verifyDetachedFile(filePath, '', publicKey, fingerprint),
    ).rejects.toThrow()
  })
})
