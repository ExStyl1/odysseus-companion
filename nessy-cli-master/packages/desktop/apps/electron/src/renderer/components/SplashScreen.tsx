// eslint-disable-next-line
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { CraftAgentsSymbol } from './icons/CraftAgentsSymbol';
import { Button } from './ui/button';

interface SplashScreenProps {
  isExiting: boolean;
  onExitComplete?: () => void;
  // [nessy-fork] desktop-first-run-setup
  message?: string;
  errorMessage?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

const splashStyle: CSSProperties = {
  zIndex: 'var(--z-splash)',
};

function ignoreWindowDragError(promise: Promise<void>) {
  void promise.catch(() => {});
}

function beginWindowDrag(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.button !== 0) return;

  event.currentTarget.setPointerCapture(event.pointerId);
  ignoreWindowDragError(
    window.electronAPI.beginWindowDrag(event.screenX, event.screenY),
  );
}

function moveWindowDrag(event: ReactPointerEvent<HTMLDivElement>) {
  if ((event.buttons & 1) === 0) return;

  ignoreWindowDragError(
    window.electronAPI.moveWindowDrag(event.screenX, event.screenY),
  );
}

function endWindowDrag(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  ignoreWindowDragError(window.electronAPI.endWindowDrag());
}

/**
 * SplashScreen - Shows Craft symbol during app initialization
 *
 * Displays centered symbol on app background, fades out when app is fully ready.
 * On exit, the symbol scales up and fades out quickly while the background fades slower.
 */
export function SplashScreen({
  isExiting,
  onExitComplete,
  message,
  errorMessage,
  onRetry,
  retryLabel,
}: SplashScreenProps) {
  return (
    <motion.div
      className="fixed inset-0 z-splash flex items-center justify-center bg-background"
      style={splashStyle}
      onPointerDown={beginWindowDrag}
      onPointerMove={moveWindowDrag}
      onPointerUp={endWindowDrag}
      onPointerCancel={endWindowDrag}
      initial={{ opacity: 1 }}
      animate={{ opacity: isExiting ? 0 : 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (isExiting && onExitComplete) {
          onExitComplete();
        }
      }}
    >
      <div className="flex flex-col items-center gap-4">
        <motion.div
          initial={{ scale: 1.5, opacity: 1 }}
          animate={{
            scale: isExiting ? 3 : 1.5,
            opacity: isExiting ? 0 : 1,
          }}
          transition={{
            duration: 0.2,
            ease: [0.16, 1, 0.3, 1], // Exponential out curve
          }}
        >
          <CraftAgentsSymbol className="h-8 text-accent" />
        </motion.div>
        {message && !errorMessage && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span>{message}</span>
          </div>
        )}
        {errorMessage && (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            {onRetry && (
              <Button
                type="button"
                variant="secondary"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onRetry}
              >
                {retryLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
