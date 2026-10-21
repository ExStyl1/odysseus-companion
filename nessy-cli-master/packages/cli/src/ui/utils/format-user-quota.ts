import type {
  UserQuota,
  UserQuotaDescriptionPart,
  UserQuotaSnapshot,
} from '@nestor/nessy-cli-core';

// [nessy-fork] user-quota-display
const PROGRESS_BAR_WIDTH = 20;

export function formatUserQuotaSnapshot(snapshot: UserQuotaSnapshot): string {
  return snapshot.limits.length === 0
    ? 'Для вашей учётной записи нет активных квот.'
    : snapshot.limits.map(formatUserQuota).join('\n\n');
}

function formatUserQuota(quota: UserQuota): string {
  const percent = Math.round(quota.usage * 100);
  const lines = [
    quota.display.title,
    `  ${formatProgressBar(quota.usage)}  Использовано: ${percent}%`,
    `  ${formatStatusIcon(quota)} ${quota.status.message}`,
  ];
  const description = quota.display.description
    ?.map(formatUserQuotaDescriptionPart)
    .join('');
  if (description) {
    lines.splice(1, 0, `${description}`);
  }
  if (quota.resetAt) {
    lines.push(`  ↻ Сброс: ${formatResetTime(quota.resetAt)}`);
  }
  const scope = [quota.scope.type, quota.scope.values.join(', ')]
    .filter(Boolean)
    .join(' · ');
  lines.push(`  ◇ Область действия: ${scope}`);
  return lines.join('\n');
}

function formatUserQuotaDescriptionPart(
  part: UserQuotaDescriptionPart,
): string {
  switch (part.type.toLowerCase()) {
    case 'text':
      return part.text;
    case 'link': {
      const url = part.url?.trim();
      return url ? `[${part.text}](${url})` : part.text;
    }
    default:
      return '';
  }
}

function formatProgressBar(usage: number): string {
  const normalizedUsage = Math.min(1, Math.max(0, usage));
  const filledWidth = Math.round(normalizedUsage * PROGRESS_BAR_WIDTH);
  return `${'█'.repeat(filledWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - filledWidth)}`;
}

function formatStatusIcon(quota: UserQuota): string {
  switch (quota.status.state.toLowerCase()) {
    case 'allowed':
      return '✓';
    case 'warning':
      return '⚠';
    case 'exhausted':
      return '✕';
    default:
      return '●';
  }
}

function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt);
  return Number.isNaN(date.getTime()) ? resetAt : date.toLocaleString('ru-RU');
}
