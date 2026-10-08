import { ProviderType } from 'providers/types';
import { FontSize, ThemeType } from './appearance';

export type LanguageType = 'en' | 'zh' | 'system';

export interface IAPISettings {
  provider: ProviderType;
  base: string;
  key: string;
  model: string;
  secret?: string;
  deploymentId?: string;
  endpoint?: string;
}

export interface ISettings {
  theme: ThemeType;
  language: LanguageType;
  fontSize: FontSize;
  api: {
    activeProvider: string;
    providers: {
      [key: string]: IAPISettings;
    };
  };
}
