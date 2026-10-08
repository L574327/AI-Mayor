/**
 * BRAND SLOTS — the owner fills these in; nothing else in the console needs to change.
 *
 *   Logo:     public/brand/logo.png   (square, transparent; shown top-left; falls back to the monogram while missing)
 *   App icon: build/icon.ico / build/icon.png (installer and window)
 *   Support:  `supportUrl` (ONE voluntary support page, opened from About; it unlocks nothing and nothing asks for it)
 *   Links:    below. An empty link is not shown.
 */
export const BRAND = {
  name: { zh: "AI 市长", en: "AI Mayor" },
  logo: "./brand/logo.png",
  websiteUrl: "https://my-portfolio-six-livid-63.vercel.app/",
  feedbackUrl: "",
  supportUrl: "https://afdian.com/a/9151a_",
  /** The open-source repository: a free star is another way to support the author. */
  githubUrl: "https://github.com/L574327/AI-Mayor",
} as const;

/** Free AI chat pages the assisted mode offers to open (any AI works: the player may use another). */
export const FREE_AI_PAGES: Array<{ name: string; url: string }> = [
  { name: "DeepSeek", url: "https://chat.deepseek.com/" },
  { name: "Kimi", url: "https://kimi.moonshot.cn/" },
  { name: "ChatGPT", url: "https://chatgpt.com/" },
  { name: "Gemini", url: "https://gemini.google.com/" },
  { name: "豆包", url: "https://www.doubao.com/chat/" },
];
