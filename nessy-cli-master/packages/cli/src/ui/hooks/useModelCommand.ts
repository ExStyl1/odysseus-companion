/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  // [nessy-fork] model-alias-fast
  isFastModelMode: boolean;
  isVoiceModelMode: boolean;
  // [nessy-fork] model-alias-visual
  isVisualModelMode: boolean;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
    visualModelMode?: boolean;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);
  const [isVisualModelMode, setIsVisualModelMode] = useState(false);

  const openModelDialog = useCallback(
    (options?: {
      fastModelMode?: boolean;
      voiceModelMode?: boolean;
      visualModelMode?: boolean;
    }) => {
      const visualModelMode = options?.visualModelMode ?? false;
      const voiceModelMode = visualModelMode
        ? false
        : (options?.voiceModelMode ?? false);
      setIsFastModelMode(
        visualModelMode || voiceModelMode
          ? false
          : (options?.fastModelMode ?? false),
      );
      setIsVoiceModelMode(voiceModelMode);
      setIsVisualModelMode(visualModelMode);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsVoiceModelMode(false);
    setIsVisualModelMode(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    isVisualModelMode,
    openModelDialog,
    closeModelDialog,
  };
};
