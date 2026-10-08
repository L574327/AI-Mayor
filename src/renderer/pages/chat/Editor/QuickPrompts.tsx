import { Button } from "@fluentui/react-components";

export const QUICK_PROMPTS = [
  { label: "\u8d85\u7ea7\u90fd\u5e02", prompt: "\u5e2e\u6211\u5efa\u7acb\u4e00\u4e2a\u8d85\u7ea7\u90fd\u5e02" },
  {
    label: "\u7a33\u5065\u53d1\u5c55",
    prompt: "\u7a33\u5065\u53d1\u5c55\u8fd9\u5ea7\u57ce\u5e02\uff0c\u4e0d\u8981\u7834\u4ea7",
  },
  { label: "\u5feb\u901f\u6269\u5f20", prompt: "\u5feb\u901f\u6269\u5f20\u4eba\u53e3\u548c\u57ce\u533a" },
  { label: "\u6ee8\u6c34\u57ce\u5e02", prompt: "\u5efa\u8bbe\u4e00\u5ea7\u6f02\u4eae\u7684\u6ee8\u6c34\u57ce\u5e02" },
  { label: "\u6539\u5584\u4ea4\u901a", prompt: "\u5e2e\u6211\u6539\u5584\u4ea4\u901a\u62e5\u5835" },
  {
    label: "\u81ea\u52a8\u4f53\u68c0",
    prompt: "\u68c0\u67e5\u8fd9\u5ea7\u57ce\u5e02\u7684\u95ee\u9898\u5e76\u81ea\u5df1\u89e3\u51b3",
  },
] as const;

export default function QuickPrompts({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (prompt: string) => void;
}) {
  return (
    <fieldset className="quick-prompts flex items-center gap-1.5 px-2.5 pb-1.5" aria-label="Quick Prompts">
      <legend className="mr-1 shrink-0 text-xs text-secondary-text">Quick Prompts</legend>
      <div className="flex min-w-0 gap-1.5 overflow-x-auto">
        {QUICK_PROMPTS.map(({ label, prompt }) => (
          <Button
            key={prompt}
            type="button"
            size="small"
            appearance="subtle"
            disabled={disabled}
            onClick={() => onSelect(prompt)}
            title={prompt}
          >
            {label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
