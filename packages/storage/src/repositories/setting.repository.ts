export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface SettingRepository {
  set(key: string, value: unknown): Promise<SettingRecord>;
  get(key: string): Promise<SettingRecord | null>;
}
