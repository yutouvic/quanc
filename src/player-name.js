export const PLAYER_NAME_ERROR = '昵称须为1至4个中文或英文字母';

export function isValidPlayerName(name) {
  return typeof name === 'string' && /^[A-Za-z\p{Script=Han}]{1,4}$/u.test(name);
}

export function randomPlayerName() {
  const letters = new Uint8Array(4);
  globalThis.crypto.getRandomValues(letters);
  return Array.from(letters, value => String.fromCharCode(97 + value % 26)).join('');
}
