/**
 * Generates a prefixed cache key for localStorage storage
 * @param {string} key - The base key to prefix
 * @returns {string} The prefixed cache key
 */
function cacheKey(key: string) {
  return `__cache__${key}`;
}

export default {
  /**
   * Stores a value in the cache with an optional expiration time
   * @param {string} key - The cache key to store the value under
   * @param {any} value - The value to cache
   * @param {number} [expiration=3600000] - Expiration time in milliseconds (default: 1 hour)
   */
  set(key: string, value: any, expiration = 3600000) {
    const item = {
      value,
      expiration: Date.now() + expiration,
    };
    localStorage.setItem(cacheKey(key), JSON.stringify(item));
  },

  /**
   * Retrieves a value from the cache if it exists and hasn't expired
   * @param {string} key - The cache key to retrieve
   * @returns {any|null} The cached value or null if not found or expired
   */
  get(key: string) {
    const itemStr = localStorage.getItem(key);
    if (!itemStr) {
      return null;
    }

    const item = JSON.parse(itemStr);
    if (Date.now() > item.expiration) {
      localStorage.removeItem(key);
      return null;
    }

    return item.value;
  },

  /**
   * Removes a specific item from the cache
   * @param {string} key - The cache key to remove
   */
  remove(key: string) {
    localStorage.removeItem(cacheKey(key));
  },

  /**
   * Clears all cached items from localStorage
   */
  clear() {
    const keys = Object.keys(localStorage);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].startsWith('__cache__')) {
        localStorage.removeItem(keys[i]);
      }
    }
  },
};