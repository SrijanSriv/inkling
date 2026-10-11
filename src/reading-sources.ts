export type ReadingSource = { id: string; url: string; minutes: number; category: "tech" | "other" };

// Public sources only. Operators can replace this list without editing code.
export const readingSources: ReadingSource[] = [
  { id: "hacker-news", url: "https://hnrss.org/frontpage", minutes: 30, category: "tech" },
  { id: "lobsters", url: "https://lobste.rs/rss", minutes: 30, category: "tech" },
  { id: "simon-willison", url: "https://simonwillison.net/atom/everything/", minutes: 60, category: "tech" },
  { id: "latent-space", url: "https://www.latent.space/feed", minutes: 60, category: "tech" },
  { id: "hugging-face", url: "https://huggingface.co/blog/feed.xml", minutes: 60, category: "tech" },
  { id: "hackaday", url: "https://hackaday.com/feed/", minutes: 60, category: "tech" },
  { id: "cloudflare", url: "https://blog.cloudflare.com/rss/", minutes: 60, category: "tech" },
  { id: "github", url: "https://github.blog/feed/", minutes: 60, category: "tech" },
  { id: "ieee-spectrum", url: "https://spectrum.ieee.org/feeds/feed.rss", minutes: 60, category: "tech" },
  { id: "aeon", url: "https://aeon.co/feed.rss", minutes: 120, category: "other" },
  { id: "quanta", url: "https://www.quantamagazine.org/feed/", minutes: 120, category: "other" },
  { id: "our-world-in-data", url: "https://ourworldindata.org/atom.xml", minutes: 120, category: "other" },
  { id: "colossal", url: "https://www.thisiscolossal.com/feed/", minutes: 120, category: "other" },
  { id: "kottke", url: "https://kottke.org/index.xml", minutes: 120, category: "other" },
];
