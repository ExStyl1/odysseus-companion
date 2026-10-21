import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { HARNESS_TOOL_DESCRIPTORS } from '../agent/pi-harness/harness-tool-descriptor.ts'
import { createFileCheckpoint, finalizeFileCheckpoint, listFileCheckpointBaselines, listFileCheckpoints, revertFileCheckpoint, sweepFileCheckpoints } from './file-checkpoints.ts'

test('serializes notebook checkpoints and truthfully restores content, mode and rewind limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessy-checkpoint-'))
  const sessionPath = join(root, 'session')
  const notebook = join(root, 'book.ipynb')
  try {
    await writeFile(notebook, 'before')
    await chmod(notebook, 0o640)
    const [first] = await Promise.all([
      createFileCheckpoint({ sessionPath, adapter: 'file', toolName: 'NotebookEdit', toolCallId: 'a', input: { notebook_path: notebook } }),
      createFileCheckpoint({ sessionPath, adapter: 'file', toolName: 'NotebookEdit', toolCallId: 'b', input: { notebook_path: notebook } }),
    ])
    const checkpoints = await listFileCheckpoints(sessionPath)
    expect(checkpoints).toHaveLength(2)
    expect(new Set(checkpoints.map(entry => entry.id)).size).toBe(2)
    await writeFile(notebook, 'after')
    await chmod(notebook, 0o600)
    await Promise.all(checkpoints.map(checkpoint => finalizeFileCheckpoint({
      sessionPath, checkpointId: checkpoint.id, succeeded: true,
    })))
    const restored = await revertFileCheckpoint({ sessionPath, checkpointId: first[0]!.id })
    expect(restored).toMatchObject({ success: true, restored: true })
    expect(restored).toMatchObject({ contentRestored: true, modeRestored: true, manifestPersisted: true })
    expect(restored.irreversibleEffects).toContain('network')
    expect(await readFile(notebook, 'utf8')).toBe('before')
    expect((await stat(notebook)).mode & 0o777).toBe(0o640)
    const absent = join(root, 'never-created.ts')
    const [absentCheckpoint] = await createFileCheckpoint({
      sessionPath, adapter: 'file', toolName: 'write', toolCallId: 'absent', input: { file_path: absent },
    })
    await finalizeFileCheckpoint({ sessionPath, checkpointId: absentCheckpoint!.id, succeeded: true })
    expect(await revertFileCheckpoint({ sessionPath, checkpointId: absentCheckpoint!.id }))
      .toMatchObject({ success: true, deleted: false, alreadyAbsent: true, manifestPersisted: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('derives file checkpoint coverage from descriptors and rewinds format bytes and mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessy-checkpoint-completeness-'))
  const sessionPath = join(root, 'session')
  try {
    const declared = HARNESS_TOOL_DESCRIPTORS.filter(descriptor => descriptor.checkpointAdapter)
    for (const descriptor of declared) {
      const target = join(root, `${descriptor.id}.txt`)
      await writeFile(target, 'before')
      const [checkpoint] = await createFileCheckpoint({
        sessionPath,
        adapter: descriptor.checkpointAdapter!,
        toolName: descriptor.id,
        toolCallId: descriptor.id,
        input: { path: target },
      })
      await writeFile(target, `after-${descriptor.id}`)
      if (descriptor.id === 'format') await chmod(target, 0o600)
      await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })
    }

    const checkpoints = await listFileCheckpoints(sessionPath)
    expect(checkpoints.map(checkpoint => checkpoint.toolName)).toEqual(declared.map(descriptor => descriptor.id))
    expect(checkpoints.map(checkpoint => checkpoint.toolName)).toContain('format')
    expect(checkpoints.map(checkpoint => checkpoint.toolName)).not.toContain('bash')
    expect(checkpoints.map(checkpoint => checkpoint.toolName)).not.toContain('mcp_dynamic')

    const format = checkpoints.find(checkpoint => checkpoint.toolName === 'format')!
    const rewind = await revertFileCheckpoint({ sessionPath, checkpointId: format.id })
    expect(rewind).toMatchObject({ success: true, contentRestored: true, modeRestored: true })
    expect(await readFile(format.filePath, 'utf8')).toBe('before')
    expect((await stat(format.filePath)).mode & 0o777).toBe(format.mode!)
    expect(rewind.irreversibleEffects).toEqual(['bash', 'mcp', 'network', 'external'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retains failed/no-op records and refuses to overwrite a concurrent external change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessy-checkpoint-conflict-'))
  const sessionPath = join(root, 'session')
  const target = join(root, 'target.txt')
  try {
    await writeFile(target, 'before')
    const [noop] = await createFileCheckpoint({
      sessionPath, adapter: 'file', toolName: 'edit', toolCallId: 'noop', input: { file_path: target },
    })
    expect(await finalizeFileCheckpoint({ sessionPath, checkpointId: noop!.id, succeeded: true }))
      .toMatchObject({ outcome: 'no-op', changed: false })

    const [failed] = await createFileCheckpoint({
      sessionPath, adapter: 'file', toolName: 'edit', toolCallId: 'failed', input: { file_path: target },
    })
    await writeFile(target, 'partial-tool-write')
    expect(await finalizeFileCheckpoint({ sessionPath, checkpointId: failed!.id, succeeded: false }))
      .toMatchObject({ outcome: 'failed', changed: true })
    await writeFile(target, 'external-write')

    const listed = await listFileCheckpoints(sessionPath)
    expect(listed.find(entry => entry.id === failed!.id)).toMatchObject({
      adapter: 'file', conflict: true, currentExists: true,
    })
    const rewind = await revertFileCheckpoint({ sessionPath, checkpointId: failed!.id })
    expect(rewind).toMatchObject({ success: false, conflict: true })
    expect(rewind.expectedDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(rewind.currentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(target, 'utf8')).toBe('external-write')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the write-time GC caps checkpoints, deletes unreferenced snapshots and pins each file first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessy-checkpoint-gc-'))
  const sessionPath = join(root, 'session')
  const a = join(root, 'a.txt')
  const b = join(root, 'b.txt')
  try {
    await writeFile(a, 'a')
    await writeFile(b, 'b')
    // Interleave two files past a small cap. Production route: every checkpoint
    // is created through createFileCheckpoint, which runs the GC itself.
    const created: string[] = []
    for (let round = 0; round < 4; round += 1) {
      for (const target of [a, b]) {
        const [entry] = await createFileCheckpoint({
          sessionPath, adapter: 'file', toolName: 'edit', toolCallId: `t${round}-${basename(target)}`, input: { file_path: target },
        })
        created.push(entry!.id)
      }
    }
    // Nothing is capped yet at the real retention of 100.
    expect(await listFileCheckpoints(sessionPath)).toHaveLength(8)
    expect(await listFileCheckpointBaselines(sessionPath)).toEqual([])

    // A dry run removes nothing and reports exactly what a real run would.
    const dry = await sweepFileCheckpoints(sessionPath, { retention: 2, dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.discardedCheckpointIds).toEqual(created.slice(0, 6))
    expect(await listFileCheckpoints(sessionPath)).toHaveLength(8)
    for (const snapshotFile of dry.deletedSnapshotFiles) {
      expect(existsSync(join(sessionPath, snapshotFile))).toBe(true)
    }

    const real = await sweepFileCheckpoints(sessionPath, { retention: 2 })
    expect(real.discardedCheckpointIds).toEqual(dry.discardedCheckpointIds)
    expect(real.deletedSnapshotFiles).toEqual(dry.deletedSnapshotFiles)
    expect(real.pinnedSnapshotFiles).toEqual(dry.pinnedSnapshotFiles)
    expect(real.failedSnapshotFiles).toEqual([])

    // Two files touched, so exactly two first snapshots are pinned — and they are
    // pinned even though no retained checkpoint references them.
    const baselines = await listFileCheckpointBaselines(sessionPath)
    expect(baselines.map(entry => entry.filePath).sort()).toEqual([a, b].sort())
    expect(baselines.map(entry => entry.checkpointId).sort()).toEqual(created.slice(0, 2).sort())
    for (const baseline of baselines) {
      expect(existsSync(join(sessionPath, baseline.snapshotFile))).toBe(true)
      expect(baseline.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
    // Everything else discarded is gone from disk and from the manifest.
    for (const snapshotFile of real.deletedSnapshotFiles) {
      expect(existsSync(join(sessionPath, snapshotFile))).toBe(false)
    }
    expect((await listFileCheckpoints(sessionPath)).map(entry => entry.id)).toEqual(created.slice(6))

    // A checkpoint written after the trim keeps a unique id.
    const [next] = await createFileCheckpoint({
      sessionPath, adapter: 'file', toolName: 'edit', toolCallId: 'after-trim', input: { file_path: a },
    })
    const ids = (await listFileCheckpoints(sessionPath)).map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(next!.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

/**
 * Every hazard below is built inside a directory this test created. A rewind
 * that follows a link mutates an inode the session filesystem scope never sees,
 * so the assertions are on the aliased file's BYTES before and after — a check
 * on the return value alone would stay green while the data was destroyed.
 */
test('rewind refuses to restore or delete through a link and leaves every alias byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessy-checkpoint-links-'))
  const sessionPath = join(root, 'session')
  const checkpoint = async (toolCallId: string, filePath: string, postImage: string | null) => {
    const [entry] = await createFileCheckpoint({
      sessionPath, adapter: 'file', toolName: 'edit', toolCallId, input: { file_path: filePath },
    })
    if (postImage === null) await rm(filePath, { force: true })
    else await writeFile(filePath, postImage)
    await finalizeFileCheckpoint({ sessionPath, checkpointId: entry!.id, succeeded: true })
    return entry!.id
  }

  try {
    // --- hard link: a second name for the same inode, invisible to any scope check
    const tracked = join(root, 'tracked.txt')
    await writeFile(tracked, 'pre-image')
    const hardLinkId = await checkpoint('hard-link', tracked, 'post-image')
    const alias = join(root, 'alias.txt')
    await link(tracked, alias)
    const aliasBefore = await readFile(alias)
    expect(aliasBefore.toString('utf8')).toBe('post-image')

    const hardLinkRewind = await revertFileCheckpoint({ sessionPath, checkpointId: hardLinkId })
    expect(hardLinkRewind).toMatchObject({ success: false, skippedLinks: 1, filePath: tracked })
    expect(hardLinkRewind.skippedPaths).toEqual([{ filePath: tracked, reason: 'hard-link' }])
    expect(await readFile(alias)).toEqual(aliasBefore)
    expect(await readFile(alias, 'utf8')).toBe('post-image')
    expect(await readFile(tracked, 'utf8')).toBe('post-image')

    // --- symlink at the tracked path, pointing at a file whose content matches the
    // post-image, so the digest conflict check cannot be what saves us
    const shared = join(root, 'shared.txt')
    await writeFile(shared, 'post-image')
    await chmod(shared, 0o644)
    const swapped = join(root, 'swapped.txt')
    await writeFile(swapped, 'pre-image')
    await chmod(swapped, 0o644)
    const symlinkId = await checkpoint('symlink', swapped, 'post-image')
    await rm(swapped)
    await symlink(shared, swapped)
    const sharedBefore = await readFile(shared)

    const symlinkRewind = await revertFileCheckpoint({ sessionPath, checkpointId: symlinkId })
    expect(symlinkRewind).toMatchObject({ success: false, skippedLinks: 1 })
    expect(symlinkRewind.skippedPaths).toEqual([{ filePath: swapped, reason: 'symlink' }])
    expect(await readFile(shared)).toEqual(sharedBefore)
    expect(await readFile(shared, 'utf8')).toBe('post-image')

    // --- parent directory replaced by a symlink: the tracked path's own final
    // component is still a regular file, so only re-resolving the parent catches it
    const realParent = join(root, 'real-parent')
    await mkdir(realParent, { recursive: true })
    const nested = join(realParent, 'note.txt')
    await writeFile(nested, 'pre-image')
    const parentId = await checkpoint('parent-symlink', nested, 'post-image')
    const decoyParent = join(root, 'decoy-parent')
    await mkdir(decoyParent, { recursive: true })
    const decoyFile = join(decoyParent, 'note.txt')
    await writeFile(decoyFile, 'post-image')
    await rm(realParent, { recursive: true, force: true })
    await symlink(decoyParent, realParent)
    const decoyBefore = await readFile(decoyFile)

    const parentRewind = await revertFileCheckpoint({ sessionPath, checkpointId: parentId })
    expect(parentRewind).toMatchObject({ success: false, skippedLinks: 1 })
    expect(parentRewind.skippedPaths).toEqual([{ filePath: nested, reason: 'parent-directory-moved' }])
    expect(await readFile(decoyFile)).toEqual(decoyBefore)
    expect(await readFile(decoyFile, 'utf8')).toBe('post-image')

    // --- parent directory removed after the tool deleted the tracked file:
    // restoring would have to recreate the directory, which a rewind must refuse
    const goneParent = join(root, 'gone-parent')
    await mkdir(goneParent, { recursive: true })
    const goneFile = join(goneParent, 'note.txt')
    await writeFile(goneFile, 'pre-image')
    const goneId = await checkpoint('parent-missing', goneFile, null)
    await rm(goneParent, { recursive: true, force: true })

    const goneRewind = await revertFileCheckpoint({ sessionPath, checkpointId: goneId })
    expect(goneRewind).toMatchObject({ success: false, skippedLinks: 1 })
    expect(goneRewind.skippedPaths).toEqual([{ filePath: goneFile, reason: 'parent-directory-missing' }])
    expect(existsSync(goneParent)).toBe(false)

    // --- a created file that has since been hard-linked: deleting one name would
    // leave the content alive under the other, so the delete branch skips too
    const created = join(root, 'created.txt')
    const createdId = await checkpoint('created-hard-link', created, 'created-content')
    const createdAlias = join(root, 'created-alias.txt')
    await link(created, createdAlias)
    const createdAliasBefore = await readFile(createdAlias)

    const createdRewind = await revertFileCheckpoint({ sessionPath, checkpointId: createdId })
    expect(createdRewind).toMatchObject({ success: false, skippedLinks: 1 })
    expect(createdRewind.deleted).toBeUndefined()
    expect(createdRewind.skippedPaths).toEqual([{ filePath: created, reason: 'hard-link' }])
    expect(existsSync(created)).toBe(true)
    expect(await readFile(createdAlias)).toEqual(createdAliasBefore)

    // A skip is never recorded as a rewind: the entry stays available so the user
    // can remove the link and rewind for real.
    const listed = await listFileCheckpoints(sessionPath)
    for (const entry of listed) expect(entry.revertedAt).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
