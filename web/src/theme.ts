import { theme } from 'antd';

/** antd 6 默认暗色算法，只保留品牌色微调（沿用旧版的蓝色主调）。 */
export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#4f8cff',
    borderRadius: 6,
  },
};
