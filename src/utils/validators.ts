export function isNotBlank(str: string | undefined | null): str is string {
  return !!(str && str.trim() !== '');
}

export function isNumeric(str: string) {
  if (typeof str !== 'string') return false; // we only process strings!
  return !isNaN(Number(str)) && !isNaN(parseFloat(str)); // ...and ensure strings of whitespace fail
}

export function isBlank(str: string | undefined | null): str is '' {
  return !isNotBlank(str);
}

export function isValidUsername(name: string) {
  // check length
  if (name.length < 2 || name.length > 20) {
    return false;
  }
  // regular expression for username validation
  const regex = /^[^.][a-z0-9.]*[^.]$/i;
  // check invalid characters
  if (/[\&\*\?=_'"“‘,,+\-<>]/.test(name)) {
    return false;
  }
  // check consecutive periods
  if (/\.{2,}/.test(name)) {
    return false;
  }
  // check against regular expression
  if (!regex.test(name)) {
    return false;
  }
  return true;
}

export function isValidEmail(email: string) {
  const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return pattern.test(email);
}

export function isValidPassword(password: string) {
  return (
    password.length >= 6 &&
    password.length <= 20 &&
    /\d/.test(password) &&
    /[a-zA-Z]/.test(password)
  );
}

export function isValidHttpHRL(url: string) {
  const pattern = /^(http|https):\/\/[^ "]+$/;
  return pattern.test(url);
}

// containing only letters (can be both cases) and numbers or hyphen, and can't start with a digit, and can't end with a hyphen
export function isValidMCPServerKey(key: string) {
  return /^[a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(key) && !/-{2,}/.test(key);
}


export function isValidMCPServer(server: any): boolean {
  if (!server || typeof server !== 'object') return false;
  if (!server.name || typeof server.name !== 'string') return false;
  const hasUrl = typeof server.url === 'string';
  const hasCmd = typeof server.command === 'string';
  if (!hasUrl && !hasCmd) return false;
  if (hasUrl && hasCmd) return false;
  if (server.args && !Array.isArray(server.args)) return false;
  if (server.headers && typeof server.headers !== 'object') return false;
  if (server.env && typeof server.env !== 'object') return false;
  if (server.description && typeof server.description !== 'string') return false;
  return true;
}
