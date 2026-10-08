// @ts-ignore
import mermaid from 'mermaid/dist/mermaid';
import useAppearanceStore from 'stores/useAppearanceStore';

export default function useMermaid() {
  const theme = useAppearanceStore((state) => state.theme);
  return {
    renderMermaid() {
      mermaid.initialize({ theme: theme === 'dark' ? 'dark' : 'default' });
      mermaid.init('div.mermaid');
    },
  };
}
