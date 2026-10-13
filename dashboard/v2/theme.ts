import { theme, type ThemeConfig } from 'antd';

// Unified V2 Design Token. Mirrors the profile declared in dashboard/semantics.json
// (accent teal / gray slate / radius medium / locale zh-CN) and stays the single source
// for spacing, radius and status colours so pages never hard-code visual values.
export const awhTokens = {
  colorPrimary: '#0d9488',
  colorInfo: '#1677ff',
  colorSuccess: '#16a34a',
  colorWarning: '#d46b08',
  colorError: '#d4380d',
  colorTextSecondary: '#5b6b7a',
  borderRadius: 8,
  fontSize: 14,
  controlHeight: 34,
  sizeStep: 4,
  sizeUnit: 4,
};

export const awhTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: awhTokens,
  components: {
    Layout: { bodyBg: '#f2f5f7', headerBg: '#ffffff', headerHeight: 60, headerPadding: '0 16px', siderBg: '#ffffff' },
    Card: { headerFontSize: 15, bodyPadding: 18, headerBg: '#ffffff' },
    Table: { headerBg: '#f7f9fa', headerColor: '#33454f' },
    Tag: { defaultBg: '#f1f5f9', defaultColor: '#41525d' },
    Menu: { itemBorderRadius: 8, itemSelectedBg: '#e6f4f1', itemSelectedColor: '#0d9488', itemHeight: 38 },
    Statistic: { titleFontSize: 13, contentFontSize: 26 },
    Descriptions: { labelBg: '#f7f9fa' },
  },
};

// Semantic status colours derived from the token set; consumed by StatusTag only.
export const semanticColors = {
  attention: awhTokens.colorWarning,
  blocked: awhTokens.colorError,
  healthy: awhTokens.colorSuccess,
  neutral: '#41525d',
};
