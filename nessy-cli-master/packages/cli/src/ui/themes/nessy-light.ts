/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { lightSemanticColors } from './semantic-tokens.js';

const nessyLightColors: ColorsTheme = {
  type: 'light',
  Background: '#f8f9fa',
  Foreground: '#5c6166',
  LightBlue: '#55b4d4',
  AccentBlue: '#399ee6',
  AccentPurple: '#a37acc',
  AccentCyan: '#4cbf99',
  AccentGreen: '#86b300',
  AccentYellow: '#f2ae49',
  AccentRed: '#f07171',
  AccentYellowDim: '#8B7000',
  AccentRedDim: '#993333',
  DiffAdded: '#86b300',
  DiffRemoved: '#f07171',
  Comment: '#ABADB1',
  Gray: '#CCCFD3',
  GradientColors: ['#399ee6', '#86b300'],
};

export const NessyLight: Theme = new Theme(
  'Nessy Light',
  'light',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: nessyLightColors.Background,
      color: nessyLightColors.Foreground,
    },
    'hljs-comment': {
      color: nessyLightColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: nessyLightColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-string': {
      color: nessyLightColors.AccentGreen,
    },
    'hljs-constant': {
      color: nessyLightColors.AccentCyan,
    },
    'hljs-number': {
      color: nessyLightColors.AccentPurple,
    },
    'hljs-keyword': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-selector-tag': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-attribute': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-variable': {
      color: nessyLightColors.Foreground,
    },
    'hljs-variable.language': {
      color: nessyLightColors.LightBlue,
      fontStyle: 'italic',
    },
    'hljs-title': {
      color: nessyLightColors.AccentBlue,
    },
    'hljs-section': {
      color: nessyLightColors.AccentGreen,
      fontWeight: 'bold',
    },
    'hljs-type': {
      color: nessyLightColors.LightBlue,
    },
    'hljs-class .hljs-title': {
      color: nessyLightColors.AccentBlue,
    },
    'hljs-tag': {
      color: nessyLightColors.LightBlue,
    },
    'hljs-name': {
      color: nessyLightColors.AccentBlue,
    },
    'hljs-builtin-name': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-meta': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-symbol': {
      color: nessyLightColors.AccentRed,
    },
    'hljs-bullet': {
      color: nessyLightColors.AccentYellow,
    },
    'hljs-regexp': {
      color: nessyLightColors.AccentCyan,
    },
    'hljs-link': {
      color: nessyLightColors.LightBlue,
    },
    'hljs-deletion': {
      color: nessyLightColors.AccentRed,
    },
    'hljs-addition': {
      color: nessyLightColors.AccentGreen,
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-literal': {
      color: nessyLightColors.AccentCyan,
    },
    'hljs-built_in': {
      color: nessyLightColors.AccentRed,
    },
    'hljs-doctag': {
      color: nessyLightColors.AccentRed,
    },
    'hljs-template-variable': {
      color: nessyLightColors.AccentCyan,
    },
    'hljs-selector-id': {
      color: nessyLightColors.AccentRed,
    },
  },
  nessyLightColors,
  lightSemanticColors,
);
