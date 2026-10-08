import { WINDOWS_TITLE_BAR_HEIGHT } from 'consts';
import usePlatform from './usePlatform';

export default function useUI() {
  const { isDarwin } = usePlatform();

  const calcHeight = (height: number): number => {
    if (isDarwin) {
      return height;
    }
    return height - WINDOWS_TITLE_BAR_HEIGHT;
  };
  const heightStyle = (height?: string | number): string => {
    if (isDarwin) {
      return height ? `${height}px` : '100vh';
    }
    const h = height || '100vh';
    if (typeof h === 'number') {
      return `${calcHeight(h)}px`;
    }
    return `calc(${h} - ${WINDOWS_TITLE_BAR_HEIGHT}px)`;
  };
  return {
    heightStyle,
    calcHeight,
  };
}
