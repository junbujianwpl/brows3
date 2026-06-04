import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { browserStorage } from './browserStorage';

interface SettingsState {
  theme: 'light' | 'dark' | 'system';
  defaultRegion: string;
  maxConcurrentTransfers: number;
  autoRefreshOnFocus: boolean;
  largeDirCacheTtlMinutes: number;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setDefaultRegion: (region: string) => void;
  setMaxConcurrentTransfers: (max: number) => void;
  setAutoRefreshOnFocus: (enabled: boolean) => void;
  setLargeDirCacheTtlMinutes: (minutes: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      defaultRegion: 'us-east-1',
      maxConcurrentTransfers: 5,
      autoRefreshOnFocus: false,
      largeDirCacheTtlMinutes: 30,
      setTheme: (theme) => set({ theme }),
      setDefaultRegion: (defaultRegion) => set({ defaultRegion }),
      setMaxConcurrentTransfers: (maxConcurrentTransfers) => set({ maxConcurrentTransfers }),
      setAutoRefreshOnFocus: (autoRefreshOnFocus) => set({ autoRefreshOnFocus }),
      setLargeDirCacheTtlMinutes: (largeDirCacheTtlMinutes) => set({ largeDirCacheTtlMinutes }),
    }),
    {
      name: 'brows3-settings',
      storage: browserStorage,
    }
  )
);
