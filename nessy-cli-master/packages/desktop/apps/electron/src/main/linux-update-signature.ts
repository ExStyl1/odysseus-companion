import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
const { createMessage, readKey, readSignature, verify } =
  require('openpgp') as typeof import('openpgp')

// [nessy-fork] desktop-linux-update-signing
export const LINUX_UPDATE_KEY_FINGERPRINT =
  '0A2987B9F751BCCEC510D3C9060891CCCD47BDA9'

export async function verifyDetachedFile(
  filePath: string,
  armoredSignature: string,
  armoredPublicKey: string,
  expectedFingerprint = LINUX_UPDATE_KEY_FINGERPRINT,
): Promise<void> {
  const publicKey = await readKey({ armoredKey: armoredPublicKey })
  if (publicKey.getFingerprint().toUpperCase() !== expectedFingerprint) {
    throw new Error('Linux update public key fingerprint mismatch')
  }

  const message = await createMessage({
    binary: Readable.toWeb(createReadStream(filePath)),
  })
  const signature = await readSignature({ armoredSignature })
  const result = await verify({
    message,
    signature,
    verificationKeys: publicKey,
    format: 'binary',
  })

  for await (const _chunk of result.data) {
    // Reading the complete stream is required before the signature is valid.
  }
  if (result.signatures.length !== 1) {
    throw new Error('Linux update must have exactly one signature')
  }
  await result.signatures[0].verified
}

export async function verifyDetachedText(
  text: string,
  armoredSignature: string,
  armoredPublicKey: string,
  expectedFingerprint = LINUX_UPDATE_KEY_FINGERPRINT,
): Promise<void> {
  const publicKey = await readKey({ armoredKey: armoredPublicKey })
  if (publicKey.getFingerprint().toUpperCase() !== expectedFingerprint) {
    throw new Error('Linux update public key fingerprint mismatch')
  }

  const result = await verify({
    message: await createMessage({ binary: new TextEncoder().encode(text) }),
    signature: await readSignature({ armoredSignature }),
    verificationKeys: publicKey,
    format: 'binary',
  })
  if (result.signatures.length !== 1) {
    throw new Error('Linux update manifest must have exactly one signature')
  }
  await result.signatures[0].verified
}
