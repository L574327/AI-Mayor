export default function usePlatform() {
  const platform = window.electron.platform || 'darwin';
  const isDarwin = platform === 'darwin';
  const isLinux = platform === 'linux';
  const isWindows = platform === 'win32';
  return {
    isDarwin,
    isLinux,
    isWindows,
    platform,
  };
}
