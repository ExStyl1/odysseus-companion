/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { darkSemanticColors } from './semantic-tokens.js';

const nessyDarkColors: ColorsTheme = {
  type: 'dark',
  Background: '#0b0e14',
  Foreground: '#bfbdb6',
  LightBlue: '#59C2FF',
  AccentBlue: '#39BAE6',
  AccentPurple: '#D2A6FF',
  AccentCyan: '#95E6CB',
  AccentGreen: '#AAD94C',
  AccentYellow: '#FFD700',
  AccentRed: '#F26D78',
  AccentYellowDim: '#8B7530',
  AccentRedDim: '#8B3A4A',
  DiffAdded: '#AAD94C',
  DiffRemoved: '#F26D78',
  Comment: '#646A71',
  Gray: '#3D4149',
  GradientColors: ['#FFD700', '#da7959'],
};

export const NessyDark: Theme = new Theme(
  'Nessy Dark',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: nessyDarkColors.Background,
      color: nessyDarkColors.Foreground,
    },
    'hljs-keyword': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-literal': {
      color: nessyDarkColors.AccentPurple,
    },
    'hljs-symbol': {
      color: nessyDarkColors.AccentCyan,
    },
    'hljs-name': {
      color: nessyDarkColors.LightBlue,
    },
    'hljs-link': {
      color: nessyDarkColors.AccentBlue,
    },
    'hljs-function .hljs-keyword': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-subst': {
      color: nessyDarkColors.Foreground,
    },
    'hljs-string': {
      color: nessyDarkColors.AccentGreen,
    },
    'hljs-title': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-type': {
      color: nessyDarkColors.AccentBlue,
    },
    'hljs-attribute': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-bullet': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-addition': {
      color: nessyDarkColors.AccentGreen,
    },
    'hljs-variable': {
      color: nessyDarkColors.Foreground,
    },
    'hljs-template-tag': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-template-variable': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-comment': {
      color: nessyDarkColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: nessyDarkColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-deletion': {
      color: nessyDarkColors.AccentRed,
    },
    'hljs-meta': {
      color: nessyDarkColors.AccentYellow,
    },
    'hljs-doctag': {
      fontWeight: 'bold',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
  },
  nessyDarkColors,
  darkSemanticColors,
);
