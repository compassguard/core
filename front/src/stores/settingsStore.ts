import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsStore {
  autoConfirmThresholdUsd: number;
  riskWarningsEnabled: boolean;
  setAutoConfirmThresholdUsd: (value: number) => void;
  setRiskWarningsEnabled: (value: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      autoConfirmThresholdUsd: 20,
      riskWarningsEnabled: true,
      setAutoConfirmThresholdUsd: (value) => set({ autoConfirmThresholdUsd: value }),
      setRiskWarningsEnabled: (value) => set({ riskWarningsEnabled: value }),
    }),
    { name: 'wallet-copilot-settings' },
  ),
);
