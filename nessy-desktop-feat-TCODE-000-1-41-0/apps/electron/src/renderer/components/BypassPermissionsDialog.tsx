import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"
import { useRegisterModal } from "@/context/ModalContext"

interface BypassPermissionsDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * BypassPermissionsDialog — the one-time responsibility acknowledgment before
 * the first switch into Bypass permissions mode (permission-modes.md makes
 * bypass an explicit opt-in; this dialog is the desktop analog of Claude's
 * bypass acknowledgment). Accepting records the acknowledgment and applies
 * the mode; declining leaves the session in its current mode.
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (the recipe is v0.15.1
 * `ResetConfirmationDialog.tsx`): Cancel is the ghost, the irreversible "I accept
 * the risk" is `danger-solid`, the warning glyph takes the info (amber) role and the two
 * notes the text roles. The wording is unchanged.
 */
export function BypassPermissionsDialog({
  open,
  onConfirm,
  onCancel,
}: BypassPermissionsDialogProps) {
  const { t } = useTranslation()

  // Register with modal context so X button / Cmd+W closes this dialog first
  useRegisterModal(open, onCancel)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0 text-info" />
            {t("dialog.bypassPermissions.title")}
          </DialogTitle>
          <DialogDescription>
            {t("dialog.bypassPermissions.description")}
          </DialogDescription>
        </DialogHeader>
        {/*
          P6.229. The row's premise — "nothing warns a user" — is refuted by
          this dialog's existence; what it lacked is the two things its
          `done_means` names, and both are copy rather than plumbing.

          `runtimeNote`: the description above promises "every action ... network
          access included", which holds on Pi and claude and OVERSTATES on codex,
          where `danger-full-access` resolves to `workspaceWrite` because the
          host's `:workspace`-extending profile supersedes it (P3.315; since
          F1.1057 it carries the protected-path floor, C3.343 — F1.1068).
          Stated for all three at once rather than switched on the session's
          runtime: the divergence is a fixed, measured fact, one sentence covers
          it, and threading a runtime into this dialog would add plumbing to
          three files to say the same thing — the host's job here is to make the
          residual difference HONEST, not to hide it behind a conditional.

          `recommendation`: the safer mode, in the same dialog. `auto` rather
          than `acceptEdits` because it is the one closest in convenience to what
          a user reaching for Bypass wants — "Handles permission decisions for
          you" — so the recommendation has a chance of being taken.
        */}
        <p className="text-label text-secondary">
          {t("dialog.bypassPermissions.runtimeNote")}
        </p>
        <p className="text-label font-medium">
          {t("dialog.bypassPermissions.recommendation")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("dialog.bypassPermissions.cancel")}
          </Button>
          <Button variant="danger-solid" onClick={onConfirm}>
            {t("dialog.bypassPermissions.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
