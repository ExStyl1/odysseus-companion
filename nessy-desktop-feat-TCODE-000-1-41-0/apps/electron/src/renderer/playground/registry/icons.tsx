import type { ComponentEntry } from './types'
import { NessyLogo } from '@/components/icons/NessyLogo'
import { NessySymbol } from '@/components/icons/NessySymbol'
import { PanelLeftRounded } from '@/components/icons/PanelLeftRounded'
import { SquarePenRounded } from '@/components/icons/SquarePenRounded'
import { ClaudeIcon, OpenAiIcon, PiIcon } from '@/components/icons/runtime'

/** Shared knobs for the mono runtime marks (size + currentColor via className). */
const runtimeMarkProps = [
  {
    name: 'size',
    description: 'CSS size for width/height (default 1em — tracks font-size)',
    control: { type: 'string' as const },
    defaultValue: '2rem',
  },
  {
    name: 'className',
    description: 'Tailwind classes; the mark inherits color from currentColor',
    control: { type: 'string' as const },
    defaultValue: '',
  },
]

const runtimeMarkVariants = [
  { name: 'Small (1em)', props: { size: '1em', className: '' } },
  { name: 'Medium (2rem)', props: { size: '2rem', className: '' } },
  { name: 'Large (4rem)', props: { size: '4rem', className: '' } },
  { name: 'Accent', props: { size: '2rem', className: 'text-accent' } },
  { name: 'Muted', props: { size: '2rem', className: 'text-muted-foreground' } },
]

export const iconComponents: ComponentEntry[] = [
  {
    id: 'nessy-logo',
    name: 'NessyLogo',
    category: 'Icons',
    description: 'Full Nessy Desktop branding logo with text',
    component: NessyLogo,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes for sizing and styling',
        control: { type: 'string' },
        defaultValue: 'h-8',
      },
    ],
    variants: [
      { name: 'Small', props: { className: 'h-6' } },
      { name: 'Medium', props: { className: 'h-8' } },
      { name: 'Large', props: { className: 'h-12' } },
    ],
  },
  {
    id: 'nessy-symbol',
    name: 'NessySymbol',
    category: 'Icons',
    description: 'Nessy Desktop "N" symbol icon (brand color: #9570BE)',
    component: NessySymbol,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes for sizing',
        control: { type: 'string' },
        defaultValue: 'h-6 w-6',
      },
    ],
    variants: [
      { name: 'Small', props: { className: 'h-4 w-4' } },
      { name: 'Medium', props: { className: 'h-6 w-6' } },
      { name: 'Large', props: { className: 'h-10 w-10' } },
    ],
  },
  {
    id: 'runtime-mark-claude',
    name: 'ClaudeIcon',
    category: 'Icons',
    description: 'Claude brand mark (mono, currentColor) — claude-runtime connections, the Claude Pro/Max card and claude-format plugin badges',
    component: ClaudeIcon,
    props: runtimeMarkProps,
    variants: runtimeMarkVariants,
  },
  {
    id: 'runtime-mark-openai',
    name: 'OpenAiIcon',
    category: 'Icons',
    description: 'OpenAI brand mark (mono, currentColor) — codex-runtime connections, the ChatGPT card and codex-format plugin badges',
    component: OpenAiIcon,
    props: runtimeMarkProps,
    variants: runtimeMarkVariants,
  },
  {
    id: 'runtime-mark-pi',
    name: 'PiIcon',
    category: 'Icons',
    description: 'Pi brand mark (mono, currentColor) — fallback for pi/pi_compat connections whose upstream provider cannot be identified',
    component: PiIcon,
    props: runtimeMarkProps,
    variants: runtimeMarkVariants,
  },
  {
    id: 'panel-left-rounded',
    name: 'PanelLeftRounded',
    category: 'Icons',
    description: 'Sidebar toggle icon with rounded corners',
    component: PanelLeftRounded,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes',
        control: { type: 'string' },
        defaultValue: 'h-5 w-5',
      },
    ],
    variants: [
      { name: 'Default', props: { className: 'h-5 w-5' } },
      { name: 'Large', props: { className: 'h-8 w-8' } },
      { name: 'Muted', props: { className: 'h-5 w-5 text-muted-foreground' } },
    ],
  },
  {
    id: 'square-pen-rounded',
    name: 'SquarePenRounded',
    category: 'Icons',
    description: 'New chat/compose icon with rounded corners',
    component: SquarePenRounded,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes',
        control: { type: 'string' },
        defaultValue: 'h-5 w-5',
      },
    ],
    variants: [
      { name: 'Default', props: { className: 'h-5 w-5' } },
      { name: 'Large', props: { className: 'h-8 w-8' } },
      { name: 'Primary', props: { className: 'h-5 w-5 text-foreground' } },
    ],
  },
]
