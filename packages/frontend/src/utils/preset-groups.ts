import type { Preset } from '@quicktone/shared';

export interface BankPresetGroup {
  key: string;
  label: string;
  items: Preset[];
}

export function getPresetBankKey(preset: Pick<Preset, 'bankType' | 'bankNumber'>): string {
  return `${preset.bankType === 'factory' ? 'F' : ''}${preset.bankNumber}`;
}

export function groupPresetsByBank(presets: readonly Preset[]): BankPresetGroup[] {
  const groups: BankPresetGroup[] = [];
  const indexByKey = new Map<string, number>();

  for (const preset of presets) {
    const key = getPresetBankKey(preset);
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      groups.push({
        key,
        label:
          preset.bankType === 'factory'
            ? `Fábrica F${preset.bankNumber}`
            : `Banco ${preset.bankNumber}`,
        items: [],
      });
    }
    groups[idx]!.items.push(preset);
  }

  for (const group of groups) {
    group.items.sort((a, b) => a.slotIndex - b.slotIndex);
  }
  return groups;
}
