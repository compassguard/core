import { useSettingsStore } from '@/stores/settingsStore';

export function useAutoConfirmThreshold() {
  return useSettingsStore((state) => ({
    value: state.autoConfirmThresholdUsd,
    setValue: state.setAutoConfirmThresholdUsd,
  }));
}
