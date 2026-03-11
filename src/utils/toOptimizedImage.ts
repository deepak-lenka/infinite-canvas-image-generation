// for gc and I don't wanna worry about reredering//
const cache: Record<string, string> = {};

export const toOptimizedImage = (url: string) => {
  if (url in cache) {
    return cache[url];
  }
  const optimized = (() => {
    try {
      const host = new URL(url).host;
      if (host.endsWith("ucarecdn.com")) {
        return `${url}-/format/auto/`;
      }
    } catch {
      // ignore invalid URLs and fall back to returning the original string
    }
    return url;
  })();
  cache[url] = optimized;
  return optimized;
};
